/**
 * SHACL Core validation (§3–§4): validates a data graph against a shapes
 * graph and produces a `ValidationReport`.
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Validator, ValidationReport } from "@thomasfosterau/effect-rdf/shacl"
 *
 * const program = Effect.gen(function* () {
 *   const report = yield* Validator.validate(dataGraph, shapesGraph)
 *   console.log(ValidationReport.format(report))
 * })
 * ```
 *
 * The `Validator` service pre-compiles a shapes graph once and validates many
 * data graphs against it:
 *
 * ```ts
 * const program = Effect.gen(function* () {
 *   const validator = yield* Validator.Validator
 *   const ok = yield* validator.conforms(dataGraph)
 * }).pipe(Effect.provide(Validator.layer(shapesGraph)))
 * ```
 *
 * @since 0.1.0
 */
import { Dataset, Term, Vocab, Xsd } from '../index.ts';
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HashMap from 'effect/HashMap';
import { constVoid, identity, pipe } from 'effect/Function';
import * as Iterable from 'effect/Iterable';
import * as Layer from 'effect/Layer';
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import { compareTerms } from './internal/compare.ts';
import * as Message from './Message.ts';
import * as Path from './Path.ts';
import * as Shapes from './Shapes.ts';
import * as Sparql from './Sparql.ts';
import * as ValidationReport from './ValidationReport.ts';
import { SH, sh } from './Vocabulary.ts';

/** A string as a JSON string literal, for messages. */
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const { rdf, rdfs, xsd } = Vocab;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Validation reached a shape again for the same focus node while still
 * validating it (a recursive shape). The SHACL specification leaves the
 * validation of recursive shapes undefined.
 *
 * @since 0.1.0
 * @category errors
 */
export class RecursiveShapeError extends Schema.TaggedError<RecursiveShapeError>()(
  'RecursiveShapeError',
  {
    message: Schema.String,
    shape: Schema.String,
    focusNode: Schema.String,
  },
) {}

/**
 * The shapes graph uses a feature this validator cannot evaluate (currently:
 * SHACL-SPARQL constraints and targets when no
 * `Sparql.SparqlConstraintEvaluator` is provided).
 *
 * @since 0.1.0
 * @category errors
 */
export class UnsupportedFeatureError extends Schema.TaggedError<UnsupportedFeatureError>()(
  'UnsupportedFeatureError',
  {
    message: Schema.String,
    feature: Schema.String,
    shape: Schema.String,
  },
) {}

/**
 * The data graph does not conform to the shapes graph (raised by
 * `Validator.check` and `assertConforms`).
 *
 * @since 0.1.0
 * @category errors
 */
export class ConformanceError extends Schema.TaggedError<ConformanceError>()('ConformanceError', {
  message: Schema.String,
  report: ValidationReport.ValidationReportSchema,
}) {}

/**
 * The errors that can prevent validation from producing a report (SHACL
 * "failures").
 *
 * @since 0.1.0
 * @category errors
 */
export type ValidationError =
  | Shapes.ShapesGraphError
  | RecursiveShapeError
  | UnsupportedFeatureError
  | Sparql.SparqlEvaluationError;

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

/**
 * Validation options.
 *
 * @since 0.1.0
 * @category models
 */
export interface ValidateOptions {
  /**
   * Validate the union of the data graph and the shapes graph (useful when
   * the data graph declares `sh:shapesGraph`, or the shapes and data live in
   * the same document). Default `false`.
   */
  readonly includeShapesGraph?: boolean | undefined;
  /**
   * What to do with SHACL-SPARQL constraints and targets when no
   * `Sparql.SparqlConstraintEvaluator` is provided: `"fail"` (default) fails
   * with an `UnsupportedFeatureError`, `"ignore"` skips them.
   */
  readonly sparql?: 'fail' | 'ignore' | undefined;
  /**
   * What to do when a shape is (directly or indirectly) validated against a
   * focus node while it is already being validated against the same node:
   * `"fail"` (default) fails with a `RecursiveShapeError`, `"ignore"` treats
   * the recursive reference as conforming.
   */
  readonly recursion?: 'fail' | 'ignore' | undefined;
  /**
   * Attach the nested results that caused `sh:node`, `sh:not`, `sh:and`,
   * `sh:or`, `sh:xone` and qualified value shape results as `sh:detail`.
   * Default `false`.
   */
  readonly details?: boolean | undefined;
}

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------

type EngineError = RecursiveShapeError | UnsupportedFeatureError | Sparql.SparqlEvaluationError;
type Results = ReadonlyArray<ValidationReport.ValidationResult>;

const langMatches = (tag: string, range: string): boolean => {
  if (tag === '') return false;
  if (range === '*') return true;
  const t = tag.toLowerCase();
  const r = range.toLowerCase();
  return t === r || t.startsWith(`${r}-`);
};

type BasicNodeKind = 'IRI' | 'BlankNode' | 'Literal';

const IRI = Option.some<BasicNodeKind>('IRI');
const BLANK_NODE = Option.some<BasicNodeKind>('BlankNode');
const LITERAL = Option.some<BasicNodeKind>('Literal');

const nodeKindOf = (t: Term.Term): Option.Option<BasicNodeKind> =>
  Term.isNamedNode(t)
    ? IRI
    : Term.isBlankNode(t)
      ? BLANK_NODE
      : Term.isLiteral(t)
        ? LITERAL
        : Option.none();

const matchesNodeKind = (t: Term.Term, kind: Shapes.NodeKind): boolean =>
  Option.exists(nodeKindOf(t), (k) => kind.includes(k));

const hasDatatype = (v: Term.Term, datatype: Term.NamedNode): boolean => {
  if (!Term.isLiteral(v) || v.datatype.value !== datatype.value) return false;
  if (datatype.value === rdf.langString.value || datatype.value === rdf.dirLangString.value)
    return v.language !== '';
  if (v.language !== '') return false;
  return Xsd.isWellFormed(v);
};

const stringValue = (v: Term.Term): Option.Option<string> =>
  Term.isNamedNode(v) || Term.isLiteral(v) ? Option.some(v.value) : Option.none();

/** Whether a value node has no string value, or one that fails `ok`. */
const failsString = (v: Term.Term, ok: (s: string) => boolean): boolean =>
  !Option.exists(stringValue(v), ok);

const show = (t: Term.Term) => t.key;

/** A high surrogate and the code unit after it: one code point. */
const surrogatePair = /[\uD800-\uDBFF][\s\S]/g;

/** The length of a string in Unicode code points (as XPath `fn:string-length`). */
const codePointLength = (s: string): number => s.replace(surrogatePair, '_').length;

type Sign = -1 | 0 | 1;

/** Whether `a` and `b` are comparable and their order satisfies `ok`. */
const ordered = (a: Term.Term, b: Term.Term, ok: (sign: Sign) => boolean): boolean =>
  Option.exists(compareTerms(a, b), ok);

const defaultMessage = (constraint: Shapes.Constraint, value: Option.Option<Term.Term>): string => {
  const v = Option.match(value, { onNone: () => 'Value', onSome: (t) => `Value ${show(t)}` });
  return Match.value(constraint)
    .pipe(
      Match.tag('Class', (c) => `${v} is not an instance of ${show(c.class)}`),
      Match.tag('Datatype', (c) => `${v} does not have datatype ${show(c.datatype)}`),
      Match.tag('NodeKind', (c) => `${v} does not have node kind sh:${c.nodeKind}`),
      Match.tag('MinCount', (c) => `Less than ${c.minCount} values`),
      Match.tag('MaxCount', (c) => `More than ${c.maxCount} values`),
      Match.tag('MinExclusive', (c) => `${v} is not greater than ${show(c.value)}`),
      Match.tag('MinInclusive', (c) => `${v} is not greater than or equal to ${show(c.value)}`),
      Match.tag('MaxExclusive', (c) => `${v} is not less than ${show(c.value)}`),
      Match.tag('MaxInclusive', (c) => `${v} is not less than or equal to ${show(c.value)}`),
      Match.tag('MinLength', (c) => `${v} is shorter than ${c.minLength} characters`),
      Match.tag('MaxLength', (c) => `${v} is longer than ${c.maxLength} characters`),
      Match.tag('Pattern', (c) => `${v} does not match pattern ${quote(c.pattern)}`),
      Match.tag(
        'LanguageIn',
        (c) => `${v} does not have a language tag in [${c.languages.join(', ')}]`,
      ),
      Match.tag('UniqueLang', () => 'Language tag used by more than one value'),
      Match.tag('Equals', (c) => `${v} is not equal to the values of ${show(c.predicate)}`),
      Match.tag('Disjoint', (c) => `${v} is also a value of ${show(c.predicate)}`),
      Match.tag('LessThan', (c) => `${v} is not less than the values of ${show(c.predicate)}`),
      Match.tag(
        'LessThanOrEquals',
        (c) => `${v} is not less than or equal to the values of ${show(c.predicate)}`,
      ),
    )
    .pipe(
      Match.tag('Not', (c) => `${v} conforms to the negated shape ${show(c.shape)}`),
      Match.tag('And', () => `${v} does not conform to all of the shapes`),
      Match.tag('Or', () => `${v} does not conform to any of the shapes`),
      Match.tag('Xone', () => `${v} does not conform to exactly one of the shapes`),
      Match.tag('Node', (c) => `${v} does not conform to shape ${show(c.shape)}`),
      Match.tag('Property', (c) => `${v} does not conform to property shape ${show(c.shape)}`),
      Match.tag(
        'QualifiedMinCount',
        (c) => `Less than ${c.count} values conform to shape ${show(c.shape)}`,
      ),
      Match.tag(
        'QualifiedMaxCount',
        (c) => `More than ${c.count} values conform to shape ${show(c.shape)}`,
      ),
      Match.tag(
        'Closed',
        () =>
          `Predicate is not allowed by the closed shape (value ${Option.match(value, { onNone: () => '', onSome: show })})`,
      ),
      Match.tag('HasValue', (c) => `Missing expected value ${show(c.value)}`),
      Match.tag('In', () => `${v} is not one of the allowed values`),
      Match.tag('Sparql', 'Component', () => `${v} violates a SPARQL-based constraint`),
      Match.exhaustive,
    );
};

const integer = (n: number) => Term.literal(String(n), xsd.integer);
const boolean = (b: boolean) => Term.literal(String(b), xsd.boolean);
const listText = (terms: ReadonlyArray<Term.Term>) =>
  Term.literal(terms.map(Message.display).join(', '));

/** The parameter values of a core constraint by parameter name (for message templates). */
const coreParameters = (
  constraint: Shapes.Constraint,
): ReadonlyArray<readonly [string, Term.Term]> => {
  return Match.value(constraint)
    .pipe(
      Match.withReturnType<ReadonlyArray<readonly [string, Term.Term]>>(),
      Match.tag('Class', (c) => [['class', c.class]]),
      Match.tag('Datatype', (c) => [['datatype', c.datatype]]),
      Match.tag('NodeKind', (c) => [['nodeKind', Term.namedNode(SH + c.nodeKind)]]),
      Match.tag('MinCount', (c) => [['minCount', integer(c.minCount)]]),
      Match.tag('MaxCount', (c) => [['maxCount', integer(c.maxCount)]]),
      Match.tag('MinExclusive', (c) => [['minExclusive', c.value]]),
      Match.tag('MinInclusive', (c) => [['minInclusive', c.value]]),
      Match.tag('MaxExclusive', (c) => [['maxExclusive', c.value]]),
      Match.tag('MaxInclusive', (c) => [['maxInclusive', c.value]]),
      Match.tag('MinLength', (c) => [['minLength', integer(c.minLength)]]),
      Match.tag('MaxLength', (c) => [['maxLength', integer(c.maxLength)]]),
      Match.tag('Pattern', (c) => [
        ['pattern', Term.literal(c.pattern)],
        ['flags', Term.literal(c.flags)],
      ]),
      Match.tag('LanguageIn', (c) => [['languageIn', Term.literal(c.languages.join(', '))]]),
      Match.tag('UniqueLang', () => [['uniqueLang', boolean(true)]]),
      Match.tag('Equals', (c) => [['equals', c.predicate]]),
      Match.tag('Disjoint', (c) => [['disjoint', c.predicate]]),
      Match.tag('LessThan', (c) => [['lessThan', c.predicate]]),
      Match.tag('LessThanOrEquals', (c) => [['lessThanOrEquals', c.predicate]]),
    )
    .pipe(
      Match.tag('Not', (c) => [['not', c.shape]]),
      Match.tag('And', (c) => [['and', listText(c.shapes)]]),
      Match.tag('Or', (c) => [['or', listText(c.shapes)]]),
      Match.tag('Xone', (c) => [['xone', listText(c.shapes)]]),
      Match.tag('Node', (c) => [['node', c.shape]]),
      Match.tag('Property', (c) => [['property', c.shape]]),
      Match.tag('QualifiedMinCount', (c) => [
        ['qualifiedValueShape', c.shape],
        ['qualifiedMinCount', integer(c.count)],
        ['qualifiedValueShapesDisjoint', boolean(c.disjoint)],
      ]),
      Match.tag('QualifiedMaxCount', (c) => [
        ['qualifiedValueShape', c.shape],
        ['qualifiedMaxCount', integer(c.count)],
        ['qualifiedValueShapesDisjoint', boolean(c.disjoint)],
      ]),
      Match.tag('Closed', (c) => [
        ['closed', boolean(true)],
        ['ignoredProperties', listText(c.ignoredProperties)],
      ]),
      Match.tag('HasValue', (c) => [['hasValue', c.value]]),
      Match.tag('In', (c) => [['in', listText(c.values)]]),
      Match.tag('Sparql', () => []),
      Match.tag('Component', (c) =>
        c.parameters.map((p) => [Message.localName(p.path), p.value] as const),
      ),
      Match.exhaustive,
    );
};

/** The `path` variable of message templates: the predicate, or the path in SPARQL syntax. */
const pathTerm = (path: Path.Path): Term.Term =>
  Predicate.isTagged(path, 'PredicatePath') ? path.predicate : Term.literal(Path.toSparql(path));

/** Substitutes `{?var}` / `{$var}` placeholders of result messages. */
const substituteMessages = (
  messages: ReadonlyArray<Term.Literal>,
  lookup: (name: string) => Option.Option<Term.Term>,
): ReadonlyArray<Term.Literal> =>
  messages.map((m) => Message.substitute(m, (name) => Option.getOrUndefined(lookup(name))));

/** The value of the last parameter of that name. */
const parameterNamed = (
  parameters: ReadonlyArray<readonly [string, Term.Term]>,
  name: string,
): Option.Option<Term.Term> =>
  Option.map(
    Arr.findLast(parameters, ([n]) => n === name),
    ([, t]) => t,
  );

/** The built-in template variables `this`, `value` and `path`. */
const builtinVariable = (
  name: string,
  focus: Term.Term,
  value: Option.Option<Term.Term>,
  resultPath: Option.Option<Path.Path>,
): Option.Option<Option.Option<Term.Term>> =>
  Match.value(name).pipe(
    Match.withReturnType<Option.Option<Option.Option<Term.Term>>>(),
    Match.when('this', () => Option.some(Option.some(focus))),
    Match.when('value', () => Option.some(value)),
    Match.when('path', () => Option.some(Option.map(resultPath, pathTerm))),
    Match.orElse(() => Option.none()),
  );

interface Engine {
  readonly validateShape: (
    shape: Shapes.Shape,
    focus: Term.GroundTerm,
  ) => Effect.Effect<Results, EngineError>;
  readonly focusNodes: (
    shape: Shapes.Shape,
  ) => Effect.Effect<ReadonlyArray<Term.GroundTerm>, EngineError>;
}

const noValue = Option.none<Term.GroundTerm>();

type Keys = MutableHashSet.MutableHashSet<string>;

const keysOf = (terms: ReadonlyArray<Term.Term>): Keys =>
  MutableHashSet.fromIterable(Arr.map(terms, (t) => t.key));

/** Ground terms by their N-Triples form, in insertion order. */
type Nodes = MutableHashMap.MutableHashMap<string, Term.GroundTerm>;

const addNew = (out: Nodes) => (t: Term.GroundTerm) => {
  if (!MutableHashMap.has(out, t.key)) MutableHashMap.set(out, t.key, t);
};

const valuesOf = (nodes: Nodes): ReadonlyArray<Term.GroundTerm> =>
  Arr.fromIterable(MutableHashMap.values(nodes));

/** Number of value nodes conforming to each member shape, for `sh:and` / `sh:or` / `sh:xone`. */
type LogicalTest = (conforming: number, members: number) => boolean;

const andFails: LogicalTest = (conforming, members) => conforming < members;
const orFails: LogicalTest = (conforming) => conforming === 0;
const xoneFails: LogicalTest = (conforming) => conforming !== 1;

const makeEngine = (
  data: Dataset.Dataset,
  shapes: Shapes.ShapesGraph,
  options: ValidateOptions,
  evaluator: Option.Option<Sparql.SparqlConstraintEvaluator['Service']>,
): Engine => {
  const memo = MutableHashMap.empty<string, Results>();
  const active: Keys = MutableHashSet.empty();
  const superClassCache = MutableHashMap.empty<string, Keys>();
  const withDetails = options.details === true;

  // -- RDFS reasoning (SHACL instances / SHACL types, §1.5) ------------------
  const computeSuperClasses = (cls: Term.GroundTerm): Keys => {
    const seen: Keys = MutableHashSet.make(cls.key);
    const unseen = (sup: Term.GroundTerm): boolean => {
      if (MutableHashSet.has(seen, sup.key)) return false;
      MutableHashSet.add(seen, sup.key);
      return true;
    };
    const nextLevel = (
      frontier: ReadonlyArray<Term.GroundTerm>,
    ): Option.Option<readonly [void, ReadonlyArray<Term.GroundTerm>]> =>
      Arr.isReadonlyArrayEmpty(frontier)
        ? Option.none()
        : Option.some([
            undefined,
            Arr.flatMap(frontier, (c) =>
              Term.isLiteral(c)
                ? []
                : Arr.filter(Dataset.objectsOf(data, c, rdfs.subClassOf), unseen),
            ),
          ]);
    Iterable.forEach(
      Iterable.unfold<ReadonlyArray<Term.GroundTerm>, void>([cls], nextLevel),
      constVoid,
    );
    MutableHashMap.set(superClassCache, cls.key, seen);
    return seen;
  };
  const superClassesOf = (cls: Term.GroundTerm): Keys =>
    Option.getOrElse(MutableHashMap.get(superClassCache, cls.key), () => computeSuperClasses(cls));
  const isInstanceOf = (node: Term.GroundTerm, cls: Term.Term): boolean =>
    !Term.isLiteral(node) &&
    Dataset.objectsOf(data, node, rdf.type).some((t) =>
      MutableHashSet.has(superClassesOf(t), cls.key),
    );
  const instancesOf = (cls: Term.Resource): ReadonlyArray<Term.GroundTerm> => {
    const out: Nodes = MutableHashMap.empty();
    Arr.forEach(Dataset.match(data, { predicate: rdf.type }), (q) => {
      if (
        !MutableHashMap.has(out, q.subject.key) &&
        MutableHashSet.has(superClassesOf(q.object), cls.key)
      )
        MutableHashMap.set(out, q.subject.key, q.subject);
    });
    return valuesOf(out);
  };

  const objectsOf = (s: Term.GroundTerm, p: Term.NamedNode): ReadonlyArray<Term.GroundTerm> =>
    Term.isLiteral(s) ? [] : Dataset.objectsOf(data, s, p);

  const shapeById = (id: Shapes.ShapeId): Shapes.Shape =>
    Option.getOrElse(Shapes.get(shapes, id), (): Shapes.Shape => ({
      _tag: 'NodeShape',
      id,
      targets: [],
      constraints: [],
      severity: sh.Violation,
      messages: [],
      deactivated: false,
    }));

  const unsupported = (
    shape: Shapes.Shape,
    feature: string,
  ): Effect.Effect<Results, EngineError> =>
    options.sparql === 'ignore'
      ? Effect.succeed([])
      : Effect.fail(
          new UnsupportedFeatureError({
            message: `${feature} used by shape ${shape.id.key} requires a SparqlConstraintEvaluator`,
            feature,
            shape: shape.id.key,
          }),
        );

  const recursive = (
    shape: Shapes.Shape,
    focus: Term.GroundTerm,
  ): Effect.Effect<Results, EngineError> =>
    options.recursion === 'ignore'
      ? Effect.succeed([])
      : Effect.fail(
          new RecursiveShapeError({
            message: `shape ${shape.id.key} is recursive for focus node ${focus.key}`,
            shape: shape.id.key,
            focusNode: focus.key,
          }),
        );

  const validateShape = (
    shape: Shapes.Shape,
    focus: Term.GroundTerm,
  ): Effect.Effect<Results, EngineError> =>
    Effect.suspend(() => {
      if (shape.deactivated) return Effect.succeed([]);
      const key = `${shape.id.key} ${focus.key}`;
      const cached = MutableHashMap.get(memo, key);
      if (Option.isSome(cached)) return Effect.succeed(cached.value);
      if (MutableHashSet.has(active, key)) return recursive(shape, focus);
      MutableHashSet.add(active, key);
      const valueNodes = Predicate.isTagged(shape, 'PropertyShape')
        ? Path.evaluate(data, focus, shape.path)
        : [focus];
      return Effect.forEach(shape.constraints, (c) => evaluate(shape, focus, valueNodes, c), {
        concurrency: 1,
      }).pipe(
        Effect.map((rs) => {
          const results = rs.flat();
          MutableHashSet.remove(active, key);
          MutableHashMap.set(memo, key, results);
          return results;
        }),
      );
    });

  const conforms = (
    id: Shapes.ShapeId,
    node: Term.GroundTerm,
  ): Effect.Effect<boolean, EngineError> =>
    Effect.map(validateShape(shapeById(id), node), (rs) => Arr.isReadonlyArrayEmpty(rs));

  const nestedResults = (id: Shapes.ShapeId, v: Term.GroundTerm) => validateShape(shapeById(id), v);

  const evaluate = Effect.fnUntraced(function* (
    shape: Shapes.Shape,
    focus: Term.GroundTerm,
    valueNodes: ReadonlyArray<Term.GroundTerm>,
    constraint: Shapes.Constraint,
  ): Effect.fn.Return<Results, EngineError> {
    const component = Shapes.componentOf(constraint);
    const shapePath = Predicate.isTagged(shape, 'PropertyShape')
      ? Option.some(shape.path)
      : Option.none<Path.Path>();
    const parameters = coreParameters(constraint);
    const result = (
      value: Option.Option<Term.GroundTerm>,
      extra: { readonly path?: Path.Path; readonly details?: Results } = {},
    ) => {
      const resultPath = extra.path === undefined ? shapePath : Option.some(extra.path);
      return ValidationReport.makeResult({
        focusNode: focus,
        sourceShape: shape.id,
        sourceConstraintComponent: component,
        severity: shape.severity,
        resultPath,
        value,
        messages: Arr.isReadonlyArrayNonEmpty(shape.messages)
          ? substituteMessages(shape.messages, (name) =>
              Option.getOrElse(builtinVariable(name, focus, value, resultPath), () =>
                parameterNamed(parameters, name),
              ),
            )
          : [Term.literal(defaultMessage(constraint, value))],
        details: withDetails ? (extra.details ?? []) : [],
      });
    };
    const each = (failed: (v: Term.GroundTerm) => boolean): Results =>
      valueNodes.filter(failed).map((v) => result(Option.some(v)));
    const logical = (members: ReadonlyArray<Shapes.ShapeId>, fails: LogicalTest) =>
      Effect.map(
        Effect.forEach(
          valueNodes,
          (v) =>
            Effect.map(
              Effect.forEach(members, (s) => nestedResults(s, v), { concurrency: 1 }),
              (nested) => {
                const conforming = nested.filter((rs) => Arr.isReadonlyArrayEmpty(rs)).length;
                return fails(conforming, members.length)
                  ? [result(Option.some(v), { details: nested.flat() })]
                  : [];
              },
            ),
          { concurrency: 1 },
        ),
        (perNode) => perNode.flat(),
      );
    // A value node counts when it conforms to the qualified shape and, with
    // `sh:qualifiedValueShapesDisjoint`, to none of the sibling shapes.
    const qualifiedCount = (c: {
      readonly shape: Shapes.ShapeId;
      readonly disjoint: boolean;
      readonly siblings: ReadonlyArray<Shapes.ShapeId>;
    }) =>
      Effect.map(
        Effect.filter(valueNodes, (v) =>
          Effect.flatMap(conforms(c.shape, v), (ok) =>
            !ok || !c.disjoint
              ? Effect.succeed(ok)
              : Effect.map(
                  Effect.findFirst(c.siblings, (s) => conforms(s, v)),
                  Option.isNone,
                ),
          ),
        ),
        (counted) => counted.length,
      );
    const lessThan = (predicate: Term.NamedNode, ok: (sign: Sign) => boolean) =>
      Effect.sync(() => {
        const others = objectsOf(focus, predicate);
        return Arr.flatMap(valueNodes, (v) =>
          Arr.map(
            Arr.filter(others, (o) => !ordered(v, o, ok)),
            () => result(Option.some(v)),
          ),
        );
      });

    return yield* Match.value(constraint)
      .pipe(
        Match.tag('Class', (c) => Effect.sync(() => each((v) => !isInstanceOf(v, c.class)))),
        Match.tag('Datatype', (c) => Effect.sync(() => each((v) => !hasDatatype(v, c.datatype)))),
        Match.tag('NodeKind', (c) =>
          Effect.sync(() => each((v) => !matchesNodeKind(v, c.nodeKind))),
        ),
        Match.tag('MinCount', (c) =>
          Effect.sync(() => (valueNodes.length < c.minCount ? [result(noValue)] : [])),
        ),
        Match.tag('MaxCount', (c) =>
          Effect.sync(() => (valueNodes.length > c.maxCount ? [result(noValue)] : [])),
        ),
        Match.tag('MinExclusive', (c) =>
          Effect.sync(() => each((v) => !ordered(v, c.value, (s) => s === 1))),
        ),
        Match.tag('MinInclusive', (c) =>
          Effect.sync(() => each((v) => !ordered(v, c.value, (s) => s !== -1))),
        ),
        Match.tag('MaxExclusive', (c) =>
          Effect.sync(() => each((v) => !ordered(v, c.value, (s) => s === -1))),
        ),
        Match.tag('MaxInclusive', (c) =>
          Effect.sync(() => each((v) => !ordered(v, c.value, (s) => s !== 1))),
        ),
        Match.tag('MinLength', (c) =>
          Effect.sync(() => each((v) => failsString(v, (s) => codePointLength(s) >= c.minLength))),
        ),
        Match.tag('MaxLength', (c) =>
          Effect.sync(() => each((v) => failsString(v, (s) => codePointLength(s) <= c.maxLength))),
        ),
        Match.tag('Pattern', (c) =>
          Effect.sync(() => each((v) => failsString(v, (s) => c.test(s)))),
        ),
        Match.tag('LanguageIn', (c) =>
          Effect.sync(() =>
            each(
              (v) =>
                !Term.isLiteral(v) || !c.languages.some((range) => langMatches(v.language, range)),
            ),
          ),
        ),
        Match.tag('UniqueLang', () =>
          Effect.sync(() => {
            const languages = Arr.flatMap(valueNodes, (v) =>
              Term.isLiteral(v) && v.language !== '' ? [v.language.toLowerCase()] : [],
            );
            return Arr.map(
              Arr.filter(Record.values(Arr.groupBy(languages, identity)), (g) => g.length > 1),
              () => result(noValue),
            );
          }),
        ),
        Match.tag('Equals', (c) =>
          Effect.sync(() => {
            const others = objectsOf(focus, c.predicate);
            const otherKeys = keysOf(others);
            const valueKeys = keysOf(valueNodes);
            return [
              ...valueNodes
                .filter((v) => !MutableHashSet.has(otherKeys, v.key))
                .map((v) => result(Option.some(v))),
              ...others
                .filter((o) => !MutableHashSet.has(valueKeys, o.key))
                .map((o) => result(Option.some(o))),
            ];
          }),
        ),
        Match.tag('Disjoint', (c) =>
          Effect.sync(() => {
            const otherKeys = keysOf(objectsOf(focus, c.predicate));
            return each((v) => MutableHashSet.has(otherKeys, v.key));
          }),
        ),
        Match.tag('LessThan', (c) => lessThan(c.predicate, (s) => s === -1)),
        Match.tag('LessThanOrEquals', (c) => lessThan(c.predicate, (s) => s !== 1)),
        Match.tag('Not', (c) =>
          Effect.gen(function* () {
            const conforming = yield* Effect.filter(valueNodes, (v) => conforms(c.shape, v));
            return conforming.map((v) => result(Option.some(v)));
          }),
        ),
      )
      .pipe(
        Match.tag('And', (c) => logical(c.shapes, andFails)),
        Match.tag('Or', (c) => logical(c.shapes, orFails)),
        Match.tag('Xone', (c) => logical(c.shapes, xoneFails)),
        Match.tag('Node', (c) =>
          Effect.gen(function* () {
            const nested = c.shape;
            const perNode = yield* Effect.forEach(
              valueNodes,
              (v) =>
                Effect.map(nestedResults(nested, v), (rs) =>
                  Arr.isReadonlyArrayNonEmpty(rs) ? [result(Option.some(v), { details: rs })] : [],
                ),
              { concurrency: 1 },
            );
            return perNode.flat();
          }),
        ),
        Match.tag('Property', (c) =>
          Effect.gen(function* () {
            const property = shapeById(c.shape);
            const perNode = yield* Effect.forEach(valueNodes, (v) => validateShape(property, v), {
              concurrency: 1,
            });
            return perNode.flat();
          }),
        ),
        Match.tag('QualifiedMinCount', (c) =>
          Effect.map(qualifiedCount(c), (count) => (count < c.count ? [result(noValue)] : [])),
        ),
        Match.tag('QualifiedMaxCount', (c) =>
          Effect.map(qualifiedCount(c), (count) => (count > c.count ? [result(noValue)] : [])),
        ),
        Match.tag('Closed', (c) =>
          Effect.sync(() => {
            const allowed = keysOf(c.allowedProperties);
            return Arr.flatMap(valueNodes, (v) =>
              Term.isLiteral(v)
                ? []
                : Arr.flatMap(Dataset.match(data, { subject: v }), (q) =>
                    MutableHashSet.has(allowed, q.predicate.key)
                      ? []
                      : [result(Option.some(q.object), { path: Path.predicate(q.predicate) })],
                  ),
            );
          }),
        ),
        Match.tag('HasValue', (c) =>
          Effect.sync(() =>
            valueNodes.some((v) => v.key === c.value.key) ? [] : [result(noValue)],
          ),
        ),
        Match.tag('In', (c) =>
          Effect.sync(() => {
            const allowed = keysOf(c.values);
            return each((v) => !MutableHashSet.has(allowed, v.key));
          }),
        ),
        Match.tag('Sparql', 'Component', (c) =>
          Effect.gen(function* () {
            if (Option.isNone(evaluator)) {
              return yield* unsupported(
                shape,
                Predicate.isTagged(c, 'Sparql')
                  ? 'sh:sparql'
                  : `constraint component ${c.component.key}`,
              );
            }
            const violations = yield* evaluator.value.evaluateConstraint({
              dataGraph: data,
              shapesGraph: shapes,
              shape,
              constraint: c,
              focusNode: focus,
              valueNodes,
            });
            return violations.map((violation) => {
              const focusNode = violation.focusNode ?? focus;
              const value = Option.fromNullishOr(violation.value);
              const resultPath =
                violation.path !== undefined ? Option.some(violation.path) : shapePath;
              const lookup = (name: string): Option.Option<Term.Term> =>
                pipe(
                  Option.flatMap(Option.fromNullishOr(violation.bindings), (b) =>
                    HashMap.get(b, name),
                  ),
                  Option.orElse(() => parameterNamed(parameters, name)),
                  Option.orElse(() =>
                    Option.flatten(builtinVariable(name, focusNode, value, resultPath)),
                  ),
                );
              const templates =
                violation.messages !== undefined && Arr.isReadonlyArrayNonEmpty(violation.messages)
                  ? violation.messages
                  : shape.messages;
              return ValidationReport.makeResult({
                focusNode,
                sourceShape: shape.id,
                sourceConstraintComponent: component,
                sourceConstraint: Predicate.isTagged(c, 'Sparql')
                  ? Option.some(c.node)
                  : Option.none(),
                severity: violation.severity ?? shape.severity,
                resultPath,
                value,
                messages: Arr.isReadonlyArrayNonEmpty(templates)
                  ? substituteMessages(templates, lookup)
                  : [Term.literal(defaultMessage(c, value))],
              });
            });
          }),
        ),
        Match.exhaustive,
      );
  });

  const focusNodes = Effect.fnUntraced(function* (
    shape: Shapes.Shape,
  ): Effect.fn.Return<ReadonlyArray<Term.GroundTerm>, EngineError> {
    const out: Nodes = MutableHashMap.empty();
    const add = addNew(out);
    yield* Effect.forEach(
      shape.targets,
      Effect.fnUntraced(function* (target) {
        yield* Match.value(target).pipe(
          Match.tag('TargetNode', (t) => Effect.sync(() => add(t.node))),
          Match.tag('TargetClass', (t) =>
            Effect.sync(() => Arr.forEach(instancesOf(t.class), add)),
          ),
          Match.tag('TargetSubjectsOf', (t) =>
            Effect.sync(() =>
              Arr.forEach(Dataset.match(data, { predicate: t.predicate }), (q) => add(q.subject)),
            ),
          ),
          Match.tag('TargetObjectsOf', (t) =>
            Effect.sync(() =>
              Arr.forEach(Dataset.match(data, { predicate: t.predicate }), (q) => add(q.object)),
            ),
          ),
          Match.tag('SparqlTarget', (t) =>
            Option.match(evaluator, {
              onNone: () => unsupported(shape, 'sh:target'),
              onSome: (ev) =>
                Effect.map(
                  ev.selectTargets({ dataGraph: data, shapesGraph: shapes, shape, target: t.node }),
                  (nodes) => Arr.forEach(nodes, add),
                ),
            }),
          ),
          Match.exhaustive,
        );
      }),
      { concurrency: 1, discard: true },
    );
    return valuesOf(out);
  });

  return { validateShape, focusNodes };
};

const resolveShapes = (
  shapes: Dataset.Dataset | Shapes.ShapesGraph,
): Effect.Effect<Shapes.ShapesGraph, Shapes.ShapesGraphError> =>
  Shapes.isShapesGraph(shapes) ? Effect.succeed(shapes) : Shapes.parse(shapes);

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

/** Parses the shapes graph (if needed) and builds the engine over the data graph. */
const prepare = Effect.fnUntraced(function* (
  dataGraph: Dataset.Dataset,
  shapesGraph: Dataset.Dataset | Shapes.ShapesGraph,
  options: ValidateOptions,
) {
  const shapes = yield* resolveShapes(shapesGraph);
  const data =
    options.includeShapesGraph === true ? Dataset.union(dataGraph, shapes.dataset) : dataGraph;
  const evaluator = yield* Effect.serviceOption(Sparql.SparqlConstraintEvaluator);
  return { shapes, engine: makeEngine(data, shapes, options, evaluator) };
});

/**
 * Validates a data graph against a shapes graph (either an RDF dataset, which
 * is parsed first, or a pre-parsed `Shapes.ShapesGraph`).
 *
 * SPARQL-based constraints and targets are delegated to a
 * `Sparql.SparqlConstraintEvaluator` when one is present in the context.
 *
 * @since 0.1.0
 * @category validation
 */
export const validate: (
  dataGraph: Dataset.Dataset,
  shapesGraph: Dataset.Dataset | Shapes.ShapesGraph,
  options?: ValidateOptions,
) => Effect.Effect<ValidationReport.ValidationReport, ValidationError> = Effect.fn(
  'Shacl.validate',
)(function* (dataGraph, shapesGraph, options = {}) {
  const { shapes, engine } = yield* prepare(dataGraph, shapesGraph, options);
  yield* Effect.annotateCurrentSpan({
    'shacl.shapes': shapes.shapes.length,
    'rdf.quads': dataGraph.size,
  });
  const perShape = yield* Effect.forEach(
    shapes.shapes,
    (shape) =>
      shape.deactivated || Arr.isReadonlyArrayEmpty(shape.targets)
        ? Effect.succeed<ReadonlyArray<ValidationReport.ValidationResult>>([])
        : Effect.flatMap(engine.focusNodes(shape), (foci) =>
            Effect.map(
              Effect.forEach(foci, (focus) => engine.validateShape(shape, focus), {
                concurrency: 1,
              }),
              (rs) => rs.flat(),
            ),
          ),
    { concurrency: 1 },
  );
  const report = ValidationReport.make(perShape.flat());
  yield* Effect.annotateCurrentSpan({
    'shacl.results': report.results.length,
    'shacl.conforms': report.conforms,
  });
  return report;
});

/**
 * Validates a single focus node against one shape of a shapes graph,
 * ignoring targets.
 *
 * @since 0.1.0
 * @category validation
 */
export const validateNode: (
  dataGraph: Dataset.Dataset,
  shapesGraph: Dataset.Dataset | Shapes.ShapesGraph,
  shape: Shapes.ShapeId,
  focusNode: Term.GroundTerm,
  options?: ValidateOptions,
) => Effect.Effect<ValidationReport.ValidationReport, ValidationError> = Effect.fnUntraced(
  function* (dataGraph, shapesGraph, shapeId, focusNode, options = {}) {
    const { shapes, engine } = yield* prepare(dataGraph, shapesGraph, options);
    const shape = Option.getOrUndefined(Shapes.get(shapes, shapeId));
    if (shape === undefined) return ValidationReport.make([]);
    return ValidationReport.make(yield* engine.validateShape(shape, focusNode));
  },
);

/**
 * Whether a data graph conforms to a shapes graph.
 *
 * @since 0.1.0
 * @category validation
 */
export const conforms = (
  dataGraph: Dataset.Dataset,
  shapesGraph: Dataset.Dataset | Shapes.ShapesGraph,
  options?: ValidateOptions,
): Effect.Effect<boolean, ValidationError> =>
  Effect.map(validate(dataGraph, shapesGraph, options), (r) => r.conforms);

/**
 * Validates and fails with a `ConformanceError` (carrying the report) when
 * the data graph does not conform; succeeds with the data graph otherwise.
 *
 * @since 0.1.0
 * @category validation
 */
export const assertConforms = (
  dataGraph: Dataset.Dataset,
  shapesGraph: Dataset.Dataset | Shapes.ShapesGraph,
  options?: ValidateOptions,
): Effect.Effect<Dataset.Dataset, ValidationError | ConformanceError> =>
  Effect.flatMap(validate(dataGraph, shapesGraph, options), (report) =>
    report.conforms
      ? Effect.succeed(dataGraph)
      : Effect.fail(new ConformanceError({ message: ValidationReport.format(report), report })),
  );

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

/**
 * A validator bound to a pre-compiled shapes graph.
 *
 * @since 0.1.0
 * @category services
 */
export class Validator extends Context.Service<
  Validator,
  {
    /** The compiled shapes graph. */
    readonly shapesGraph: Shapes.ShapesGraph;
    /** Validates a data graph, producing a report. */
    readonly validate: (
      dataGraph: Dataset.Dataset,
      options?: ValidateOptions,
    ) => Effect.Effect<ValidationReport.ValidationReport, ValidationError>;
    /** Whether a data graph conforms. */
    readonly conforms: (
      dataGraph: Dataset.Dataset,
      options?: ValidateOptions,
    ) => Effect.Effect<boolean, ValidationError>;
    /** Succeeds with the data graph if it conforms, failing with a `ConformanceError` otherwise. */
    readonly check: (
      dataGraph: Dataset.Dataset,
      options?: ValidateOptions,
    ) => Effect.Effect<Dataset.Dataset, ValidationError | ConformanceError>;
  }
>()('@thomasfosterau/effect-rdf/shacl/Validator') {}

/**
 * Compiles a shapes graph into a `Validator` service implementation. The
 * given options are defaults that individual calls may override.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: (
  shapesGraph: Dataset.Dataset | Shapes.ShapesGraph,
  defaults?: ValidateOptions,
) => Effect.Effect<Validator['Service'], Shapes.ShapesGraphError> = Effect.fnUntraced(function* (
  shapesGraph,
  defaults = {},
) {
  const compiled = yield* resolveShapes(shapesGraph);
  const merge = (options?: ValidateOptions) => ({ ...defaults, ...options });
  return Validator.of({
    shapesGraph: compiled,
    validate: (data, options) => validate(data, compiled, merge(options)),
    conforms: (data, options) => conforms(data, compiled, merge(options)),
    check: (data, options) => assertConforms(data, compiled, merge(options)),
  });
});

/**
 * A layer providing a `Validator` for the given shapes graph.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  shapesGraph: Dataset.Dataset | Shapes.ShapesGraph,
  defaults?: ValidateOptions,
): Layer.Layer<Validator, Shapes.ShapesGraphError> =>
  Layer.effect(Validator, make(shapesGraph, defaults));

// -----------------------------------------------------------------------------
// Schema integration
// -----------------------------------------------------------------------------

/**
 * Options for `schema`: validation options plus the severity that fails
 * decoding.
 *
 * @since 0.1.0
 * @category schemas
 */
export interface SchemaOptions extends ValidateOptions {
  /**
   * The least severe result that fails decoding: `"violation"` (default)
   * accepts data whose results are only `sh:Warning` or `sh:Info`,
   * `"warning"` also fails on warnings, and `"info"` on any result (the
   * report's own `conforms`, which is false whenever there is any result).
   * Results with a custom severity count as violations.
   */
  readonly failOn?: 'violation' | 'warning' | 'info' | undefined;
}

const severityRank = (severity: Term.NamedNode): number =>
  severity.value === sh.Info.value ? 0 : severity.value === sh.Warning.value ? 1 : 2;

const thresholdRank = { info: 0, warning: 1, violation: 2 } as const;

/**
 * A `Schema` that accepts a `Dataset` only if it conforms to the given shapes
 * graph. Decoding fails with a `SchemaIssue.Composite` holding one
 * `InvalidValue` issue per failing result: its `message` annotation is the
 * formatted result (`ValidationReport.formatResult`) and its `result`
 * annotation the `ValidationResult` itself, for consumers that inspect
 * failures (focus node, path, constraint component, severity, messages). By
 * default only `sh:Violation` results fail (see `SchemaOptions.failOn`).
 * Encoding is the identity.
 *
 * Compose it with a syntax codec to parse and validate in one decode:
 * `Turtle.codec.schema.pipe(Schema.decodeTo(Validator.schema(shapes)))`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const schema = (
  shapesGraph: Shapes.ShapesGraph,
  options?: SchemaOptions,
): Schema.decodeTo<Schema.declare<Dataset.Dataset>, Schema.declare<Dataset.Dataset>> => {
  const threshold = thresholdRank[options?.failOn ?? 'violation'];
  return Dataset.DatasetSchema.pipe(
    Schema.decodeTo(
      Dataset.DatasetSchema,
      SchemaTransformation.transformEffect({
        decode: (data: Dataset.Dataset, parseOptions) =>
          validate(data, shapesGraph, options).pipe(
            Effect.mapError(
              (e) => new SchemaIssue.InvalidValue({ message: e.message }, data, parseOptions),
            ),
            Effect.flatMap((report) =>
              Arr.match(
                Arr.filter(report.results, (r) => severityRank(r.severity) >= threshold),
                {
                  onEmpty: () => Effect.succeed(data),
                  onNonEmpty: (failing) =>
                    Effect.fail(
                      new SchemaIssue.Composite(
                        Dataset.DatasetSchema.ast,
                        Arr.map(
                          failing,
                          (r) =>
                            new SchemaIssue.InvalidValue(
                              { message: ValidationReport.formatResult(r), result: r },
                              r,
                              parseOptions,
                            ),
                        ),
                        data,
                      ),
                    ),
                },
              ),
            ),
          ),
        encode: (data: Dataset.Dataset) => Effect.succeed(data),
      }),
    ),
  );
};

/**
 * The SHACL `sh:Violation`, `sh:Warning` and `sh:Info` severities.
 *
 * @since 0.1.0
 * @category constants
 */
export const severities = {
  Violation: sh.Violation,
  Warning: sh.Warning,
  Info: sh.Info,
} as const;
