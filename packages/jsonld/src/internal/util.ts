/** @internal */
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as JsonLdError from '../JsonLdError.ts';
import * as Predicate from 'effect/Predicate';

/** @internal */
export type Json = any;
/** @internal */
export type JsonObject = Record<string, any>;

const JsonText = Schema.fromJsonString(Schema.Unknown);

const encodeJson = Schema.encodeUnknownResult(JsonText);

/**
 * Serialises a JSON value (`JSON.stringify` semantics); a value with no JSON
 * form (`undefined`) renders as `String(value)`, as in a template literal.
 *
 * @internal
 */
export const stringifyJson = (value: Json): string =>
  Result.getOrElse(encodeJson(value), () => String(value));

/** @internal */
export const KEYWORDS: ReadonlySet<string> = new Set([
  '@base',
  '@container',
  '@context',
  '@default',
  '@direction',
  '@embed',
  '@explicit',
  '@graph',
  '@id',
  '@import',
  '@included',
  '@index',
  '@json',
  '@language',
  '@list',
  '@nest',
  '@none',
  '@omitDefault',
  '@prefix',
  '@preserve',
  '@protected',
  '@requireAll',
  '@reverse',
  '@set',
  '@type',
  '@value',
  '@version',
  '@vocab',
]);

/** @internal */
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
/** @internal */
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
/** @internal */
export const RDF_TYPE = `${RDF}type`;
/** @internal */
export const RDF_FIRST = `${RDF}first`;
/** @internal */
export const RDF_REST = `${RDF}rest`;
/** @internal */
export const RDF_NIL = `${RDF}nil`;
/** @internal */
export const RDF_LIST = `${RDF}List`;
/** @internal */
export const RDF_JSON = `${RDF}JSON`;
/** @internal */
export const RDF_VALUE = `${RDF}value`;
/** @internal */
export const RDF_LANGUAGE = `${RDF}language`;
/** @internal */
export const RDF_DIRECTION = `${RDF}direction`;
/** @internal */
export const RDF_LANG_STRING = `${RDF}langString`;
/** @internal */
export const XSD_STRING = `${XSD}string`;
/** @internal */
export const XSD_BOOLEAN = `${XSD}boolean`;
/** @internal */
export const XSD_INTEGER = `${XSD}integer`;
/** @internal */
export const XSD_DOUBLE = `${XSD}double`;
/** @internal */
export const I18N = 'https://www.w3.org/ns/i18n#';

/** @internal */
export const fail = (code: JsonLdError.Code, message?: string): never => {
  throw JsonLdError.make(code, message);
};

/**
 * Runs `f`, handing a thrown `JsonLdError` to `onError` (which rethrows a
 * different one); any other thrown value propagates unchanged.
 *
 * @internal
 */
export const mapJsonLdError = <A>(
  f: () => A,
  onError: (error: JsonLdError.JsonLdError) => never,
): A =>
  Result.getOrElse(
    Result.try({
      try: f,
      catch: (e) => {
        if (JsonLdError.isJsonLdError(e)) return e;
        throw e;
      },
    }),
    onError,
  );

/** @internal */
export const hasOwn = (o: JsonObject, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** @internal */
export const getOrInit = (o: JsonObject, k: string, init: () => Json): Json => {
  if (!hasOwn(o, k)) o[k] = init();
  return o[k];
};

/** @internal */
export const isKeyword = (v: Json): boolean => Predicate.isString(v) && KEYWORDS.has(v);

/** @internal */
export const hasKeywordForm = (v: string): boolean => /^@[a-zA-Z]+$/.test(v);

/** @internal */
export const isObject = (v: unknown): v is JsonObject => Predicate.isObject(v);

/** @internal */
export const isEmptyObject = (v: Json): boolean => isObject(v) && Object.keys(v).length === 0;

/** @internal */
export const isString = (v: unknown): v is string => Predicate.isString(v);

/** @internal */
export const isScalar = (v: unknown): v is string | number | boolean =>
  Predicate.isString(v) || Predicate.isNumber(v) || Predicate.isBoolean(v);

/** @internal */
export const asArray = (v: Json): Array<Json> => (Array.isArray(v) ? v : [v]);

/** @internal */
export const isBlankNodeId = (v: unknown): v is string =>
  Predicate.isString(v) && v.startsWith('_:');

/** @internal */
export const isAbsoluteIri = (v: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(v);

/** @internal */
export const isWellFormedIri = (v: string): boolean => Iri.isValid(v);

/** @internal */
export const isWellFormedLanguage = (v: string): boolean =>
  /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(v);

/** @internal */
export const isValueObject = (v: Json): boolean => isObject(v) && '@value' in v;

/** @internal */
export const isListObject = (v: Json): boolean => isObject(v) && '@list' in v;

/** @internal */
export const isGraphObject = (v: unknown): v is JsonObject => {
  if (!isObject(v) || !('@graph' in v)) return false;
  for (const k of Object.keys(v)) {
    if (k !== '@graph' && k !== '@id' && k !== '@index' && k !== '@context') return false;
  }
  return true;
};

/** @internal */
export const isSimpleGraphObject = (v: unknown): v is JsonObject =>
  isGraphObject(v) && !('@id' in v);

/** @internal */
export const isNodeObject = (v: unknown): v is JsonObject =>
  isObject(v) && !('@value' in v) && !('@list' in v) && !('@set' in v);

/** @internal */
export const deepEqual = (a: Json, b: Json): boolean => {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
};

/** @internal */
export const compareStrings: Order.Order<string> = Order.String;

/** @internal */
export const sortedKeys = (o: JsonObject): Array<string> =>
  Arr.sort(Object.keys(o), compareStrings);

/**
 * Adds a value to an entry of a map. When `asArray` is true the entry is
 * always an array.
 *
 * @internal
 */
export const addValue = (object: JsonObject, key: string, value: Json, asArray: boolean): void => {
  if (Array.isArray(value)) {
    if (value.length === 0 && asArray && !hasOwn(object, key)) object[key] = [];
    for (const v of value) addValue(object, key, v, asArray);
    return;
  }
  if (!hasOwn(object, key)) {
    object[key] = asArray ? [value] : value;
  } else {
    if (!Array.isArray(object[key])) object[key] = [object[key]];
    object[key].push(value);
  }
};

/** @internal */
export const addUnique = (array: Array<Json>, value: Json): void => {
  for (const v of array) if (deepEqual(v, value)) return;
  array.push(value);
};

/** @internal */
export const clone = <A>(v: A): A => (v === undefined ? v : structuredClone(v));

/**
 * The JSON Canonicalization Scheme (RFC 8785).
 *
 * @internal
 */
export const canonicalJson = (v: Json): string => {
  if (v === null || Predicate.isBoolean(v) || Predicate.isNumber(v) || Predicate.isString(v)) {
    return stringifyJson(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Arr.sort(Object.keys(v), compareStrings);
  return `{${keys.map((k) => `${stringifyJson(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

/**
 * A blank node identifier issuer.
 *
 * @internal
 */
export class IdIssuer {
  #counter = 0;
  readonly #map = new Map<string, string>();
  readonly prefix: string;
  constructor(prefix: string = '_:b') {
    this.prefix = prefix;
  }
  issue(old?: string | null): string {
    if (old != null) {
      const existing = this.#map.get(old);
      if (existing !== undefined) return existing;
    }
    const id = `${this.prefix}${this.#counter++}`;
    if (old != null) this.#map.set(old, id);
    return id;
  }
  has(old: string): boolean {
    return this.#map.has(old);
  }
}
