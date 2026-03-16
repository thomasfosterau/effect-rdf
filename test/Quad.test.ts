/**
 * Tests for Quad module (including DefaultGraph).
 */
import { describe, it, expect } from "bun:test"
import { Equal } from "effect"
import * as Quad from "../src/Quad.js"
import * as Triple from "../src/Triple.js"
import * as IRI from "../src/IRI.js"
import * as Literal from "../src/Literal.js"

const s = IRI.makeUnsafe("https://example.org/alice")
const p = IRI.makeUnsafe("https://schema.org/name")
const o = Literal.string("Alice")
const g = IRI.makeUnsafe("https://example.org/graph1")

describe("DefaultGraph", () => {
  it("has _tag 'DefaultGraph'", () => {
    expect(Quad.defaultGraph._tag).toBe("DefaultGraph")
  })

  it("two default-graph instances are equal", () => {
    expect(Equal.equals(Quad.defaultGraph, new Quad.DefaultGraph())).toBe(true)
  })
})

describe("Quad", () => {
  describe("make", () => {
    it("creates a quad in the default graph when graph is omitted", () => {
      const q = Quad.make(s, p, o)
      expect(q._tag).toBe("Quad")
      expect(q.graph._tag).toBe("DefaultGraph")
    })

    it("creates a quad in a named graph", () => {
      const q = Quad.make(s, p, o, g)
      expect(Equal.equals(q.graph, g)).toBe(true)
    })
  })

  describe("fromTriple", () => {
    it("promotes a Triple into a Quad", () => {
      const t = Triple.make(s, p, o)
      const q = Quad.fromTriple(t)
      expect(q.graph._tag).toBe("DefaultGraph")
      expect(Equal.equals(q.toTriple(), t)).toBe(true)
    })
  })

  describe("toNQ", () => {
    it("serialises a default-graph quad without graph component", () => {
      const q = Quad.make(s, p, o)
      expect(q.toNQ()).not.toContain("<https://example.org/graph1>")
      expect(q.toNQ()).toEndWith(" .")
    })

    it("serialises a named-graph quad with graph component", () => {
      const q = Quad.make(s, p, o, g)
      expect(q.toNQ()).toContain("<https://example.org/graph1>")
      expect(q.toNQ()).toEndWith(" .")
    })
  })

  describe("inDefaultGraph", () => {
    it("returns true for default-graph quads", () => {
      expect(Quad.inDefaultGraph(Quad.make(s, p, o))).toBe(true)
    })

    it("returns false for named-graph quads", () => {
      expect(Quad.inDefaultGraph(Quad.make(s, p, o, g))).toBe(false)
    })
  })

  describe("matchesPattern", () => {
    it("empty pattern matches all quads", () => {
      const q = Quad.make(s, p, o)
      expect(Quad.matchesPattern(q, {})).toBe(true)
    })

    it("subject pattern filters by subject", () => {
      const q = Quad.make(s, p, o)
      expect(Quad.matchesPattern(q, { subject: s })).toBe(true)
      expect(
        Quad.matchesPattern(q, { subject: IRI.makeUnsafe("https://example.org/other") })
      ).toBe(false)
    })

    it("predicate pattern filters by predicate", () => {
      const q = Quad.make(s, p, o)
      expect(Quad.matchesPattern(q, { predicate: p })).toBe(true)
      expect(
        Quad.matchesPattern(q, { predicate: IRI.makeUnsafe("https://example.org/other") })
      ).toBe(false)
    })

    it("object pattern filters by object", () => {
      const q = Quad.make(s, p, o)
      expect(Quad.matchesPattern(q, { object: o })).toBe(true)
      expect(Quad.matchesPattern(q, { object: Literal.string("Bob") })).toBe(false)
    })

    it("graph pattern filters by graph", () => {
      const q = Quad.make(s, p, o, g)
      expect(Quad.matchesPattern(q, { graph: g })).toBe(true)
      expect(Quad.matchesPattern(q, { graph: Quad.defaultGraph })).toBe(false)
    })

    it("combined pattern filters correctly", () => {
      const q = Quad.make(s, p, o)
      expect(Quad.matchesPattern(q, { subject: s, predicate: p })).toBe(true)
      expect(
        Quad.matchesPattern(q, { subject: s, predicate: IRI.makeUnsafe("https://other.org/x") })
      ).toBe(false)
    })
  })

  describe("structural equality", () => {
    it("two identical quads are equal", () => {
      const a = Quad.make(s, p, o, g)
      const b = Quad.make(s, p, o, g)
      expect(Equal.equals(a, b)).toBe(true)
    })

    it("quads differing only in graph are not equal", () => {
      const a = Quad.make(s, p, o)
      const b = Quad.make(s, p, o, g)
      expect(Equal.equals(a, b)).toBe(false)
    })
  })
})
