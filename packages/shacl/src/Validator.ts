/**
 * SHACL Core validation (§3–§4): validates a data graph against a shapes
 * graph and produces a `ValidationReport`.
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Validator, ValidationReport } from "@thomasfosterau/effect-shacl"
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
import { Dataset, Term, Vocab, Xsd } from '@thomasfosterau/effect-rdf';
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
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

const nodeKindOf = (t: Term.Term): 'IRI' | 'BlankNode' | 'Literal' | undefined =>
  t._tag === 'NamedNode'
    ? 'IRI'
    : t._tag === 'BlankNode'
      ? 'BlankNode'
      : t._tag === 'Literal'
        ? 'Literal'
        : undefined;

const matchesNodeKind = (t: Term.Term, kind: Shapes.NodeKind): boolean => {
  const k = nodeKindOf(t);
  return k !== undefined && kind.includes(k);
};

const hasDatatype = (v: Term.Term, datatype: Term.NamedNode): boolean => {
  if (v._tag !== 'Literal' || v.datatype.value !== datatype.value) return false;
  if (datatype.value === rdf.langString.value || datatype.value === rdf.dirLangString.value)
    return v.language !== '';
  if (v.language !== '') return false;
  return Xsd.isWellFormed(v);
};

const stringValue = (v: Term.Term): string | undefined =>
  v._tag === 'NamedNode' || v._tag === 'Literal' ? v.value : undefined;

const show = (t: Term.Term) => t.key;

/** The length of a string in Unicode code points (as XPath `fn:string-length`). */
const codePointLength = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i++;
    n++;
  }
  return n;
};

const defaultMessage = (c: Shapes.Constraint, value: Term.Term | undefined): string => {
  const v = value === undefined ? 'Value' : `Value ${show(value)}`;
  return Match.value(c)
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
          `Predicate is not allowed by the closed shape (value ${value === undefined ? '' : show(value)})`,
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
const coreParameters = (c: Shapes.Constraint): ReadonlyArray<readonly [string, Term.Term]> => {
  return Match.value(c)
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
  path._tag === 'PredicatePath' ? path.predicate : Term.literal(Path.toSparql(path));

/** Substitutes `{?var}` / `{$var}` placeholders of result messages. */
const substituteMessages = (
  messages: ReadonlyArray<Term.Literal>,
  lookup: (name: string) => Term.Term | undefined,
): ReadonlyArray<Term.Literal> => messages.map((m) => Message.substitute(m, lookup));

interface Engine {
  readonly validateShape: (
    shape: Shapes.Shape,
    focus: Term.GroundTerm,
  ) => Effect.Effect<Results, EngineError>;
  readonly focusNodes: (
    shape: Shapes.Shape,
  ) => Effect.Effect<ReadonlyArray<Term.GroundTerm>, EngineError>;
}

const makeEngine = (
  data: Dataset.Dataset,
  shapes: Shapes.ShapesGraph,
  options: ValidateOptions,
  evaluator: Option.Option<Sparql.SparqlConstraintEvaluator['Service']>,
): Engine => {
  const memo = new Map<string, Results>();
  const active = new Set<string>();
  const superClassCache = new Map<string, ReadonlySet<string>>();
  const withDetails = options.details === true;

  // -- RDFS reasoning (SHACL instances / SHACL types, §1.5) ------------------
  const superClassesOf = (cls: Term.GroundTerm): ReadonlySet<string> => {
    const cached = superClassCache.get(cls.key);
    if (cached !== undefined) return cached;
    const seen = new Set<string>([cls.key]);
    const stack: Array<Term.GroundTerm> = [cls];
    while (Arr.isReadonlyArrayNonEmpty(stack)) {
      const c = stack.pop()!;
      if (c._tag === 'Literal') continue;
      for (const sup of Dataset.objectsOf(data, c, rdfs.subClassOf)) {
        if (!seen.has(sup.key)) {
          seen.add(sup.key);
          stack.push(sup);
        }
      }
    }
    superClassCache.set(cls.key, seen);
    return seen;
  };
  const isInstanceOf = (node: Term.GroundTerm, cls: Term.Term): boolean =>
    node._tag !== 'Literal' &&
    Dataset.objectsOf(data, node, rdf.type).some((t) => superClassesOf(t).has(cls.key));
  const instancesOf = (cls: Term.Resource): ReadonlyArray<Term.GroundTerm> => {
    const out = new Map<string, Term.GroundTerm>();
    for (const q of Dataset.match(data, { predicate: rdf.type })) {
      if (!out.has(q.subject.key) && superClassesOf(q.object).has(cls.key))
        out.set(q.subject.key, q.subject);
    }
    return Array.from(out.values());
  };

  const objectsOf = (s: Term.GroundTerm, p: Term.NamedNode): ReadonlyArray<Term.GroundTerm> =>
    s._tag === 'Literal' ? [] : Dataset.objectsOf(data, s, p);

  // SAFETY: a shape id is an IRI or blank node, and only those index the shapes.
  const shapeById = (id: Term.Term): Shapes.Shape =>
    shapes.index.get(id.key) ?? {
      _tag: 'NodeShape',
      id: id as Shapes.ShapeId,
      targets: [],
      constraints: [],
      severity: sh.Violation,
      messages: [],
      deactivated: false,
    };

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

  const validateShape = (
    shape: Shapes.Shape,
    focus: Term.GroundTerm,
  ): Effect.Effect<Results, EngineError> =>
    Effect.suspend(() => {
      if (shape.deactivated) return Effect.succeed([]);
      const key = `${shape.id.key} ${focus.key}`;
      const cached = memo.get(key);
      if (cached !== undefined) return Effect.succeed(cached);
      if (active.has(key)) {
        return options.recursion === 'ignore'
          ? Effect.succeed([])
          : Effect.fail(
              new RecursiveShapeError({
                message: `shape ${shape.id.key} is recursive for focus node ${focus.key}`,
                shape: shape.id.key,
                focusNode: focus.key,
              }),
            );
      }
      active.add(key);
      const valueNodes =
        shape._tag === 'PropertyShape' ? Path.evaluate(data, focus, shape.path) : [focus];
      return Effect.forEach(shape.constraints, (c) => evaluate(shape, focus, valueNodes, c), {
        concurrency: 1,
      }).pipe(
        Effect.map((rs) => {
          const results = rs.flat();
          active.delete(key);
          memo.set(key, results);
          return results;
        }),
      );
    });

  const conforms = (id: Term.Term, node: Term.GroundTerm): Effect.Effect<boolean, EngineError> =>
    Effect.map(validateShape(shapeById(id), node), (rs) => Arr.isReadonlyArrayEmpty(rs));

  const evaluate = Effect.fnUntraced(function* (
    shape: Shapes.Shape,
    focus: Term.GroundTerm,
    valueNodes: ReadonlyArray<Term.GroundTerm>,
    c: Shapes.Constraint,
  ): Effect.fn.Return<Results, EngineError> {
    const component = Shapes.componentOf(c);
    const shapePath =
      shape._tag === 'PropertyShape' ? Option.some(shape.path) : Option.none<Path.Path>();
    const parameters = new Map(coreParameters(c));
    const result = (
      value: Term.GroundTerm | undefined,
      extra: { readonly path?: Path.Path; readonly details?: Results } = {},
    ) => {
      const resultPath = extra.path === undefined ? shapePath : Option.some(extra.path);
      return ValidationReport.makeResult({
        focusNode: focus,
        sourceShape: shape.id,
        sourceConstraintComponent: component,
        severity: shape.severity,
        resultPath,
        value: Option.fromNullishOr(value),
        messages: Arr.isReadonlyArrayNonEmpty(shape.messages)
          ? substituteMessages(shape.messages, (name) => {
              return Match.value(name).pipe(
                Match.when('this', () => focus),
                Match.when('value', () => value),
                Match.when('path', () =>
                  Option.isSome(resultPath) ? pathTerm(resultPath.value) : undefined,
                ),
                Match.orElse(() => parameters.get(name)),
              );
            })
          : [Term.literal(defaultMessage(c, value))],
        details: withDetails ? (extra.details ?? []) : [],
      });
    };
    const each = (failed: (v: Term.GroundTerm) => boolean): Results =>
      valueNodes.filter(failed).map((v) => result(v));
    const nestedResults = (id: Term.Term, v: Term.GroundTerm) => validateShape(shapeById(id), v);

    return yield* Match.value(c)
      .pipe(
        Match.tag('Class', (c) => Effect.sync(() => each((v) => !isInstanceOf(v, c.class)))),
        Match.tag('Datatype', (c) => Effect.sync(() => each((v) => !hasDatatype(v, c.datatype)))),
        Match.tag('NodeKind', (c) =>
          Effect.sync(() => each((v) => !matchesNodeKind(v, c.nodeKind))),
        ),
        Match.tag('MinCount', (c) =>
          Effect.sync(() => (valueNodes.length < c.minCount ? [result(undefined)] : [])),
        ),
        Match.tag('MaxCount', (c) =>
          Effect.sync(() => (valueNodes.length > c.maxCount ? [result(undefined)] : [])),
        ),
        Match.tag('MinExclusive', (c) =>
          Effect.sync(() => each((v) => compareTerms(v, c.value) !== 1)),
        ),
        Match.tag('MinInclusive', (c) =>
          Effect.sync(() =>
            each((v) => {
              const r = compareTerms(v, c.value);
              return r !== 1 && r !== 0;
            }),
          ),
        ),
        Match.tag('MaxExclusive', (c) =>
          Effect.sync(() => each((v) => compareTerms(v, c.value) !== -1)),
        ),
        Match.tag('MaxInclusive', (c) =>
          Effect.sync(() =>
            each((v) => {
              const r = compareTerms(v, c.value);
              return r !== -1 && r !== 0;
            }),
          ),
        ),
        Match.tag('MinLength', (c) =>
          Effect.sync(() =>
            each((v) => {
              const s = stringValue(v);
              return s === undefined || codePointLength(s) < c.minLength;
            }),
          ),
        ),
        Match.tag('MaxLength', (c) =>
          Effect.sync(() =>
            each((v) => {
              const s = stringValue(v);
              return s === undefined || codePointLength(s) > c.maxLength;
            }),
          ),
        ),
        Match.tag('Pattern', (c) =>
          Effect.sync(() =>
            each((v) => {
              const s = stringValue(v);
              return s === undefined || !c.regex.test(s);
            }),
          ),
        ),
        Match.tag('LanguageIn', (c) =>
          Effect.sync(() =>
            each(
              (v) =>
                v._tag !== 'Literal' ||
                !c.languages.some((range) => langMatches(v.language, range)),
            ),
          ),
        ),
        Match.tag('UniqueLang', () =>
          Effect.sync(() => {
            const counts = new Map<string, number>();
            for (const v of valueNodes) {
              if (v._tag === 'Literal' && v.language !== '') {
                const lang = v.language.toLowerCase();
                counts.set(lang, (counts.get(lang) ?? 0) + 1);
              }
            }
            return Array.from(counts.values())
              .filter((n) => n > 1)
              .map(() => result(undefined));
          }),
        ),
        Match.tag('Equals', (c) =>
          Effect.sync(() => {
            const others = objectsOf(focus, c.predicate);
            const otherKeys = new Set(others.map((o) => o.key));
            const valueKeys = new Set(valueNodes.map((v) => v.key));
            return [
              ...valueNodes.filter((v) => !otherKeys.has(v.key)).map((v) => result(v)),
              ...others.filter((o) => !valueKeys.has(o.key)).map((o) => result(o)),
            ];
          }),
        ),
        Match.tag('Disjoint', (c) =>
          Effect.sync(() => {
            const otherKeys = new Set(objectsOf(focus, c.predicate).map((o) => o.key));
            return each((v) => otherKeys.has(v.key));
          }),
        ),
        Match.tag('LessThan', 'LessThanOrEquals', (c) =>
          Effect.sync(() => {
            const others = objectsOf(focus, c.predicate);
            const ok = (r: -1 | 0 | 1 | undefined) =>
              r === -1 || (c._tag === 'LessThanOrEquals' && r === 0);
            const out: Array<ValidationReport.ValidationResult> = [];
            for (const v of valueNodes) {
              for (const o of others) {
                if (!ok(compareTerms(v, o))) out.push(result(v));
              }
            }
            return out;
          }),
        ),
        Match.tag('Not', (c) =>
          Effect.gen(function* () {
            const conforming = yield* Effect.filter(valueNodes, (v) => conforms(c.shape, v));
            return conforming.map((v) => result(v));
          }),
        ),
      )
      .pipe(
        Match.tag('And', 'Or', 'Xone', (c) =>
          Effect.gen(function* () {
            const shapes = c.shapes;
            const tag = c._tag;
            const perNode = yield* Effect.forEach(
              valueNodes,
              (v) =>
                Effect.map(
                  Effect.forEach(shapes, (s) => nestedResults(s, v), { concurrency: 1 }),
                  (nested) => {
                    const conforming = nested.filter((rs) => Arr.isReadonlyArrayEmpty(rs)).length;
                    const failed =
                      tag === 'And'
                        ? conforming < shapes.length
                        : tag === 'Or'
                          ? conforming === 0
                          : conforming !== 1;
                    return failed ? [result(v, { details: nested.flat() })] : [];
                  },
                ),
              { concurrency: 1 },
            );
            return perNode.flat();
          }),
        ),
        Match.tag('Node', (c) =>
          Effect.gen(function* () {
            const shape = c.shape;
            const perNode = yield* Effect.forEach(
              valueNodes,
              (v) =>
                Effect.map(nestedResults(shape, v), (rs) =>
                  Arr.isReadonlyArrayNonEmpty(rs) ? [result(v, { details: rs })] : [],
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
        Match.tag('QualifiedMinCount', 'QualifiedMaxCount', (c) =>
          Effect.gen(function* () {
            const { shape, disjoint, siblings } = c;
            // A value node counts when it conforms to the qualified shape and, with
            // `sh:qualifiedValueShapesDisjoint`, to none of the sibling shapes.
            const counted = yield* Effect.filter(valueNodes, (v) =>
              Effect.flatMap(conforms(shape, v), (ok) =>
                !ok || !disjoint
                  ? Effect.succeed(ok)
                  : Effect.map(
                      Effect.findFirst(siblings, (s) => conforms(s, v)),
                      Option.isNone,
                    ),
              ),
            );
            const count = counted.length;
            const failed = c._tag === 'QualifiedMinCount' ? count < c.count : count > c.count;
            return failed ? [result(undefined)] : [];
          }),
        ),
        Match.tag('Closed', (c) =>
          Effect.sync(() => {
            const allowed = new Set(c.allowedProperties.map((p) => p.key));
            const out: Array<ValidationReport.ValidationResult> = [];
            for (const v of valueNodes) {
              if (v._tag === 'Literal') continue;
              for (const q of Dataset.match(data, { subject: v })) {
                if (!allowed.has(q.predicate.key))
                  out.push(result(q.object, { path: Path.predicate(q.predicate) }));
              }
            }
            return out;
          }),
        ),
        Match.tag('HasValue', (c) =>
          Effect.sync(() =>
            valueNodes.some((v) => v.key === c.value.key) ? [] : [result(undefined)],
          ),
        ),
        Match.tag('In', (c) =>
          Effect.sync(() => {
            const allowed = new Set(c.values.map((v) => v.key));
            return each((v) => !allowed.has(v.key));
          }),
        ),
        Match.tag('Sparql', 'Component', (c) =>
          Effect.gen(function* () {
            if (Option.isNone(evaluator)) {
              return yield* unsupported(
                shape,
                c._tag === 'Sparql' ? 'sh:sparql' : `constraint component ${c.component.key}`,
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
              const resultPath =
                violation.path !== undefined ? Option.some(violation.path) : shapePath;
              const lookup = (name: string): Term.Term | undefined => {
                const bound = violation.bindings?.get(name) ?? parameters.get(name);
                if (bound !== undefined) return bound;
                return Match.value(name).pipe(
                  Match.when('this', () => focusNode),
                  Match.when('value', () => violation.value),
                  Match.when('path', () =>
                    Option.isSome(resultPath) ? pathTerm(resultPath.value) : undefined,
                  ),
                  Match.orElse(() => undefined),
                );
              };
              const templates =
                violation.messages !== undefined && Arr.isReadonlyArrayNonEmpty(violation.messages)
                  ? violation.messages
                  : shape.messages;
              return ValidationReport.makeResult({
                focusNode,
                sourceShape: shape.id,
                sourceConstraintComponent: component,
                sourceConstraint: c._tag === 'Sparql' ? Option.some(c.node) : Option.none(),
                severity: violation.severity ?? shape.severity,
                resultPath,
                value: Option.fromNullishOr(violation.value),
                messages: Arr.isReadonlyArrayNonEmpty(templates)
                  ? substituteMessages(templates, lookup)
                  : [Term.literal(defaultMessage(c, violation.value))],
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
    const out = new Map<string, Term.GroundTerm>();
    const add = (t: Term.GroundTerm) => {
      if (!out.has(t.key)) out.set(t.key, t);
    };
    yield* Effect.forEach(
      shape.targets,
      Effect.fnUntraced(function* (target) {
        yield* Match.value(target).pipe(
          Match.tag('TargetNode', (t) => Effect.sync(() => add(t.node))),
          Match.tag('TargetClass', (t) => Effect.sync(() => instancesOf(t.class).forEach(add))),
          Match.tag('TargetSubjectsOf', (t) =>
            Effect.sync(() => {
              for (const q of Dataset.match(data, { predicate: t.predicate })) add(q.subject);
            }),
          ),
          Match.tag('TargetObjectsOf', (t) =>
            Effect.sync(() => {
              for (const q of Dataset.match(data, { predicate: t.predicate })) add(q.object);
            }),
          ),
          Match.tag('SparqlTarget', (t) =>
            Option.match(evaluator, {
              onNone: () => unsupported(shape, 'sh:target'),
              onSome: (ev) =>
                Effect.map(
                  ev.selectTargets({ dataGraph: data, shapesGraph: shapes, shape, target: t.node }),
                  (nodes) => nodes.forEach(add),
                ),
            }),
          ),
          Match.exhaustive,
        );
      }),
      { concurrency: 1, discard: true },
    );
    return Array.from(out.values());
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
) => Effect.Effect<ValidationReport.ValidationReport, ValidationError> = Effect.fnUntraced(
  function* (dataGraph, shapesGraph, options = {}) {
    const { shapes, engine } = yield* prepare(dataGraph, shapesGraph, options);
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
    return ValidationReport.make(perShape.flat());
  },
);

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
>()('@thomasfosterau/effect-shacl/Validator') {}

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
  const merge = (options: ValidateOptions | undefined) => ({ ...defaults, ...options });
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
 * A `Schema` that accepts a `Dataset` only if it conforms to the given shapes
 * graph. Decoding fails with an `InvalidValue` issue whose message is the
 * formatted validation report; encoding is the identity.
 *
 * @since 0.1.0
 * @category schemas
 */
export const schema = (
  shapesGraph: Shapes.ShapesGraph,
  options?: ValidateOptions,
): Schema.decodeTo<Schema.declare<Dataset.Dataset>, Schema.declare<Dataset.Dataset>> =>
  Dataset.DatasetSchema.pipe(
    Schema.decodeTo(
      Dataset.DatasetSchema,
      SchemaTransformation.transformEffect({
        decode: (data: Dataset.Dataset) =>
          validate(data, shapesGraph, options).pipe(
            Effect.mapError((e) => new SchemaIssue.InvalidValue({ message: e.message }, data)),
            Effect.flatMap((report) =>
              report.conforms
                ? Effect.succeed(data)
                : Effect.fail(
                    new SchemaIssue.InvalidValue(
                      { message: ValidationReport.format(report) },
                      data,
                    ),
                  ),
            ),
          ),
        encode: (data: Dataset.Dataset) => Effect.succeed(data),
      }),
    ),
  );

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
