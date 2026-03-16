/**
 * RDF Quad — a `Triple` extended with a *graph name*, enabling named graphs
 * and the RDF Dataset data model.
 *
 * The special `DefaultGraph` singleton represents the unnamed default graph.
 *
 * @example
 * ```ts
 * import * as Quad from "./Quad.js"
 * import * as IRI from "./IRI.js"
 * import * as Literal from "./Literal.js"
 *
 * const s = IRI.makeUnsafe("https://example.org/alice")
 * const p = IRI.makeUnsafe("https://schema.org/name")
 * const o = Literal.string("Alice")
 * const q = Quad.make(s, p, o)           // placed in the default graph
 * const q2 = Quad.make(s, p, o, IRI.makeUnsafe("https://example.org/graph1"))
 * ```
 *
 * @since 0.1.0
 */
import { Data, Equal } from "effect"
import { IRI } from "./IRI.js"
import { BlankNode } from "./BlankNode.js"
import { Triple } from "./Triple.js"
import type { TripleSubject, TriplePredicate, TripleObject } from "./Triple.js"

// ---------------------------------------------------------------------------
// DefaultGraph
// ---------------------------------------------------------------------------

/**
 * The unnamed default graph of an RDF dataset.
 *
 * There is exactly one default graph; comparisons use the `_tag` discriminant.
 *
 * @since 0.1.0
 * @category models
 */
export class DefaultGraph extends Data.TaggedClass("DefaultGraph")<Record<never, never>> {
  toNT(): string {
    return ""
  }
  override toString(): string {
    return "DefaultGraph"
  }
}

/** The singleton default-graph instance. */
export const defaultGraph: DefaultGraph = new DefaultGraph()

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * The graph-name position of a quad.
 *
 * @since 0.1.0
 * @category models
 */
export type QuadGraph = IRI | BlankNode | DefaultGraph

/**
 * An RDF quad (subject–predicate–object–graph).
 *
 * @since 0.1.0
 * @category models
 */
export class Quad extends Data.TaggedClass("Quad")<{
  readonly subject: TripleSubject
  readonly predicate: TriplePredicate
  readonly object: TripleObject
  readonly graph: QuadGraph
}> {
  /** Returns the `Triple` component of this quad (ignoring the graph). */
  toTriple(): Triple {
    return new Triple({
      subject: this.subject,
      predicate: this.predicate,
      object: this.object
    })
  }

  /** Serialises to N-Quads notation (without trailing newline). */
  toNQ(): string {
    const graphPart =
      this.graph instanceof DefaultGraph ? "" : ` ${this.graph.toNT()}`
    return `${this.toTriple().toNT()}${graphPart} .`
  }

  override toString(): string {
    return this.toNQ()
  }
}

/**
 * A pattern used to filter quads in a `Dataset`.
 * Each field is optional; omitting a field acts as a wildcard.
 *
 * @since 0.1.0
 * @category models
 */
export interface QuadPattern {
  readonly subject?: TripleSubject | undefined
  readonly predicate?: TriplePredicate | undefined
  readonly object?: TripleObject | undefined
  readonly graph?: QuadGraph | undefined
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Constructs a `Quad`.  When `graph` is omitted the quad is placed in the
 * `DefaultGraph`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  subject: TripleSubject,
  predicate: TriplePredicate,
  object: TripleObject,
  graph: QuadGraph = defaultGraph
): Quad => new Quad({ subject, predicate, object, graph })

/**
 * Promotes a `Triple` into a `Quad` by attaching a graph name.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromTriple = (triple: Triple, graph: QuadGraph = defaultGraph): Quad =>
  new Quad({
    subject: triple.subject,
    predicate: triple.predicate,
    object: triple.object,
    graph
  })

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Type-guard: returns `true` when `u` is a `Quad`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isQuad = (u: unknown): u is Quad => u instanceof Quad

/**
 * Returns `true` when the quad belongs to the default graph.
 *
 * @since 0.1.0
 * @category predicates
 */
export const inDefaultGraph = (quad: Quad): boolean =>
  quad.graph instanceof DefaultGraph

// ---------------------------------------------------------------------------
// Pattern matching helper (used by Dataset)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when a `Quad` matches all the non-`undefined` fields of a
 * `QuadPattern`.  Uses Effect structural equality for term comparison.
 *
 * @since 0.1.0
 * @category utils
 */
export const matchesPattern = (quad: Quad, pattern: QuadPattern): boolean => {
  if (
    pattern.subject !== undefined &&
    !Equal.equals(quad.subject, pattern.subject)
  )
    return false
  if (
    pattern.predicate !== undefined &&
    !Equal.equals(quad.predicate, pattern.predicate)
  )
    return false
  if (
    pattern.object !== undefined &&
    !Equal.equals(quad.object, pattern.object)
  )
    return false
  if (
    pattern.graph !== undefined &&
    !Equal.equals(quad.graph, pattern.graph)
  )
    return false
  return true
}
