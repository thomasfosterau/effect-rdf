/**
 * JSON text parsing that keeps the engine's `SyntaxError` text, which the
 * results parsers put in their error messages (`Schema.fromJsonString`
 * reports only "Expected a valid JSON string").
 *
 * @internal
 */
import * as Result from 'effect/Result';

/** Parses JSON text; the failure is the engine's `SyntaxError`, as text. */
export const parse = (text: string): Result.Result<unknown, string> =>
  Result.try({ try: () => JSON.parse(text), catch: (cause) => String(cause) });
