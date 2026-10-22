import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';
import type * as ShExJ from '../../src/ShExJ.ts';

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
  const referencedTe = new Set<string>();
  const collectRefs = (v: Schema.Json, key: string | undefined): void => {
    if (Predicate.isString(v)) {
      if ((key === 'expression' || key === 'expressions') && v.startsWith('_:'))
        referencedTe.add(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x) => collectRefs(x, key));
      return;
    }
    if (isJsonObject(v)) for (const [k, x] of Object.entries(v)) collectRefs(x, k);
  };
  collectRefs(json, undefined);
  const names = new Map<string, string>();
  const rename = (label: string) => {
    let n = names.get(label);
    if (n === undefined) names.set(label, (n = `_:c${names.size}`));
    return n;
  };
  const byString = Order.make<Schema.Json>((a, b) => {
    const c = String(a).localeCompare(String(b));
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  });
  const byKey = Order.mapInput(Order.String, ([k]: readonly [string, Schema.Json]) => k);
  const go = (v: Schema.Json, key: string | undefined): Schema.Json => {
    if (Predicate.isString(v)) return v.startsWith('_:') && key !== 'value' ? rename(v) : v;
    if (Array.isArray(v)) {
      const items = v.map((x) => go(x, key));
      return key === 'extra' ? Arr.sort(items, byString) : items;
    }
    if (isJsonObject(v)) {
      const out: { [key: string]: Schema.Json } = {};
      const isTe = isTripleExpression(v);
      for (const [k, x] of Arr.sort(Object.entries(v), byKey)) {
        if (
          isTe &&
          k === 'id' &&
          Predicate.isString(x) &&
          x.startsWith('_:') &&
          !referencedTe.has(x)
        )
          continue;
        out[k] = go(x, k);
      }
      return out;
    }
    return v;
  };
  return go(json, undefined);
};
