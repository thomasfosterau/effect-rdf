/** @internal */
import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Iri from '../../Iri.ts';
import * as JsonLdError from '../JsonLdError.ts';
import * as Predicate from 'effect/Predicate';

/** @internal */
export type Json = any;
/** @internal */
export type JsonObject = globalThis.Record<string, any>;

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
export const hasOwn = (o: JsonObject, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/**
 * A membership test for a fixed set of strings: a lookup in a prototype-less
 * record, so that no `Object.prototype` member is a member.
 *
 * @internal
 */
export const stringSet = (members: ReadonlyArray<string>): ((s: string) => boolean) => {
  const record: globalThis.Record<string, true> = Object.create(null);
  members.forEach((m) => {
    record[m] = true;
  });
  return (s) => record[s] === true;
};

const isKeywordString = stringSet([
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

/**
 * Throws the `JsonLdError` with this code. Its type is declared on the
 * binding, so that a call statement narrows like a `throw`.
 *
 * @internal
 */
export const fail: (code: JsonLdError.Code, message?: string) => never = (code, message) => {
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

/**
 * The active property of the algorithms: none at the top level of a document.
 *
 * @internal
 */
export type ActiveProperty = Option.Option<string>;

/** @internal */
export const GRAPH_PROPERTY: ActiveProperty = Option.some('@graph');
/** @internal */
export const REVERSE_PROPERTY: ActiveProperty = Option.some('@reverse');

/**
 * The active property is `keyword` (`@graph`, `@reverse`, …).
 *
 * @internal
 */
export const isProperty = (activeProperty: ActiveProperty, keyword: string): boolean =>
  Option.isSome(activeProperty) && activeProperty.value === keyword;

/**
 * At the top level, or directly under `@graph`: where free-floating values are dropped.
 *
 * @internal
 */
export const isTopLevel = (activeProperty: ActiveProperty): boolean =>
  Option.isNone(activeProperty) || activeProperty.value === '@graph';

/** @internal */
export const getOrInit = (o: JsonObject, k: string, init: () => Json): Json => {
  if (!hasOwn(o, k)) o[k] = init();
  return o[k];
};

/** @internal */
export const isKeyword = (v: Json): boolean => Predicate.isString(v) && isKeywordString(v);

// Hoisted: a regex literal makes a new `RegExp` each time it is evaluated.
const KEYWORD_FORM = /^@[a-zA-Z]+$/;
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/;

/** @internal */
export const hasKeywordForm = (v: string): boolean => KEYWORD_FORM.test(v);

/** @internal */
export const isObject = (v: unknown): v is JsonObject => Predicate.isObject(v);

/** @internal */
export const isEmptyObject = (v: Json): boolean =>
  isObject(v) && Arr.isReadonlyArrayEmpty(Record.keys(v));

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
export const isAbsoluteIri = (v: string): boolean => ABSOLUTE_IRI.test(v);

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
  return Record.keys(v).every(
    (k) => k === '@graph' || k === '@id' || k === '@index' || k === '@context',
  );
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
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Record.keys(a);
    return (
      ka.length === Record.keys(b).length && ka.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
};

/** @internal */
export const compareStrings: Order.Order<string> = Order.String;

/** @internal */
export const sortedKeys = (o: JsonObject): Array<string> =>
  Arr.sort(Record.keys(o), compareStrings);

/**
 * Appends every item to `target` (one `push` per item: spreading a large
 * array into `push` can overflow the stack).
 *
 * @internal
 */
export const pushAll = (target: Array<Json>, items: ReadonlyArray<Json>): void => {
  items.forEach((item) => target.push(item));
};

/**
 * Adds a value to an entry of a map. When `forceArray` is true the entry is
 * always an array.
 *
 * @internal
 */
export const addValue = (
  object: JsonObject,
  key: string,
  value: Json,
  forceArray: boolean,
): void => {
  if (Array.isArray(value)) {
    if (Arr.isReadonlyArrayEmpty(value) && forceArray && !hasOwn(object, key)) object[key] = [];
    value.forEach((v) => addValue(object, key, v, forceArray));
    return;
  }
  if (!hasOwn(object, key)) {
    object[key] = forceArray ? [value] : value;
  } else {
    if (!Array.isArray(object[key])) object[key] = [object[key]];
    object[key].push(value);
  }
};

/** @internal */
export const addUnique = (array: Array<Json>, value: Json): void => {
  if (!array.some((v) => deepEqual(v, value))) array.push(value);
};

/**
 * Steps a state until `step` returns none, and returns the last state: a
 * loop as a function, for the scans that walk a structure of unknown length.
 *
 * @internal
 */
export const loop = <S>(initial: S, step: (state: S) => Option.Option<S>): S => {
  let state = initial;
  Arr.unfold(undefined, () =>
    Option.map(step(state), (next): readonly [undefined, undefined] => {
      state = next;
      return [undefined, undefined];
    }),
  );
  return state;
};

/**
 * Deep-copies a JSON value with an explicit work stack: `structuredClone`
 * recurses natively, so a deeply embedded framing result overflowed the stack
 * (#108). Shared and cyclic references are kept, as `structuredClone` keeps them.
 *
 * @internal
 */
export const clone = <A>(v: A): A => {
  if (!Predicate.isObjectOrArray(v)) return v;
  const copies = new WeakMap<object>();
  const copyOf = (source: object): Json => {
    const known = copies.get(source);
    if (known !== undefined) return known;
    const copy: Json = Array.isArray(source) ? [] : {};
    copies.set(source, copy);
    pending.push([source, copy]);
    return copy;
  };
  const pending: Array<readonly [Json, Json]> = [];
  const root = copyOf(v);
  loop(pending, (stack) => {
    const top = stack.pop();
    if (top === undefined) return Option.none();
    const [source, copy] = top;
    Record.keys(source).forEach((key) => {
      const value = source[key];
      copy[key] = Predicate.isObjectOrArray(value) ? copyOf(value) : value;
    });
    return Option.some(stack);
  });
  return root;
};

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
  const keys = Arr.sort(Record.keys(v), compareStrings);
  return `{${keys.map((k) => `${stringifyJson(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

/**
 * A blank node identifier issuer.
 *
 * @internal
 */
export class IdIssuer {
  #counter = 0;
  readonly #map = MutableHashMap.empty<string, string>();
  readonly prefix: string;
  constructor(prefix: string = '_:b') {
    this.prefix = prefix;
  }
  /** A fresh identifier, or the one already issued for `old`. */
  issue(old?: string): string {
    if (old === undefined) return this.#next();
    return Option.getOrElse(MutableHashMap.get(this.#map, old), () => {
      const id = this.#next();
      MutableHashMap.set(this.#map, old, id);
      return id;
    });
  }
  has(old: string): boolean {
    return MutableHashMap.has(this.#map, old);
  }
  #next(): string {
    return `${this.prefix}${this.#counter++}`;
  }
}
