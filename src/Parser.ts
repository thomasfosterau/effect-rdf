/**
 * Parser service — an Effect `Context.Tag` for RDF parsers.
 *
 * This module defines the `Parser` service interface and tag.  Concrete
 * parser implementations (e.g. N-Triples, Turtle) are provided as separate
 * `Layer` values.
 *
 * The service is intentionally stubbed: the helper `unimplemented` layers
 * exist so that callers can wire the service into their dependency graph
 * today while concrete parsers are added incrementally.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import * as P from "./Parser.js"
 *
 * // Use the service through the Effect context
 * const program = Effect.gen(function* () {
 *   const parser = yield* P.Parser
 *   const quads = yield* parser.parseNTriples(
 *     `<https://example.org/s> <https://example.org/p> "o" .`
 *   )
 *   return quads
 * })
 * ```
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import { Quad } from "./Quad.js"
import { IRI } from "./IRI.js"
import { ParseError } from "./Errors.js"

// ---------------------------------------------------------------------------
// Prefix table
// ---------------------------------------------------------------------------

/**
 * A mapping from prefix labels (e.g. `"rdf"`) to base IRI strings.
 *
 * @since 0.1.0
 * @category models
 */
export type Prefixes = Readonly<Record<string, string>>

// ---------------------------------------------------------------------------
// Parser options
// ---------------------------------------------------------------------------

/**
 * Options shared by all parser methods.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParseOptions {
  /**
   * Base IRI used to resolve relative IRIs in the input.
   * Mandatory for formats that support relative IRIs (e.g. Turtle).
   */
  readonly baseIRI?: IRI | undefined
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * The operations provided by a `Parser` service.
 *
 * @since 0.1.0
 * @category models
 */
export interface ParserService {
  /**
   * Parses an N-Triples document (`application/n-triples`) and returns the
   * quads it describes (all in the default graph).
   *
   * @see https://www.w3.org/TR/n-triples/
   */
  readonly parseNTriples: (
    input: string,
    options?: ParseOptions
  ) => Effect.Effect<ReadonlyArray<Quad>, ParseError>

  /**
   * Parses an N-Quads document (`application/n-quads`) and returns the quads.
   *
   * @see https://www.w3.org/TR/n-quads/
   */
  readonly parseNQuads: (
    input: string,
    options?: ParseOptions
  ) => Effect.Effect<ReadonlyArray<Quad>, ParseError>

  /**
   * Parses a Turtle document (`text/turtle`) and returns the quads it
   * describes (all in the default graph).
   *
   * @see https://www.w3.org/TR/turtle/
   */
  readonly parseTurtle: (
    input: string,
    options?: ParseOptions
  ) => Effect.Effect<ReadonlyArray<Quad>, ParseError>

  /**
   * Parses a TriG document (`application/trig`) and returns the quads.
   *
   * @see https://www.w3.org/TR/trig/
   */
  readonly parseTrig: (
    input: string,
    options?: ParseOptions
  ) => Effect.Effect<ReadonlyArray<Quad>, ParseError>
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

/**
 * The `Parser` service tag.
 *
 * @since 0.1.0
 * @category tags
 */
export class Parser extends Context.Tag("effect-rdf/Parser")<
  Parser,
  ParserService
>() {}

// ---------------------------------------------------------------------------
// Stub layer
// ---------------------------------------------------------------------------

/**
 * A stub `Layer<Parser>` whose methods always fail with a `ParseError`
 * carrying the message `"not implemented"`.
 *
 * Useful as a placeholder while a concrete parser is being developed.
 *
 * @since 0.1.0
 * @category layers
 */
export const unimplemented: Layer.Layer<Parser> = Layer.succeed(
  Parser,
  {
    parseNTriples: (_input, _opts) =>
      Effect.fail(
        new ParseError({ format: "N-Triples", line: undefined, message: "not implemented" })
      ),
    parseNQuads: (_input, _opts) =>
      Effect.fail(
        new ParseError({ format: "N-Quads", line: undefined, message: "not implemented" })
      ),
    parseTurtle: (_input, _opts) =>
      Effect.fail(
        new ParseError({ format: "Turtle", line: undefined, message: "not implemented" })
      ),
    parseTrig: (_input, _opts) =>
      Effect.fail(
        new ParseError({ format: "TriG", line: undefined, message: "not implemented" })
      )
  } satisfies ParserService
)
