/**
 * Dataset service — an Effect `Context.Tag` representing a mutable collection
 * of `Quad` values, analogous to the RDF Dataset interface.
 *
 * The module ships:
 * - `Dataset` — the service tag (for dependency injection)
 * - `make` — builds an in-memory `Layer` pre-populated with optional quads
 * - `DatasetService` — the interface that implementations must satisfy
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import * as D from "./Dataset.js"
 * import * as Quad from "./Quad.js"
 * import * as IRI from "./IRI.js"
 * import * as Literal from "./Literal.js"
 *
 * const program = Effect.gen(function* () {
 *   const dataset = yield* D.Dataset
 *   const quad = Quad.make(
 *     IRI.makeUnsafe("https://example.org/alice"),
 *     IRI.makeUnsafe("https://schema.org/name"),
 *     Literal.string("Alice")
 *   )
 *   yield* dataset.add(quad)
 *   const size = yield* dataset.size
 *   return size // 1
 * })
 *
 * const result = await Effect.runPromise(
 *   program.pipe(Effect.provide(D.make()))
 * )
 * ```
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Ref } from "effect"
import { Quad, matchesPattern } from "./Quad.js"
import type { QuadPattern } from "./Quad.js"

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * The operations provided by a `Dataset` service.
 *
 * @since 0.1.0
 * @category models
 */
export interface DatasetService {
  /**
   * Adds a single `Quad` to the dataset.
   * If an equal quad is already present the dataset is unchanged.
   */
  readonly add: (quad: Quad) => Effect.Effect<void>

  /**
   * Adds all quads from an iterable.
   * Duplicate quads are silently ignored.
   */
  readonly addAll: (quads: Iterable<Quad>) => Effect.Effect<void>

  /**
   * Removes a single `Quad` from the dataset (no-op when absent).
   */
  readonly delete: (quad: Quad) => Effect.Effect<void>

  /**
   * Returns `true` when the dataset contains the given quad.
   */
  readonly has: (quad: Quad) => Effect.Effect<boolean>

  /**
   * Returns all quads matching the given pattern.
   * Omitting a pattern field acts as a wildcard.
   */
  readonly match: (pattern: QuadPattern) => Effect.Effect<ReadonlyArray<Quad>>

  /**
   * Returns the number of quads in the dataset.
   */
  readonly size: Effect.Effect<number>

  /**
   * Returns all quads as an array.
   */
  readonly toArray: Effect.Effect<ReadonlyArray<Quad>>
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

/**
 * The `Dataset` service tag.
 *
 * Yields a `DatasetService` from the Effect context.
 *
 * @since 0.1.0
 * @category tags
 */
export class Dataset extends Context.Tag("effect-rdf/Dataset")<
  Dataset,
  DatasetService
>() {}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Constructs an in-memory `Layer<Dataset>` optionally pre-populated with the
 * supplied quads.
 *
 * The implementation stores quads in a `Ref<ReadonlyArray<Quad>>`.  It is
 * intentionally simple and suitable for testing and lightweight use-cases;
 * production workloads should replace this layer with a proper triplestore
 * adapter.
 *
 * @since 0.1.0
 * @category layers
 */
export const make = (initial: Iterable<Quad> = []): Layer.Layer<Dataset> =>
  Layer.effect(
    Dataset,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Quad>>(Array.from(initial))

      const add = (quad: Quad): Effect.Effect<void> =>
        Ref.update(ref, (quads) => {
          const already = quads.some((q) => matchesPattern(q, quad))
          return already ? quads : [...quads, quad]
        })

      const addAll = (incoming: Iterable<Quad>): Effect.Effect<void> =>
        Effect.forEach(incoming, add, { discard: true })

      const deleteQuad = (quad: Quad): Effect.Effect<void> =>
        Ref.update(ref, (quads) =>
          quads.filter((q) => !matchesPattern(q, quad))
        )

      const has = (quad: Quad): Effect.Effect<boolean> =>
        Ref.get(ref).pipe(Effect.map((quads) => quads.some((q) => matchesPattern(q, quad))))

      const match = (pattern: QuadPattern): Effect.Effect<ReadonlyArray<Quad>> =>
        Ref.get(ref).pipe(
          Effect.map((quads) => quads.filter((q) => matchesPattern(q, pattern)))
        )

      const size: Effect.Effect<number> = Ref.get(ref).pipe(
        Effect.map((quads) => quads.length)
      )

      const toArray: Effect.Effect<ReadonlyArray<Quad>> = Ref.get(ref)

      return {
        add,
        addAll,
        delete: deleteQuad,
        has,
        match,
        size,
        toArray
      } satisfies DatasetService
    })
  )
