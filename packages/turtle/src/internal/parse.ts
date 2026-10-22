import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Effect from 'effect/Effect';
import * as Predicate from 'effect/Predicate';
import * as Stream from 'effect/Stream';
import { SyntaxFailure, TurtleParser } from './parser.ts';

/** @internal */
export interface Syntax {
  readonly name: string;
  readonly trig: boolean;
}

/**
 * The result of parsing a document into quads in document order.
 *
 * @internal
 */
export interface QuadsResult {
  readonly quads: ReadonlyArray<Term.Quad>;
  readonly prefixes: PrefixMap.PrefixMap;
  readonly baseIri: string | undefined;
}

const makeParser = (syntax: Syntax, options?: Serialization.ParseOptions): TurtleParser =>
  new TurtleParser({
    trig: syntax.trig,
    baseIri: options?.baseIri,
    blankNodePrefix: options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix(),
    graph: (syntax.trig ? undefined : options?.graph) ?? Term.defaultGraph,
  });

/**
 * Maps what a parse threw — a `SyntaxFailure`, or a defect as an `Error` or
 * its string form — to an `RdfParseError`.
 */
const toParseError = (syntax: Syntax, error: Error | string): Serialization.RdfParseError =>
  error instanceof SyntaxFailure
    ? new Serialization.RdfParseError({
        format: syntax.name,
        message: error.message,
        line: error.line,
        column: error.column,
      })
    : new Serialization.RdfParseError({
        format: syntax.name,
        message: Predicate.isString(error) ? error : error.message,
      });

/** @internal */
export const parseQuads = (
  syntax: Syntax,
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<QuadsResult, Serialization.RdfParseError> =>
  Effect.try({
    try: () => {
      const parser = makeParser(syntax, options);
      const quads = parser.parseDocument(input);
      return {
        quads,
        prefixes: PrefixMap.make(parser.prefixes),
        baseIri: parser.base,
      };
    },
    catch: (error) => toParseError(syntax, Predicate.isError(error) ? error : String(error)),
  });

/** @internal */
export const parse = (
  syntax: Syntax,
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.map(parseQuads(syntax, input, options), (result) => ({
    dataset: Dataset.fromIterable(result.quads),
    prefixes: result.prefixes,
    baseIri: result.baseIri,
  }));

const END: unique symbol = Symbol('end');

/** @internal */
export const parseStream =
  (syntax: Syntax) =>
  <E, R>(
    input: Stream.Stream<string, E, R>,
    options?: Serialization.ParseOptions,
  ): Stream.Stream<Term.Quad, Serialization.RdfParseError | E, R> =>
    Stream.suspend(() => {
      const parser = makeParser(syntax, options);
      return Stream.concat(
        input as Stream.Stream<string | typeof END, E, R>,
        Stream.succeed(END),
      ).pipe(
        Stream.mapAccumArrayEffect(
          () => undefined,
          (_, chunks) =>
            Effect.try({
              try: () => {
                const out: Array<Term.Quad> = [];
                for (const chunk of chunks) {
                  const quads = chunk === END ? parser.end() : parser.feed(chunk);
                  for (const q of quads) out.push(q);
                }
                return [undefined, out] as const;
              },
              catch: (error) =>
                toParseError(syntax, Predicate.isError(error) ? error : String(error)),
            }),
        ),
      );
    });
