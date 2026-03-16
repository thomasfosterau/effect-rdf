/**
 * Tests for IRI module.
 */
import { describe, it, expect } from "bun:test"
import { Equal } from "effect"
import * as IRI from "../src/IRI.js"
import { Effect } from "effect"

describe("IRI", () => {
  describe("makeUnsafe", () => {
    it("creates an IRI with the given value", () => {
      const iri = IRI.makeUnsafe("https://schema.org/Person")
      expect(iri.value).toBe("https://schema.org/Person")
      expect(iri._tag).toBe("IRI")
    })

    it("serialises to N-Triples notation", () => {
      const iri = IRI.makeUnsafe("https://schema.org/Person")
      expect(iri.toNT()).toBe("<https://schema.org/Person>")
    })

    it("toString returns the raw value", () => {
      const iri = IRI.makeUnsafe("https://example.org/")
      expect(iri.toString()).toBe("https://example.org/")
    })
  })

  describe("make", () => {
    it("succeeds for a valid IRI", async () => {
      const result = await Effect.runPromise(IRI.make("https://example.org/"))
      expect(result.value).toBe("https://example.org/")
    })

    it("fails for a string without a scheme", async () => {
      const result = await Effect.runPromise(
        IRI.make("not-an-iri").pipe(Effect.either)
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("InvalidIRIError")
        expect(result.left.input).toBe("not-an-iri")
      }
    })

    it("succeeds for various valid schemes", async () => {
      for (const iri of ["http://x.org/", "urn:isbn:123", "mailto:test@example.org"]) {
        const result = await Effect.runPromise(IRI.make(iri))
        expect(result.value).toBe(iri)
      }
    })
  })

  describe("structural equality", () => {
    it("two IRIs with the same value are equal", () => {
      const a = IRI.makeUnsafe("https://schema.org/Person")
      const b = IRI.makeUnsafe("https://schema.org/Person")
      expect(Equal.equals(a, b)).toBe(true)
    })

    it("two IRIs with different values are not equal", () => {
      const a = IRI.makeUnsafe("https://schema.org/Person")
      const b = IRI.makeUnsafe("https://schema.org/Organization")
      expect(Equal.equals(a, b)).toBe(false)
    })
  })

  describe("isIRI", () => {
    it("returns true for IRI instances", () => {
      expect(IRI.isIRI(IRI.makeUnsafe("https://x.org/"))).toBe(true)
    })

    it("returns false for non-IRI values", () => {
      expect(IRI.isIRI("https://x.org/")).toBe(false)
      expect(IRI.isIRI(null)).toBe(false)
    })
  })

  describe("isValid", () => {
    it("accepts well-formed IRIs", () => {
      expect(IRI.isValid("https://example.org/")).toBe(true)
      expect(IRI.isValid("urn:uuid:abc")).toBe(true)
    })

    it("rejects strings without a scheme", () => {
      expect(IRI.isValid("no-scheme")).toBe(false)
      expect(IRI.isValid("")).toBe(false)
    })
  })
})
