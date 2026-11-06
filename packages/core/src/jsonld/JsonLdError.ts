/**
 * The error raised by every JSON-LD algorithm. It carries one of the error
 * codes defined by the JSON-LD 1.1 Processing Algorithms and API
 * specification (and the JSON-LD 1.1 Framing specification).
 *
 * @since 0.1.0
 */
import * as Schema from 'effect/Schema';

/**
 * The JSON-LD error codes.
 *
 * @since 0.1.0
 * @category models
 */
export const codes = [
  'colliding keywords',
  'conflicting indexes',
  'context overflow',
  'cyclic IRI mapping',
  'invalid @id value',
  'invalid @import value',
  'invalid @included value',
  'invalid @index value',
  'invalid @nest value',
  'invalid @prefix value',
  'invalid @propagate value',
  'invalid @protected value',
  'invalid @reverse value',
  'invalid @version value',
  'invalid base direction',
  'invalid base IRI',
  'invalid container mapping',
  'invalid context entry',
  'invalid context nullification',
  'invalid default language',
  'invalid IRI mapping',
  'invalid JSON literal',
  'invalid keyword alias',
  'invalid language map value',
  'invalid language mapping',
  'invalid language-tagged string',
  'invalid language-tagged value',
  'invalid local context',
  'invalid remote context',
  'invalid reverse property',
  'invalid reverse property map',
  'invalid reverse property value',
  'invalid scoped context',
  'invalid script element',
  'invalid set or list object',
  'invalid term definition',
  'invalid type mapping',
  'invalid type value',
  'invalid typed value',
  'invalid value object',
  'invalid value object value',
  'invalid vocab mapping',
  'IRI confused with prefix',
  'keyword redefinition',
  'loading document failed',
  'loading remote context failed',
  'multiple context link headers',
  'processing mode conflict',
  'protected term redefinition',
  'list of lists',
  'compaction to list of lists',
  'recursive context inclusion',
  'invalid frame',
  'invalid @embed value',
] as const;

/**
 * A JSON-LD error code, e.g. `"invalid @id value"`.
 *
 * @since 0.1.0
 * @category models
 */
export type Code = (typeof codes)[number];

/**
 * A JSON-LD processing error.
 *
 * @since 0.1.0
 * @category errors
 */
export class JsonLdError extends Schema.TaggedError<JsonLdError>()('JsonLdError', {
  code: Schema.Literals(codes),
  message: Schema.String,
}) {}

/**
 * Creates a `JsonLdError`. The message defaults to the code.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (code: Code, message?: string): JsonLdError =>
  new JsonLdError({ code, message: message === undefined ? code : `${code}: ${message}` });

/**
 * @since 0.1.0
 * @category guards
 */
export const isJsonLdError = (u: unknown): u is JsonLdError => u instanceof JsonLdError;
