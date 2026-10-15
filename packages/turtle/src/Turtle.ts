/**
 * RDF 1.2 Turtle.
 *
 * @since 0.1.0
 */
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import type * as Effect from 'effect/Effect';
import type * as Stream from 'effect/Stream';
import * as internal from './internal/parse.ts';

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
 * declared prefixes and the final base IRI.
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
 * @since 0.1.0
 * @category parsing
 */
export const parser: Serialization.Parser = Serialization.makeParser({
  format,
  parse,
  parseStream,
});
