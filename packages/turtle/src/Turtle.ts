/**
 * RDF 1.2 Turtle: the terse RDF triple language.
 *
 * The parser supports the full RDF 1.2 grammar (triple terms `<<( s p o )>>`,
 * reified triples `<< s p o ~ r >>`, annotations `{| ... |}`, `VERSION`,
 * directional language tags) as well as RDF 1.1 documents, and reports the
 * declared prefixes and final base IRI. `parseStream` parses incrementally,
 * emitting statements as soon as they are complete.
 *
 * The serializer produces idiomatic output: prefixed names, `@base`
 * relativisation, subject grouping with `;` and `,`, `a` for `rdf:type`,
 * inline `[ ... ]` blank nodes, `( ... )` collections, numeric and boolean
 * shorthand, annotation syntax for reified asserted triples, and a
 * deterministic statement order.
 *
 * @example
 * ```ts
 * import { Effect } from 'effect'
 * import { PrefixMap } from '@thomasfosterau/effect-rdf'
 * import { Turtle } from '@thomasfosterau/effect-turtle'
 *
 * const program = Effect.gen(function* () {
 *   const { dataset, prefixes } = yield* Turtle.parse(`
 *     PREFIX ex: <http://example.org/>
 *     ex:alice a ex:Person ; ex:knows [ ex:name "Bob" ] .
 *   `)
 *   return yield* Turtle.serialize(dataset, { prefixes })
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Effect from 'effect/Effect';
import type * as Stream from 'effect/Stream';
import * as internal from './internal/parse.ts';
import * as internalSerialize from './internal/serialize.ts';

const syntax: internal.Syntax = { name: 'Turtle', trig: false };

/**
 * The result of `parseQuads`: statements in document order with the
 * document's prefixes and final base IRI.
 *
 * @since 0.1.0
 * @category models
 */
export type QuadsResult = internal.QuadsResult;

/**
 * Options for the Turtle serializer.
 *
 * @since 0.1.0
 * @category models
 */
export type SerializeOptions = internalSerialize.SerializeOptions;

/**
 * @since 0.1.0
 * @category formats
 */
export const format: Serialization.Format = Serialization.makeFormat({
  name: 'Turtle',
  mediaType: 'text/turtle',
  mediaTypes: ['text/turtle', 'application/x-turtle'],
  extensions: ['ttl'],
  datasets: false,
});

/**
 * Parses a Turtle document, returning the dataset together with the
 * declared prefixes and the final base IRI. Triples are placed in
 * `options.graph` (the default graph when omitted).
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  internal.parse(syntax, input, options);

/**
 * Parses a Turtle document into statements in document order.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQuads = (
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<QuadsResult, Serialization.RdfParseError> =>
  internal.parseQuads(syntax, input, options);

/**
 * Parses a stream of text chunks incrementally. Statements are emitted as
 * soon as they are complete; chunk boundaries may fall anywhere.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseStream: <E, R>(
  input: Stream.Stream<string, E, R>,
  options?: Serialization.ParseOptions,
) => Stream.Stream<Term.Quad, Serialization.RdfParseError | E, R> = internal.parseStream(syntax);

/**
 * Serialises triples as pretty Turtle. Fails for quads in named graphs and
 * for triple terms in the subject position (not expressible in Turtle 1.2).
 *
 * @since 0.1.0
 * @category serializing
 */
export const serialize = (
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  internalSerialize.serialize(syntax, quads, options);

/**
 * Serialises a stream of triples incrementally in constant memory. Only
 * consecutive statements are grouped, and blank nodes keep their labels.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializeStream: <E, R>(
  quads: Stream.Stream<Term.Quad, E, R>,
  options?: SerializeOptions,
) => Stream.Stream<string, Serialization.RdfSerializeError | E, R> =
  internalSerialize.serializeStream(syntax);

/**
 * @since 0.1.0
 * @category parsing
 */
export const parser: Serialization.Parser = Serialization.makeParser({
  format,
  parse,
  parseStream,
});

/**
 * @since 0.1.0
 * @category serializing
 */
export const serializer: Serialization.Serializer<SerializeOptions> = Serialization.makeSerializer({
  format,
  serialize,
  serializeStream,
});

/**
 * @since 0.1.0
 * @category codecs
 */
export const codec: Serialization.Codec<Serialization.ParseOptions, SerializeOptions> =
  Serialization.makeCodec(parser, serializer);
