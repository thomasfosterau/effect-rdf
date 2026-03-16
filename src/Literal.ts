/**
 * RDF Literal — a concrete value such as a string, number, date, or boolean.
 *
 * Every literal carries a `value` string and a `datatype` IRI.  Plain-text
 * literals in a natural language also carry a BCP 47 `language` tag; in that
 * case the datatype is automatically set to
 * `rdf:langString` (`http://www.w3.org/1999/02/22-rdf-syntax-ns#langString`).
 *
 * @example
 * ```ts
 * import { Equal, Option } from "effect"
 * import * as Literal from "./Literal.js"
 *
 * const a = Literal.string("hello")
 * const b = Literal.string("hello")
 * assert(Equal.equals(a, b)) // true
 *
 * const greeting = Literal.langString("Hola", "es")
 * assert(Option.isSome(greeting.language))   // true
 * ```
 *
 * @since 0.1.0
 */
import { Data, Option } from "effect"
import { IRI, makeUnsafe as iriUnsafe } from "./IRI.js"

// ---------------------------------------------------------------------------
// Well-known datatype IRIs
// ---------------------------------------------------------------------------

/** `xsd:string` */
export const XSD_STRING: IRI = iriUnsafe("http://www.w3.org/2001/XMLSchema#string")
/** `xsd:boolean` */
export const XSD_BOOLEAN: IRI = iriUnsafe("http://www.w3.org/2001/XMLSchema#boolean")
/** `xsd:integer` */
export const XSD_INTEGER: IRI = iriUnsafe("http://www.w3.org/2001/XMLSchema#integer")
/** `xsd:decimal` */
export const XSD_DECIMAL: IRI = iriUnsafe("http://www.w3.org/2001/XMLSchema#decimal")
/** `xsd:double` */
export const XSD_DOUBLE: IRI = iriUnsafe("http://www.w3.org/2001/XMLSchema#double")
/** `xsd:dateTime` */
export const XSD_DATETIME: IRI = iriUnsafe("http://www.w3.org/2001/XMLSchema#dateTime")
/** `xsd:date` */
export const XSD_DATE: IRI = iriUnsafe("http://www.w3.org/2001/XMLSchema#date")
/** `rdf:langString` */
export const RDF_LANG_STRING: IRI = iriUnsafe(
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
)

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * An RDF literal node.
 *
 * @since 0.1.0
 * @category models
 */
export class Literal extends Data.TaggedClass("Literal")<{
  /** The lexical form of the literal (the raw string). */
  readonly value: string
  /** The datatype IRI. */
  readonly datatype: IRI
  /**
   * BCP 47 language tag, present only for `rdf:langString` literals.
   * Always `None` for typed literals.
   */
  readonly language: Option.Option<string>
}> {
  /**
   * Serialises the literal to its N-Triples representation.
   *
   * @example `"hello"^^<http://www.w3.org/2001/XMLSchema#string>`
   * @example `"Hola"@es`
   */
  toNT(): string {
    return Option.match(this.language, {
      onNone: () =>
        `"${escapeLexicalForm(this.value)}"^^${this.datatype.toNT()}`,
      onSome: (lang) => `"${escapeLexicalForm(this.value)}"@${lang}`
    })
  }

  override toString(): string {
    return this.toNT()
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Escapes characters that must be escaped in N-Triples literal lexical forms. */
const escapeLexicalForm = (s: string): string =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Creates a plain `xsd:string` literal.
 *
 * @since 0.1.0
 * @category constructors
 */
export const string = (value: string): Literal =>
  new Literal({ value, datatype: XSD_STRING, language: Option.none() })

/**
 * Creates an `rdf:langString` literal with the given BCP 47 language tag.
 *
 * @since 0.1.0
 * @category constructors
 */
export const langString = (value: string, language: string): Literal =>
  new Literal({ value, datatype: RDF_LANG_STRING, language: Option.some(language) })

/**
 * Creates a typed literal with an explicit datatype IRI.
 *
 * @since 0.1.0
 * @category constructors
 */
export const typed = (value: string, datatype: IRI): Literal =>
  new Literal({ value, datatype, language: Option.none() })

/**
 * Creates an `xsd:boolean` literal.
 *
 * @since 0.1.0
 * @category constructors
 */
export const boolean = (value: boolean): Literal =>
  new Literal({ value: value ? "true" : "false", datatype: XSD_BOOLEAN, language: Option.none() })

/**
 * Creates an `xsd:integer` literal.
 *
 * @since 0.1.0
 * @category constructors
 */
export const integer = (value: bigint | number): Literal =>
  new Literal({
    value: String(typeof value === "bigint" ? value : Math.trunc(value)),
    datatype: XSD_INTEGER,
    language: Option.none()
  })

/**
 * Creates an `xsd:double` literal.
 *
 * @since 0.1.0
 * @category constructors
 */
export const double = (value: number): Literal =>
  new Literal({ value: String(value), datatype: XSD_DOUBLE, language: Option.none() })

/**
 * Creates an `xsd:dateTime` literal from a `Date`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const dateTime = (value: Date): Literal =>
  new Literal({ value: value.toISOString(), datatype: XSD_DATETIME, language: Option.none() })

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Type-guard: returns `true` when `u` is a `Literal`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isLiteral = (u: unknown): u is Literal => u instanceof Literal

/**
 * Returns `true` when the literal is a language-tagged string.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isLangString = (literal: Literal): boolean =>
  Option.isSome(literal.language)
