import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as PrefixMap from '@thomasfosterau/effect-rdf/PrefixMap';
import * as Serialization from '@thomasfosterau/effect-rdf/Serialization';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Predicate from 'effect/Predicate';
import * as Stream from 'effect/Stream';
import * as Lexical from '../Lexical.ts';
import { LineParser, splitLines, SyntaxFailure } from './lineParser.ts';

/** @internal */
export interface Syntax {
  readonly name: string;
  readonly quads: boolean;
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
    try: () => {
      const parser = makeLineParser(syntax, options);
      const out: Array<Term.Quad> = [];
      const lines = splitLines(input);
      for (let i = 0; i < lines.length; i++) {
        const q = parser.parseLine(stripBom(lines[i]!, i + 1), i + 1);
        if (q !== undefined) out.push(q);
      }
      return out;
    },
    catch: toParseError(syntax),
  });

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
  }));

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
                for (const line of lines) {
                  lineNumber++;
                  const q = parser.parseLine(stripBom(line, lineNumber), lineNumber);
                  if (q !== undefined) out.push(q);
                }
                return [lineNumber, out] as const;
              },
              catch: toParseError(syntax),
            }),
        ),
      );
    });

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

const checkIris = (term: Term.Term): void => {
  switch (term._tag) {
    case 'NamedNode':
      if (!Lexical.isWritableIri(term.value)) {
        throw new SerializeFailure(`Invalid or relative IRI ${term.key}`);
      }
      return;
    case 'Literal':
      return checkIris(term.datatype);
    case 'Triple':
      checkIris(term.subject);
      checkIris(term.predicate);
      return checkIris(term.object);
    default:
      return;
  }
};

const formatQuad = (syntax: Syntax, quad: Term.Quad): string => {
  checkIris(quad.subject);
  checkIris(quad.predicate);
  checkIris(quad.object);
  checkIris(quad.graph);
  if (quad.subject._tag === 'Triple') {
    throw new SerializeFailure(
      `Triple terms are not allowed in the subject position in ${syntax.name}: ${quad.key}`,
    );
  }
  const s = Lexical.formatTerm(quad.subject);
  const o = Lexical.formatTerm(quad.object);
  if (s === undefined || o === undefined || quad.predicate._tag !== 'NamedNode') {
    throw new SerializeFailure(`Cannot serialise non-ground quad ${quad.key}`);
  }
  const triple = `${s} ${Lexical.formatIri(quad.predicate.value)} ${o}`;
  switch (quad.graph._tag) {
    case 'DefaultGraph':
      return `${triple} .\n`;
    case 'NamedNode':
    case 'BlankNode':
      if (!syntax.quads) {
        throw new SerializeFailure(
          `${syntax.name} cannot represent quads in named graphs: ${quad.key}`,
        );
      }
      return `${triple} ${Lexical.formatTerm(quad.graph)!} .\n`;
    default:
      throw new SerializeFailure(`Invalid graph term in ${quad.key}`);
  }
};

const formatAll = (syntax: Syntax, quads: Iterable<Term.Quad>): string => {
  let out = '';
  for (const q of quads) out += formatQuad(syntax, q);
  return out;
};

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
  });

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
    );

/** @internal */
export const formatStatement = formatQuad;
