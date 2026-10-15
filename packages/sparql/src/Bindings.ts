/**
 * Solution mappings: immutable maps from variable names to RDF terms.
 *
 * `Bindings` implement `Equal` and `Hash` (two solutions are equal when they
 * bind the same variables to the same terms) and `Iterable` over
 * `[name, term]` pairs.
 *
 * @since 0.1.0
 */
import * as Equal from 'effect/Equal';
import * as Hash from 'effect/Hash';
import { NodeInspectSymbol } from 'effect/Inspectable';
import * as Option from 'effect/Option';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import { hasProperty } from 'effect/Predicate';
import type * as Term from '@thomasfosterau/effect-rdf/Term';

/**
 * @since 0.1.0
 * @category symbols
 */
export const TypeId: unique symbol = Symbol.for('@thomasfosterau/effect-sparql/Bindings');

/**
 * @since 0.1.0
 * @category symbols
 */
export type TypeId = typeof TypeId;

/**
 * A solution mapping.
 *
 * @since 0.1.0
 * @category models
 */
export class Bindings implements Iterable<readonly [string, Term.GroundTerm]>, Equal.Equal, Pipeable {
  readonly [TypeId]: TypeId = TypeId;
  #key: string | undefined;
  /** @internal */
  constructor(readonly map: ReadonlyMap<string, Term.GroundTerm>) {}

  /** The number of bound variables. */
  get size(): number {
    return this.map.size;
  }

  /** A canonical string identifying this solution (used for hashing and DISTINCT). */
  get key(): string {
    if (this.#key === undefined) {
      const names = Array.from(this.map.keys()).sort();
      this.#key = names.map((n) => `${n}=${this.map.get(n)!.key}`).join('\u0000');
    }
    return this.#key;
  }

  [Symbol.iterator](): Iterator<readonly [string, Term.GroundTerm]> {
    return this.map.entries();
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return isBindings(that) && that.key === this.key;
  }

  [Hash.symbol](): number {
    return Hash.string(this.key);
  }

  pipe() {
    return pipeArguments(this, arguments);
  }

  toJSON(): unknown {
    return Object.fromEntries(Array.from(this.map, ([k, v]) => [k, v.toString()]));
  }

  toString(): string {
    return `{ ${Array.from(this.map, ([k, v]) => `?${k} → ${v.toString()}`).join(', ')} }`;
  }

  [NodeInspectSymbol](): unknown {
    return this.toJSON();
  }
}

/**
 * @since 0.1.0
 * @category guards
 */
export const isBindings = (u: unknown): u is Bindings => hasProperty(u, TypeId);

/**
 * The empty solution mapping (the join identity).
 *
 * @since 0.1.0
 * @category constructors
 */
export const empty: Bindings = new Bindings(new Map());

/**
 * @since 0.1.0
 * @category constructors
 */
export const fromEntries = (
  entries: Iterable<readonly [string, Term.GroundTerm | undefined]>,
): Bindings => {
  const map = new Map<string, Term.GroundTerm>();
  for (const [k, v] of entries) if (v !== undefined) map.set(k, v);
  return new Bindings(map);
};

/**
 * Creates bindings from a record of variable names (without `?`) to terms.
 * `undefined` values are left unbound.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (record: Readonly<Record<string, Term.GroundTerm | undefined>>): Bindings =>
  fromEntries(Object.entries(record));

/**
 * The term bound to a variable, if any.
 *
 * @since 0.1.0
 * @category getters
 */
export const get = (self: Bindings, name: string): Option.Option<Term.GroundTerm> =>
  Option.fromNullishOr(self.map.get(name));

/**
 * The term bound to a variable, or `undefined`.
 *
 * @since 0.1.0
 * @category getters
 */
export const getUndefined = (self: Bindings, name: string): Term.GroundTerm | undefined =>
  self.map.get(name);

/**
 * @since 0.1.0
 * @category getters
 */
export const has = (self: Bindings, name: string): boolean => self.map.has(name);

/**
 * The names of the bound variables.
 *
 * @since 0.1.0
 * @category getters
 */
export const variables = (self: Bindings): ReadonlyArray<string> => Array.from(self.map.keys());

/**
 * Binds a variable (replacing any existing binding).
 *
 * @since 0.1.0
 * @category combinators
 */
export const set = (self: Bindings, name: string, term: Term.GroundTerm): Bindings => {
  const map = new Map(self.map);
  map.set(name, term);
  return new Bindings(map);
};

/**
 * Removes a binding.
 *
 * @since 0.1.0
 * @category combinators
 */
export const remove = (self: Bindings, name: string): Bindings => {
  if (!self.map.has(name)) return self;
  const map = new Map(self.map);
  map.delete(name);
  return new Bindings(map);
};

/**
 * Whether two solutions are compatible: every shared variable is bound to
 * the same term.
 *
 * @since 0.1.0
 * @category predicates
 */
export const compatible = (a: Bindings, b: Bindings): boolean => {
  const [small, large] = a.map.size <= b.map.size ? [a, b] : [b, a];
  for (const [k, v] of small.map) {
    const w = large.map.get(k);
    if (w !== undefined && w.key !== v.key) return false;
  }
  return true;
};

/**
 * Whether two solutions share at least one variable.
 *
 * @since 0.1.0
 * @category predicates
 */
export const sharesVariable = (a: Bindings, b: Bindings): boolean => {
  const [small, large] = a.map.size <= b.map.size ? [a, b] : [b, a];
  for (const k of small.map.keys()) if (large.map.has(k)) return true;
  return false;
};

/**
 * Merges two solutions, returning `undefined` if they are not compatible.
 *
 * @since 0.1.0
 * @category combinators
 */
export const merge = (a: Bindings, b: Bindings): Bindings | undefined => {
  if (b.map.size === 0) return a;
  if (a.map.size === 0) return b;
  const map = new Map(a.map);
  for (const [k, v] of b.map) {
    const w = map.get(k);
    if (w === undefined) map.set(k, v);
    else if (w.key !== v.key) return undefined;
  }
  return new Bindings(map);
};

/**
 * Restricts a solution to the given variables.
 *
 * @since 0.1.0
 * @category combinators
 */
export const project = (self: Bindings, names: ReadonlyArray<string>): Bindings => {
  const map = new Map<string, Term.GroundTerm>();
  for (const n of names) {
    const v = self.map.get(n);
    if (v !== undefined) map.set(n, v);
  }
  return map.size === self.map.size ? self : new Bindings(map);
};

/**
 * Converts a solution to a plain record.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toRecord = (self: Bindings): Readonly<Record<string, Term.GroundTerm>> =>
  Object.fromEntries(self.map);
