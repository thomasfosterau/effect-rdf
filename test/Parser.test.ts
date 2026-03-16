/**
 * Tests for Parser service stub.
 */
import { describe, it, expect } from "bun:test"
import { Effect, Either } from "effect"
import * as P from "../src/Parser.js"

describe("Parser (unimplemented layer)", () => {
  const run = <A, E>(program: Effect.Effect<A, E, P.Parser>): Promise<Either.Either<A, E>> =>
    Effect.runPromise(program.pipe(Effect.provide(P.unimplemented), Effect.either))

  it("parseNTriples fails with ParseError 'not implemented'", async () => {
    const result = await run(
      Effect.gen(function* () {
        const parser = yield* P.Parser
        return yield* parser.parseNTriples("")
      })
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ParseError")
      expect(result.left.format).toBe("N-Triples")
      expect(result.left.message).toBe("not implemented")
    }
  })

  it("parseNQuads fails with ParseError", async () => {
    const result = await run(
      Effect.gen(function* () {
        const parser = yield* P.Parser
        return yield* parser.parseNQuads("")
      })
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.format).toBe("N-Quads")
    }
  })

  it("parseTurtle fails with ParseError", async () => {
    const result = await run(
      Effect.gen(function* () {
        const parser = yield* P.Parser
        return yield* parser.parseTurtle("")
      })
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.format).toBe("Turtle")
    }
  })

  it("parseTrig fails with ParseError", async () => {
    const result = await run(
      Effect.gen(function* () {
        const parser = yield* P.Parser
        return yield* parser.parseTrig("")
      })
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.format).toBe("TriG")
    }
  })
})
