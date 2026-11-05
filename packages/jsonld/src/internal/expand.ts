/**
 * Expansion Algorithm (JSON-LD 1.1 API §5.1).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import {
  type ActiveContext,
  applyTypeScopedContexts,
  type Env,
  expandIri,
  processContext,
  scopedTermOf,
  termOf,
} from './context.ts';
import {
  type Json,
  type JsonObject,
  asArray,
  compareStrings,
  fail,
  isAbsoluteIri,
  isBlankNodeId,
  isEmptyObject,
  isGraphObject,
  isKeyword,
  isListObject,
  isObject,
  isScalar,
  isString,
  isValueObject,
  getOrInit,
  hasOwn,
  pushAll,
  type ActiveProperty,
  GRAPH_PROPERTY,
  REVERSE_PROPERTY,
  isProperty,
  isTopLevel,
  stringifyJson,
} from './util.ts';

/** A frame-expansion `@language` / `@direction` value: `{}` or an array of strings. */
const isFrameStringValue = (value: Json): boolean =>
  isEmptyObject(value) || (Array.isArray(value) && value.every(isString));

/** @internal */
export interface ExpandOptions {
  readonly frameExpansion: boolean;
  readonly ordered: boolean;
}

/** @internal */
export const expandElement = (
  env: Env,
  active: ActiveContext,
  activeProperty: ActiveProperty,
  element: Json,
  baseUrl: string | null,
  options: ExpandOptions,
  fromMap = false,
): Json => {
  // 1
  if (element === null || element === undefined) return null;
  // 2
  if (isProperty(activeProperty, '@default')) options = { ...options, frameExpansion: false };
  // 3
  const propDef = Option.isNone(activeProperty)
    ? Option.none()
    : termOf(active, activeProperty.value);
  const propertyScoped = Option.filter(propDef, (def) => def.hasContext);
  // 4
  if (isScalar(element)) {
    if (Option.isNone(activeProperty) || activeProperty.value === '@graph') return null;
    if (Option.isSome(propertyScoped)) {
      const def = propertyScoped.value;
      active = processContext(env, active, def.context, def.baseUrl ?? null);
    }
    return expandValue(env, active, activeProperty.value, element);
  }
  // 5
  if (Array.isArray(element)) {
    const result: Array<Json> = [];
    const isList = Option.isSome(propDef) && propDef.value.container.includes('@list');
    element.forEach((item) => {
      const expanded = expandElement(env, active, activeProperty, item, baseUrl, options, fromMap);
      if (Array.isArray(expanded)) {
        if (isList) result.push({ '@list': expanded });
        else pushAll(result, expanded);
      } else if (expanded !== null) result.push(expanded);
    });
    return result;
  }
  // 6
  if (!isObject(element)) fail('invalid local context');
  // 7
  if (active.previous !== undefined && !fromMap) {
    const keys = Record.keys(element);
    const keep = keys.some((key) => {
      const exp = expandIri(env, active, key, true);
      return exp === '@value' || (keys.length === 1 && exp === '@id');
    });
    if (!keep) active = active.previous;
  }
  // 8
  if (Option.isSome(propertyScoped)) {
    const def = propertyScoped.value;
    active = processContext(env, active, def.context, def.baseUrl ?? null, [], true);
  }
  // 9
  if ('@context' in element) {
    active = processContext(env, active, element['@context'], baseUrl);
  }
  // 10
  const typeScoped = active;
  // 11
  const keys = Arr.sort(Record.keys(element), compareStrings);
  keys.forEach((key) => {
    if (expandIri(env, active, key, true) !== '@type') return;
    const values = asArray(element[key]);
    active = applyTypeScopedContexts(
      env,
      active,
      typeScoped,
      Arr.sort(Arr.filter(values, isString), compareStrings),
    );
  });
  // 12
  const typeKey = keys.find((key) => expandIri(env, active, key, true) === '@type');
  const lastType = typeKey === undefined ? undefined : asArray(element[typeKey]).at(-1);
  const inputIsJson = isString(lastType) && expandIri(env, active, lastType, true) === '@json';
  // 13, 14
  const result: JsonObject = {};
  expandObject(
    env,
    active,
    typeScoped,
    activeProperty,
    element,
    result,
    inputIsJson,
    baseUrl,
    options,
  );
  // 15
  if ('@value' in result) {
    const extra = Record.keys(result).find(
      (k) =>
        k !== '@direction' &&
        k !== '@index' &&
        k !== '@language' &&
        k !== '@type' &&
        k !== '@value',
    );
    if (extra !== undefined) fail('invalid value object', extra);
    if ('@type' in result && ('@language' in result || '@direction' in result)) {
      fail('invalid value object');
    }
    const type = result['@type'];
    if (type === '@json') {
      // any value
    } else {
      const v = result['@value'];
      if (v === null || (Array.isArray(v) && Arr.isReadonlyArrayEmpty(v))) return null;
      if (!isString(v) && '@language' in result) {
        if (!options.frameExpansion) fail('invalid language-tagged value');
      }
      if ('@type' in result) {
        if (options.frameExpansion) {
          // frames may use wildcards and arrays
        } else if (!isString(type) || !isAbsoluteIri(type) || isBlankNodeId(type)) {
          fail('invalid typed value');
        }
      }
    }
  } else if ('@type' in result) {
    // 16
    if (!Array.isArray(result['@type'])) result['@type'] = [result['@type']];
  } else if ('@set' in result || '@list' in result) {
    // 17
    const n = Record.keys(result).length;
    if (n > 2 || (n === 2 && !('@index' in result))) fail('invalid set or list object');
    if ('@set' in result) {
      const set = result['@set'];
      return finalize(set, activeProperty, options);
    }
  }
  return finalize(result, activeProperty, options);
};

const finalize = (result: Json, activeProperty: ActiveProperty, options: ExpandOptions): Json => {
  // 18
  if (isObject(result)) {
    const keys = Record.keys(result);
    if (keys.length === 1 && keys[0] === '@language') return null;
    // 19 (free-floating nodes are kept in frames)
    if (!options.frameExpansion && isTopLevel(activeProperty)) {
      if (Arr.isReadonlyArrayEmpty(keys) || '@value' in result || '@list' in result) return null;
      if (keys.length === 1 && keys[0] === '@id') return null;
    }
  }
  return result;
};

type ExpandObjectArguments = Parameters<typeof expandObject>;

/** What a keyword's expansion reads from the object being expanded (13.4). */
interface KeywordScope {
  readonly env: Env;
  readonly active: ActiveContext;
  readonly typeScoped: ActiveContext;
  readonly activeProperty: ExpandObjectArguments[3];
  readonly result: JsonObject;
  /** The object's last `@type` expands to `@json`. */
  readonly inputIsJson: ExpandObjectArguments[6];
  readonly baseUrl: ExpandObjectArguments[7];
  readonly options: ExpandOptions;
  readonly nests: Array<string>;
}

// Built once: runs for every keyword key of every object (13.4). It returns the expanded value
// to store under the keyword, or `undefined` when there is nothing to store.
const expandKeyword = Match.fn(
  (expandedProperty: string, _key: string, _value: Json, _kw: KeywordScope) => expandedProperty,
).pipe(
  Match.withReturnType<Json>(),
  Match.when('@id', (_p, _ep, _key, value, kw) => {
    if (isString(value)) return expandIri(kw.env, kw.active, value, false, true);
    if (kw.options.frameExpansion && isEmptyObject(value)) return [value];
    if (kw.options.frameExpansion && Array.isArray(value) && value.every(isString)) {
      return value.map((v) => expandIri(kw.env, kw.active, v, false, true));
    }
    return fail('invalid @id value', stringifyJson(value));
  }),
  Match.when('@type', (_p, _ep, _key, value, kw) => {
    let expandedValue: Json = undefined;
    if (kw.options.frameExpansion && isEmptyObject(value)) {
      expandedValue = value;
    } else if (
      kw.options.frameExpansion &&
      isObject(value) &&
      '@default' in value &&
      Record.keys(value).length === 1
    ) {
      expandedValue = {
        '@default': expandIri(kw.env, kw.typeScoped, value['@default'], true, true),
      };
    } else if (isString(value)) {
      expandedValue = expandIri(kw.env, kw.typeScoped, value, true, true);
    } else if (Array.isArray(value) && value.every(isString)) {
      expandedValue = value.map((v) => expandIri(kw.env, kw.typeScoped, v, true, true));
    } else {
      fail('invalid type value', stringifyJson(value));
    }
    if ('@type' in kw.result) {
      expandedValue = [...asArray(kw.result['@type']), ...asArray(expandedValue)];
    }
    return expandedValue;
  }),
  Match.when('@graph', (_p, _ep, _key, value, kw) =>
    asArray(expandElement(kw.env, kw.active, GRAPH_PROPERTY, value, kw.baseUrl, kw.options)),
  ),
  Match.when('@included', (_p, _ep, _key, value, kw) => {
    if (kw.env.processingMode === 'json-ld-1.0') return undefined;
    const expandedValue = asArray(
      expandElement(kw.env, kw.active, kw.activeProperty, value, kw.baseUrl, kw.options),
    );
    if (expandedValue.some((v) => !isObject(v) || '@value' in v || '@list' in v || '@set' in v)) {
      fail('invalid @included value');
    }
    return '@included' in kw.result ? [...kw.result['@included'], ...expandedValue] : expandedValue;
  }),
  Match.when('@value', (_p, _ep, _key, value, kw) => {
    let expandedValue: Json = undefined;
    if (kw.inputIsJson) {
      if (kw.env.processingMode === 'json-ld-1.0') fail('invalid value object value');
      expandedValue = value;
    } else if (value === null || isScalar(value)) {
      expandedValue = value;
    } else if (
      kw.options.frameExpansion &&
      (isEmptyObject(value) || (Array.isArray(value) && value.every(isScalar)))
    ) {
      expandedValue = value;
    } else {
      fail('invalid value object value');
    }
    if (expandedValue === null) {
      kw.result['@value'] = null;
      return undefined;
    }
    return expandedValue;
  }),
  Match.when('@language', (_p, _ep, _key, value, kw) => {
    if (isString(value)) return value;
    if (kw.options.frameExpansion && isFrameStringValue(value)) return value;
    return fail('invalid language-tagged string');
  }),
  Match.when('@direction', (_p, _ep, _key, value, kw) => {
    if (kw.env.processingMode === 'json-ld-1.0') return undefined;
    if (value === 'ltr' || value === 'rtl') return value;
    if (kw.options.frameExpansion && isFrameStringValue(value)) return value;
    return fail('invalid base direction');
  }),
  Match.when('@index', (_p, _ep, _key, value) => {
    if (!isString(value)) fail('invalid @index value');
    return value;
  }),
  Match.when('@list', (_p, _ep, _key, value, kw) => {
    if (isTopLevel(kw.activeProperty)) return undefined;
    const expandedValue = asArray(
      expandElement(kw.env, kw.active, kw.activeProperty, value, kw.baseUrl, kw.options),
    );
    if (kw.env.processingMode === 'json-ld-1.0' && expandedValue.some(isListObject)) {
      fail('list of lists');
    }
    return expandedValue;
  }),
  Match.when('@set', (_p, _ep, _key, value, kw) =>
    expandElement(kw.env, kw.active, kw.activeProperty, value, kw.baseUrl, kw.options),
  ),
  Match.when('@reverse', (_p, _ep, _key, value, kw) => {
    if (!isObject(value)) fail('invalid @reverse value');
    const ev = expandElement(kw.env, kw.active, REVERSE_PROPERTY, value, kw.baseUrl, kw.options);
    if (isObject(ev)) {
      if ('@reverse' in ev) {
        // An expanded `@reverse` value is a JSON object of reverse properties.
        const reversed: JsonObject = ev['@reverse'];
        Record.keys(reversed).forEach((property) => {
          if (!hasOwn(kw.result, property)) kw.result[property] = [];
          pushAll(kw.result[property], asArray(reversed[property]));
        });
      }
      const others = Record.keys(ev).filter((k) => k !== '@reverse');
      if (Arr.isReadonlyArrayNonEmpty(others)) {
        const reverseMap: JsonObject = getOrInit(kw.result, '@reverse', () => ({}));
        others.forEach((property) =>
          asArray(ev[property]).forEach((item) => {
            if (isValueObject(item) || isListObject(item)) {
              fail('invalid reverse property value');
            }
            getOrInit(reverseMap, property, () => []).push(item);
          }),
        );
      }
    }
    return undefined;
  }),
  Match.when('@nest', (_p, _ep, key, _value, kw) => {
    kw.nests.push(key);
    return undefined;
  }),
  Match.when('@default', (_p, _ep, _key, value, kw) =>
    kw.options.frameExpansion
      ? expandElement(kw.env, kw.active, kw.activeProperty, value, kw.baseUrl, kw.options)
      : undefined,
  ),
  Match.when(
    Match.is('@embed', '@explicit', '@omitDefault', '@requireAll'),
    (_p, _ep, _key, value, kw) => (kw.options.frameExpansion ? asArray(value) : undefined),
  ),
  Match.orElse(() => undefined),
);

const expandObject = (
  env: Env,
  active: ActiveContext,
  typeScoped: ActiveContext,
  activeProperty: ActiveProperty,
  element: JsonObject,
  result: JsonObject,
  inputIsJson: boolean,
  baseUrl: string | null,
  options: ExpandOptions,
): void => {
  const nests: Array<string> = [];
  const scope: KeywordScope = {
    env,
    active,
    typeScoped,
    activeProperty,
    result,
    inputIsJson,
    baseUrl,
    options,
    nests,
  };
  const keys = options.ordered
    ? Arr.sort(Record.keys(element), compareStrings)
    : Record.keys(element);
  keys.forEach((key) => {
    const value = element[key];
    // 13.1
    if (key === '@context') return;
    // 13.2
    const expandedProperty = expandIri(env, active, key, true);
    // 13.3
    if (
      expandedProperty === null ||
      (!expandedProperty.includes(':') && !isKeyword(expandedProperty))
    ) {
      return;
    }
    // 13.4
    if (isKeyword(expandedProperty)) {
      if (isProperty(activeProperty, '@reverse')) fail('invalid reverse property map');
      if (
        hasOwn(result, expandedProperty) &&
        expandedProperty !== '@included' &&
        expandedProperty !== '@type'
      ) {
        fail('colliding keywords', expandedProperty);
      }
      if (
        expandedProperty in result &&
        expandedProperty === '@type' &&
        env.processingMode === 'json-ld-1.0'
      ) {
        fail('colliding keywords', expandedProperty);
      }
      const expandedValue = expandKeyword(expandedProperty, key, value, scope);
      if (expandedValue !== undefined) result[expandedProperty] = expandedValue;
      return;
    }
    // 13.5
    const def = termOf(active, key);
    const container = Option.isSome(def) ? def.value.container : [];
    let expandedValue: Json;
    if (Option.isSome(def) && def.value.type === '@json') {
      // 13.6
      expandedValue = { '@value': value, '@type': '@json' };
    } else if (container.includes('@language') && isObject(value)) {
      // 13.7
      const values: Array<Json> = [];
      expandedValue = values;
      const direction =
        Option.isSome(def) && 'direction' in def.value ? def.value.direction : active.direction;
      const langs = options.ordered
        ? Arr.sort(Record.keys(value), compareStrings)
        : Record.keys(value);
      langs.forEach((language) =>
        asArray(value[language]).forEach((item) => {
          if (item === null) return;
          if (!isString(item)) fail('invalid language map value');
          const v: JsonObject = { '@value': item, '@language': language };
          if (language === '@none' || expandIri(env, active, language, true) === '@none') {
            delete v['@language'];
          }
          if (direction !== null && direction !== undefined) v['@direction'] = direction;
          values.push(v);
        }),
      );
    } else if (
      (container.includes('@index') || container.includes('@type') || container.includes('@id')) &&
      isObject(value)
    ) {
      // 13.8
      const values: Array<Json> = [];
      expandedValue = values;
      const indexKey = Option.isSome(def) ? (def.value.index ?? '@index') : '@index';
      const indexes = options.ordered
        ? Arr.sort(Record.keys(value), compareStrings)
        : Record.keys(value);
      indexes.forEach((index) => {
        let mapContext: ActiveContext = active;
        if (container.includes('@type')) {
          mapContext = active.previous ?? active;
          const indexDef = scopedTermOf(mapContext, index);
          if (Option.isSome(indexDef)) {
            mapContext = processContext(
              env,
              mapContext,
              indexDef.value.context,
              indexDef.value.baseUrl ?? null,
            );
          }
        }
        const expandedIndex = expandIri(env, active, index, true);
        const indexValue = asArray(
          expandElement(
            env,
            mapContext,
            Option.some(key),
            asArray(value[index]),
            baseUrl,
            options,
            true,
          ),
        );
        indexValue.forEach((expandedItem) => {
          const item =
            container.includes('@graph') && !isGraphObject(expandedItem)
              ? { '@graph': asArray(expandedItem) }
              : expandedItem;
          if (container.includes('@index') && indexKey !== '@index' && expandedIndex !== '@none') {
            const reExpanded = expandValue(env, active, indexKey, index);
            const expandedIndexKey = expandIri(env, active, indexKey, true) ?? indexKey;
            const existing = hasOwn(item, expandedIndexKey) ? asArray(item[expandedIndexKey]) : [];
            item[expandedIndexKey] = [reExpanded, ...existing];
            if (isValueObject(item) && Record.keys(item).length > 1) {
              fail('invalid value object');
            }
          } else if (
            container.includes('@index') &&
            !('@index' in item) &&
            expandedIndex !== '@none'
          ) {
            item['@index'] = index;
          } else if (container.includes('@id') && !('@id' in item) && expandedIndex !== '@none') {
            item['@id'] = expandIri(env, active, index, false, true);
          } else if (container.includes('@type') && expandedIndex !== '@none') {
            item['@type'] = [expandedIndex, ...(item['@type'] ? asArray(item['@type']) : [])];
          }
          values.push(item);
        });
      });
    } else {
      // 13.9
      expandedValue = expandElement(env, active, Option.some(key), value, baseUrl, options);
    }
    // 13.10
    if (expandedValue === null) return;
    // 13.11
    if (container.includes('@list') && !isListObject(expandedValue)) {
      expandedValue = { '@list': asArray(expandedValue) };
    }
    // 13.12
    if (
      container.includes('@graph') &&
      !container.includes('@id') &&
      !container.includes('@index')
    ) {
      expandedValue = asArray(expandedValue).map((ev) => ({ '@graph': asArray(ev) }));
    }
    // 13.13
    if (Option.isSome(def) && def.value.reverse) {
      const reverseMap: JsonObject = getOrInit(result, '@reverse', () => ({}));
      asArray(expandedValue).forEach((item) => {
        if (isValueObject(item) || isListObject(item)) fail('invalid reverse property value');
        getOrInit(reverseMap, expandedProperty, () => []).push(item);
      });
    } else {
      // 13.14
      pushAll(
        getOrInit(result, expandedProperty, () => []),
        asArray(expandedValue),
      );
    }
  });
  // 14
  const nestKeys = options.ordered ? Arr.sort(nests, compareStrings) : nests;
  nestKeys.forEach((nestKey) =>
    asArray(element[nestKey]).forEach((nested) => {
      if (!isObject(nested)) fail('invalid @nest value');
      if (Record.keys(nested).some((k) => expandIri(env, active, k, true) === '@value')) {
        fail('invalid @nest value');
      }
      const nestContext = Option.match(scopedTermOf(active, nestKey), {
        onNone: () => active,
        onSome: (nestDef) =>
          processContext(env, active, nestDef.context, nestDef.baseUrl ?? null, [], true),
      });
      expandObject(
        env,
        nestContext,
        typeScoped,
        activeProperty,
        nested,
        result,
        inputIsJson,
        baseUrl,
        options,
      );
    }),
  );
};

/**
 * Value Expansion algorithm.
 *
 * @internal
 */
export const expandValue = (
  env: Env,
  active: ActiveContext,
  activeProperty: string,
  value: Json,
): JsonObject => {
  const def = Option.getOrNull(termOf(active, activeProperty));
  const type = def === null ? undefined : def.type;
  // 1, 2
  if (type === '@id' && isString(value)) {
    return { '@id': expandIri(env, active, value, false, true) };
  }
  if (type === '@vocab' && isString(value)) {
    return { '@id': expandIri(env, active, value, true, true) };
  }
  // 3
  const result: JsonObject = { '@value': value };
  // 4
  if (type !== undefined && type !== '@id' && type !== '@vocab' && type !== '@none') {
    result['@type'] = type;
  } else if (isString(value)) {
    // 5
    const language = def !== null && 'language' in def ? def.language : active.language;
    const direction = def !== null && 'direction' in def ? def.direction : active.direction;
    if (language !== null && language !== undefined) result['@language'] = language;
    if (direction !== null && direction !== undefined) result['@direction'] = direction;
  }
  return result;
};
