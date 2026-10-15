/**
 * RDF 1.2 N-Quads: a line-based, plain-text format for RDF datasets.
 *
 * The parser is strict and streaming (see `NTriples`); the serializer emits
 * canonical N-Quads.
 *
 * @example
 * ```ts
 * import { Effect } from 'effect'
 * import { NQuads } from '@thomasfosterau/effect-rdf-ntriples'
 *
 * const program = Effect.gen(function* () {
 *   const { dataset } = yield* NQuads.parse('<http://ex/s> <http://ex/p> <http://ex/o> <http://ex/g> .\n')
 *   return yield* NQuads.serialize(dataset, { sort: true })
 * })
 * ```
 *
 * @since 0.1.0
 */
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Effect from 'effect/Effect';
import type * as Stream from 'effect/Stream';
import * as internal from './internal/codec.ts';

const syntax: internal.Syntax = { name: 'N-Quads', quads: true };

/**
 * Options for the N-Quads serializer.
 *
 * @since 0.1.0
 * @category models
 */
export type SerializeOptions = internal.SerializeOptions;

/**
 * @since 0.1.0
 * @category formats
 */
export const format: Serialization.Format = Serialization.makeFormat({
  name: 'N-Quads',
  mediaType: 'application/n-quads',
  extensions: ['nq'],
  datasets: true,
});

/**
 * Parses an N-Quads document. Statements without a graph label are placed
 * in `options.graph` (the default graph when omitted).
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
 * Parses an N-Quads document into quads in document order (duplicates are
 * kept).
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQuads = (
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<ReadonlyArray<Term.Quad>, Serialization.RdfParseError> =>
  internal.parseQuads(syntax, input, options);

/**
 * Parses a stream of text chunks incrementally, line by line. Chunk
 * boundaries may fall anywhere.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseStream: <E, R>(
  input: Stream.Stream<string, E, R>,
  options?: Serialization.ParseOptions,
) => Stream.Stream<Term.Quad, Serialization.RdfParseError | E, R> = internal.parseStream(syntax);

/**
 * Serialises quads as canonical N-Quads. Fails for triple terms in the
 * subject position.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serialize = (
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  internal.serialize(syntax, quads, options);

/**
 * Serialises a stream of quads incrementally as canonical N-Quads.
 *
 * @since 0.1.0
 * @category serializing
 */
export const serializeStream: <E, R>(
  quads: Stream.Stream<Term.Quad, E, R>,
  options?: SerializeOptions,
) => Stream.Stream<string, Serialization.RdfSerializeError | E, R> =
  internal.serializeStream(syntax);

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
