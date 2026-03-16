/**
 * Tests for Triple module (including RDF-star quoted triples).
 */
import { describe, it, expect } from "bun:test"
import { Equal } from "effect"
import * as Triple from "../src/Triple.js"
import * as IRI from "../src/IRI.js"
import * as BlankNode from "../src/BlankNode.js"
import * as Literal from "../src/Literal.js"

const alice = IRI.makeUnsafe("https://example.org/alice")
const bob = IRI.makeUnsafe("https://example.org/bob")
const knows = IRI.makeUnsafe("https://schema.org/knows")
const name = IRI.makeUnsafe("https://schema.org/name")
const aliceLit = Literal.string("Alice")

describe("Triple", () => {
  describe("make", () => {
    it("creates a triple with IRI subject", () => {
      const t = Triple.make(alice, name, aliceLit)
      expect(t._tag).toBe("Triple")
      expect(Equal.equals(t.subject, alice)).toBe(true)
      expect(Equal.equals(t.predicate, name)).toBe(true)
      expect(Equal.equals(t.object, aliceLit)).toBe(true)
    })

    it("creates a triple with BlankNode subject", () => {
      const bn = BlankNode.make("b0")
      const t = Triple.make(bn, name, aliceLit)
      expect(Equal.equals(t.subject, bn)).toBe(true)
    })
  })

  describe("toNT", () => {
    it("serialises a simple triple to N-Triples", () => {
      const t = Triple.make(alice, name, aliceLit)
      expect(t.toNT()).toBe(
        '<https://example.org/alice> <https://schema.org/name> "Alice"^^<http://www.w3.org/2001/XMLSchema#string>'
      )
    })
  })

  describe("RDF-star (quoted triples)", () => {
    it("allows a Triple as the subject", () => {
      const inner = Triple.make(alice, knows, bob)
      const outer = Triple.make(inner, IRI.makeUnsafe("https://example.org/certainty"), Literal.double(0.9))
      expect(Triple.isQuoted(outer)).toBe(true)
      expect(outer.toNT()).toContain("<< ")
      expect(outer.toNT()).toContain(" >>")
    })

    it("allows a Triple as the object", () => {
      const inner = Triple.make(alice, knows, bob)
      const outer = Triple.make(
        IRI.makeUnsafe("https://example.org/agent"),
        IRI.makeUnsafe("https://example.org/claims"),
        inner
      )
      expect(Triple.isQuoted(outer)).toBe(true)
    })

    it("isQuoted returns false for plain triples", () => {
      const t = Triple.make(alice, name, aliceLit)
      expect(Triple.isQuoted(t)).toBe(false)
    })
  })

  describe("structural equality", () => {
    it("two identical triples are equal", () => {
      const a = Triple.make(alice, name, aliceLit)
      const b = Triple.make(alice, name, aliceLit)
      expect(Equal.equals(a, b)).toBe(true)
    })

    it("triples with different objects are not equal", () => {
      const a = Triple.make(alice, name, Literal.string("Alice"))
      const b = Triple.make(alice, name, Literal.string("Bob"))
      expect(Equal.equals(a, b)).toBe(false)
    })
  })

  describe("isTriple", () => {
    it("returns true for Triple instances", () => {
      expect(Triple.isTriple(Triple.make(alice, name, aliceLit))).toBe(true)
    })

    it("returns false for non-Triple values", () => {
      expect(Triple.isTriple(alice)).toBe(false)
    })
  })
})
