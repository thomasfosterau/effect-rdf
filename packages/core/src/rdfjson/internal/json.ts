/**
 * The one `JSON.parse` call of this package. It stays native because the
 * engine's `SyntaxError` text is part of the parse error messages, and
 * `Schema.fromJsonString` replaces it with a generic issue.
 *
 * @internal
 */
import * as Result from 'effect/Result';

/**
 * Parses JSON text, failing with the engine's `SyntaxError`.
 *
 * @internal
 */
export const parseJson = (text: string): Result.Result<unknown, SyntaxError> =>
  Result.try({
    try: () => JSON.parse(text),
    catch: (e) => (e instanceof SyntaxError ? e : new SyntaxError(String(e))),
  });
