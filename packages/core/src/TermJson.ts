/**
 * The JSON shape of RDF terms and quads: the term encoding of the SPARQL 1.2
 * Query Results JSON Format (`{ "type": "uri", "value": … }`, triple terms
 * and `its:dir` included), extended with variables and the default graph.
 *
 * These are plain JSON schemas. `Term.toJson` / `Term.fromJson` convert
 * between them and terms, and the `Term` and `Dataset` schemas link to them
 * as their `toCodecJson` representation, so `Schema.toCodecJson(Term.TermSchema)`
 * and `Schema.toJsonSchemaDocument(Term.TermSchema)` work.
 *
 * Two members extend the SPARQL results format, which has no need for them:
 *
 * - a variable is `{ "type": "variable", "value": "name" }` (the name without
 *   the leading `?`);
 * - the default graph is `{ "type": "default-graph" }`.
 *
 * @since 0.1.0
 */
import * as Schema from 'effect/Schema';

/**
 * The JSON encoding of an IRI.
 *
 * @since 0.1.0
 * @category models
 */
export interface NamedNode {
  readonly type: 'uri';
  readonly value: string;
}

/**
 * The JSON encoding of a blank node; `value` is its label without `_:`.
 *
 * @since 0.1.0
 * @category models
 */
export interface BlankNode {
  readonly type: 'bnode';
  readonly value: string;
}

/**
 * The JSON encoding of a literal. A literal without `xml:lang` or `datatype`
 * is an `xsd:string`; `typed-literal` is the SPARQL 1.0 spelling, accepted
 * on input.
 *
 * @since 0.1.0
 * @category models
 */
export interface Literal {
  readonly type: 'literal' | 'typed-literal';
  readonly value: string;
  readonly 'xml:lang'?: string | undefined;
  readonly 'its:dir'?: string | undefined;
  readonly datatype?: string | undefined;
}

/**
 * The JSON encoding of a triple term. As in SPARQL JSON results, each
 * position holds any ground JSON term; `Term.TripleSchema`'s JSON codec
 * rejects a triple whose positions don't fit RDF.
 *
 * @since 0.1.0
 * @category models
 */
export interface Triple {
  readonly type: 'triple';
  readonly value: {
    readonly subject: GroundTerm;
    readonly predicate: GroundTerm;
    readonly object: GroundTerm;
  };
}

/**
 * The JSON encoding of a SPARQL variable (an extension of the SPARQL results
 * format); `value` is the name without `?`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Variable {
  readonly type: 'variable';
  readonly value: string;
}

/**
 * The JSON encoding of the default graph (an extension of the SPARQL results
 * format).
 *
 * @since 0.1.0
 * @category models
 */
export interface DefaultGraph {
  readonly type: 'default-graph';
}

/**
 * The JSON encoding of a ground term: exactly the RDF term of SPARQL 1.2
 * JSON results.
 *
 * @since 0.1.0
 * @category models
 */
export type GroundTerm = NamedNode | BlankNode | Literal | Triple;

/**
 * The JSON encoding of any term, variables and the default graph included.
 *
 * @since 0.1.0
 * @category models
 */
export type Term = GroundTerm | Variable | DefaultGraph;

/**
 * The JSON encoding of a quad. `graph` is omitted for the default graph.
 *
 * @since 0.1.0
 * @category models
 */
export interface Quad {
  readonly subject: NamedNode | BlankNode | Triple;
  readonly predicate: NamedNode;
  readonly object: GroundTerm;
  readonly graph?: NamedNode | BlankNode;
}

/**
 * Schema of the JSON encoding of an IRI.
 *
 * @since 0.1.0
 * @category schemas
 */
export const NamedNodeSchema: Schema.Codec<NamedNode> = Schema.Struct({
  type: Schema.Literal('uri'),
  value: Schema.String,
}).annotate({ identifier: 'JsonNamedNode' });

/**
 * The type `NamedNodeSchema` decodes to (the same as `NamedNode`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type NamedNodeSchema = typeof NamedNodeSchema.Type;

/**
 * Schema of the JSON encoding of a blank node.
 *
 * @since 0.1.0
 * @category schemas
 */
export const BlankNodeSchema: Schema.Codec<BlankNode> = Schema.Struct({
  type: Schema.Literal('bnode'),
  value: Schema.String,
}).annotate({ identifier: 'JsonBlankNode' });

/**
 * The type `BlankNodeSchema` decodes to (the same as `BlankNode`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type BlankNodeSchema = typeof BlankNodeSchema.Type;

/**
 * Schema of the JSON encoding of a literal.
 *
 * @since 0.1.0
 * @category schemas
 */
export const LiteralSchema: Schema.Codec<Literal> = Schema.Struct({
  type: Schema.Literals(['literal', 'typed-literal']),
  value: Schema.String,
  'xml:lang': Schema.optional(Schema.String),
  'its:dir': Schema.optional(Schema.String),
  datatype: Schema.optional(Schema.String),
}).annotate({ identifier: 'JsonLiteral' });

/**
 * The type `LiteralSchema` decodes to (the same as `Literal`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type LiteralSchema = typeof LiteralSchema.Type;

/**
 * Schema of the JSON encoding of a triple term.
 *
 * @since 0.1.0
 * @category schemas
 */
export const TripleSchema: Schema.Codec<Triple> = Schema.Struct({
  type: Schema.Literal('triple'),
  value: Schema.Struct({
    subject: Schema.suspend((): Schema.Codec<GroundTerm> => GroundTermSchema),
    predicate: Schema.suspend((): Schema.Codec<GroundTerm> => GroundTermSchema),
    object: Schema.suspend((): Schema.Codec<GroundTerm> => GroundTermSchema),
  }),
}).annotate({ identifier: 'JsonTriple' });

/**
 * The type `TripleSchema` decodes to (the same as `Triple`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type TripleSchema = typeof TripleSchema.Type;

/**
 * Schema of the JSON encoding of a variable.
 *
 * @since 0.1.0
 * @category schemas
 */
export const VariableSchema: Schema.Codec<Variable> = Schema.Struct({
  type: Schema.Literal('variable'),
  value: Schema.String,
}).annotate({ identifier: 'JsonVariable' });

/**
 * The type `VariableSchema` decodes to (the same as `Variable`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type VariableSchema = typeof VariableSchema.Type;

/**
 * Schema of the JSON encoding of the default graph.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DefaultGraphSchema: Schema.Codec<DefaultGraph> = Schema.Struct({
  type: Schema.Literal('default-graph'),
}).annotate({ identifier: 'JsonDefaultGraph' });

/**
 * The type `DefaultGraphSchema` decodes to (the same as `DefaultGraph`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type DefaultGraphSchema = typeof DefaultGraphSchema.Type;

/**
 * Schema of the JSON encoding of a ground term (the SPARQL 1.2 JSON results
 * term).
 *
 * @since 0.1.0
 * @category schemas
 */
export const GroundTermSchema: Schema.Codec<GroundTerm> = Schema.Union([
  NamedNodeSchema,
  BlankNodeSchema,
  LiteralSchema,
  TripleSchema,
]).annotate({ identifier: 'JsonGroundTerm' });

/**
 * The type `GroundTermSchema` decodes to (the same as `GroundTerm`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type GroundTermSchema = typeof GroundTermSchema.Type;

/**
 * Schema of the JSON encoding of any term.
 *
 * @since 0.1.0
 * @category schemas
 */
export const TermSchema: Schema.Codec<Term> = Schema.Union([
  NamedNodeSchema,
  BlankNodeSchema,
  LiteralSchema,
  TripleSchema,
  VariableSchema,
  DefaultGraphSchema,
]).annotate({ identifier: 'JsonTerm' });

/**
 * The type `TermSchema` decodes to (the same as `Term`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type TermSchema = typeof TermSchema.Type;

/**
 * Schema of the JSON encoding of a quad.
 *
 * @since 0.1.0
 * @category schemas
 */
export const QuadSchema: Schema.Codec<Quad> = Schema.Struct({
  subject: Schema.Union([NamedNodeSchema, BlankNodeSchema, TripleSchema]),
  predicate: NamedNodeSchema,
  object: GroundTermSchema,
  graph: Schema.optionalKey(Schema.Union([NamedNodeSchema, BlankNodeSchema])),
}).annotate({ identifier: 'JsonQuad' });

/**
 * The type `QuadSchema` decodes to (the same as `Quad`).
 *
 * @since 0.1.0
 * @category schemas
 */
export type QuadSchema = typeof QuadSchema.Type;
