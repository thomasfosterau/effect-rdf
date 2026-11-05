/**
 * Counting and list-following helpers shared by the passes that fold
 * `rdf:first` / `rdf:rest` chains into collections (`Isomorphism`, `Mapping`).
 *
 * @internal
 */
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import { rdf } from '@thomasfosterau/effect-rdf/Vocab';
import * as Guards from './guards.ts';
import { loop } from './loop.ts';

/** Adds one to the count of `key`. @internal */
export const increment = (
  counts: MutableHashMap.MutableHashMap<string, number>,
  key: string,
): void => {
  MutableHashMap.set(counts, key, (counts.backing.get(key) ?? 0) + 1);
};

/** The count of `key` (0 when it has none). @internal */
export const count = (counts: MutableHashMap.MutableHashMap<string, number>, key: string): number =>
  counts.backing.get(key) ?? 0;

/** Appends `value` to the values of `key`. @internal */
export const append = <A>(
  map: MutableHashMap.MutableHashMap<string, Array<A>>,
  key: string,
  value: A,
): void => {
  const values = map.backing.get(key);
  if (values === undefined) MutableHashMap.set(map, key, [value]);
  else values.push(value);
};

/** The `rdf:first` and `rdf:rest` statements (or quads) of a list cell. @internal */
export type Cell<S> = readonly [first: S, rest: S];

/** The single value of `key`, if it has exactly one. @internal */
export const single = <A>(
  map: MutableHashMap.MutableHashMap<string, Array<A>>,
  key: string,
): Option.Option<A> => {
  const values = map.backing.get(key);
  return values?.length === 1 ? Option.fromUndefinedOr(values[0]) : Option.none();
};

/**
 * Follows the list whose first cell is the blank node `head` to `rdf:nil`:
 * its cells, or `None` when it is not a well-formed list (a cell is missing
 * or not allowed, the chain is cyclic or does not end in `rdf:nil`).
 * `cellOf` gives the cell of a label, and whether it is the head.
 *
 * @internal
 */
export const followList = <S extends { readonly object: unknown }>(
  head: string,
  cellOf: (label: string, isHead: boolean) => Option.Option<Cell<S>>,
): Option.Option<ReadonlyArray<Cell<S>>> => {
  const cells: Array<Cell<S>> = [];
  const seen = MutableHashSet.empty<string>();
  let label = head;
  let ok = true;
  loop(() => {
    const cell = MutableHashSet.has(seen, label) ? Option.none() : cellOf(label, label === head);
    if (Option.isNone(cell)) {
      ok = false;
      return false;
    }
    MutableHashSet.add(seen, label);
    cells.push(cell.value);
    const next = cell.value[1].object;
    if (Guards.isNamedNode(next) && next.value === rdf.nil.value) return false;
    if (!Guards.isBlankNode(next)) {
      ok = false;
      return false;
    }
    label = next.value;
    return true;
  });
  return ok ? Option.some(cells) : Option.none();
};

/**
 * Records the list at `head`: its items under `head` in `heads`, and its
 * cells' statements (or quads) as `consumed`.
 *
 * @internal
 */
export const record = <S extends { readonly object: O }, O>(
  heads: MutableHashMap.MutableHashMap<string, Array<O>>,
  consumed: WeakSet<S>,
  head: string,
  cells: ReadonlyArray<Cell<S>>,
): void => {
  MutableHashMap.set(
    heads,
    head,
    cells.map(([first]) => first.object),
  );
  cells.forEach(([first, rest]) => {
    consumed.add(first);
    consumed.add(rest);
  });
};
