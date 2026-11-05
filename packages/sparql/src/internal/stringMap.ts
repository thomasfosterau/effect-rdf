/**
 * String-keyed maps for the engine's hot paths (solution mappings, hash
 * joins, indexes). Each is the backing `Map` of a `MutableHashMap`: string
 * keys need no hashing, so `MutableHashMap` stores them there unchanged, and
 * the engine reads and writes it directly, without a `dual` call or an
 * `Option` per lookup. Insertion order is kept, as solution order depends on
 * it.
 *
 * @internal
 */
import * as Iterable from 'effect/Iterable';
import * as MutableHashMap from 'effect/MutableHashMap';

/** A new, empty string-keyed map. */
export const empty = <V>(): Map<string, V> => MutableHashMap.empty<string, V>().backing;

/** A copy of a string-keyed map. */
export const copy = <V>(map: ReadonlyMap<string, V>): Map<string, V> => {
  const out = empty<V>();
  map.forEach((v, k) => out.set(k, v));
  return out;
};

/** A string-keyed map of the entries (a later entry replaces an earlier one). */
export const fromEntries = <V>(entries: Iterable<readonly [string, V]>): Map<string, V> => {
  const out = empty<V>();
  Iterable.forEach(entries, ([k, v]) => out.set(k, v));
  return out;
};

/** A new, empty string set (a string-keyed map to `true`). */
export const emptySet = (): Map<string, true> => empty<true>();

/** A string set of the values. */
export const setOf = (values: Iterable<string>): Map<string, true> => {
  const out = emptySet();
  Iterable.forEach(values, (v) => out.set(v, true));
  return out;
};
