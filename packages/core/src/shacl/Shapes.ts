/**
 * Shapes graphs: parsing an RDF shapes graph into a typed, validated model of
 * node shapes and property shapes with their targets and constraints
 * (SHACL Core §2–§4, plus the SHACL-SPARQL constructs needed to delegate to a
 * `Sparql.SparqlConstraintEvaluator`).
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Shapes } from "@thomasfosterau/effect-rdf/shacl"
 *
 * const program = Effect.gen(function* () {
 *   const shapes = yield* Shapes.parse(shapesDataset)
 *   for (const shape of shapes.shapes) console.log(shape._tag, shape.id.key)
 * })
 * ```
 *
 * @since 0.1.0
 */
import { Dataset, Rdfs, Term, Vocab, Xsd } from '../index.ts';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Regex from '../internal/regex.ts';
import * as Path from './Path.ts';
import { SH, sh } from './Vocabulary.ts';

const { rdfs, xsd } = Vocab;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * The shapes graph is ill-formed (§3.4.1 "ill-formed shapes graph"), so it
 * cannot be used for validation.
 *
 * @since 0.1.0
 * @category errors
 */
export class ShapesGraphError extends Schema.TaggedError<
  ShapesGraphError,
  { readonly brand: unique symbol }
>()('ShapesGraphError', {
  message: Schema.String,
  /** The N-Triples form of the offending node, when known. */
  node: Schema.optional(Schema.String),
}) {}

// -----------------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------------

/**
 * The identifier of a shape: an IRI or a blank node of the shapes graph.
 *
 * @since 0.1.0
 * @category models
 */
export type ShapeId = Term.NamedNode | Term.BlankNode;

/**
 * A target declaration (§2.1.3).
 *
 * @since 0.1.0
 * @category models
 */
export type Target =
  | { readonly _tag: 'TargetNode'; readonly node: Term.GroundTerm }
  | { readonly _tag: 'TargetClass'; readonly class: Term.Resource; readonly implicit: boolean }
  | { readonly _tag: 'TargetSubjectsOf'; readonly predicate: Term.NamedNode }
  | { readonly _tag: 'TargetObjectsOf'; readonly predicate: Term.NamedNode }
  | {
      /** A SPARQL-based target or custom target type (`sh:target`). */
      readonly _tag: 'SparqlTarget';
      readonly node: Term.GroundTerm;
    };

/**
 * The node kinds of `sh:nodeKind`.
 *
 * @since 0.1.0
 * @category models
 */
export type NodeKind =
  | 'BlankNode'
  | 'IRI'
  | 'Literal'
  | 'BlankNodeOrIRI'
  | 'BlankNodeOrLiteral'
  | 'IRIOrLiteral';

/**
 * A constraint on a value node set, i.e. an instance of a constraint
 * component with its parameter values (§2.2, §4).
 *
 * @since 0.1.0
 * @category models
 */
export type Constraint =
  | { readonly _tag: 'Class'; readonly class: Term.Resource }
  | { readonly _tag: 'Datatype'; readonly datatype: Term.NamedNode }
  | { readonly _tag: 'NodeKind'; readonly nodeKind: NodeKind }
  | { readonly _tag: 'MinCount'; readonly minCount: number }
  | { readonly _tag: 'MaxCount'; readonly maxCount: number }
  | { readonly _tag: 'MinExclusive'; readonly value: Term.GroundTerm }
  | { readonly _tag: 'MinInclusive'; readonly value: Term.GroundTerm }
  | { readonly _tag: 'MaxExclusive'; readonly value: Term.GroundTerm }
  | { readonly _tag: 'MaxInclusive'; readonly value: Term.GroundTerm }
  | { readonly _tag: 'MinLength'; readonly minLength: number }
  | { readonly _tag: 'MaxLength'; readonly maxLength: number }
  | {
      readonly _tag: 'Pattern';
      readonly pattern: string;
      readonly flags: string;
      /** Whether a string matches the pattern (in time linear in its length). */
      readonly test: (value: string) => boolean;
    }
  | { readonly _tag: 'LanguageIn'; readonly languages: ReadonlyArray<string> }
  | { readonly _tag: 'UniqueLang' }
  | { readonly _tag: 'Equals'; readonly predicate: Term.NamedNode }
  | { readonly _tag: 'Disjoint'; readonly predicate: Term.NamedNode }
  | { readonly _tag: 'LessThan'; readonly predicate: Term.NamedNode }
  | { readonly _tag: 'LessThanOrEquals'; readonly predicate: Term.NamedNode }
  | { readonly _tag: 'Not'; readonly shape: ShapeId }
  | { readonly _tag: 'And'; readonly shapes: ReadonlyArray<ShapeId> }
  | { readonly _tag: 'Or'; readonly shapes: ReadonlyArray<ShapeId> }
  | { readonly _tag: 'Xone'; readonly shapes: ReadonlyArray<ShapeId> }
  | { readonly _tag: 'Node'; readonly shape: ShapeId }
  | { readonly _tag: 'Property'; readonly shape: ShapeId }
  | {
      readonly _tag: 'QualifiedMinCount';
      readonly shape: ShapeId;
      readonly count: number;
      readonly disjoint: boolean;
      /** Sibling qualified value shapes (only used when `disjoint`). */
      readonly siblings: ReadonlyArray<ShapeId>;
    }
  | {
      readonly _tag: 'QualifiedMaxCount';
      readonly shape: ShapeId;
      readonly count: number;
      readonly disjoint: boolean;
      readonly siblings: ReadonlyArray<ShapeId>;
    }
  | {
      readonly _tag: 'Closed';
      readonly ignoredProperties: ReadonlyArray<Term.NamedNode>;
      /** Predicates allowed by `sh:property` predicate paths and `sh:ignoredProperties`. */
      readonly allowedProperties: ReadonlyArray<Term.NamedNode>;
    }
  | { readonly _tag: 'HasValue'; readonly value: Term.GroundTerm }
  | { readonly _tag: 'In'; readonly values: ReadonlyArray<Term.GroundTerm> }
  | SparqlConstraint
  | ComponentConstraint;

/**
 * A SHACL-SPARQL constraint (`sh:sparql`), evaluated by a
 * `Sparql.SparqlConstraintEvaluator`.
 *
 * @since 0.1.0
 * @category models
 */
export interface SparqlConstraint {
  readonly _tag: 'Sparql';
  /** The `sh:SPARQLConstraint` node in the shapes graph. */
  readonly node: Term.NamedNode | Term.BlankNode;
}

/**
 * An instance of a custom (SPARQL-based) constraint component declared in the
 * shapes graph, evaluated by a `Sparql.SparqlConstraintEvaluator`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ComponentConstraint {
  readonly _tag: 'Component';
  readonly component: Term.NamedNode | Term.BlankNode;
  /** The parameter bindings of this constraint, keyed by parameter path. */
  readonly parameters: ReadonlyArray<{
    readonly path: Term.NamedNode;
    readonly value: Term.GroundTerm;
  }>;
}

/**
 * The tags of all constraint kinds.
 *
 * @since 0.1.0
 * @category models
 */
export type ConstraintTag = Constraint['_tag'];

interface ShapeBase {
  readonly id: ShapeId;
  readonly targets: ReadonlyArray<Target>;
  readonly constraints: ReadonlyArray<Constraint>;
  /** `sh:severity`, defaulting to `sh:Violation`. */
  readonly severity: Term.NamedNode;
  /** `sh:message` values. */
  readonly messages: ReadonlyArray<Term.Literal>;
  /** `sh:deactivated true`. */
  readonly deactivated: boolean;
}

/**
 * A node shape (§2.2): its constraints apply to the focus node itself.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeShape extends ShapeBase {
  readonly _tag: 'NodeShape';
}

/**
 * A property shape (§2.3): its constraints apply to the values reachable
 * from the focus node via `path`.
 *
 * @since 0.1.0
 * @category models
 */
export interface PropertyShape extends ShapeBase {
  readonly _tag: 'PropertyShape';
  readonly path: Path.Path;
}

/**
 * @since 0.1.0
 * @category models
 */
export type Shape = NodeShape | PropertyShape;

/**
 * A parsed shapes graph.
 *
 * @since 0.1.0
 * @category models
 */
export interface ShapesGraph {
  readonly _tag: 'ShapesGraph';
  /** The RDF shapes graph this model was parsed from. */
  readonly dataset: Dataset.Dataset;
  /** Every shape of the shapes graph, in a deterministic order. */
  readonly shapes: ReadonlyArray<Shape>;
  /** Shapes indexed by the N-Triples form of their identifier. */
  readonly index: ReadonlyMap<string, Shape>;
}

// -----------------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category guards
 */
export const isShapesGraph = (u: unknown): u is ShapesGraph => Predicate.isTagged(u, 'ShapesGraph');

/**
 * Looks up a shape by its identifier.
 *
 * @since 0.1.0
 * @category accessors
 */
export const get = (self: ShapesGraph, id: Term.Term): Option.Option<Shape> =>
  Option.fromNullishOr(self.index.get(id.key));

/**
 * The shapes that declare at least one target and are not deactivated.
 *
 * @since 0.1.0
 * @category accessors
 */
export const targetedShapes = (self: ShapesGraph): ReadonlyArray<Shape> =>
  self.shapes.filter((s) => !s.deactivated && Arr.isReadonlyArrayNonEmpty(s.targets));

/**
 * Whether the shapes graph uses SHACL-SPARQL features (SPARQL constraints,
 * SPARQL-based constraint components or SPARQL-based targets).
 *
 * @since 0.1.0
 * @category accessors
 */
export const usesSparql = (self: ShapesGraph): boolean =>
  self.shapes.some(
    (s) =>
      s.targets.some(Predicate.isTagged('SparqlTarget')) ||
      s.constraints.some(
        (c) => Predicate.isTagged(c, 'Sparql') || Predicate.isTagged(c, 'Component'),
      ),
  );

const componentNames: Record.ReadonlyRecord<
  Exclude<ConstraintTag, 'Sparql' | 'Component'>,
  string
> = {
  Class: 'ClassConstraintComponent',
  Datatype: 'DatatypeConstraintComponent',
  NodeKind: 'NodeKindConstraintComponent',
  MinCount: 'MinCountConstraintComponent',
  MaxCount: 'MaxCountConstraintComponent',
  MinExclusive: 'MinExclusiveConstraintComponent',
  MinInclusive: 'MinInclusiveConstraintComponent',
  MaxExclusive: 'MaxExclusiveConstraintComponent',
  MaxInclusive: 'MaxInclusiveConstraintComponent',
  MinLength: 'MinLengthConstraintComponent',
  MaxLength: 'MaxLengthConstraintComponent',
  Pattern: 'PatternConstraintComponent',
  LanguageIn: 'LanguageInConstraintComponent',
  UniqueLang: 'UniqueLangConstraintComponent',
  Equals: 'EqualsConstraintComponent',
  Disjoint: 'DisjointConstraintComponent',
  LessThan: 'LessThanConstraintComponent',
  LessThanOrEquals: 'LessThanOrEqualsConstraintComponent',
  Not: 'NotConstraintComponent',
  And: 'AndConstraintComponent',
  Or: 'OrConstraintComponent',
  Xone: 'XoneConstraintComponent',
  Node: 'NodeConstraintComponent',
  Property: 'PropertyConstraintComponent',
  QualifiedMinCount: 'QualifiedMinCountConstraintComponent',
  QualifiedMaxCount: 'QualifiedMaxCountConstraintComponent',
  Closed: 'ClosedConstraintComponent',
  HasValue: 'HasValueConstraintComponent',
  In: 'InConstraintComponent',
};

/**
 * The constraint component IRI of a constraint (e.g.
 * `sh:MinCountConstraintComponent`).
 *
 * @since 0.1.0
 * @category accessors
 */
export const componentOf = (constraint: Constraint): Term.NamedNode | Term.BlankNode => {
  return Match.value(constraint).pipe(
    Match.tag('Sparql', () => sh.SPARQLConstraintComponent),
    Match.tag('Component', (custom) => custom.component),
    Match.orElse((core) => Term.namedNode(SH + componentNames[core._tag])),
  );
};

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

class ParseFailure {
  readonly message: string;
  readonly node: Option.Option<Term.Term>;
  constructor(message: string, node: Option.Option<Term.Term>) {
    this.message = message;
    this.node = node;
  }
}

const TRUE = Term.literal('true', xsd.boolean).key;

const nodeKinds: Record.ReadonlyRecord<string, NodeKind> = Record.fromEntries(
  Arr.map(
    [
      'BlankNode',
      'IRI',
      'Literal',
      'BlankNodeOrIRI',
      'BlankNodeOrLiteral',
      'IRIOrLiteral',
    ] as const,
    (k) => [SH + k, k] as const,
  ),
);

/** Parameters of the core constraint components (§4). */
const coreParameters: ReadonlyArray<Term.NamedNode> = [
  sh.class,
  sh.datatype,
  sh.nodeKind,
  sh.minCount,
  sh.maxCount,
  sh.minExclusive,
  sh.minInclusive,
  sh.maxExclusive,
  sh.maxInclusive,
  sh.minLength,
  sh.maxLength,
  sh.pattern,
  sh.flags,
  sh.languageIn,
  sh.uniqueLang,
  sh.equals,
  sh.disjoint,
  sh.lessThan,
  sh.lessThanOrEquals,
  sh.not,
  sh.and,
  sh.or,
  sh.xone,
  sh.node,
  sh.property,
  sh.qualifiedValueShape,
  sh.qualifiedValueShapesDisjoint,
  sh.qualifiedMinCount,
  sh.qualifiedMaxCount,
  sh.closed,
  sh.ignoredProperties,
  sh.hasValue,
  sh.in,
  sh.sparql,
];

const targetPredicates: ReadonlyArray<Term.NamedNode> = [
  sh.targetNode,
  sh.targetClass,
  sh.targetSubjectsOf,
  sh.targetObjectsOf,
  sh.target,
];

const rangeParameters = [
  [sh.minExclusive, 'MinExclusive'],
  [sh.minInclusive, 'MinInclusive'],
  [sh.maxExclusive, 'MaxExclusive'],
  [sh.maxInclusive, 'MaxInclusive'],
] as const;

const pairParameters = [
  [sh.equals, 'Equals'],
  [sh.disjoint, 'Disjoint'],
  [sh.lessThan, 'LessThan'],
  [sh.lessThanOrEquals, 'LessThanOrEquals'],
] as const;

const logicalParameters = [
  [sh.and, 'And'],
  [sh.or, 'Or'],
  [sh.xone, 'Xone'],
] as const;

interface ComponentDeclaration {
  readonly component: Term.NamedNode | Term.BlankNode;
  readonly mandatory: ReadonlyArray<Term.NamedNode>;
  readonly optional: ReadonlyArray<Term.NamedNode>;
}

type ComponentParameter = ComponentConstraint['parameters'][number];

const isShapeId: (t: Term.Term) => t is ShapeId = Term.isResource;

/**
 * Parses a shapes graph synchronously, returning a `Result`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseResult = (
  dataset: Dataset.Dataset,
): Result.Result<ShapesGraph, ShapesGraphError> =>
  Result.try({
    try: () => parseUnsafe(dataset),
    catch: (e) => {
      if (e instanceof ParseFailure) {
        return new ShapesGraphError(
          Option.match(e.node, {
            onNone: () => ({ message: e.message }),
            onSome: (node) => ({ message: e.message, node: node.key }),
          }),
        );
      }
      throw e;
    },
  });

/**
 * Parses a shapes graph into a typed model. Fails with a `ShapesGraphError`
 * when the shapes graph is ill-formed (e.g. malformed paths or lists,
 * parameters with values of the wrong kind, or invalid regular expressions).
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (dataset: Dataset.Dataset): Effect.Effect<ShapesGraph, ShapesGraphError> =>
  Effect.suspend(() => {
    const result = parseResult(dataset);
    return Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure);
  });

const failShapes = (message: string, node?: Term.Term): never => {
  throw new ParseFailure(message, Option.fromUndefinedOr(node));
};

const isTrue = (t: Term.Term): boolean => t.key === TRUE;

const isTrueOption = (t: Option.Option<Term.Term>): boolean => Option.exists(t, isTrue);

const shapeRef = (owner: Term.Term, p: Term.NamedNode, t: Term.Term): ShapeId =>
  isShapeId(t)
    ? t
    : failShapes(`the value of ${p.key} on ${owner.key} must be an IRI or blank node`, owner);

const resourceOf = (owner: Term.Term, t: Term.Term, message: string): Term.Resource =>
  Term.isResource(t) ? t : failShapes(message, owner);

const iriOf = (owner: Term.Term, p: Term.NamedNode, t: Term.Term): Term.NamedNode =>
  Term.isNamedNode(t)
    ? t
    : failShapes(`the value of ${p.key} on ${owner.key} must be an IRI`, owner);

const nonNegativeInteger = (owner: Term.Term, p: Term.NamedNode, t: Term.Term): number => {
  if (Term.isLiteral(t) && Xsd.isIntegerDatatype(t.datatype.value) && Xsd.isWellFormed(t)) {
    const n = Number(t.value);
    if (n >= 0) return n;
  }
  return failShapes(
    `the value of ${p.key} on ${owner.key} must be a non-negative xsd:integer`,
    owner,
  );
};

/** Reads values from the shapes graph, failing on ill-formed lists and repeated values. */
interface Reader {
  readonly g: Dataset.Dataset;
  readonly objects: (s: Term.Term, p: Term.NamedNode) => ReadonlyArray<Term.GroundTerm>;
  readonly list: (
    owner: Term.Term,
    head: Term.Term,
    p: Term.NamedNode,
  ) => ReadonlyArray<Term.GroundTerm>;
  readonly single: (s: Term.Term, p: Term.NamedNode) => Option.Option<Term.GroundTerm>;
}

const makeReader = (g: Dataset.Dataset): Reader => {
  const objects = (s: Term.Term, p: Term.NamedNode): ReadonlyArray<Term.GroundTerm> =>
    isShapeId(s) ? Dataset.objectsOf(g, s, p) : [];
  const list = (
    owner: Term.Term,
    head: Term.Term,
    p: Term.NamedNode,
  ): ReadonlyArray<Term.GroundTerm> => {
    const items = Term.isObject(head) ? Dataset.list(g, head) : Option.none();
    if (Option.isNone(items))
      return failShapes(
        `the value of ${p.key} on ${owner.key} must be a well-formed RDF list`,
        owner,
      );
    return items.value;
  };
  const single = (s: Term.Term, p: Term.NamedNode): Option.Option<Term.GroundTerm> => {
    const vs = objects(s, p);
    if (vs.length > 1) failShapes(`${s.key} has more than one value for ${p.key}`, s);
    return Arr.head(vs);
  };
  return { g, objects, list, single };
};

// --- Custom constraint components -------------------------------------------

const parameterPath = (r: Reader, c: Term.Term, param: Term.GroundTerm): Term.NamedNode =>
  Option.getOrElse(Option.filter(r.single(param, sh.path), Term.isNamedNode), () =>
    failShapes(`parameter ${param.key} of ${c.key} must have an IRI sh:path`, param),
  );

const componentDeclarations = (r: Reader): ReadonlyArray<ComponentDeclaration> =>
  Arr.flatMap(Rdfs.instancesOf(r.g, sh.ConstraintComponent), (c) => {
    if (!isShapeId(c) || (Term.isNamedNode(c) && c.value.startsWith(SH))) return [];
    const parameters = Arr.map(r.objects(c, sh.parameter), (param) => {
      const path = parameterPath(r, c, param);
      return { path, optional: isTrueOption(r.single(param, sh.optional)) };
    });
    const mandatory = Arr.map(
      Arr.filter(parameters, (p) => !p.optional),
      (p) => p.path,
    );
    const optional = Arr.map(
      Arr.filter(parameters, (p) => p.optional),
      (p) => p.path,
    );
    return Arr.isReadonlyArrayNonEmpty(mandatory) ? [{ component: c, mandatory, optional }] : [];
  });

// --- Collect shapes (§2.1) --------------------------------------------------

const collectCandidates = (
  r: Reader,
  components: ReadonlyArray<ComponentDeclaration>,
): ReadonlyArray<ShapeId> => {
  const candidates = MutableHashMap.empty<string, ShapeId>();
  const addCandidate = (t: Term.Term, reason: string) => {
    if (!isShapeId(t)) failShapes(`${t.key} cannot be a shape (${reason})`, t);
    else if (!MutableHashMap.has(candidates, t.key)) MutableHashMap.set(candidates, t.key, t);
  };
  Arr.forEach([sh.NodeShape, sh.PropertyShape], (cls) =>
    Arr.forEach(Rdfs.instancesOf(r.g, cls), (s) => addCandidate(s, `instance of ${cls.key}`)),
  );
  const subjectTriggers = [
    ...targetPredicates,
    ...coreParameters,
    ...components.flatMap((c) => c.mandatory),
  ];
  Arr.forEach(subjectTriggers, (p) =>
    Arr.forEach(Dataset.match(r.g, { predicate: p }), (q) => {
      if (!Term.isTriple(q.subject)) addCandidate(q.subject, `subject of ${p.key}`);
    }),
  );
  Arr.forEach([sh.node, sh.property, sh.qualifiedValueShape, sh.not], (p) =>
    Arr.forEach(Dataset.match(r.g, { predicate: p }), (q) =>
      addCandidate(q.object, `value of ${p.key}`),
    ),
  );
  Arr.forEach([sh.and, sh.or, sh.xone], (p) =>
    Arr.forEach(Dataset.match(r.g, { predicate: p }), (q) =>
      Arr.forEach(r.list(q.subject, q.object, p), (member) =>
        addCandidate(member, `member of ${p.key}`),
      ),
    ),
  );
  return Arr.sort(MutableHashMap.values(candidates), Term.compare);
};

// --- Parse each shape -------------------------------------------------------

const parseTargets = (
  r: Reader,
  id: ShapeId,
  classInstances: MutableHashSet.MutableHashSet<string>,
): ReadonlyArray<Target> => [
  ...Arr.map(objects(r, id, sh.targetNode), (node): Target => ({ _tag: 'TargetNode', node })),
  ...Arr.map(objects(r, id, sh.targetClass), (c): Target => ({
    _tag: 'TargetClass',
    class: resourceOf(id, c, `the value of sh:targetClass on ${id.key} must be an IRI`),
    implicit: false,
  })),
  ...(Term.isNamedNode(id) && MutableHashSet.has(classInstances, id.key)
    ? [{ _tag: 'TargetClass', class: id, implicit: true } satisfies Target]
    : []),
  ...Arr.map(objects(r, id, sh.targetSubjectsOf), (p): Target => ({
    _tag: 'TargetSubjectsOf',
    predicate: iriOf(id, sh.targetSubjectsOf, p),
  })),
  ...Arr.map(objects(r, id, sh.targetObjectsOf), (p): Target => ({
    _tag: 'TargetObjectsOf',
    predicate: iriOf(id, sh.targetObjectsOf, p),
  })),
  ...Arr.map(objects(r, id, sh.target), (node): Target => ({ _tag: 'SparqlTarget', node })),
];

const objects = (r: Reader, s: Term.Term, p: Term.NamedNode) => r.objects(s, p);

const valueConstraints = (r: Reader, id: ShapeId): ReadonlyArray<Constraint> => [
  ...Arr.map(objects(r, id, sh.class), (c): Constraint => ({
    _tag: 'Class',
    class: resourceOf(id, c, `the value of sh:class on ${id.key} must be an IRI`),
  })),
  ...Arr.map(objects(r, id, sh.datatype), (d): Constraint => ({
    _tag: 'Datatype',
    datatype: iriOf(id, sh.datatype, d),
  })),
  ...Arr.map(objects(r, id, sh.nodeKind), (k): Constraint => ({
    _tag: 'NodeKind',
    nodeKind: Option.getOrElse(Record.get(nodeKinds, Term.isNamedNode(k) ? k.value : ''), () =>
      failShapes(`${k.key} is not a valid sh:nodeKind`, id),
    ),
  })),
  ...Arr.map(objects(r, id, sh.minCount), (n): Constraint => ({
    _tag: 'MinCount',
    minCount: nonNegativeInteger(id, sh.minCount, n),
  })),
  ...Arr.map(objects(r, id, sh.maxCount), (n): Constraint => ({
    _tag: 'MaxCount',
    maxCount: nonNegativeInteger(id, sh.maxCount, n),
  })),
  ...Arr.flatMap(rangeParameters, ([p, tag]) =>
    Arr.map(objects(r, id, p), (v): Constraint =>
      Term.isLiteral(v)
        ? { _tag: tag, value: v }
        : failShapes(`the value of ${p.key} on ${id.key} must be a literal`, id),
    ),
  ),
  ...Arr.map(objects(r, id, sh.minLength), (n): Constraint => ({
    _tag: 'MinLength',
    minLength: nonNegativeInteger(id, sh.minLength, n),
  })),
  ...Arr.map(objects(r, id, sh.maxLength), (n): Constraint => ({
    _tag: 'MaxLength',
    maxLength: nonNegativeInteger(id, sh.maxLength, n),
  })),
  ...patternConstraints(r, id),
  ...Arr.map(objects(r, id, sh.languageIn), (l): Constraint => ({
    _tag: 'LanguageIn',
    languages: Arr.map(r.list(id, l, sh.languageIn), (t) =>
      Term.isLiteral(t)
        ? t.value
        : failShapes(`sh:languageIn members of ${id.key} must be literals`, id),
    ),
  })),
  ...Arr.flatMap(objects(r, id, sh.uniqueLang), (u): ReadonlyArray<Constraint> =>
    isTrue(u) ? [{ _tag: 'UniqueLang' }] : [],
  ),
  ...Arr.flatMap(pairParameters, ([p, tag]) =>
    Arr.map(objects(r, id, p), (v): Constraint => ({ _tag: tag, predicate: iriOf(id, p, v) })),
  ),
];

const patternConstraints = (r: Reader, id: ShapeId): ReadonlyArray<Constraint> => {
  const patterns = objects(r, id, sh.pattern);
  if (Arr.isReadonlyArrayEmpty(patterns)) return [];
  const flags = Option.match(r.single(id, sh.flags), {
    onNone: () => '',
    onSome: (f) =>
      Term.isLiteral(f)
        ? f.value
        : failShapes(`the value of sh:flags on ${id.key} must be a literal`, id),
  });
  return Arr.map(patterns, (p): Constraint => {
    if (!Term.isLiteral(p))
      return failShapes(`the value of sh:pattern on ${id.key} must be a literal`, id);
    return Result.match(Regex.compileCached(p.value, 'xpath', flags), {
      onFailure: (error) =>
        failShapes(`invalid regular expression: ${error} (sh:pattern on ${id.key})`, id),
      onSuccess: (regex) => ({
        _tag: 'Pattern',
        pattern: p.value,
        flags,
        test: (value) => Regex.test(regex, value),
      }),
    });
  });
};

const shapeConstraints = (r: Reader, id: ShapeId): ReadonlyArray<Constraint> => [
  ...Arr.map(objects(r, id, sh.not), (s): Constraint => ({
    _tag: 'Not',
    shape: shapeRef(id, sh.not, s),
  })),
  ...Arr.flatMap(logicalParameters, ([p, tag]) =>
    Arr.map(objects(r, id, p), (l): Constraint => ({
      _tag: tag,
      shapes: r.list(id, l, p).map((m) => shapeRef(id, p, m)),
    })),
  ),
  ...Arr.map(objects(r, id, sh.node), (s): Constraint => ({
    _tag: 'Node',
    shape: shapeRef(id, sh.node, s),
  })),
  ...Arr.map(objects(r, id, sh.property), (s): Constraint => ({
    _tag: 'Property',
    shape: shapeRef(id, sh.property, s),
  })),
];

/** The other qualified value shapes of the property shapes beside `id`. */
const siblingShapes = (r: Reader, id: ShapeId, q: ShapeId): ReadonlyArray<ShapeId> => {
  const siblings = MutableHashMap.empty<string, ShapeId>();
  Arr.forEach(Dataset.subjectsOf(r.g, sh.property, id), (parent) =>
    Arr.forEach(objects(r, parent, sh.property), (sibling) =>
      Arr.forEach(objects(r, sibling, sh.qualifiedValueShape), (sq) => {
        if (sq.key !== q.key && isShapeId(sq)) MutableHashMap.set(siblings, sq.key, sq);
      }),
    ),
  );
  return Arr.fromIterable(MutableHashMap.values(siblings));
};

const qualifiedConstraints = (r: Reader, id: ShapeId): ReadonlyArray<Constraint> => {
  const qualifiedShapes = objects(r, id, sh.qualifiedValueShape);
  if (Arr.isReadonlyArrayEmpty(qualifiedShapes)) return [];
  const minNode = r.single(id, sh.qualifiedMinCount);
  const maxNode = r.single(id, sh.qualifiedMaxCount);
  const disjoint = isTrueOption(r.single(id, sh.qualifiedValueShapesDisjoint));
  return Arr.flatMap(qualifiedShapes, (qNode) => {
    const q = shapeRef(id, sh.qualifiedValueShape, qNode);
    const common = { shape: q, disjoint, siblings: disjoint ? siblingShapes(r, id, q) : [] };
    return [
      ...Option.toArray(
        Option.map(minNode, (n): Constraint => ({
          _tag: 'QualifiedMinCount',
          count: nonNegativeInteger(id, sh.qualifiedMinCount, n),
          ...common,
        })),
      ),
      ...Option.toArray(
        Option.map(maxNode, (n): Constraint => ({
          _tag: 'QualifiedMaxCount',
          count: nonNegativeInteger(id, sh.qualifiedMaxCount, n),
          ...common,
        })),
      ),
    ];
  });
};

const closedConstraints = (r: Reader, id: ShapeId): ReadonlyArray<Constraint> => {
  if (!isTrueOption(r.single(id, sh.closed))) return [];
  const ignoredProperties = Option.match(r.single(id, sh.ignoredProperties), {
    onNone: (): ReadonlyArray<Term.NamedNode> => [],
    onSome: (node) =>
      Arr.map(r.list(id, node, sh.ignoredProperties), (t) => iriOf(id, sh.ignoredProperties, t)),
  });
  const allowed = MutableHashMap.empty<string, Term.NamedNode>();
  Arr.forEach(objects(r, id, sh.property), (p) =>
    Arr.forEach(objects(r, p, sh.path), (path) => {
      if (Term.isNamedNode(path)) MutableHashMap.set(allowed, path.key, path);
    }),
  );
  Arr.forEach(ignoredProperties, (p) => {
    MutableHashMap.set(allowed, p.key, p);
  });
  return [
    {
      _tag: 'Closed',
      ignoredProperties,
      allowedProperties: Arr.fromIterable(MutableHashMap.values(allowed)),
    },
  ];
};

const sparqlConstraints = (r: Reader, id: ShapeId): ReadonlyArray<Constraint> =>
  Arr.flatMap(objects(r, id, sh.sparql), (s): ReadonlyArray<Constraint> => {
    if (!isShapeId(s))
      return failShapes(`the value of sh:sparql on ${id.key} must be an IRI or blank node`, id);
    return isTrueOption(r.single(s, sh.deactivated)) ? [] : [{ _tag: 'Sparql', node: s }];
  });

const noParameters: ReadonlyArray<ReadonlyArray<ComponentParameter>> = [[]];

const componentConstraints = (
  r: Reader,
  id: ShapeId,
  components: ReadonlyArray<ComponentDeclaration>,
): ReadonlyArray<Constraint> =>
  Arr.flatMap(components, (decl): ReadonlyArray<Constraint> => {
    const bindings = Arr.map(
      [...decl.mandatory, ...decl.optional],
      (p) => [p, objects(r, id, p)] as const,
    );
    if (decl.mandatory.some((p) => Arr.isReadonlyArrayEmpty(objects(r, id, p)))) return [];
    // One constraint per combination of parameter values.
    const combos = Arr.reduce(bindings, noParameters, (acc, [path, values]) =>
      Arr.isReadonlyArrayEmpty(values)
        ? acc
        : Arr.flatMap(acc, (combo) => values.map((value) => Arr.append(combo, { path, value }))),
    );
    return Arr.map(combos, (parameters): Constraint => ({
      _tag: 'Component',
      component: decl.component,
      parameters,
    }));
  });

const parseShape = (
  r: Reader,
  components: ReadonlyArray<ComponentDeclaration>,
  classInstances: MutableHashSet.MutableHashSet<string>,
  id: ShapeId,
): Shape => {
  const targets = parseTargets(r, id, classInstances);

  // Shape characteristics
  const severity = Option.match(r.single(id, sh.severity), {
    onNone: () => sh.Violation,
    onSome: (node) => iriOf(id, sh.severity, node),
  });
  const messages = objects(r, id, sh.message).filter(Term.isLiteral);
  const deactivated = isTrueOption(r.single(id, sh.deactivated));

  const constraints: ReadonlyArray<Constraint> = [
    ...valueConstraints(r, id),
    ...shapeConstraints(r, id),
    ...qualifiedConstraints(r, id),
    ...closedConstraints(r, id),
    ...Arr.map(objects(r, id, sh.hasValue), (v): Constraint => ({ _tag: 'HasValue', value: v })),
    ...Arr.map(objects(r, id, sh.in), (l): Constraint => ({
      _tag: 'In',
      values: r.list(id, l, sh.in),
    })),
    ...sparqlConstraints(r, id),
    ...componentConstraints(r, id, components),
  ];

  // Property shape?
  return Option.match(r.single(id, sh.path), {
    onNone: (): Shape => ({
      _tag: 'NodeShape',
      id,
      targets,
      constraints,
      severity,
      messages,
      deactivated,
    }),
    onSome: (pathNode): Shape => ({
      _tag: 'PropertyShape',
      id,
      path: Result.getOrElse(Path.fromRdf(r.g, pathNode), (failure) =>
        failShapes(`ill-formed sh:path of ${id.key}: ${failure.message}`, id),
      ),
      targets,
      constraints,
      severity,
      messages,
      deactivated,
    }),
  });
};

const parseUnsafe = (g: Dataset.Dataset): ShapesGraph => {
  const r = makeReader(g);
  const components = componentDeclarations(r);
  const candidates = collectCandidates(r, components);
  const classInstances = MutableHashSet.fromIterable(
    Arr.map(Rdfs.instancesOf(g, rdfs.Class), (c) => c.key),
  );
  const shapes = Arr.map(candidates, (id) => parseShape(r, components, classInstances, id));
  // The public `index` is a `ReadonlyMap`.
  const index = new Map(shapes.map((s) => [s.id.key, s]));
  return { _tag: 'ShapesGraph', dataset: g, shapes, index };
};
