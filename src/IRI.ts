/**
 * IRI (Internationalized Resource Identifier) — the fundamental identifier in RDF.
 *
 * Uses `Data.TaggedClass` so that two `IRI` instances with the same `value`
 * compare equal structurally (via `Equal.equals`) and hash identically.
 *
 * @example
 * ```ts
 * import { Equal } from "effect"
 * import * as IRI from "./IRI.js"
 *
 * const a = IRI.makeUnsafe("https://schema.org/Person")
 * const b = IRI.makeUnsafe("https://schema.org/Person")
 * assert(Equal.equals(a, b)) // true
 * ```
 *
 * @since 0.1.0
 */
import { Data, Effect } from "effect"
import { InvalidIRIError } from "./Errors.js"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * An RDF IRI node.
 *
 * @since 0.1.0
 * @category models
 */
export class IRI extends Data.TaggedClass("IRI")<{
  /** The raw IRI string, e.g. `"https://schema.org/Person"`. */
  readonly value: string
}> {
  /** Returns the IRI wrapped in angle brackets, as required by N-Triples / Turtle. */
  toNT(): string {
    return `<${this.value}>`
  }

  override toString(): string {
    return this.value
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** @internal */
const IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:/

/**
 * Returns `true` when `value` looks like a syntactically valid IRI.
 * This is a lightweight check (scheme presence); full validation is deferred
 * to a dedicated parser.
 *
 * @since 0.1.0
 * @category guards
 */
export const isValid = (value: string): boolean => IRI_SCHEME_RE.test(value)

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Constructs an `IRI` from a string, returning an `Effect` that fails with
 * `InvalidIRIError` when the string does not carry a recognised scheme.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (value: string): Effect.Effect<IRI, InvalidIRIError> =>
  isValid(value)
    ? Effect.succeed(new IRI({ value }))
    : Effect.fail(
        new InvalidIRIError({
          input: value,
          message: `"${value}" is not a valid IRI (missing or malformed scheme)`
        })
      )

/**
 * Constructs an `IRI` without validation.  Prefer `make` in application code.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeUnsafe = (value: string): IRI => new IRI({ value })

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Type-guard: returns `true` when `u` is an `IRI`.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isIRI = (u: unknown): u is IRI => u instanceof IRI
