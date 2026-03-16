/**
 * Tests for Serializer service.
 */
import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import * as S from "../src/Serializer.js"
import * as Quad from "../src/Quad.js"
import * as IRI from "../src/IRI.js"
import * as Literal from "../src/Literal.js"
import { SerializeError } from "../src/Errors.js"

const s = IRI.makeUnsafe("https://example.org/s")
const p = IRI.makeUnsafe("https://example.org/p")
const oStr = Literal.string("hello")
const g = IRI.makeUnsafe("https://example.org/g")

const q1 = Quad.make(s, p, oStr)
const q2 = Quad.make(s, p, oStr, g)

describe("Serializer (nquads layer)", () => {
  const run = <A>(program: Effect.Effect<A, SerializeError, S.Serializer>): Promise<A> =>
    Effect.runPromise(
      program.pipe(Effect.provide(S.nquads), Effect.orDie)
    )

  describe("toNTriples", () => {
    it("serialises quads to N-Triples (ignores graph)", async () => {
      const output = await run(Effect.gen(function* () {
        const ser = yield* S.Serializer
        return yield* ser.toNTriples([q1])
      }))
      expect(output).toContain("<https://example.org/s>")
      expect(output).toContain("<https://example.org/p>")
      expect(output).toContain('"hello"')
      expect(output).toEndWith(" .")
    })

    it("serialises multiple quads as separate lines", async () => {
      const output = await run(Effect.gen(function* () {
        const ser = yield* S.Serializer
        return yield* ser.toNTriples([q1, q2])
      }))
      expect(output.split("\n").length).toBe(2)
    })
  })

  describe("toNQuads", () => {
    it("serialises a named-graph quad with graph IRI", async () => {
      const output = await run(Effect.gen(function* () {
        const ser = yield* S.Serializer
        return yield* ser.toNQuads([q2])
      }))
      expect(output).toContain("<https://example.org/g>")
      expect(output).toEndWith(" .")
    })

    it("serialises a default-graph quad without graph IRI", async () => {
      const output = await run(Effect.gen(function* () {
        const ser = yield* S.Serializer
        return yield* ser.toNQuads([q1])
      }))
      // No named graph in the output
      expect(output).not.toContain("<https://example.org/g>")
    })
  })

  describe("toTurtle (stub)", () => {
    it("fails with SerializeError", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const ser = yield* S.Serializer
          return yield* ser.toTurtle([q1]).pipe(Effect.either)
        }).pipe(Effect.provide(S.nquads))
      )
      expect(result._tag).toBe("Left")
    })
  })
})

describe("Serializer (unimplemented layer)", () => {
  it("every method fails with SerializeError", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ser = yield* S.Serializer
        return yield* ser.toNQuads([q1]).pipe(Effect.either)
      }).pipe(Effect.provide(S.unimplemented))
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("SerializeError")
    }
  })
})
