/**
 * A complete parser for SPARQL 1.1 Query and Update, written with
 * `@thomasfosterau/effect-parse` (see `internal/parser.ts`), including the SPARQL 1.2 additions (triple terms, reified triples,
 * annotations, `VERSION`, directional language tags and the new built-in
 * functions).
 *
 * The parser expands all abbreviations (prefixed names, relative IRIs,
 * `a`, blank node property lists, collections, reifiers and annotations)
 * and enforces the static constraints of the specification (blank node
 * label scoping, grouping rules, `BIND`/`AS` scoping, `VALUES` arity,
 * variable-free `INSERT DATA`, blank-node-free `DELETE` templates, …).
 *
 * @since 0.1.0
 */
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import type * as Ast from './Ast.ts';
import * as Internal from './internal/parser.ts';

// -----------------------------------------------------------------------------
// Errors and options
// -----------------------------------------------------------------------------

/**
 * A syntax (or static semantic) error in a SPARQL query or update.
 *
 * @since 0.1.0
 * @category errors
 */
export class SparqlParseError extends Schema.TaggedError<SparqlParseError>()('SparqlParseError', {
  message: Schema.String,
  /** 1-based line of the error. */
  line: Schema.Number,
  /** 1-based column of the error. */
  column: Schema.Number,
  /** 0-based character offset of the error. */
  offset: Schema.Number,
}) {}

/**
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions {
  /** The base IRI used to resolve relative IRIs (unless overridden by `BASE`). */
  readonly baseIri?: string | undefined;
  /** Prefixes available without declaration. */
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
}

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

const position = (input: string, offset: number): { line: number; column: number } => {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < input.length; i++) {
    if (input[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
};

const toError =
  (input: string) =>
  (e: Internal.Failure): SparqlParseError => {
    const { line, column } = position(input, e.offset);
    return new SparqlParseError({
      message: `${e.message} (line ${line}, column ${column})`,
      line,
      column,
      offset: e.offset,
    });
  };

/**
 * Parses a SPARQL query, returning a `Result`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQueryResult = (
  input: string,
  options?: ParseOptions,
): Result.Result<Ast.Query, SparqlParseError> =>
  Result.mapError(Internal.parseQuery(input, options?.baseIri, options?.prefixes), toError(input));

/**
 * Parses a SPARQL update request, returning a `Result`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseUpdateResult = (
  input: string,
  options?: ParseOptions,
): Result.Result<Ast.Update, SparqlParseError> =>
  Result.mapError(Internal.parseUpdate(input, options?.baseIri, options?.prefixes), toError(input));

/**
 * Parses a SPARQL query.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQuery = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Ast.Query, SparqlParseError> =>
  Effect.suspend(() => Effect.fromResult(parseQueryResult(input, options)));

/**
 * Parses a SPARQL update request.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseUpdate = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Ast.Update, SparqlParseError> =>
  Effect.suspend(() => Effect.fromResult(parseUpdateResult(input, options)));

/**
 * Parses either a query or an update request: the text is parsed as a query
 * first and, if that fails, as an update.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<Ast.Query | Ast.Update, SparqlParseError> =>
  Effect.suspend((): Effect.Effect<Ast.Query | Ast.Update, SparqlParseError> => {
    const q = parseQueryResult(input, options);
    if (Result.isSuccess(q)) return Effect.succeed(q.success);
    const u = parseUpdateResult(input, options);
    if (Result.isSuccess(u)) return Effect.succeed(u.success);
    // Report the error of the parse that got further.
    return Effect.fail(q.failure.offset >= u.failure.offset ? q.failure : u.failure);
  });

/**
 * Parses a SPARQL query, throwing a `SparqlParseError` on failure.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseQueryUnsafe = (input: string, options?: ParseOptions): Ast.Query => {
  const r = parseQueryResult(input, options);
  if (Result.isFailure(r)) throw r.failure;
  return r.success;
};

/**
 * Parses a SPARQL update request, throwing a `SparqlParseError` on failure.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseUpdateUnsafe = (input: string, options?: ParseOptions): Ast.Update => {
  const r = parseUpdateResult(input, options);
  if (Result.isFailure(r)) throw r.failure;
  return r.success;
};
