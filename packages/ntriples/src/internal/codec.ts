import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Iterable from 'effect/Iterable';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Stream from 'effect/Stream';
import * as Lexical from '../Lexical.ts';
import { LineParser, splitLines, SyntaxFailure } from './lineParser.ts';

/** @internal */
export interface Syntax {
  readonly name: string;
  readonly quads: boolean;
  /** The span prefix and format for tracing (`<module>.parse`, …); untraced when absent. */
  readonly trace?: Serialization.SpanTarget;
}

const makeLineParser = (syntax: Syntax, options?: Serialization.ParseOptions): LineParser =>
  new LineParser({
    quads: syntax.quads,
    blankNodePrefix: options?.blankNodePrefix ?? Serialization.freshBlankNodePrefix(),
    graph: options?.graph ?? Term.defaultGraph,
  });

const toParseError =
  (syntax: Syntax) =>
  (cause: unknown): Serialization.RdfParseError =>
    cause instanceof SyntaxFailure
      ? new Serialization.RdfParseError({
          format: syntax.name,
          message: cause.message,
          line: cause.line,
          column: cause.column,
        })
      : new Serialization.RdfParseError({ format: syntax.name, message: String(cause) });

const stripBom = (line: string, lineNumber: number): string =>
  lineNumber === 1 && line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;

/**
 * Parses a whole document synchronously into an array of quads, in document
 * order.
 *
 * @internal
 */
export const parseQuads = (
  syntax: Syntax,
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<Array<Term.Quad>, Serialization.RdfParseError> =>
  Effect.try({
    try: () => parseLines(makeLineParser(syntax, options), input),
    catch: toParseError(syntax),
  });

/** The statements of every line of `input`, in order (throws a `SyntaxFailure`). */
const parseLines = (parser: LineParser, input: string): Array<Term.Quad> => {
  const out: Array<Term.Quad> = [];
  splitLines(input).forEach((line, i) => {
    const q = parser.parseLine(stripBom(line, i + 1), i + 1);
    if (Option.isSome(q)) out.push(q.value);
  });
  return out;
};

/** @internal */
export const parse = (
  syntax: Syntax,
  input: string,
  options?: Serialization.ParseOptions,
): Effect.Effect<Serialization.ParseResult, Serialization.RdfParseError> =>
  Effect.map(parseQuads(syntax, input, options), (quads) => ({
    dataset: Dataset.fromIterable(quads),
    prefixes: PrefixMap.empty,
    baseIri: undefined,
  })).pipe(Serialization.withParseSpan(syntax.trace, input));

/** @internal */
export const parseStream =
  (syntax: Syntax) =>
  <E, R>(
    input: Stream.Stream<string, E, R>,
    options?: Serialization.ParseOptions,
  ): Stream.Stream<Term.Quad, Serialization.RdfParseError | E, R> =>
    Stream.suspend(() => {
      const parser = makeLineParser(syntax, options);
      return input.pipe(
        Stream.splitLines,
        Stream.mapAccumArrayEffect(
          () => 0,
          (lineNumber, lines) =>
            Effect.try({
              try: () => {
                const out: Array<Term.Quad> = [];
                let n = lineNumber;
                Arr.forEach(lines, (line) => {
                  n++;
                  const q = parser.parseLine(stripBom(line, n), n);
                  if (Option.isSome(q)) out.push(q.value);
                });
                return [n, out] as const;
              },
              catch: toParseError(syntax),
            }),
        ),
      );
    }).pipe(Serialization.withStreamSpan(syntax.trace, 'parseStream'));

/**
 * Options for the N-Triples and N-Quads serializers.
 *
 * @since 0.1.0
 * @category models
 */
export interface SerializeOptions extends Serialization.SerializeOptions {
  /**
   * Sort statements (by graph, subject, predicate, object) for a fully
   * deterministic document. Defaults to `false`, which keeps input order.
   * Ignored by `serializeStream`.
   */
  readonly sort?: boolean | undefined;
}

class SerializeFailure extends Error {}

// Built once: `checkIris` runs for every term of every quad serialised.
const checkIris: (term: Term.Term) => void = Match.type<Term.Term>().pipe(
  Match.withReturnType<void>(),
  Match.tag('NamedNode', (term) => {
    if (!Lexical.isWritableIri(term.value)) {
      throw new SerializeFailure(`Invalid or relative IRI ${term.key}`);
    }
  }),
  Match.tag('Literal', (term) => checkIris(term.datatype)),
  Match.tag('Triple', (term) => {
    checkIris(term.subject);
    checkIris(term.predicate);
    checkIris(term.object);
  }),
  Match.orElse(() => undefined),
);

// Built once: `formatQuad` runs it for every quad serialised.
const formatGraph = Match.fn(
  (quad: Term.Quad, _syntax: Syntax, _triple: string) => quad.graph,
).pipe(
  Match.withReturnType<string>(),
  Match.tag('DefaultGraph', (_graph, _quad, _syntax, triple) => `${triple} .\n`),
  Match.tag('NamedNode', 'BlankNode', (graph, quad, syntax, triple) => {
    if (!syntax.quads) {
      throw new SerializeFailure(
        `${syntax.name} cannot represent quads in named graphs: ${quad.key}`,
      );
    }
    // An IRI or blank node always has an N-Triples form
    return `${triple} ${Lexical.formatTerm(graph) ?? ''} .\n`;
  }),
  Match.orElse((_graph, quad) => {
    throw new SerializeFailure(`Invalid graph term in ${quad.key}`);
  }),
);

const formatQuad = (syntax: Syntax, quad: Term.Quad): string => {
  checkIris(quad.subject);
  checkIris(quad.predicate);
  checkIris(quad.object);
  checkIris(quad.graph);
  if (Predicate.isTagged(quad.subject, 'Triple')) {
    throw new SerializeFailure(
      `Triple terms are not allowed in the subject position in ${syntax.name}: ${quad.key}`,
    );
  }
  const s = Lexical.formatTerm(quad.subject);
  const o = Lexical.formatTerm(quad.object);
  if (s === undefined || o === undefined || !Predicate.isTagged(quad.predicate, 'NamedNode')) {
    throw new SerializeFailure(`Cannot serialise non-ground quad ${quad.key}`);
  }
  const triple = `${s} ${Lexical.formatIri(quad.predicate.value)} ${o}`;
  return formatGraph(quad, syntax, triple);
};

const formatAll = (syntax: Syntax, quads: Iterable<Term.Quad>): string =>
  Iterable.reduce(quads, '', (out, q) => out + formatQuad(syntax, q));

const toSerializeError =
  (syntax: Syntax) =>
  (cause: unknown): Serialization.RdfSerializeError =>
    new Serialization.RdfSerializeError({
      format: syntax.name,
      message: Predicate.isError(cause) ? cause.message : String(cause),
    });

/** @internal */
export const serialize = (
  syntax: Syntax,
  quads: Iterable<Term.Quad>,
  options?: SerializeOptions,
): Effect.Effect<string, Serialization.RdfSerializeError> =>
  Effect.try({
    try: () =>
      formatAll(syntax, options?.sort === true ? Arr.sort(quads, Term.compareQuads) : quads),
    catch: toSerializeError(syntax),
  }).pipe(Serialization.withSerializeSpan(syntax.trace));

/** @internal */
export const serializeStream =
  (syntax: Syntax) =>
  <E, R>(
    quads: Stream.Stream<Term.Quad, E, R>,
    _options?: SerializeOptions,
  ): Stream.Stream<string, Serialization.RdfSerializeError | E, R> =>
    quads.pipe(
      Stream.chunks,
      Stream.mapEffect((chunk) =>
        Effect.try({
          try: () => formatAll(syntax, chunk),
          catch: toSerializeError(syntax),
        }),
      ),
      Serialization.withStreamSpan(syntax.trace, 'serializeStream'),
    );

/** @internal */
export const formatStatement = formatQuad;
