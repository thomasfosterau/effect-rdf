import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import type * as ShExJ from '../../../src/shex/ShExJ.ts';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

/**
 * A schema as the JSON it serialises to (absent and `undefined` members
 * alike are dropped, as `toEqual` treats them).
 */
const toJson = (schema: ShExJ.Schema): Schema.Json => decodeJson(encodeJson(schema));

/** Whether a JSON value is an object (not an array or `null`). */
export const isJsonObject = (v: Schema.Json): v is Schema.JsonObject =>
  Predicate.isObject(v) && !Array.isArray(v);

const isTripleExpression = (v: Schema.JsonObject): boolean =>
  v['type'] === 'TripleConstraint' || v['type'] === 'EachOf' || v['type'] === 'OneOf';

/**
 * Canonicalises a ShExJ schema for comparison modulo blank node labels and
 * the order of `extra` predicates (which ShExR cannot preserve): blank node
 * labels are renamed in order of first appearance, and blank-node triple
 * expression labels that are never referenced are dropped (RDF cannot
 * distinguish them from anonymous expressions).
 */
export const canonical = (schema: ShExJ.Schema): Schema.Json => {
  const json = toJson(schema);
  const referencedTe = MutableHashSet.empty<string>();
  const collectRefs = (v: Schema.Json, key: Option.Option<string>): void => {
    if (Predicate.isString(v)) {
      if (
        Option.exists(key, (k) => k === 'expression' || k === 'expressions') &&
        v.startsWith('_:')
      )
        MutableHashSet.add(referencedTe, v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x) => collectRefs(x, key));
      return;
    }
    if (isJsonObject(v)) Record.toEntries(v).forEach(([k, x]) => collectRefs(x, Option.some(k)));
  };
  collectRefs(json, Option.none());
  const names = MutableHashMap.empty<string, string>();
  const rename = (label: string) =>
    Option.getOrElse(MutableHashMap.get(names, label), () => {
      const n = `_:c${MutableHashMap.size(names)}`;
      MutableHashMap.set(names, label, n);
      return n;
    });
  const byKey = Order.mapInput(Order.String, ([k]: readonly [string, Schema.Json]) => k);
  const go = (v: Schema.Json, key: Option.Option<string>): Schema.Json => {
    if (Predicate.isString(v))
      return v.startsWith('_:') && !Option.contains(key, 'value') ? rename(v) : v;
    if (Array.isArray(v)) {
      const items = v.map((x) => go(x, key));
      return Option.contains(key, 'extra') && Arr.every(items, Predicate.isString)
        ? Arr.sort(items, Order.String)
        : items;
    }
    if (isJsonObject(v)) {
      const isTe = isTripleExpression(v);
      return Record.fromEntries(
        Arr.filterMap(Arr.sort(Record.toEntries(v), byKey), ([k, x]) =>
          isTe &&
          k === 'id' &&
          Predicate.isString(x) &&
          x.startsWith('_:') &&
          !MutableHashSet.has(referencedTe, x)
            ? Result.failVoid
            : Result.succeed([k, go(x, Option.some(k))] as const),
        ),
      );
    }
    return v;
  };
  return go(json, Option.none());
};
