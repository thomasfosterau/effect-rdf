/**
 * The errors of the SPARQL client. Every operation fails with a
 * `SparqlClientError`, one of:
 *
 * - `HttpStatusError`: the server answered with a non-success status (the
 *   response body is kept, e.g. a syntax error message);
 * - `MalformedResponseError`: the response could not be parsed;
 * - `UnsupportedMediaTypeError`: the response has a media type the client
 *   cannot read;
 * - `TransportError`: the request could not be sent or the response not
 *   received;
 * - `TimeoutError`: the request exceeded the configured timeout;
 * - `ConfigurationError`: the operation needs an endpoint that is not
 *   configured.
 *
 * @since 0.1.0
 */
import * as Match from 'effect/Match';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';

/**
 * The server answered with a non-success HTTP status.
 *
 * @since 0.1.0
 * @category errors
 */
export class HttpStatusError extends Schema.TaggedError<HttpStatusError>()('HttpStatusError', {
  method: Schema.String,
  url: Schema.String,
  status: Schema.Number,
  /** The response body (truncated to 64 KiB). */
  body: Schema.String,
}) {
  override get message(): string {
    const body = this.body.trim();
    return `${this.method} ${this.url} failed with status ${this.status}${body === '' ? '' : `: ${body.slice(0, 500)}`}`;
  }
}

/**
 * The response could not be parsed.
 *
 * @since 0.1.0
 * @category errors
 */
export class MalformedResponseError extends Schema.TaggedError<MalformedResponseError>()(
  'MalformedResponseError',
  {
    message: Schema.String,
    contentType: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The response has a media type the client cannot read.
 *
 * @since 0.1.0
 * @category errors
 */
export class UnsupportedMediaTypeError extends Schema.TaggedError<UnsupportedMediaTypeError>()(
  'UnsupportedMediaTypeError',
  {
    contentType: Schema.String,
    expected: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Unsupported response media type '${this.contentType}' (expected one of ${this.expected.join(', ')})`;
  }
}

/**
 * The request could not be sent or the response not received.
 *
 * @since 0.1.0
 * @category errors
 */
export class TransportError extends Schema.TaggedError<TransportError>()('TransportError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The request exceeded the configured timeout.
 *
 * @since 0.1.0
 * @category errors
 */
export class TimeoutError extends Schema.TaggedError<TimeoutError>()('TimeoutError', {
  message: Schema.String,
}) {}

/**
 * The operation needs an endpoint that is not configured (e.g. a Graph
 * Store operation without `graphStoreEndpoint`).
 *
 * @since 0.1.0
 * @category errors
 */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  'ConfigurationError',
  {
    message: Schema.String,
  },
) {}

/**
 * Any error of the SPARQL client.
 *
 * @since 0.1.0
 * @category errors
 */
export type SparqlClientError =
  | HttpStatusError
  | MalformedResponseError
  | UnsupportedMediaTypeError
  | TransportError
  | TimeoutError
  | ConfigurationError;

const TAGS = new Set([
  'HttpStatusError',
  'MalformedResponseError',
  'UnsupportedMediaTypeError',
  'TransportError',
  'TimeoutError',
  'ConfigurationError',
]);

/**
 * Whether a value is a `SparqlClientError`.
 *
 * @since 0.1.0
 * @category guards
 */
export const isSparqlClientError = (u: unknown): u is SparqlClientError =>
  Predicate.isTagged(u, 'HttpStatusError') ||
  (Predicate.hasProperty(u, '_tag') && Predicate.isString(u._tag) && TAGS.has(u._tag));

/**
 * Whether an error is worth retrying: transport failures, timeouts, and the
 * statuses `408`, `429`, `502`, `503` and `504`.
 *
 * @since 0.1.0
 * @category guards
 */
export const isTransient = (error: SparqlClientError): boolean => {
  return Match.value(error).pipe(
    Match.tag('TransportError', 'TimeoutError', () => true),
    Match.tag('HttpStatusError', (error) => [408, 429, 502, 503, 504].includes(error.status)),
    Match.orElse(() => false),
  );
};
