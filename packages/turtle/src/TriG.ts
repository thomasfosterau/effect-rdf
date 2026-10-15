/**
 * RDF 1.2 TriG: Turtle extended with named graphs.
 *
 * Supports the same RDF 1.2 features as `Turtle`, plus `GRAPH` blocks and
 * `{ ... }` default-graph blocks. The serializer writes default-graph
 * triples at the top level followed by one block per named graph, with the
 * same pretty-printing as the Turtle serializer.
 *
 * @example
 * ```ts
 * import { Effect } from 'effect'
 * import { TriG } from '@thomasfosterau/effect-turtle'
 *
 * const program = Effect.gen(function* () {
 *   const { dataset, prefixes } = yield* TriG.parse(`
 *     PREFIX ex: <http://example.org/>
 *     ex:g { ex:s ex:p ex:o }
 *   `)
 *   return yield* TriG.serialize(dataset, { prefixes })
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

const syntax: internal.Syntax = { name: 'TriG', trig: true };

/**
 * The result of `parseQuads`: statements in document order with the
 * document's prefixes and final base IRI.
 *
 * @since 0.1.0
 * @category models
 */
export type QuadsResult = internal.QuadsResult;

/**
 * Options for the TriG serializer.
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
  name: 'TriG',
  mediaType: 'application/trig',
  extensions: ['trig'],
  datasets: true,
});

/**
 * Parses a TriG document, returning the dataset together with the declared
 * prefixes and the final base IRI.
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
 * Parses a TriG document into statements in document order.
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
 * soon as they are complete (statements inside graph blocks individually);
 * chunk boundaries may fall anywhere.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseStream: <E, R>(
  input: Stream.Stream<string, E, R>,
  options?: Serialization.ParseOptions,
) => Stream.Stream<Term.Quad, Serialization.RdfParseError | E, R> = internal.parseStream(syntax);

/**
 * Serialises quads as pretty TriG. Fails for triple terms in the subject
 * position (not expressible in TriG 1.2).
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
 * Serialises a stream of quads incrementally in constant memory. Only
 * consecutive statements are grouped (a graph block is opened whenever the
 * graph changes), and blank nodes keep their labels.
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
