/**
 * Serializer service — an Effect `Context.Tag` for RDF serializers.
 *
 * This module defines the `Serializer` service interface and tag.  Concrete
 * serializer implementations are provided as separate `Layer` values.
 *
 * A minimal N-Triples / N-Quads serializer is included as a built-in layer
 * because the serialisation rules are straightforward and depend only on the
 * `toNT()` / `toNQ()` methods already defined on the core types.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import * as S from "./Serializer.js"
 * import * as Quad from "./Quad.js"
 * import * as IRI from "./IRI.js"
 * import * as Literal from "./Literal.js"
 *
 * const program = Effect.gen(function* () {
 *   const serializer = yield* S.Serializer
 *   const q = Quad.make(
 *     IRI.makeUnsafe("https://example.org/s"),
 *     IRI.makeUnsafe("https://example.org/p"),
 *     Literal.string("hello")
 *   )
 *   return yield* serializer.toNQuads([q])
 * })
 *
 * const output = await Effect.runPromise(
 *   program.pipe(Effect.provide(S.nquads))
 * )
 * ```
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import { Quad } from "./Quad.js"
import { SerializeError } from "./Errors.js"

// ---------------------------------------------------------------------------
// Prefix table
// ---------------------------------------------------------------------------

/**
 * A mapping from prefix labels to base IRI strings, used when serializing
 * to prefix-aware formats such as Turtle.
 *
 * @since 0.1.0
 * @category models
 */
export type Prefixes = Readonly<Record<string, string>>

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * The operations provided by a `Serializer` service.
 *
 * @since 0.1.0
 * @category models
 */
export interface SerializerService {
  /**
   * Serializes quads to N-Triples format (`application/n-triples`).
   * All quads are projected to triples (the graph component is ignored).
   *
   * @see https://www.w3.org/TR/n-triples/
   */
  readonly toNTriples: (
    quads: Iterable<Quad>
  ) => Effect.Effect<string, SerializeError>

  /**
   * Serializes quads to N-Quads format (`application/n-quads`).
   *
   * @see https://www.w3.org/TR/n-quads/
   */
  readonly toNQuads: (
    quads: Iterable<Quad>
  ) => Effect.Effect<string, SerializeError>

  /**
   * Serializes quads to Turtle format (`text/turtle`).
   *
   * @param quads  Quads to serialize (all projected to the default graph).
   * @param prefixes  Optional prefix table used to abbreviate IRIs.
   */
  readonly toTurtle: (
    quads: Iterable<Quad>,
    prefixes?: Prefixes
  ) => Effect.Effect<string, SerializeError>
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

/**
 * The `Serializer` service tag.
 *
 * @since 0.1.0
 * @category tags
 */
export class Serializer extends Context.Tag("effect-rdf/Serializer")<
  Serializer,
  SerializerService
>() {}

// ---------------------------------------------------------------------------
// Built-in N-Triples / N-Quads layer
// ---------------------------------------------------------------------------

/**
 * A `Layer<Serializer>` that serialises quads to N-Quads and N-Triples.
 *
 * Turtle serialisation stubs out with `SerializeError("not implemented")`.
 *
 * @since 0.1.0
 * @category layers
 */
export const nquads: Layer.Layer<Serializer> = Layer.succeed(
  Serializer,
  {
    toNTriples: (quads) =>
      Effect.sync(() => {
        const lines: Array<string> = []
        for (const quad of quads) {
          lines.push(`${quad.toTriple().toNT()} .`)
        }
        return lines.join("\n")
      }),

    toNQuads: (quads) =>
      Effect.sync(() => {
        const lines: Array<string> = []
        for (const quad of quads) {
          lines.push(quad.toNQ())
        }
        return lines.join("\n")
      }),

    toTurtle: (_quads, _prefixes) =>
      Effect.fail(
        new SerializeError({ message: "Turtle serialization is not yet implemented" })
      )
  } satisfies SerializerService
)

/**
 * A stub `Layer<Serializer>` whose every method fails with
 * `SerializeError("not implemented")`.
 *
 * @since 0.1.0
 * @category layers
 */
export const unimplemented: Layer.Layer<Serializer> = Layer.succeed(
  Serializer,
  {
    toNTriples: (_quads) =>
      Effect.fail(new SerializeError({ message: "not implemented" })),
    toNQuads: (_quads) =>
      Effect.fail(new SerializeError({ message: "not implemented" })),
    toTurtle: (_quads, _prefixes) =>
      Effect.fail(new SerializeError({ message: "not implemented" }))
  } satisfies SerializerService
)
