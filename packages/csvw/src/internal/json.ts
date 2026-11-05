/**
 * The one `JSON.parse` call of this package. It stays native because the
 * engine's `SyntaxError` text is part of the metadata error messages, and
 * `Schema.fromJsonString` replaces it with a generic issue.
 *
 * @internal
 */
import type * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import type * as Schema from 'effect/Schema';

/**
 * Parses JSON text, failing with the engine's `SyntaxError` message.
 *
 * @internal
 */
export const parseJson = (text: string): Result.Result<Schema.Json, string> =>
  Result.try({
    try: (): Schema.Json => JSON.parse(text),
    catch: (e) => (e instanceof SyntaxError ? e.message : String(e)),
  });

/**
 * Whether a JSON value is an object (not an array, not `null`).
 *
 * @internal
 */
export const isObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/**
 * Whether a JSON value is an array.
 *
 * @internal
 */
export const isArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

/**
 * The entries of a JSON object, in insertion order.
 *
 * @internal
 */
export const entries = (obj: Schema.JsonObject): Array<[string, Schema.Json]> =>
  Record.toEntries<string, Schema.Json>(obj);

/**
 * The keys of a JSON object, in insertion order.
 *
 * @internal
 */
export const keys = (obj: Schema.JsonObject): Array<string> =>
  Record.keys<string, Schema.Json>(obj);

/**
 * Whether a JSON object has a key.
 *
 * @internal
 */
export const has = (obj: Schema.JsonObject, key: string): boolean => obj[key] !== undefined;

/**
 * The value of a key of a JSON object.
 *
 * @internal
 */
export const get = (obj: Schema.JsonObject, key: string): Option.Option<Schema.Json> =>
  Record.get<string, Schema.Json>(obj, key);

/**
 * Maps the values of a JSON object.
 *
 * @internal
 */
export const mapValues = (
  obj: Schema.JsonObject,
  f: (value: Schema.Json, key: string) => Schema.Json,
): Schema.JsonObject => Record.map<string, Schema.Json, Schema.Json>(obj, f);

/**
 * A JSON object with one key set.
 *
 * @internal
 */
export const set = (obj: Schema.JsonObject, key: string, value: Schema.Json): Schema.JsonObject =>
  Record.set(
    Record.map<string, Schema.Json, Schema.Json>(obj, (v) => v),
    key,
    value,
  );

/**
 * A short description of a JSON value for messages: strings quoted, numbers
 * and booleans as written, `null`, and the kind of anything else.
 *
 * @internal
 */
export const describe = (value: Schema.Json): string => {
  if (Predicate.isString(value)) return `"${value}"`;
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return `${value}`;
  if (Predicate.isNull(value)) return 'null';
  return isArray(value) ? 'an array' : 'an object';
};
