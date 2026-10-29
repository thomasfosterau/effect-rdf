/**
 * Shapes graphs: parsing an RDF shapes graph into a typed, validated model of
 * node shapes and property shapes with their targets and constraints
 * (SHACL Core §2–§4, plus the SHACL-SPARQL constructs needed to delegate to a
 * `Sparql.SparqlConstraintEvaluator`).
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Shapes } from "@thomasfosterau/effect-shacl"
 *
 * const program = Effect.gen(function* () {
 *   const shapes = yield* Shapes.parse(shapesDataset)
 *   for (const shape of shapes.shapes) console.log(shape._tag, shape.id.key)
 * })
 * ```
 *
 * @since 0.1.0
 */
import { Dataset, Rdfs, Term, Vocab, Xsd } from '@thomasfosterau/effect-rdf';
import * as Match from 'effect/Match';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Regex from './internal/regex.ts';
import * as Path from './Path.ts';
import { SH, sh } from './Vocabulary.ts';
import * as Predicate from 'effect/Predicate';

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
export class ShapesGraphError extends Schema.TaggedError<ShapesGraphError>()('ShapesGraphError', {
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
      readonly regex: RegExp;
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
      s.targets.some((t) => t._tag === 'SparqlTarget') ||
      s.constraints.some((c) => c._tag === 'Sparql' || c._tag === 'Component'),
  );

const componentNames: Record<Exclude<ConstraintTag, 'Sparql' | 'Component'>, string> = {
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
    Match.tag('Component', (constraint) => constraint.component),
    Match.orElse((constraint) => Term.namedNode(SH + componentNames[constraint._tag])),
  );
};

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

class ParseFailure {
  readonly message: string;
  readonly node: Term.Term | undefined;
  constructor(message: string, node: Term.Term | undefined) {
    this.message = message;
    this.node = node;
  }
}

const TRUE = Term.literal('true', xsd.boolean).key;

const nodeKinds: ReadonlyMap<string, NodeKind> = new Map(
  (
    ['BlankNode', 'IRI', 'Literal', 'BlankNodeOrIRI', 'BlankNodeOrLiteral', 'IRIOrLiteral'] as const
  ).map((k) => [SH + k, k]),
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

interface ComponentDeclaration {
  readonly component: Term.NamedNode | Term.BlankNode;
  readonly mandatory: ReadonlyArray<Term.NamedNode>;
  readonly optional: ReadonlyArray<Term.NamedNode>;
}

const isShapeId = (t: Term.Term): t is ShapeId => t._tag === 'NamedNode' || t._tag === 'BlankNode';

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
          e.node === undefined ? { message: e.message } : { message: e.message, node: e.node.key },
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

const parseUnsafe = (g: Dataset.Dataset): ShapesGraph => {
  const fail = (message: string, node?: Term.Term): never => {
    throw new ParseFailure(message, node);
  };
  const objects = (s: Term.Term, p: Term.NamedNode): ReadonlyArray<Term.GroundTerm> =>
    isShapeId(s) ? Dataset.objectsOf(g, s, p) : [];
  const list = (
    owner: Term.Term,
    head: Term.Term,
    p: Term.NamedNode,
  ): ReadonlyArray<Term.GroundTerm> => {
    const items = Term.isObject(head) ? Dataset.list(g, head) : Option.none();
    if (Option.isNone(items))
      return fail(`the value of ${p.key} on ${owner.key} must be a well-formed RDF list`, owner);
    return items.value;
  };
  const isTrue = (t: Term.Term | undefined) => t !== undefined && t.key === TRUE;
  const single = (s: Term.Term, p: Term.NamedNode): Term.GroundTerm | undefined => {
    const vs = objects(s, p);
    if (vs.length > 1) fail(`${s.key} has more than one value for ${p.key}`, s);
    return vs[0];
  };
  const shapeRef = (owner: Term.Term, p: Term.NamedNode, t: Term.Term): ShapeId =>
    isShapeId(t)
      ? t
      : fail(`the value of ${p.key} on ${owner.key} must be an IRI or blank node`, owner);
  const iri = (owner: Term.Term, p: Term.NamedNode, t: Term.Term): Term.NamedNode =>
    t._tag === 'NamedNode'
      ? t
      : fail(`the value of ${p.key} on ${owner.key} must be an IRI`, owner);
  const nonNegativeInteger = (owner: Term.Term, p: Term.NamedNode, t: Term.Term): number => {
    if (t._tag === 'Literal' && Xsd.isIntegerDatatype(t.datatype.value) && Xsd.isWellFormed(t)) {
      const n = Number(t.value);
      if (n >= 0) return n;
    }
    return fail(`the value of ${p.key} on ${owner.key} must be a non-negative xsd:integer`, owner);
  };

  // --- Custom constraint components -----------------------------------------
  const components: Array<ComponentDeclaration> = [];
  for (const c of Rdfs.instancesOf(g, sh.ConstraintComponent)) {
    if (!isShapeId(c) || (c._tag === 'NamedNode' && c.value.startsWith(SH))) continue;
    const mandatory: Array<Term.NamedNode> = [];
    const optional: Array<Term.NamedNode> = [];
    for (const param of objects(c, sh.parameter)) {
      const path = single(param, sh.path);
      if (path === undefined || path._tag !== 'NamedNode')
        fail(`parameter ${param.key} of ${c.key} must have an IRI sh:path`, param);
      // SAFETY: a non-IRI path failed above.
      (isTrue(single(param, sh.optional)) ? optional : mandatory).push(path as Term.NamedNode);
    }
    if (Arr.isReadonlyArrayNonEmpty(mandatory))
      components.push({ component: c, mandatory, optional });
  }

  // --- Collect shapes (§2.1) ------------------------------------------------
  const candidates = new Map<string, ShapeId>();
  const addCandidate = (t: Term.Term, reason: string) => {
    if (!isShapeId(t)) fail(`${t.key} cannot be a shape (${reason})`, t);
    else if (!candidates.has(t.key)) candidates.set(t.key, t);
  };
  for (const cls of [sh.NodeShape, sh.PropertyShape]) {
    for (const s of Rdfs.instancesOf(g, cls)) addCandidate(s, `instance of ${cls.key}`);
  }
  const subjectTriggers = [
    ...targetPredicates,
    ...coreParameters,
    ...components.flatMap((c) => c.mandatory),
  ];
  for (const p of subjectTriggers) {
    for (const q of Dataset.match(g, { predicate: p })) {
      if (q.subject._tag !== 'Triple') addCandidate(q.subject, `subject of ${p.key}`);
    }
  }
  for (const p of [sh.node, sh.property, sh.qualifiedValueShape, sh.not]) {
    for (const q of Dataset.match(g, { predicate: p })) addCandidate(q.object, `value of ${p.key}`);
  }
  for (const p of [sh.and, sh.or, sh.xone]) {
    for (const q of Dataset.match(g, { predicate: p })) {
      for (const member of list(q.subject, q.object, p)) addCandidate(member, `member of ${p.key}`);
    }
  }

  const classInstances = new Set(Rdfs.instancesOf(g, rdfs.Class).map((c) => c.key));

  // --- Parse each shape -----------------------------------------------------
  const parseShape = (id: ShapeId): Shape => {
    // Targets
    const targets: Array<Target> = [];
    for (const n of objects(id, sh.targetNode)) targets.push({ _tag: 'TargetNode', node: n });
    for (const c of objects(id, sh.targetClass)) {
      if (!isShapeId(c)) fail(`the value of sh:targetClass on ${id.key} must be an IRI`, id);
      // SAFETY: `isShapeId` holds (checked above), so it is an IRI or blank node.
      targets.push({ _tag: 'TargetClass', class: c as Term.Resource, implicit: false });
    }
    if (id._tag === 'NamedNode' && classInstances.has(id.key)) {
      targets.push({ _tag: 'TargetClass', class: id, implicit: true });
    }
    for (const p of objects(id, sh.targetSubjectsOf))
      targets.push({ _tag: 'TargetSubjectsOf', predicate: iri(id, sh.targetSubjectsOf, p) });
    for (const p of objects(id, sh.targetObjectsOf))
      targets.push({ _tag: 'TargetObjectsOf', predicate: iri(id, sh.targetObjectsOf, p) });
    for (const t of objects(id, sh.target)) targets.push({ _tag: 'SparqlTarget', node: t });

    // Shape characteristics
    const severityNode = single(id, sh.severity);
    const severity = severityNode === undefined ? sh.Violation : iri(id, sh.severity, severityNode);
    const messages = objects(id, sh.message).filter(Term.isLiteral);
    const deactivated = isTrue(single(id, sh.deactivated));

    // Constraints
    const constraints: Array<Constraint> = [];
    const push = (c: Constraint) => constraints.push(c);

    for (const c of objects(id, sh.class)) {
      if (!isShapeId(c)) fail(`the value of sh:class on ${id.key} must be an IRI`, id);
      // SAFETY: `isShapeId` holds (checked above), so it is an IRI or blank node.
      push({ _tag: 'Class', class: c as Term.Resource });
    }
    for (const d of objects(id, sh.datatype)) {
      push({ _tag: 'Datatype', datatype: iri(id, sh.datatype, d) });
    }
    for (const k of objects(id, sh.nodeKind)) {
      const nodeKind = nodeKinds.get(k._tag === 'NamedNode' ? k.value : '');
      if (nodeKind === undefined) fail(`${k.key} is not a valid sh:nodeKind`, id);
      push({ _tag: 'NodeKind', nodeKind: nodeKind! });
    }
    for (const n of objects(id, sh.minCount))
      push({ _tag: 'MinCount', minCount: nonNegativeInteger(id, sh.minCount, n) });
    for (const n of objects(id, sh.maxCount))
      push({ _tag: 'MaxCount', maxCount: nonNegativeInteger(id, sh.maxCount, n) });
    for (const [p, tag] of [
      [sh.minExclusive, 'MinExclusive'],
      [sh.minInclusive, 'MinInclusive'],
      [sh.maxExclusive, 'MaxExclusive'],
      [sh.maxInclusive, 'MaxInclusive'],
    ] as const) {
      for (const v of objects(id, p)) {
        if (v._tag !== 'Literal') fail(`the value of ${p.key} on ${id.key} must be a literal`, id);
        push({ _tag: tag, value: v });
      }
    }
    for (const n of objects(id, sh.minLength))
      push({ _tag: 'MinLength', minLength: nonNegativeInteger(id, sh.minLength, n) });
    for (const n of objects(id, sh.maxLength))
      push({ _tag: 'MaxLength', maxLength: nonNegativeInteger(id, sh.maxLength, n) });
    const patterns = objects(id, sh.pattern);
    if (Arr.isReadonlyArrayNonEmpty(patterns)) {
      const flagsNode = single(id, sh.flags);
      let flags = '';
      if (flagsNode !== undefined) {
        if (flagsNode._tag !== 'Literal')
          return fail(`the value of sh:flags on ${id.key} must be a literal`, id);
        flags = flagsNode.value;
      }
      for (const p of patterns) {
        if (p._tag !== 'Literal')
          return fail(`the value of sh:pattern on ${id.key} must be a literal`, id);
        const compiled = Regex.compile(p.value, flags);
        if ('error' in compiled) fail(`${compiled.error} (sh:pattern on ${id.key})`, id);
        else push({ _tag: 'Pattern', pattern: p.value, flags, regex: compiled.regex });
      }
    }
    for (const l of objects(id, sh.languageIn)) {
      const languages = list(id, l, sh.languageIn).map((t) =>
        t._tag === 'Literal'
          ? t.value
          : fail(`sh:languageIn members of ${id.key} must be literals`, id),
      );
      push({ _tag: 'LanguageIn', languages });
    }
    for (const u of objects(id, sh.uniqueLang)) if (isTrue(u)) push({ _tag: 'UniqueLang' });
    for (const [p, tag] of [
      [sh.equals, 'Equals'],
      [sh.disjoint, 'Disjoint'],
      [sh.lessThan, 'LessThan'],
      [sh.lessThanOrEquals, 'LessThanOrEquals'],
    ] as const) {
      for (const v of objects(id, p)) push({ _tag: tag, predicate: iri(id, p, v) });
    }
    for (const s of objects(id, sh.not)) push({ _tag: 'Not', shape: shapeRef(id, sh.not, s) });
    for (const [p, tag] of [
      [sh.and, 'And'],
      [sh.or, 'Or'],
      [sh.xone, 'Xone'],
    ] as const) {
      for (const l of objects(id, p)) {
        push({ _tag: tag, shapes: list(id, l, p).map((m) => shapeRef(id, p, m)) });
      }
    }
    for (const s of objects(id, sh.node)) push({ _tag: 'Node', shape: shapeRef(id, sh.node, s) });
    for (const s of objects(id, sh.property))
      push({ _tag: 'Property', shape: shapeRef(id, sh.property, s) });

    // Qualified value shapes
    const qualifiedShapes = objects(id, sh.qualifiedValueShape);
    if (Arr.isReadonlyArrayNonEmpty(qualifiedShapes)) {
      const minNode = single(id, sh.qualifiedMinCount);
      const maxNode = single(id, sh.qualifiedMaxCount);
      const disjoint = isTrue(single(id, sh.qualifiedValueShapesDisjoint));
      for (const qNode of qualifiedShapes) {
        const q = shapeRef(id, sh.qualifiedValueShape, qNode);
        const siblings = new Map<string, ShapeId>();
        if (disjoint) {
          for (const parent of Dataset.subjectsOf(g, sh.property, id)) {
            for (const sibling of objects(parent, sh.property)) {
              for (const sq of objects(sibling, sh.qualifiedValueShape)) {
                if (sq.key !== q.key && isShapeId(sq)) siblings.set(sq.key, sq);
              }
            }
          }
        }
        const common = { shape: q, disjoint, siblings: Array.from(siblings.values()) };
        if (minNode !== undefined)
          push({
            _tag: 'QualifiedMinCount',
            count: nonNegativeInteger(id, sh.qualifiedMinCount, minNode),
            ...common,
          });
        if (maxNode !== undefined)
          push({
            _tag: 'QualifiedMaxCount',
            count: nonNegativeInteger(id, sh.qualifiedMaxCount, maxNode),
            ...common,
          });
      }
    }

    // Closed shapes
    if (isTrue(single(id, sh.closed))) {
      const ignoredNode = single(id, sh.ignoredProperties);
      const ignoredProperties =
        ignoredNode === undefined
          ? []
          : list(id, ignoredNode, sh.ignoredProperties).map((t) =>
              iri(id, sh.ignoredProperties, t),
            );
      const allowed = new Map<string, Term.NamedNode>();
      for (const p of objects(id, sh.property)) {
        for (const path of objects(p, sh.path))
          if (path._tag === 'NamedNode') allowed.set(path.key, path);
      }
      for (const p of ignoredProperties) allowed.set(p.key, p);
      push({ _tag: 'Closed', ignoredProperties, allowedProperties: Array.from(allowed.values()) });
    }

    for (const v of objects(id, sh.hasValue)) push({ _tag: 'HasValue', value: v });
    for (const l of objects(id, sh.in)) push({ _tag: 'In', values: list(id, l, sh.in) });

    // SHACL-SPARQL
    for (const s of objects(id, sh.sparql)) {
      if (!isShapeId(s))
        fail(`the value of sh:sparql on ${id.key} must be an IRI or blank node`, id);
      else if (!isTrue(single(s, sh.deactivated))) push({ _tag: 'Sparql', node: s });
    }
    for (const decl of components) {
      const bindings = [...decl.mandatory, ...decl.optional].map(
        (p) => [p, objects(id, p)] as const,
      );
      if (decl.mandatory.some((p) => Arr.isReadonlyArrayEmpty(objects(id, p)))) continue;
      // One constraint per combination of parameter values.
      let combos: Array<Array<{ path: Term.NamedNode; value: Term.GroundTerm }>> = [[]];
      for (const [path, values] of bindings) {
        if (Arr.isReadonlyArrayEmpty(values)) continue;
        combos = combos.flatMap((combo) => values.map((value) => [...combo, { path, value }]));
      }
      for (const parameters of combos)
        push({ _tag: 'Component', component: decl.component, parameters });
    }

    // Property shape?
    const pathNode = single(id, sh.path);
    if (pathNode !== undefined) {
      const path = Path.fromRdf(g, pathNode);
      if (Result.isFailure(path))
        fail(`ill-formed sh:path of ${id.key}: ${path.failure.message}`, id);
      // SAFETY: a failure called `fail` above, which throws.
      return {
        _tag: 'PropertyShape',
        id,
        path: (path as Result.Success<Path.Path, never>).success,
        targets,
        constraints,
        severity,
        messages,
        deactivated,
      };
    }
    return { _tag: 'NodeShape', id, targets, constraints, severity, messages, deactivated };
  };

  const shapes = Arr.map(Arr.sort(candidates.values(), Term.compare), parseShape);
  const index = new Map(shapes.map((s) => [s.id.key, s]));
  return { _tag: 'ShapesGraph', dataset: g, shapes, index };
};
