/**
 * Errors of the protocol layer. Every failure of a protocol request is
 * mapped to a `ProtocolError` carrying the HTTP status to answer with.
 *
 * @since 0.1.0
 */
import * as Schema from 'effect/Schema';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';

/**
 * A protocol-level failure: the HTTP status, a human-readable message (sent
 * as a `text/plain` body) and extra response headers (e.g. `Allow`).
 *
 * @since 0.1.0
 * @category errors
 */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()('ProtocolError', {
  status: Schema.Number,
  message: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

/**
 * `400 Bad Request`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const badRequest = (message: string): ProtocolError =>
  new ProtocolError({ status: 400, message });

/**
 * `403 Forbidden`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const forbidden = (message: string): ProtocolError =>
  new ProtocolError({ status: 403, message });

/**
 * `404 Not Found`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const notFound = (message: string): ProtocolError =>
  new ProtocolError({ status: 404, message });

/**
 * `405 Method Not Allowed` with an `Allow` header.
 *
 * @since 0.1.0
 * @category constructors
 */
export const methodNotAllowed = (method: string, allow: ReadonlyArray<string>): ProtocolError =>
  new ProtocolError({
    status: 405,
    message: `Method ${method} is not allowed here (allowed: ${allow.join(', ')})`,
    headers: { allow: allow.join(', ') },
  });

/**
 * `406 Not Acceptable`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const notAcceptable = (accept: string, available: ReadonlyArray<string>): ProtocolError =>
  new ProtocolError({
    status: 406,
    message: `None of the requested media types (${accept}) is available; available: ${available.join(', ')}`,
  });

/**
 * `415 Unsupported Media Type`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const unsupportedMediaType = (message: string): ProtocolError =>
  new ProtocolError({ status: 415, message });

/**
 * `500 Internal Server Error`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const internal = (message: string): ProtocolError =>
  new ProtocolError({ status: 500, message });

/**
 * `503 Service Unavailable`, used when a query exceeds the configured
 * timeout.
 *
 * @since 0.1.0
 * @category constructors
 */
export const timeout = (message: string): ProtocolError =>
  new ProtocolError({ status: 503, message });

/**
 * Renders a protocol error as a `text/plain` response.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toResponse = (error: ProtocolError): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(`${error.message}\n`, {
    status: error.status,
    headers: error.headers ?? {},
  });
