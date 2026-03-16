/**
 * RDF Blank Node — an anonymous resource that has no globally-scoped identifier.
 *
 * Blank nodes are identified within a document by a local label.  Two blank
 * nodes compare equal when their `value` labels are the same string.
 *
 * @example
 * ```ts
 * import { Equal } from "effect"
 * import * as BlankNode from "./BlankNode.js"
 *
 * const b1 = BlankNode.make("x")
 * const b2 = BlankNode.make("x")
 * assert(Equal.equals(b1, b2)) // true
 * ```
 *
 * @since 0.1.0
 */
import { Data } from "effect"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * An RDF blank node.
 *
 * @since 0.1.0
 * @category models
 */
export class BlankNode extends Data.TaggedClass("BlankNode")<{
  /** The local blank-node label (without the `_:` prefix). */
  readonly value: string
}> {
  /** Returns the blank node in N-Triples / Turtle notation (`_:<value>`). */
  toNT(): string {
    return `_:${this.value}`
  }

  override toString(): string {
    return `_:${this.value}`
  }
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Constructs a `BlankNode` with the supplied label.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (value: string): BlankNode => new BlankNode({ value })

/**
 * Generates a `BlankNode` whose label is derived from `crypto.randomUUID()`.
 * Each call returns a node with a distinct label.
 *
 * @since 0.1.0
 * @category constructors
 */
export const generateFresh = (): BlankNode =>
  new BlankNode({ value: crypto.randomUUID() })

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Type-guard: returns `true` when `u` is a `BlankNode`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isBlankNode = (u: unknown): u is BlankNode => u instanceof BlankNode
