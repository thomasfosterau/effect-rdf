/**
 * Tests for Dataset service.
 */
import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import * as D from "../src/Dataset.js"
import * as Quad from "../src/Quad.js"
import * as IRI from "../src/IRI.js"
import * as Literal from "../src/Literal.js"
import * as BlankNode from "../src/BlankNode.js"

const s1 = IRI.makeUnsafe("https://example.org/alice")
const s2 = IRI.makeUnsafe("https://example.org/bob")
const pName = IRI.makeUnsafe("https://schema.org/name")
const pKnows = IRI.makeUnsafe("https://schema.org/knows")
const oAlice = Literal.string("Alice")
const oBob = Literal.string("Bob")
const g1 = IRI.makeUnsafe("https://example.org/graph1")

const q1 = Quad.make(s1, pName, oAlice)
const q2 = Quad.make(s2, pName, oBob)
const q3 = Quad.make(s1, pKnows, s2, g1)

const run = <A>(program: Effect.Effect<A, never, D.Dataset>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(D.make())))

describe("Dataset (in-memory)", () => {
  describe("add / size / toArray", () => {
    it("starts empty", async () => {
      const size = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        return yield* ds.size
      }))
      expect(size).toBe(0)
    })

    it("adds a quad and reports size 1", async () => {
      const size = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q1)
        return yield* ds.size
      }))
      expect(size).toBe(1)
    })

    it("does not add duplicate quads", async () => {
      const size = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q1)
        yield* ds.add(q1)
        return yield* ds.size
      }))
      expect(size).toBe(1)
    })

    it("returns all quads via toArray", async () => {
      const quads = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q1)
        yield* ds.add(q2)
        return yield* ds.toArray
      }))
      expect(quads.length).toBe(2)
    })
  })

  describe("addAll", () => {
    it("adds multiple quads at once", async () => {
      const size = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.addAll([q1, q2, q3])
        return yield* ds.size
      }))
      expect(size).toBe(3)
    })
  })

  describe("has", () => {
    it("returns true when the quad is present", async () => {
      const found = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q1)
        return yield* ds.has(q1)
      }))
      expect(found).toBe(true)
    })

    it("returns false when the quad is absent", async () => {
      const found = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q1)
        return yield* ds.has(q2)
      }))
      expect(found).toBe(false)
    })
  })

  describe("delete", () => {
    it("removes a quad", async () => {
      const size = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q1)
        yield* ds.add(q2)
        yield* ds.delete(q1)
        return yield* ds.size
      }))
      expect(size).toBe(1)
    })

    it("is a no-op when quad is absent", async () => {
      const size = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q1)
        yield* ds.delete(q2)
        return yield* ds.size
      }))
      expect(size).toBe(1)
    })
  })

  describe("match", () => {
    it("returns all quads for an empty pattern", async () => {
      const matches = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.addAll([q1, q2, q3])
        return yield* ds.match({})
      }))
      expect(matches.length).toBe(3)
    })

    it("filters by subject", async () => {
      const matches = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.addAll([q1, q2, q3])
        return yield* ds.match({ subject: s1 })
      }))
      // q1 (s1, pName, oAlice, default) and q3 (s1, pKnows, s2, g1)
      expect(matches.length).toBe(2)
    })

    it("filters by predicate", async () => {
      const matches = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.addAll([q1, q2, q3])
        return yield* ds.match({ predicate: pName })
      }))
      expect(matches.length).toBe(2)
    })

    it("filters by graph", async () => {
      const matches = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.addAll([q1, q2, q3])
        return yield* ds.match({ graph: g1 })
      }))
      expect(matches.length).toBe(1)
    })

    it("returns empty array when nothing matches", async () => {
      const matches = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.addAll([q1, q2])
        return yield* ds.match({ subject: IRI.makeUnsafe("https://example.org/nobody") })
      }))
      expect(matches.length).toBe(0)
    })
  })

  describe("make with initial quads", () => {
    it("pre-populates the dataset", async () => {
      const size = await Effect.runPromise(
        Effect.gen(function* () {
          const ds = yield* D.Dataset
          return yield* ds.size
        }).pipe(Effect.provide(D.make([q1, q2, q3])))
      )
      expect(size).toBe(3)
    })
  })

  describe("Dataset service tag", () => {
    it("can be provided via make() layer", async () => {
      const size = await Effect.runPromise(
        Effect.gen(function* () {
          const ds = yield* D.Dataset
          return yield* ds.size
        }).pipe(Effect.provide(D.make()))
      )
      expect(size).toBe(0)
    })
  })

  describe("BlankNode subjects", () => {
    it("adds and retrieves quads with blank-node subjects", async () => {
      const bn = BlankNode.make("b0")
      const q = Quad.make(bn, pName, Literal.string("Anonymous"))
      const found = await run(Effect.gen(function* () {
        const ds = yield* D.Dataset
        yield* ds.add(q)
        return yield* ds.has(q)
      }))
      expect(found).toBe(true)
    })
  })
})
