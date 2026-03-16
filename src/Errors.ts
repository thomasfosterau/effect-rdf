/**
 * Error types for effect-rdf.
 *
 * All errors use `Data.TaggedError` so they carry a discriminant `_tag`,
 * support structural equality, and integrate naturally with `Effect`.
 *
 * @since 0.1.0
 */
import { Data } from "effect"

/**
 * Raised when a string cannot be interpreted as a valid IRI.
 *
 * @since 0.1.0
 * @category errors
 */
export class InvalidIRIError extends Data.TaggedError("InvalidIRIError")<{
  /** The offending input string. */
  readonly input: string
  /** Human-readable explanation. */
  readonly message: string
}> {}

/**
 * Raised when an RDF literal is constructed with an invalid language tag or
 * datatype combination.
 *
 * @since 0.1.0
 * @category errors
 */
export class InvalidLiteralError extends Data.TaggedError("InvalidLiteralError")<{
  readonly message: string
}> {}

/**
 * Raised by the Parser service when serialised RDF input cannot be parsed.
 *
 * @since 0.1.0
 * @category errors
 */
export class ParseError extends Data.TaggedError("ParseError")<{
  /** The format that was being parsed (e.g. "N-Triples", "Turtle"). */
  readonly format: string
  /** Zero-based line number, if known. */
  readonly line: number | undefined
  readonly message: string
}> {}

/**
 * Raised by the Serializer service when quads cannot be serialised.
 *
 * @since 0.1.0
 * @category errors
 */
export class SerializeError extends Data.TaggedError("SerializeError")<{
  readonly message: string
}> {}

/**
 * Union of all error types produced by this library.
 *
 * @since 0.1.0
 * @category errors
 */
export type RdfError = InvalidIRIError | InvalidLiteralError | ParseError | SerializeError
