/**
 * RDF Triple — the fundamental unit of RDF data, comprising a subject,
 * predicate and object.
 *
 * This module also covers **RDF-star** (RDF 1.2): a `Triple` can itself
 * appear as the subject or object of another `Triple`, forming a *quoted
 * triple*.  The types are self-referential to express this:
 *
 * ```
 * Subject  = IRI | BlankNode | Triple
 * Object   = IRI | BlankNode | Literal | Triple
 * ```
 *
 * @example
 * ```ts
 * import { Equal } from "effect"
 * import * as T from "./Triple.js"
 * import * as IRI from "./IRI.js"
 * import * as Literal from "./Literal.js"
 *
 * const s = IRI.makeUnsafe("https://example.org/alice")
 * const p = IRI.makeUnsafe("https://schema.org/name")
 * const o = Literal.string("Alice")
 * const triple = T.make(s, p, o)
 * ```
 *
 * @since 0.1.0
 */
import { Data } from "effect"
import { IRI } from "./IRI.js"
import { BlankNode } from "./BlankNode.js"
import { Literal } from "./Literal.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * The subject position of a triple.
 *
 * In plain RDF: `IRI | BlankNode`.
 * In RDF-star: `IRI | BlankNode | Triple` (a quoted triple).
 *
 * @since 0.1.0
 * @category models
 */
export type TripleSubject = IRI | BlankNode | Triple

/**
 * The predicate position of a triple — always an IRI.
 *
 * @since 0.1.0
 * @category models
 */
export type TriplePredicate = IRI

/**
 * The object position of a triple.
 *
 * In plain RDF: `IRI | BlankNode | Literal`.
 * In RDF-star: `IRI | BlankNode | Literal | Triple` (a quoted triple).
 *
 * @since 0.1.0
 * @category models
 */
export type TripleObject = IRI | BlankNode | Literal | Triple

/**
 * An RDF triple (subject–predicate–object).
 *
 * Instances compare structurally via `Equal.equals` thanks to
 * `Data.TaggedClass`.
 *
 * @since 0.1.0
 * @category models
 */
export class Triple extends Data.TaggedClass("Triple")<{
  readonly subject: TripleSubject
  readonly predicate: TriplePredicate
  readonly object: TripleObject
}> {
  /**
   * Serialises the triple to its N-Triples representation (without trailing
   * dot or newline).
   */
  toNT(): string {
    return `${termToNT(this.subject)} ${termToNT(this.predicate)} ${termToNT(this.object)}`
  }

  override toString(): string {
    return this.toNT()
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const termToNT = (term: TripleSubject | TripleObject): string => {
  if (term instanceof Triple) {
    // RDF-star quoted triple notation: << subject predicate object >>
    return `<< ${term.toNT()} >>`
  }
  return term.toNT()
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Constructs a `Triple` from subject, predicate and object.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  subject: TripleSubject,
  predicate: TriplePredicate,
  object: TripleObject
): Triple => new Triple({ subject, predicate, object })

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Type-guard: returns `true` when `u` is a `Triple`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isTriple = (u: unknown): u is Triple => u instanceof Triple

/**
 * Returns `true` when the triple is an RDF-star *quoted triple* (i.e. its
 * subject or object is itself a `Triple`).
 *
 * @since 0.1.0
 * @category predicates
 */
export const isQuoted = (triple: Triple): boolean =>
  triple.subject instanceof Triple || triple.object instanceof Triple
