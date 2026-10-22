/**
 * `JSON.parse` as a `Result`, keeping the engine's `SyntaxError` as the
 * failure: `Schema.fromJsonString` reports only "Expected a valid JSON
 * string", which drops the position the streaming parser's messages carry.
 *
 * @internal
 */
import * as Result from 'effect/Result';

/** Parses a JSON text, failing with the engine's error. */
export const parse = (text: string): Result.Result<unknown, unknown> =>
  Result.try(() => JSON.parse(text));
