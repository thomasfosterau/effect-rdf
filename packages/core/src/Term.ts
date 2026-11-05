/**
 * The RDF 1.2 term model.
 *
 * Terms are immutable values that implement Effect's `Equal` and `Hash`
 * protocols, so they can be used directly as keys of `HashMap`/`HashSet` and
 * compared with `Equal.equals`. Every term carries a canonical `key` — its
 * N-Triples / N-Quads serialisation — which is also what `toString()` returns.
 *
 * The model supports RDF 1.2 (and RDF-star) triple terms, directional
 * language-tagged strings, and SPARQL variables (used only in patterns).
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Equal from 'effect/Equal';
import * as equivalence from 'effect/Equivalence';
import * as Hash from 'effect/Hash';
import { NodeInspectSymbol } from 'effect/Inspectable';
import * as Match from 'effect/Match';
import * as order from 'effect/Order';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import { hasProperty, isString } from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import type * as SchemaAST from 'effect/SchemaAST';
import * as TermJson from './TermJson.ts';
import { representations as Generate } from './internal/arbitrary.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * @since 0.1.0
 * @category symbols
 */
export const TypeId: unique symbol = Symbol.for('@thomasfosterau/effect-rdf/Term');

/**
 * @since 0.1.0
 * @category symbols
 */
export type TypeId = typeof TypeId;

/**
 * The base direction of a directional language-tagged string.
 *
 * @since 0.1.0
 * @category models
 */
export type Direction = 'ltr' | 'rtl';

/** `isTerm` for a value already known to be an object. */
const hasTermTypeId = (u: Equal.Equal): u is Term => TypeId in u;

abstract class TermBase implements Equal.Equal, Pipeable {
  readonly [TypeId]: TypeId = TypeId;
  abstract readonly _tag: string;
  #key: string | undefined;
  #hash: number | undefined;

  /** The canonical N-Triples serialisation of this term. */
  get key(): string {
    return (this.#key ??= this.computeKey());
  }

  protected abstract computeKey(): string;

  /** RDF/JS compatible alias of `_tag`. */
  get termType(): this['_tag'] {
    return this._tag;
  }

  /** RDF/JS compatible equality. */
  equals(that: unknown): boolean {
    return isTerm(that) && that.key === this.key;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return hasTermTypeId(that) && that.key === this.key;
  }

  [Hash.symbol](): number {
    return (this.#hash ??= Hash.string(this.key));
  }

  pipe() {
    return pipeArguments(this, arguments);
  }

  toString(): string {
    return this.key;
  }

  toJSON() {
    return { _tag: this._tag, value: this.key };
  }

  [NodeInspectSymbol](): string {
    return `${this._tag}(${this.key})`;
  }
}

/**
 * An IRI.
 *
 * @since 0.1.0
 * @category models
 */
export class NamedNode<out Iri extends string = string> extends TermBase {
  readonly _tag = 'NamedNode' as const;
  readonly value: Iri;
  constructor(value: Iri) {
    super();
    this.value = value;
  }
  protected computeKey(): string {
    return `<${escapeIri(this.value)}>`;
  }
}

/**
 * A blank node. Labels are scoped to the dataset or document that contains
 * them.
 *
 * @since 0.1.0
 * @category models
 */
export class BlankNode extends TermBase {
  readonly _tag = 'BlankNode' as const;
  readonly value: string;
  constructor(value: string) {
    super();
    this.value = value;
  }
  protected computeKey(): string {
    return `_:${this.value}`;
  }
}

/**
 * A literal. Language-tagged strings have datatype `rdf:langString`, and
 * directional language-tagged strings (RDF 1.2) have datatype
 * `rdf:dirLangString`.
 *
 * @since 0.1.0
 * @category models
 */
export class Literal extends TermBase {
  readonly _tag = 'Literal' as const;
  readonly value: string;
  readonly datatype: NamedNode;
  readonly language: string;
  readonly direction: Direction | undefined;
  constructor(value: string, datatype: NamedNode, language: string = '', direction?: Direction) {
    super();
    this.value = value;
    this.datatype = datatype;
    this.language = language;
    this.direction = direction;
  }
  protected computeKey(): string {
    const lexical = `"${escapeString(this.value)}"`;
    if (this.language !== '') {
      return this.direction === undefined
        ? `${lexical}@${this.language}`
        : `${lexical}@${this.language}--${this.direction}`;
    }
    if (this.datatype.value === XSD_STRING) return lexical;
    return `${lexical}^^${this.datatype.key}`;
  }
}

/**
 * A SPARQL query variable. Variables never appear in RDF data; they are used
 * in quad patterns.
 *
 * @since 0.1.0
 * @category models
 */
export class Variable<out Name extends string = string> extends TermBase {
  readonly _tag = 'Variable' as const;
  readonly value: Name;
  constructor(value: Name) {
    super();
    this.value = value;
  }
  protected computeKey(): string {
    return `?${this.value}`;
  }
}

/**
 * The default graph of a dataset.
 *
 * @since 0.1.0
 * @category models
 */
export class DefaultGraph extends TermBase {
  readonly _tag = 'DefaultGraph' as const;
  readonly value = '' as const;
  protected computeKey(): string {
    return '';
  }
}

/**
 * An RDF triple. Triples are also terms (RDF 1.2 "triple terms", RDF-star
 * "quoted triples") and may appear in the subject or object position of
 * other triples.
 *
 * @since 0.1.0
 * @category models
 */
export class Triple<
  out S extends Subject = Subject,
  out P extends Predicate = Predicate,
  out O extends Object = Object,
> extends TermBase {
  readonly _tag = 'Triple' as const;
  readonly subject: S;
  readonly predicate: P;
  readonly object: O;
  constructor(subject: S, predicate: P, object: O) {
    super();
    this.subject = subject;
    this.predicate = predicate;
    this.object = object;
  }
  protected computeKey(): string {
    return `<<( ${this.subject.key} ${this.predicate.key} ${this.object.key} )>>`;
  }
  /** Always the default graph: a triple term carries no graph name. */
  get graph(): DefaultGraph {
    return defaultGraph;
  }
}

/**
 * An RDF quad: a triple together with the graph that contains it.
 *
 * `Quad` is a statement, not a term; use `Triple` for triple terms.
 *
 * @since 0.1.0
 * @category models
 */
export class Quad<
  out S extends Subject = Subject,
  out P extends Predicate = Predicate,
  out O extends Object = Object,
  out G extends Graph = Graph,
>
  implements Equal.Equal, Pipeable
{
  readonly _tag = 'Quad' as const;
  #key: string | undefined;
  #hash: number | undefined;
  readonly subject: S;
  readonly predicate: P;
  readonly object: O;
  readonly graph: G;
  constructor(subject: S, predicate: P, object: O, graph: G) {
    this.subject = subject;
    this.predicate = predicate;
    this.object = object;
    this.graph = graph;
  }

  /** The canonical N-Quads statement (without the trailing ` .`). */
  get key(): string {
    if (this.#key === undefined) {
      const triple = `${this.subject.key} ${this.predicate.key} ${this.object.key}`;
      this.#key = this.graph._tag === 'DefaultGraph' ? triple : `${triple} ${this.graph.key}`;
    }
    return this.#key;
  }

  /** The triple of this quad, without its graph. */
  get triple(): Triple<S, P, O> {
    return new Triple(this.subject, this.predicate, this.object);
  }

  equals(that: unknown): boolean {
    return isQuad(that) && that.key === this.key;
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Quad && that.key === this.key;
  }

  [Hash.symbol](): number {
    return (this.#hash ??= Hash.string(this.key));
  }

  pipe() {
    return pipeArguments(this, arguments);
  }

  toString(): string {
    return `${this.key} .`;
  }

  toJSON() {
    return { _tag: 'Quad' as const, value: this.toString() };
  }

  [NodeInspectSymbol](): string {
    return `Quad(${this.key})`;
  }
}

// -----------------------------------------------------------------------------
// Unions
// -----------------------------------------------------------------------------

/**
 * Any RDF term.
 *
 * @since 0.1.0
 * @category models
 */
export type Term = NamedNode | BlankNode | Literal | Variable | DefaultGraph | Triple;

/**
 * Terms allowed in the subject position of RDF data.
 *
 * @since 0.1.0
 * @category models
 */
export type Subject = NamedNode | BlankNode | Triple;

/**
 * Terms allowed in the predicate position of RDF data.
 *
 * @since 0.1.0
 * @category models
 */
export type Predicate = NamedNode;

/**
 * Terms allowed in the object position of RDF data.
 *
 * @since 0.1.0
 * @category models
 */
export type Object = NamedNode | BlankNode | Literal | Triple;

/**
 * Terms allowed as graph names.
 *
 * @since 0.1.0
 * @category models
 */
export type Graph = NamedNode | BlankNode | DefaultGraph;

/**
 * Ground terms: terms that may appear in RDF data (everything except
 * variables and the default graph marker).
 *
 * @since 0.1.0
 * @category models
 */
export type GroundTerm = NamedNode | BlankNode | Literal | Triple;

/**
 * IRIs and blank nodes.
 *
 * @since 0.1.0
 * @category models
 */
export type Resource = NamedNode | BlankNode;

/**
 * A term or variable in a quad pattern.
 *
 * @since 0.1.0
 * @category models
 */
export type PatternTerm<T extends Term> = T | Variable;

// -----------------------------------------------------------------------------
// Constructors
// -----------------------------------------------------------------------------

/**
 * The singleton default graph.
 *
 * @since 0.1.0
 * @category constructors
 */
export const defaultGraph: DefaultGraph = new DefaultGraph();

/**
 * @since 0.1.0
 * @category constructors
 */
export const namedNode = <const Iri extends string>(iri: Iri): NamedNode<Iri> => new NamedNode(iri);

let blankNodeCounter = 0;

/**
 * Creates a blank node. When no label is given a fresh, process-unique label
 * is generated.
 *
 * @since 0.1.0
 * @category constructors
 */
export const blankNode = (label?: string): BlankNode =>
  new BlankNode(label ?? `b${(blankNodeCounter++).toString(36)}`);

/**
 * @since 0.1.0
 * @category constructors
 */
export const variable = <const Name extends string>(name: Name): Variable<Name> =>
  new Variable(name);

/** @internal */
export const XSD_STRING = `${XSD}string`;
/** @internal */
export const RDF_LANG_STRING = `${RDF}langString`;
/** @internal */
export const RDF_DIR_LANG_STRING = `${RDF}dirLangString`;

const xsdString = new NamedNode(XSD_STRING);
const rdfLangString = new NamedNode(RDF_LANG_STRING);
const rdfDirLangString = new NamedNode(RDF_DIR_LANG_STRING);

/**
 * Creates a literal.
 *
 * - `literal("x")` is an `xsd:string`
 * - `literal("x", "en")` is a language-tagged string
 * - `literal("x", { language: "ar", direction: "rtl" })` is a directional
 *   language-tagged string
 * - `literal("1", xsd.integer)` is a typed literal
 *
 * Language tags are normalised to lower case.
 *
 * @since 0.1.0
 * @category constructors
 */
export const literal = (
  value: string,
  languageOrDatatype?:
    | string
    | NamedNode
    | { readonly language: string; readonly direction?: Direction | undefined },
): Literal => {
  if (languageOrDatatype === undefined) return new Literal(value, xsdString);
  if (isString(languageOrDatatype)) {
    return new Literal(value, rdfLangString, languageOrDatatype.toLowerCase());
  }
  if ('language' in languageOrDatatype) {
    const language = languageOrDatatype.language.toLowerCase();
    return languageOrDatatype.direction === undefined
      ? new Literal(value, rdfLangString, language)
      : new Literal(value, rdfDirLangString, language, languageOrDatatype.direction);
  }
  if (
    languageOrDatatype.value === RDF_LANG_STRING ||
    languageOrDatatype.value === RDF_DIR_LANG_STRING
  ) {
    // A language-tagged datatype without a language tag is invalid; keep the
    // lexical form but fall back to a plain string.
    return new Literal(value, xsdString);
  }
  return new Literal(value, languageOrDatatype);
};

/**
 * Creates a triple (and triple term).
 *
 * @since 0.1.0
 * @category constructors
 */
export const triple = <S extends Subject, P extends Predicate, O extends Object>(
  subject: S,
  predicate: P,
  object: O,
): Triple<S, P, O> => new Triple(subject, predicate, object);

/**
 * Creates a quad. The graph defaults to the default graph.
 *
 * @since 0.1.0
 * @category constructors
 */
export function quad<S extends Subject, P extends Predicate, O extends Object>(
  subject: S,
  predicate: P,
  object: O,
): Quad<S, P, O, DefaultGraph>;
export function quad<S extends Subject, P extends Predicate, O extends Object, G extends Graph>(
  subject: S,
  predicate: P,
  object: O,
  graph: G,
): Quad<S, P, O, G>;
export function quad(
  subject: Subject,
  predicate: Predicate,
  object: Object,
  graph: Graph = defaultGraph,
): Quad {
  return new Quad(subject, predicate, object, graph);
}

/**
 * Converts a triple to a quad in the given graph (default graph when omitted).
 *
 * @since 0.1.0
 * @category constructors
 */
export const toQuad = <
  S extends Subject,
  P extends Predicate,
  O extends Object,
  G extends Graph = DefaultGraph,
>(
  self: Triple<S, P, O>,
  graph?: G,
): Quad<S, P, O, G> =>
  // SAFETY: `G` defaults to the default graph type when no graph is given.
  new Quad(self.subject, self.predicate, self.object, (graph ?? defaultGraph) as G);

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category guards
 */
export const isTerm = (u: unknown): u is Term => hasProperty(u, TypeId);

/**
 * @since 0.1.0
 * @category guards
 */
export const isNamedNode = (u: unknown): u is NamedNode => isTerm(u) && u._tag === 'NamedNode';

/**
 * @since 0.1.0
 * @category guards
 */
export const isBlankNode = (u: unknown): u is BlankNode => isTerm(u) && u._tag === 'BlankNode';

/**
 * @since 0.1.0
 * @category guards
 */
export const isLiteral = (u: unknown): u is Literal => isTerm(u) && u._tag === 'Literal';

/**
 * @since 0.1.0
 * @category guards
 */
export const isVariable = (u: unknown): u is Variable => isTerm(u) && u._tag === 'Variable';

/**
 * @since 0.1.0
 * @category guards
 */
export const isDefaultGraph = (u: unknown): u is DefaultGraph =>
  isTerm(u) && u._tag === 'DefaultGraph';

/**
 * @since 0.1.0
 * @category guards
 */
export const isTriple = (u: unknown): u is Triple => isTerm(u) && u._tag === 'Triple';

/**
 * @since 0.1.0
 * @category guards
 */
export const isQuad = (u: unknown): u is Quad => u instanceof Quad;

/**
 * @since 0.1.0
 * @category guards
 */
export const isResource = (u: unknown): u is Resource => isNamedNode(u) || isBlankNode(u);

/**
 * @since 0.1.0
 * @category guards
 */
export const isSubject = (u: unknown): u is Subject =>
  isNamedNode(u) || isBlankNode(u) || isTriple(u);

/**
 * @since 0.1.0
 * @category guards
 */
export const isObject = (u: unknown): u is Object =>
  isNamedNode(u) || isBlankNode(u) || isLiteral(u) || isTriple(u);

/**
 * @since 0.1.0
 * @category guards
 */
export const isGraph = (u: unknown): u is Graph =>
  isNamedNode(u) || isBlankNode(u) || isDefaultGraph(u);

/**
 * @since 0.1.0
 * @category guards
 */
export const isGroundTerm = (u: unknown): u is GroundTerm =>
  isNamedNode(u) || isBlankNode(u) || isLiteral(u) || isTriple(u);

/**
 * Whether a literal is a (possibly directional) language-tagged string.
 *
 * @since 0.1.0
 * @category guards
 */
export const isLanguageTagged = (self: Literal): boolean => self.language !== '';

// Built once: `hasBlankNodes` runs for every term of every quad a dataset or comparison visits.
const blankNodesIn: (self: Term | Quad) => boolean = Match.type<Term | Quad>().pipe(
  Match.tag('BlankNode', () => true),
  Match.tag('Triple', (self) => hasBlankNodes(self.subject) || hasBlankNodes(self.object)),
  Match.tag(
    'Quad',
    (self) =>
      hasBlankNodes(self.subject) || hasBlankNodes(self.object) || hasBlankNodes(self.graph),
  ),
  Match.orElse(() => false),
);

/**
 * Whether a triple or quad mentions a blank node anywhere, including inside
 * nested triple terms.
 *
 * @since 0.1.0
 * @category predicates
 */
export const hasBlankNodes = (self: Term | Quad): boolean => blankNodesIn(self);

// Built once: `isGround` runs for every term of every pattern or quad it checks.
const groundCheck: (self: Term | Quad) => boolean = Match.type<Term | Quad>().pipe(
  Match.tag('Variable', () => false),
  Match.tag(
    'Triple',
    (self) => isGround(self.subject) && isGround(self.predicate) && isGround(self.object),
  ),
  Match.tag(
    'Quad',
    (self) =>
      isGround(self.subject) &&
      isGround(self.predicate) &&
      isGround(self.object) &&
      isGround(self.graph),
  ),
  Match.orElse(() => true),
);

/**
 * Whether a term or quad is free of variables.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isGround = (self: Term | Quad): boolean => groundCheck(self);

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Applies `f` to every term in a quad or triple term (recursively through
 * nested triple terms).
 *
 * @since 0.1.0
 * @category combinators
 */
export function mapTerms<T extends Quad | Triple>(
  self: T,
  f: (term: NamedNode | BlankNode | Literal | DefaultGraph) => Term,
): T;
export function mapTerms(
  self: Quad | Triple,
  f: (term: NamedNode | BlankNode | Literal | DefaultGraph) => Term,
): Quad | Triple {
  // SAFETY: `f` maps each leaf to a term of the same kind, so each position keeps its kind.
  const go = (term: Subject | Predicate | Object | Graph): Term =>
    term._tag === 'Triple'
      ? new Triple(
          go(term.subject) as Subject,
          go(term.predicate) as Predicate,
          go(term.object) as Object,
        )
      : f(term);
  if (self._tag === 'Triple') {
    // SAFETY: a triple maps to a triple.
    return go(self) as Triple;
  }
  // SAFETY: `f` maps each leaf to a term of the same kind, so each position keeps its kind.
  return new Quad(
    go(self.subject) as Subject,
    go(self.predicate) as Predicate,
    go(self.object) as Object,
    go(self.graph) as Graph,
  );
}

/**
 * A total ordering of terms suitable for deterministic serialisation:
 * default graph < blank nodes < IRIs < literals < triple terms < variables,
 * then by canonical key.
 *
 * @since 0.1.0
 * @category ordering
 */
export const compare = (a: Term, b: Term): -1 | 0 | 1 => {
  const ra = rank[a._tag];
  const rb = rank[b._tag];
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

const rank: Record<Term['_tag'], number> = {
  DefaultGraph: 0,
  BlankNode: 1,
  NamedNode: 2,
  Literal: 3,
  Triple: 4,
  Variable: 5,
};

/**
 * Orders quads by graph, subject, predicate, object.
 *
 * @since 0.1.0
 * @category ordering
 */
export const compareQuads = (a: Quad, b: Quad): -1 | 0 | 1 =>
  compare(a.graph, b.graph) ||
  compare(a.subject, b.subject) ||
  compare(a.predicate, b.predicate) ||
  compare(a.object, b.object);

/**
 * The `compare` ordering of terms as an Effect `Order`, for `Array.sort`,
 * `Order.mapInput` and the other `Order` combinators.
 *
 * @since 0.1.0
 * @category ordering
 */
export const Order: order.Order<Term> = order.make(compare);

/**
 * The `compareQuads` ordering (graph, subject, predicate, object) as an
 * Effect `Order`.
 *
 * @since 0.1.0
 * @category ordering
 */
export const QuadOrder: order.Order<Quad> = order.make(compareQuads);

/**
 * Term equality as an Effect `Equivalence`: the same as `Equal.equals`
 * (equal canonical keys).
 *
 * @since 0.1.0
 * @category equivalence
 */
export const Equivalence: equivalence.Equivalence<Term> = equivalence.make(
  (a, b) => a.key === b.key,
);

/**
 * Quad equality as an Effect `Equivalence`: the same as `Equal.equals`.
 *
 * @since 0.1.0
 * @category equivalence
 */
export const QuadEquivalence: equivalence.Equivalence<Quad> = equivalence.make(
  (a, b) => a.key === b.key,
);

// -----------------------------------------------------------------------------
// Escaping
// -----------------------------------------------------------------------------

// Built once: `escapeString` runs it for every character of a string that needs escaping.
const escapeChar: (ch: string) => string = Match.type<string>().pipe(
  Match.when('"', () => '\\"'),
  Match.when('\\', () => '\\\\'),
  Match.when('\n', () => '\\n'),
  Match.when('\r', () => '\\r'),
  Match.when('\t', () => '\\t'),
  Match.when('\b', () => '\\b'),
  Match.when('\f', () => '\\f'),
  Match.orElse((ch) => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || code === 0x7f || code === 0xfffe || code === 0xffff
      ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
      : ch;
  }),
);

/**
 * Escapes a string for use inside a double-quoted N-Triples / Turtle string
 * literal, using the canonical N-Triples escapes.
 *
 * @since 0.1.0
 * @category formatting
 */
export const escapeString = (value: string): string => {
  // eslint-disable-next-line no-control-regex
  if (!/["\\\u0000-\u001f\u007f\ufffe\uffff]/.test(value)) return value;
  let out = '';
  for (const ch of value) out += escapeChar(ch);
  return out;
};

// The characters an IRIREF cannot contain unescaped, hoisted so the hot
// `NamedNode.key` path does not build a regex per call. `replace` resets the
// global one's `lastIndex`, and `test` on the non-global one keeps no state.
// eslint-disable-next-line no-control-regex
const IRI_UNSAFE = /[\u0000- <>"{}|^`\\]/;
// eslint-disable-next-line no-control-regex
const IRI_UNSAFE_ALL = /[\u0000- <>"{}|^`\\]/g;

/**
 * Escapes characters that are not allowed inside `<...>` IRI references.
 *
 * @since 0.1.0
 * @category formatting
 */
export const escapeIri = (value: string): string =>
  IRI_UNSAFE.test(value)
    ? value.replace(
        IRI_UNSAFE_ALL,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      )
    : value;

// -----------------------------------------------------------------------------
// JSON
// -----------------------------------------------------------------------------

const namedNodeToJson = (n: NamedNode): TermJson.NamedNode => ({ type: 'uri', value: n.value });

const blankNodeToJson = (b: BlankNode): TermJson.BlankNode => ({ type: 'bnode', value: b.value });

const resourceToJson: (r: Resource) => TermJson.NamedNode | TermJson.BlankNode =
  Match.type<Resource>().pipe(
    Match.tag('NamedNode', namedNodeToJson),
    Match.tag('BlankNode', blankNodeToJson),
    Match.exhaustive,
  );

const literalToJson = (l: Literal): TermJson.Literal => {
  if (l.language !== '') {
    return l.direction === undefined
      ? { type: 'literal', value: l.value, 'xml:lang': l.language }
      : { type: 'literal', value: l.value, 'xml:lang': l.language, 'its:dir': l.direction };
  }
  return l.datatype.value === XSD_STRING
    ? { type: 'literal', value: l.value }
    : { type: 'literal', value: l.value, datatype: l.datatype.value };
};

const tripleToJson = (x: Triple): TermJson.Triple => ({
  type: 'triple',
  value: {
    subject: toJson(x.subject),
    predicate: namedNodeToJson(x.predicate),
    object: toJson(x.object),
  },
});

const variableToJson = (v: Variable): TermJson.Variable => ({ type: 'variable', value: v.value });

const defaultGraphToJson = (): TermJson.DefaultGraph => ({ type: 'default-graph' });

// Built once: `toJson` runs for every term a JSON codec or SPARQL results writer encodes.
const groundToJson: (self: GroundTerm) => TermJson.GroundTerm = Match.type<GroundTerm>().pipe(
  Match.tag('NamedNode', namedNodeToJson),
  Match.tag('BlankNode', blankNodeToJson),
  Match.tag('Literal', literalToJson),
  Match.tag('Triple', tripleToJson),
  Match.exhaustive,
);

const termToJson: (self: Term) => TermJson.Term = Match.type<Term>().pipe(
  Match.tag('Variable', variableToJson),
  Match.tag('DefaultGraph', defaultGraphToJson),
  Match.orElse(groundToJson),
);

/**
 * Encodes a term as JSON: the SPARQL 1.2 JSON results term for a ground term,
 * plus the `variable` and `default-graph` extensions (see `TermJson`).
 *
 * @since 0.1.0
 * @category json
 */
export function toJson(self: GroundTerm): TermJson.GroundTerm;
export function toJson(self: Term): TermJson.Term;
export function toJson(self: Term): TermJson.Term {
  return termToJson(self);
}

const literalFromJson = (l: TermJson.Literal): Literal => {
  const lang = l['xml:lang'];
  if (lang !== undefined && lang !== '') {
    const dir = l['its:dir'];
    return dir === 'ltr' || dir === 'rtl'
      ? literal(l.value, { language: lang, direction: dir })
      : literal(l.value, lang);
  }
  return l.datatype === undefined ? literal(l.value) : literal(l.value, namedNode(l.datatype));
};

const tripleFromJson = (x: TermJson.Triple): Triple =>
  // SAFETY: unchecked, as in SPARQL JSON results; `isWellFormed` (and the JSON codecs) check
  // that the positions hold a subject, an IRI predicate and an object.
  new Triple(
    fromJson(x.value.subject) as Subject,
    fromJson(x.value.predicate) as Predicate,
    fromJson(x.value.object),
  );

const groundFromJson: (json: TermJson.GroundTerm) => GroundTerm =
  Match.type<TermJson.GroundTerm>().pipe(
    Match.when({ type: 'uri' }, (u): GroundTerm => namedNode(u.value)),
    Match.when({ type: 'bnode' }, (b): GroundTerm => blankNode(b.value)),
    Match.when({ type: Match.is('literal', 'typed-literal') }, literalFromJson),
    Match.when({ type: 'triple' }, tripleFromJson),
    Match.exhaustive,
  );

// Built once: `fromJson` runs for every term of every JSON row it decodes.
const termFromJson: (json: TermJson.Term) => Term = Match.type<TermJson.Term>().pipe(
  Match.when({ type: 'variable' }, (v): Term => variable(v.value)),
  Match.when({ type: 'default-graph' }, (): Term => defaultGraph),
  Match.orElse(groundFromJson),
);

/**
 * Decodes a JSON term (see `TermJson`). Like a SPARQL JSON results reader,
 * it trusts the positions of a triple term; use `isWellFormed`, or decode
 * through `Schema.toCodecJson(TermSchema)`, to check them.
 *
 * @since 0.1.0
 * @category json
 */
export function fromJson(json: TermJson.GroundTerm): GroundTerm;
export function fromJson(json: TermJson.Term): Term;
export function fromJson(json: TermJson.Term): Term {
  return termFromJson(json);
}

const subjectToJson: (s: Subject) => TermJson.Quad['subject'] = Match.type<Subject>().pipe(
  Match.tag('Triple', tripleToJson),
  Match.orElse(resourceToJson),
);

/**
 * Encodes a quad as JSON; `graph` is omitted for the default graph.
 *
 * @since 0.1.0
 * @category json
 */
export const quadToJson = (self: Quad): TermJson.Quad => {
  const subject = subjectToJson(self.subject);
  const predicate = namedNodeToJson(self.predicate);
  const object = groundToJson(self.object);
  return Match.value(self.graph).pipe(
    Match.tag('DefaultGraph', (): TermJson.Quad => ({ subject, predicate, object })),
    Match.orElse((graph): TermJson.Quad => ({
      subject,
      predicate,
      object,
      graph: resourceToJson(graph),
    })),
  );
};

const resourceFromJson = (json: TermJson.NamedNode | TermJson.BlankNode): Resource =>
  json.type === 'uri' ? namedNode(json.value) : blankNode(json.value);

/**
 * Decodes a JSON quad; a missing `graph` is the default graph. Triple terms
 * are trusted as in `fromJson`.
 *
 * @since 0.1.0
 * @category json
 */
export const quadFromJson = (json: TermJson.Quad): Quad =>
  new Quad(
    json.subject.type === 'triple' ? tripleFromJson(json.subject) : resourceFromJson(json.subject),
    namedNode(json.predicate.value),
    groundFromJson(json.object),
    json.graph === undefined ? defaultGraph : resourceFromJson(json.graph),
  );

/**
 * Whether every triple term inside a term or quad, at any depth, has a
 * subject (IRI, blank node or triple term), an IRI predicate and an object
 * (anything but a variable or the default graph) — always true for terms
 * built with `triple` and `quad`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isWellFormed = (self: Term | Quad): boolean => wellFormedCheck(self);

// Built once: the JSON codecs run it on every term and quad they decode.
const wellFormedCheck: (self: Term | Quad) => boolean = Match.type<Term | Quad>().pipe(
  Match.tag('Quad', (q) => isWellFormed(q.subject) && isWellFormed(q.object)),
  Match.tag(
    'Triple',
    (x) =>
      isSubject(x.subject) &&
      isNamedNode(x.predicate) &&
      isObject(x.object) &&
      isWellFormed(x.subject) &&
      isWellFormed(x.object),
  ),
  Match.orElse(() => true),
);

/**
 * The `toCodecJson` (and `toCodecArbitrary`) link of a term declaration, to a
 * `TermJson`-shaped schema: decodes through `fromJson` and fails unless the
 * result is the declared kind and well formed.
 */
const jsonLink =
  <T extends Term, J extends TermJson.Term>(
    json: Schema.Codec<J>,
    is: (term: Term) => term is T,
    encode: (term: T) => J,
    expected: string,
  ) =>
  (): SchemaAST.Link =>
    Schema.link<T>()(
      json,
      SchemaTransformation.transformEffect<T, J>({
        decode: (j, options) => {
          const term = fromJson(j);
          return is(term) && isWellFormed(term)
            ? Effect.succeed(term)
            : Effect.fail(new SchemaIssue.InvalidValue({ expected }, j, options));
        },
        encode: (term) => Effect.succeed(encode(term)),
      }),
    );

/** The `toCodecJson` / `toCodecArbitrary` link of `QuadSchema`. */
const quadLink = (json: Schema.Codec<TermJson.Quad>) => (): SchemaAST.Link =>
  Schema.link<Quad>()(
    json,
    SchemaTransformation.transformEffect<Quad, TermJson.Quad>({
      decode: (j, options) => {
        const q = quadFromJson(j);
        return isWellFormed(q)
          ? Effect.succeed(q)
          : Effect.fail(
              new SchemaIssue.InvalidValue({ expected: 'a well-formed quad' }, j, options),
            );
      },
      encode: (q) => Effect.succeed(quadToJson(q)),
    }),
  );

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/**
 * Schema of an IRI term; its JSON codec is `TermJson.NamedNode`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const NamedNodeSchema: Schema.declare<NamedNode> = Schema.declare(isNamedNode, {
  identifier: 'NamedNode',
  toCodecJson: jsonLink(TermJson.NamedNodeSchema, isNamedNode, namedNodeToJson, 'an IRI'),
  toCodecArbitrary: jsonLink(Generate.NamedNode, isNamedNode, namedNodeToJson, 'an IRI'),
});

/**
 * The type `NamedNodeSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type NamedNodeSchema = typeof NamedNodeSchema.Type;

/**
 * Schema of a blank node; its JSON codec is `TermJson.BlankNode`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const BlankNodeSchema: Schema.declare<BlankNode> = Schema.declare(isBlankNode, {
  identifier: 'BlankNode',
  toCodecJson: jsonLink(TermJson.BlankNodeSchema, isBlankNode, blankNodeToJson, 'a blank node'),
  toCodecArbitrary: jsonLink(Generate.BlankNode, isBlankNode, blankNodeToJson, 'a blank node'),
});

/**
 * The type `BlankNodeSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type BlankNodeSchema = typeof BlankNodeSchema.Type;

/**
 * Schema of a literal; its JSON codec is `TermJson.Literal`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const LiteralSchema: Schema.declare<Literal> = Schema.declare(isLiteral, {
  identifier: 'Literal',
  toCodecJson: jsonLink(TermJson.LiteralSchema, isLiteral, literalToJson, 'a literal'),
  toCodecArbitrary: jsonLink(Generate.Literal, isLiteral, literalToJson, 'a literal'),
});

/**
 * The type `LiteralSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type LiteralSchema = typeof LiteralSchema.Type;

/**
 * Schema of a variable; its JSON codec is `TermJson.Variable`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const VariableSchema: Schema.declare<Variable> = Schema.declare(isVariable, {
  identifier: 'Variable',
  toCodecJson: jsonLink(TermJson.VariableSchema, isVariable, variableToJson, 'a variable'),
  toCodecArbitrary: jsonLink(Generate.Variable, isVariable, variableToJson, 'a variable'),
});

/**
 * The type `VariableSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type VariableSchema = typeof VariableSchema.Type;

/**
 * Schema of a triple term; its JSON codec is `TermJson.Triple`, and decoding rejects positions that don't fit RDF.
 *
 * @since 0.1.0
 * @category schemas
 */
export const TripleSchema: Schema.declare<Triple> = Schema.declare(isTriple, {
  identifier: 'Triple',
  toCodecJson: jsonLink(TermJson.TripleSchema, isTriple, tripleToJson, 'a well-formed triple term'),
  toCodecArbitrary: jsonLink(Generate.Triple, isTriple, tripleToJson, 'a well-formed triple term'),
});

/**
 * The type `TripleSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type TripleSchema = typeof TripleSchema.Type;

/**
 * Schema of a quad; its JSON codec is `TermJson.Quad`, with `graph` omitted for the default graph.
 *
 * @since 0.1.0
 * @category schemas
 */
export const QuadSchema: Schema.declare<Quad> = Schema.declare(isQuad, {
  identifier: 'Quad',
  toCodecJson: quadLink(TermJson.QuadSchema),
  toCodecArbitrary: quadLink(Generate.Quad),
});

/**
 * The type `QuadSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type QuadSchema = typeof QuadSchema.Type;

/**
 * Schema of any term; its JSON codec is `TermJson.Term`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const TermSchema: Schema.declare<Term> = Schema.declare(isTerm, {
  identifier: 'Term',
  toCodecJson: jsonLink(TermJson.TermSchema, isTerm, termToJson, 'a well-formed term'),
  toCodecArbitrary: jsonLink(Generate.Term, isTerm, termToJson, 'a well-formed term'),
});

/**
 * The type `TermSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type TermSchema = typeof TermSchema.Type;

/**
 * Schema of a ground term (no variables or default graph); its JSON codec is `TermJson.GroundTerm`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const GroundTermSchema: Schema.declare<GroundTerm> = Schema.declare(isGroundTerm, {
  identifier: 'GroundTerm',
  toCodecJson: jsonLink(
    TermJson.GroundTermSchema,
    isGroundTerm,
    groundToJson,
    'a well-formed ground term',
  ),
  toCodecArbitrary: jsonLink(
    Generate.GroundTerm,
    isGroundTerm,
    groundToJson,
    'a well-formed ground term',
  ),
});

/**
 * The type `GroundTermSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type GroundTermSchema = typeof GroundTermSchema.Type;
