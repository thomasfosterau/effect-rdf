/** @internal */
import * as Iri from '@thomasfosterau/effect-rdf/Iri';
import * as JsonLdError from '../JsonLdError.ts';

/** @internal */
export type Json = any;
/** @internal */
export type JsonObject = Record<string, any>;

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

/** @internal */
export const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** @internal */
export const getOrInit = (o: Record<string, any>, k: string, init: () => unknown): any => {
  if (!hasOwn(o, k)) o[k] = init();
  return o[k];
};

/** @internal */
export const isKeyword = (v: unknown): boolean => typeof v === 'string' && KEYWORDS.has(v);

/** @internal */
export const hasKeywordForm = (v: string): boolean => /^@[a-zA-Z]+$/.test(v);

/** @internal */
export const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** @internal */
export const isEmptyObject = (v: unknown): boolean => isObject(v) && Object.keys(v).length === 0;

/** @internal */
export const isString = (v: unknown): v is string => typeof v === 'string';

/** @internal */
export const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** @internal */
export const asArray = (v: Json): Array<Json> => (Array.isArray(v) ? v : [v]);

/** @internal */
export const isBlankNodeId = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('_:');

/** @internal */
export const isAbsoluteIri = (v: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(v);

/** @internal */
export const isWellFormedIri = (v: string): boolean => Iri.isValid(v);

/** @internal */
export const isWellFormedLanguage = (v: string): boolean =>
  /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(v);

/** @internal */
export const isValueObject = (v: unknown): boolean => isObject(v) && '@value' in v;

/** @internal */
export const isListObject = (v: unknown): boolean => isObject(v) && '@list' in v;

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
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** @internal */
export const sortedKeys = (o: JsonObject): Array<string> => Object.keys(o).sort(compareStrings);

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
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort(compareStrings);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
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
