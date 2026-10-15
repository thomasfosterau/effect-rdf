import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import type { Syntax } from './parse.ts';
import { StreamWriter } from './streamWriter.ts';
import { prepare, Writer, type WriterOptions } from './writer.ts';

/**
 * Options for the Turtle and TriG serializers.
 *
 * @since 0.1.0
 * @category models
 */
export interface SerializeOptions extends Serialization.SerializeOptions {
  /**
   * Also declare prefixes detected from the data: well-known vocabularies
   * (`rdf`, `rdfs`, `xsd`, `owl`) and `nsN` prefixes for other namespaces
   * used at least twice. Prefixes in `prefixes` take precedence. Defaults to
   * `false`. Ignored by `serializeStream`.
   */
  readonly autoPrefixes?: boolean | undefined;
  /** Use SPARQL-style `PREFIX` / `BASE` directives. Defaults to `false`. */
  readonly sparqlDirectives?: boolean | undefined;
  /** The indentation unit. Defaults to four spaces. */
  readonly indent?: string | undefined;
}

const writerOptions = (syntax: Syntax, options?: SerializeOptions): WriterOptions => ({
  trig: syntax.trig,
  prefixes: options?.prefixes,
  baseIri: options?.baseIri,
  autoPrefixes: options?.autoPrefixes ?? false,
  sparqlDirectives: options?.sparqlDirectives ?? false,
  indent: options?.indent ?? '    ',
});

const toSerializeError = (syntax: Syntax, error: unknown): Serialization.RdfSerializeError =>
  new Serialization.RdfSerializeError({
    format: syntax.name,
    message: error instanceof Error ? error.message : String(error),
  });

/** @internal */
export const serialize = (
  syntax: Syntax,
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  Effect.try({
    try: () => new Writer(writerOptions(syntax, options), prepare(quads)).write(),
    catch: (error) => toSerializeError(syntax, error),
  });

/** @internal */
export const serializeStream =
  (syntax: Syntax) =>
  <E, R>(
    quads: Stream.Stream<Term.Quad, E, R>,
    options?: SerializeOptions,
  ): Stream.Stream<string, Serialization.RdfSerializeError | E, R> =>
    Stream.suspend(() => {
      const writer = new StreamWriter(writerOptions(syntax, options));
      const write = (f: () => string) =>
        Effect.try({ try: f, catch: (error) => toSerializeError(syntax, error) });
      return quads.pipe(
        Stream.chunks,
        Stream.mapEffect((chunk) => write(() => writer.write(chunk))),
        Stream.concat(Stream.fromEffect(write(() => writer.end()))),
        Stream.filter((s) => s !== ''),
      );
    });
