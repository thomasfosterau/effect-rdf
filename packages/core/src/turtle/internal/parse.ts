import * as Dataset from '../../Dataset.ts';
import * as PrefixMap from '../../PrefixMap.ts';
import * as Serialization from '../../Serialization.ts';
import * as Term from '../../Term.ts';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Stream from 'effect/Stream';
import { SyntaxFailure, TurtleParser } from './parser.ts';

/** @internal */
export interface Syntax {
  readonly name: string;
  readonly trig: boolean;
  /** The span prefix and format for tracing (`<module>.parse`, …); untraced when `None`. */
  readonly trace: Option.Option<Serialization.SpanTarget>;
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
    baseIri: Option.fromUndefinedOr(options?.baseIri),
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
        baseIri: Option.getOrUndefined(parser.base),
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
  })).pipe(Serialization.withParseSpan(Option.getOrUndefined(syntax.trace), input));

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
      return Stream.concat(input, Stream.succeed(END)).pipe(
        Stream.mapAccumArrayEffect(
          () => undefined,
          (_, chunks) =>
            Effect.try({
              try: (): readonly [undefined, ReadonlyArray<Term.Quad>] => [
                undefined,
                Arr.flatMap(chunks, (chunk) => (chunk === END ? parser.end() : parser.feed(chunk))),
              ],
              catch: (error) =>
                toParseError(syntax, Predicate.isError(error) ? error : String(error)),
            }),
        ),
      );
    }).pipe(Serialization.withStreamSpan(Option.getOrUndefined(syntax.trace), 'parseStream'));
