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
import * as Equal from 'effect/Equal';
import * as Hash from 'effect/Hash';
import { NodeInspectSymbol } from 'effect/Inspectable';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import { hasProperty } from 'effect/Predicate';
import * as Schema from 'effect/Schema';

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
  if (typeof languageOrDatatype === 'string') {
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

/**
 * Whether a triple or quad mentions a blank node anywhere, including inside
 * nested triple terms.
 *
 * @since 0.1.0
 * @category predicates
 */
export const hasBlankNodes = (self: Term | Quad): boolean => {
  switch (self._tag) {
    case 'BlankNode':
      return true;
    case 'Triple':
      return hasBlankNodes(self.subject) || hasBlankNodes(self.object);
    case 'Quad':
      return hasBlankNodes(self.subject) || hasBlankNodes(self.object) || hasBlankNodes(self.graph);
    default:
      return false;
  }
};

/**
 * Whether a term or quad is free of variables.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isGround = (self: Term | Quad): boolean => {
  switch (self._tag) {
    case 'Variable':
      return false;
    case 'Triple':
      return isGround(self.subject) && isGround(self.predicate) && isGround(self.object);
    case 'Quad':
      return (
        isGround(self.subject) &&
        isGround(self.predicate) &&
        isGround(self.object) &&
        isGround(self.graph)
      );
    default:
      return true;
  }
};

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
  const go = (term: Subject | Predicate | Object | Graph): Term =>
    term._tag === 'Triple'
      ? new Triple(
          go(term.subject) as Subject,
          go(term.predicate) as Predicate,
          go(term.object) as Object,
        )
      : f(term);
  if (self._tag === 'Triple') return go(self) as Triple;
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

// -----------------------------------------------------------------------------
// Escaping
// -----------------------------------------------------------------------------

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
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      default: {
        const code = ch.codePointAt(0)!;
        out +=
          code < 0x20 || code === 0x7f || code === 0xfffe || code === 0xffff
            ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
            : ch;
      }
    }
  }
  return out;
};

/**
 * Escapes characters that are not allowed inside `<...>` IRI references.
 *
 * @since 0.1.0
 * @category formatting
 */
export const escapeIri = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  /[\u0000- <>"{}|^`\\]/.test(value)
    ? value.replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000- <>"{}|^`\\]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      )
    : value;

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/**
 * @since 0.1.0
 * @category schemas
 */
export const NamedNodeSchema: Schema.declare<NamedNode> = Schema.declare(isNamedNode, {
  identifier: 'NamedNode',
});

/**
 * The type `NamedNodeSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type NamedNodeSchema = typeof NamedNodeSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const BlankNodeSchema: Schema.declare<BlankNode> = Schema.declare(isBlankNode, {
  identifier: 'BlankNode',
});

/**
 * The type `BlankNodeSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type BlankNodeSchema = typeof BlankNodeSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const LiteralSchema: Schema.declare<Literal> = Schema.declare(isLiteral, {
  identifier: 'Literal',
});

/**
 * The type `LiteralSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type LiteralSchema = typeof LiteralSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const VariableSchema: Schema.declare<Variable> = Schema.declare(isVariable, {
  identifier: 'Variable',
});

/**
 * The type `VariableSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type VariableSchema = typeof VariableSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const TripleSchema: Schema.declare<Triple> = Schema.declare(isTriple, {
  identifier: 'Triple',
});

/**
 * The type `TripleSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type TripleSchema = typeof TripleSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const QuadSchema: Schema.declare<Quad> = Schema.declare(isQuad, { identifier: 'Quad' });

/**
 * The type `QuadSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type QuadSchema = typeof QuadSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const TermSchema: Schema.declare<Term> = Schema.declare(isTerm, { identifier: 'Term' });

/**
 * The type `TermSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type TermSchema = typeof TermSchema.Type;

/**
 * @since 0.1.0
 * @category schemas
 */
export const GroundTermSchema: Schema.declare<GroundTerm> = Schema.declare(isGroundTerm, {
  identifier: 'GroundTerm',
});

/**
 * The type `GroundTermSchema` decodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export type GroundTermSchema = typeof GroundTermSchema.Type;
