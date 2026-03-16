/**
 * RDF Term types — the union of all node kinds that can appear in RDF data.
 *
 * This module provides type aliases and helper functions that work across all
 * term kinds (`IRI`, `BlankNode`, `Literal`, `Triple`, `DefaultGraph`).
 *
 * @since 0.1.0
 */
import { Equal } from "effect"
import { IRI, isIRI } from "./IRI.js"
import { BlankNode, isBlankNode } from "./BlankNode.js"
import { Literal, isLiteral } from "./Literal.js"
import { Triple, isTriple } from "./Triple.js"
import { DefaultGraph } from "./Quad.js"

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

/**
 * The subject position of an RDF triple.
 *
 * - Basic RDF: `IRI | BlankNode`
 * - RDF-star: additionally `Triple` (quoted triple)
 *
 * @since 0.1.0
 * @category models
 */
export type Subject = IRI | BlankNode | Triple

/**
 * The predicate position of an RDF triple — always an `IRI`.
 *
 * @since 0.1.0
 * @category models
 */
export type Predicate = IRI

/**
 * The object position of an RDF triple.
 *
 * - Basic RDF: `IRI | BlankNode | Literal`
 * - RDF-star: additionally `Triple` (quoted triple)
 *
 * @since 0.1.0
 * @category models
 */
export type RdfObject = IRI | BlankNode | Literal | Triple

/**
 * A graph name in an RDF dataset.
 *
 * @since 0.1.0
 * @category models
 */
export type GraphName = IRI | BlankNode | DefaultGraph

/**
 * Any RDF term — the union of all node kinds.
 *
 * @since 0.1.0
 * @category models
 */
export type Term = IRI | BlankNode | Literal | Triple | DefaultGraph

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `u` is any RDF term.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isTerm = (u: unknown): u is Term =>
  isIRI(u) || isBlankNode(u) || isLiteral(u) || isTriple(u) || u instanceof DefaultGraph

// Re-export guards for convenience
export { isIRI, isBlankNode, isLiteral, isTriple }

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

/**
 * Compares two terms for structural equality using Effect's `Equal` protocol.
 *
 * @since 0.1.0
 * @category equality
 */
export const equals = (a: Term, b: Term): boolean => Equal.equals(a, b)

// ---------------------------------------------------------------------------
// N-Triples serialisation
// ---------------------------------------------------------------------------

/**
 * Converts any `Term` to its N-Triples / N-Quads string representation.
 *
 * @since 0.1.0
 * @category serialisation
 */
export const toNT = (term: Term): string => {
  if (term instanceof DefaultGraph) return ""
  if (term instanceof Triple) return `<< ${term.toNT()} >>`
  return term.toNT()
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { IRI, BlankNode, Literal, Triple, DefaultGraph }
export type { TripleSubject, TriplePredicate, TripleObject } from "./Triple.js"
export type { QuadGraph } from "./Quad.js"
