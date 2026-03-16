/**
 * Tests for BlankNode module.
 */
import { describe, it, expect } from "bun:test"
import { Equal } from "effect"
import * as BlankNode from "../src/BlankNode.js"

describe("BlankNode", () => {
  describe("make", () => {
    it("creates a blank node with the given label", () => {
      const bn = BlankNode.make("b0")
      expect(bn.value).toBe("b0")
      expect(bn._tag).toBe("BlankNode")
    })

    it("serialises to N-Triples notation", () => {
      const bn = BlankNode.make("x")
      expect(bn.toNT()).toBe("_:x")
    })

    it("toString returns the prefixed label", () => {
      const bn = BlankNode.make("abc")
      expect(bn.toString()).toBe("_:abc")
    })
  })

  describe("generateFresh", () => {
    it("generates distinct nodes on each call", () => {
      const a = BlankNode.generateFresh()
      const b = BlankNode.generateFresh()
      expect(Equal.equals(a, b)).toBe(false)
    })
  })

  describe("structural equality", () => {
    it("two nodes with the same label are equal", () => {
      const a = BlankNode.make("node1")
      const b = BlankNode.make("node1")
      expect(Equal.equals(a, b)).toBe(true)
    })

    it("two nodes with different labels are not equal", () => {
      const a = BlankNode.make("node1")
      const b = BlankNode.make("node2")
      expect(Equal.equals(a, b)).toBe(false)
    })
  })

  describe("isBlankNode", () => {
    it("returns true for BlankNode instances", () => {
      expect(BlankNode.isBlankNode(BlankNode.make("x"))).toBe(true)
    })

    it("returns false for non-BlankNode values", () => {
      expect(BlankNode.isBlankNode("_:x")).toBe(false)
      expect(BlankNode.isBlankNode(null)).toBe(false)
    })
  })
})
