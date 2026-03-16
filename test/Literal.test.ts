/**
 * Tests for Literal module.
 */
import { describe, it, expect } from "bun:test"
import { Equal, Option } from "effect"
import * as Literal from "../src/Literal.js"
import * as IRI from "../src/IRI.js"

describe("Literal", () => {
  describe("string", () => {
    it("creates an xsd:string literal", () => {
      const lit = Literal.string("hello")
      expect(lit.value).toBe("hello")
      expect(lit.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#string")
      expect(Option.isNone(lit.language)).toBe(true)
    })

    it("serialises to N-Triples notation", () => {
      const lit = Literal.string("hello")
      expect(lit.toNT()).toBe('"hello"^^<http://www.w3.org/2001/XMLSchema#string>')
    })

    it("escapes special characters in lexical form", () => {
      const lit = Literal.string('say "hi"\nline2')
      expect(lit.toNT()).toContain('\\"hi\\"')
      expect(lit.toNT()).toContain("\\n")
    })
  })

  describe("langString", () => {
    it("creates a language-tagged literal", () => {
      const lit = Literal.langString("Hola", "es")
      expect(lit.value).toBe("Hola")
      expect(Option.isSome(lit.language)).toBe(true)
      expect(Option.getOrElse(lit.language, () => "")).toBe("es")
      expect(lit.datatype.value).toBe(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
      )
    })

    it("serialises with @ notation", () => {
      const lit = Literal.langString("Hola", "es")
      expect(lit.toNT()).toBe('"Hola"@es')
    })
  })

  describe("typed", () => {
    it("creates a typed literal with a custom datatype", () => {
      const dt = IRI.makeUnsafe("http://www.w3.org/2001/XMLSchema#date")
      const lit = Literal.typed("2024-01-15", dt)
      expect(lit.value).toBe("2024-01-15")
      expect(lit.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#date")
      expect(lit.toNT()).toBe('"2024-01-15"^^<http://www.w3.org/2001/XMLSchema#date>')
    })
  })

  describe("boolean", () => {
    it("creates xsd:boolean literals", () => {
      expect(Literal.boolean(true).value).toBe("true")
      expect(Literal.boolean(false).value).toBe("false")
      expect(Literal.boolean(true).datatype.value).toBe(
        "http://www.w3.org/2001/XMLSchema#boolean"
      )
    })
  })

  describe("integer", () => {
    it("creates xsd:integer literals from numbers", () => {
      const lit = Literal.integer(42)
      expect(lit.value).toBe("42")
      expect(lit.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#integer")
    })

    it("creates xsd:integer literals from bigint", () => {
      const lit = Literal.integer(BigInt("9007199254740993"))
      expect(lit.value).toBe("9007199254740993")
    })
  })

  describe("double", () => {
    it("creates xsd:double literals", () => {
      const lit = Literal.double(3.14)
      expect(lit.value).toBe("3.14")
      expect(lit.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#double")
    })
  })

  describe("dateTime", () => {
    it("creates xsd:dateTime literals from Date objects", () => {
      const date = new Date("2024-01-15T12:00:00.000Z")
      const lit = Literal.dateTime(date)
      expect(lit.value).toBe("2024-01-15T12:00:00.000Z")
      expect(lit.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#dateTime")
    })
  })

  describe("structural equality", () => {
    it("two identical literals are equal", () => {
      const a = Literal.string("hello")
      const b = Literal.string("hello")
      expect(Equal.equals(a, b)).toBe(true)
    })

    it("literals with different values are not equal", () => {
      expect(Equal.equals(Literal.string("a"), Literal.string("b"))).toBe(false)
    })

    it("literals with different datatypes are not equal", () => {
      const a = Literal.string("42")
      const b = Literal.integer(42)
      expect(Equal.equals(a, b)).toBe(false)
    })

    it("lang-string literals with different languages are not equal", () => {
      const en = Literal.langString("hello", "en")
      const fr = Literal.langString("hello", "fr")
      expect(Equal.equals(en, fr)).toBe(false)
    })
  })

  describe("isLiteral / isLangString", () => {
    it("isLiteral returns true for Literal instances", () => {
      expect(Literal.isLiteral(Literal.string("x"))).toBe(true)
    })

    it("isLangString returns true only for language-tagged literals", () => {
      expect(Literal.isLangString(Literal.langString("hi", "en"))).toBe(true)
      expect(Literal.isLangString(Literal.string("hi"))).toBe(false)
    })
  })
})
