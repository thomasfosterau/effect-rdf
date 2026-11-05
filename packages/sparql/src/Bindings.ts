/**
 * Solution mappings: immutable maps from variable names to RDF terms.
 *
 * `Bindings` implement `Equal` and `Hash` (two solutions are equal when they
 * bind the same variables to the same terms) and `Iterable` over
 * `[name, term]` pairs.
 *
 * @since 0.1.0
 */
import * as Arr from 'effect/Array';
import * as Equal from 'effect/Equal';
import * as Hash from 'effect/Hash';
import { NodeInspectSymbol } from 'effect/Inspectable';
import * as Iterable from 'effect/Iterable';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import { pipeArguments, type Pipeable } from 'effect/Pipeable';
import { hasProperty } from 'effect/Predicate';
import * as Record from 'effect/Record';
import type * as Term from '@thomasfosterau/effect-rdf/Term';
import * as StringMap from './internal/stringMap.ts';

/** Orders `[name, term]` entries by name. */
const byName = Order.mapInput(Order.String, ([name]: readonly [string, Term.GroundTerm]) => name);

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
export class Bindings
  implements Iterable<readonly [string, Term.GroundTerm]>, Equal.Equal, Pipeable
{
  readonly [TypeId]: TypeId = TypeId;
  #key = Option.none<string>();
  /** @internal */
  readonly map: ReadonlyMap<string, Term.GroundTerm>;
  /**
   * The solution this one was extended from (by `BIND` / select
   * expressions), identifying the "same solution" for `BNODE(str)`.
   *
   * @internal
   */
  readonly origin: Bindings | undefined;
  constructor(map: ReadonlyMap<string, Term.GroundTerm>, origin?: Bindings) {
    this.map = map;
    this.origin = origin;
  }

  /** The number of bound variables. */
  get size(): number {
    return this.map.size;
  }

  /** A canonical string identifying this solution (used for hashing and DISTINCT). */
  get key(): string {
    if (Option.isSome(this.#key)) return this.#key.value;
    const key = Arr.sort(this.map, byName)
      .map(([n, t]) => `${n}=${t.key}`)
      .join('\u0000');
    this.#key = Option.some(key);
    return key;
  }

  [Symbol.iterator](): Iterator<readonly [string, Term.GroundTerm]> {
    return this.map.entries();
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return isEqualBindings(that) && that.key === this.key;
  }

  [Hash.symbol](): number {
    return Hash.string(this.key);
  }

  pipe() {
    return pipeArguments(this, arguments);
  }

  toJSON(): Readonly<Record<string, string>> {
    return Record.fromEntries(Array.from(this.map, ([k, v]) => [k, v.toString()]));
  }

  toString(): string {
    return `{ ${Array.from(this.map, ([k, v]) => `?${k} → ${v.toString()}`).join(', ')} }`;
  }

  [NodeInspectSymbol](): Readonly<Record<string, string>> {
    return this.toJSON();
  }
}

/**
 * @since 0.1.0
 * @category guards
 */
export const isBindings = (u: unknown): u is Bindings => hasProperty(u, TypeId);

const isEqualBindings = (that: Equal.Equal): that is Bindings => hasProperty(that, TypeId);

/**
 * The empty solution mapping (the join identity).
 *
 * @since 0.1.0
 * @category constructors
 */
export const empty: Bindings = new Bindings(StringMap.empty());

/**
 * @since 0.1.0
 * @category constructors
 */
export const fromEntries = (
  entries: Iterable<readonly [string, Term.GroundTerm | undefined]>,
): Bindings => {
  const map = StringMap.empty<Term.GroundTerm>();
  Iterable.forEach(entries, ([k, v]) => {
    if (v !== undefined) map.set(k, v);
  });
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
  fromEntries(Record.toEntries(record));

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
  const map = StringMap.copy(self.map);
  map.set(name, term);
  return new Bindings(map, self.origin ?? self);
};

/**
 * Removes a binding.
 *
 * @since 0.1.0
 * @category combinators
 */
export const remove = (self: Bindings, name: string): Bindings => {
  if (!self.map.has(name)) return self;
  const map = StringMap.copy(self.map);
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
  return !Iterable.some(small.map, ([k, v]) => {
    const w = large.map.get(k);
    return w !== undefined && w.key !== v.key;
  });
};

/**
 * Whether two solutions share at least one variable.
 *
 * @since 0.1.0
 * @category predicates
 */
export const sharesVariable = (a: Bindings, b: Bindings): boolean => {
  const [small, large] = a.map.size <= b.map.size ? [a, b] : [b, a];
  return Iterable.some(small.map.keys(), (k) => large.map.has(k));
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
  const map = StringMap.copy(a.map);
  // The first variable bound to different terms, if any (the others are merged in on the way).
  const clash = Iterable.some(b.map, ([k, v]) => {
    const w = map.get(k);
    if (w !== undefined) return w.key !== v.key;
    map.set(k, v);
    return false;
  });
  return clash ? undefined : new Bindings(map);
};

/**
 * Restricts a solution to the given variables.
 *
 * @since 0.1.0
 * @category combinators
 */
export const project = (self: Bindings, names: ReadonlyArray<string>): Bindings => {
  const map = StringMap.empty<Term.GroundTerm>();
  names.forEach((n) => {
    const v = self.map.get(n);
    if (v !== undefined) map.set(n, v);
  });
  return map.size === self.map.size ? self : new Bindings(map);
};

/**
 * Converts a solution to a plain record.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toRecord = (self: Bindings): Readonly<Record<string, Term.GroundTerm>> =>
  Record.fromEntries(self.map);
