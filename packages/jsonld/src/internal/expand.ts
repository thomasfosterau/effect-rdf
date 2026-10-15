/**
 * Expansion Algorithm (JSON-LD 1.1 API §5.1).
 *
 * @internal
 */
import { type ActiveContext, type Env, expandIri, processContext } from './context.ts';
import {
  type Json,
  type JsonObject,
  asArray,
  compareStrings,
  fail,
  isAbsoluteIri,
  isBlankNodeId,
  isGraphObject,
  isKeyword,
  isListObject,
  isObject,
  isScalar,
  isString,
  isValueObject,
  getOrInit,
  hasOwn,
} from './util.ts';

/** @internal */
export interface ExpandOptions {
  readonly frameExpansion: boolean;
  readonly ordered: boolean;
}

/** @internal */
export const expandElement = (
  env: Env,
  active: ActiveContext,
  activeProperty: string | null,
  element: Json,
  baseUrl: string | null,
  options: ExpandOptions,
  fromMap = false,
): Json => {
  // 1
  if (element === null || element === undefined) return null;
  // 2
  if (activeProperty === '@default') options = { ...options, frameExpansion: false };
  // 3
  const propDef = activeProperty === null ? undefined : active.terms.get(activeProperty);
  const propertyScoped = propDef?.hasContext === true ? propDef : undefined;
  // 4
  if (isScalar(element)) {
    if (activeProperty === null || activeProperty === '@graph') return null;
    if (propertyScoped !== undefined) {
      active = processContext(env, active, propertyScoped.context, propertyScoped.baseUrl ?? null);
    }
    return expandValue(env, active, activeProperty, element);
  }
  // 5
  if (Array.isArray(element)) {
    const result: Array<Json> = [];
    const container = propDef?.container ?? [];
    for (const item of element) {
      let expanded = expandElement(env, active, activeProperty, item, baseUrl, options, fromMap);
      if (container.includes('@list') && Array.isArray(expanded)) expanded = { '@list': expanded };
      if (Array.isArray(expanded)) result.push(...expanded);
      else if (expanded !== null) result.push(expanded);
    }
    return result;
  }
  // 6
  if (!isObject(element)) fail('invalid local context');
  // 7
  if (active.previous !== undefined && !fromMap) {
    let revert = true;
    const keys = Object.keys(element);
    for (const key of keys) {
      const exp = expandIri(env, active, key, true);
      if (exp === '@value' || (keys.length === 1 && exp === '@id')) {
        revert = false;
        break;
      }
    }
    if (revert) active = active.previous;
  }
  // 8
  if (propertyScoped !== undefined) {
    active = processContext(
      env,
      active,
      propertyScoped.context,
      propertyScoped.baseUrl ?? null,
      [],
      true,
    );
  }
  // 9
  if ('@context' in element) {
    active = processContext(env, active, element['@context'], baseUrl);
  }
  // 10
  const typeScoped = active;
  // 11
  let inputType: string | null = null;
  const keys = Object.keys(element).sort(compareStrings);
  for (const key of keys) {
    if (expandIri(env, active, key, true) !== '@type') continue;
    const values = asArray(element[key]);
    for (const term of [...values].filter(isString).sort(compareStrings)) {
      const def = typeScoped.terms.get(term);
      if (def?.hasContext === true) {
        active = processContext(env, active, def.context, def.baseUrl ?? null, [], false, false);
      }
    }
  }
  // 12
  for (const key of keys) {
    if (expandIri(env, active, key, true) !== '@type') continue;
    const values = asArray(element[key]);
    const lastValue = values[values.length - 1];
    if (isString(lastValue)) inputType = expandIri(env, active, lastValue, true);
    break;
  }
  // 13, 14
  const result: JsonObject = {};
  expandObject(
    env,
    active,
    typeScoped,
    activeProperty,
    element,
    result,
    inputType,
    baseUrl,
    options,
  );
  // 15
  if ('@value' in result) {
    for (const k of Object.keys(result)) {
      if (
        k !== '@direction' &&
        k !== '@index' &&
        k !== '@language' &&
        k !== '@type' &&
        k !== '@value'
      ) {
        fail('invalid value object', k);
      }
    }
    if ('@type' in result && ('@language' in result || '@direction' in result)) {
      fail('invalid value object');
    }
    const type = result['@type'];
    if (type === '@json') {
      // any value
    } else {
      const v = result['@value'];
      if (v === null || (Array.isArray(v) && v.length === 0)) return null;
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
    const n = Object.keys(result).length;
    if (n > 2 || (n === 2 && !('@index' in result))) fail('invalid set or list object');
    if ('@set' in result) {
      const set = result['@set'];
      return finalize(set, activeProperty, options);
    }
  }
  return finalize(result, activeProperty, options);
};

const finalize = (result: Json, activeProperty: string | null, options: ExpandOptions): Json => {
  // 18
  if (isObject(result)) {
    const keys = Object.keys(result);
    if (keys.length === 1 && keys[0] === '@language') return null;
    // 19 (free-floating nodes are kept in frames)
    if (!options.frameExpansion && (activeProperty === null || activeProperty === '@graph')) {
      if (keys.length === 0 || '@value' in result || '@list' in result) return null;
      if (keys.length === 1 && keys[0] === '@id') return null;
    }
  }
  return result;
};

const expandObject = (
  env: Env,
  active: ActiveContext,
  typeScoped: ActiveContext,
  activeProperty: string | null,
  element: JsonObject,
  result: JsonObject,
  inputType: string | null,
  baseUrl: string | null,
  options: ExpandOptions,
): void => {
  const nests: Array<string> = [];
  const keys = options.ordered ? Object.keys(element).sort(compareStrings) : Object.keys(element);
  for (const key of keys) {
    const value = element[key];
    // 13.1
    if (key === '@context') continue;
    // 13.2
    const expandedProperty = expandIri(env, active, key, true);
    // 13.3
    if (
      expandedProperty === null ||
      (!expandedProperty.includes(':') && !isKeyword(expandedProperty))
    ) {
      continue;
    }
    // 13.4
    if (isKeyword(expandedProperty)) {
      if (activeProperty === '@reverse') fail('invalid reverse property map');
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
      let expandedValue: Json = undefined;
      switch (expandedProperty) {
        case '@id': {
          if (isString(value)) {
            expandedValue = expandIri(env, active, value, false, true);
          } else if (options.frameExpansion && isObject(value) && Object.keys(value).length === 0) {
            expandedValue = [value];
          } else if (options.frameExpansion && Array.isArray(value) && value.every(isString)) {
            expandedValue = value.map((v) => expandIri(env, active, v, false, true));
          } else {
            fail('invalid @id value', JSON.stringify(value));
          }
          break;
        }
        case '@type': {
          if (options.frameExpansion && isObject(value) && Object.keys(value).length === 0) {
            expandedValue = value;
          } else if (
            options.frameExpansion &&
            isObject(value) &&
            '@default' in value &&
            Object.keys(value).length === 1
          ) {
            expandedValue = {
              '@default': expandIri(env, typeScoped, value['@default'], true, true),
            };
          } else if (isString(value)) {
            expandedValue = expandIri(env, typeScoped, value, true, true);
          } else if (Array.isArray(value) && value.every(isString)) {
            expandedValue = value.map((v) => expandIri(env, typeScoped, v, true, true));
          } else {
            fail('invalid type value', JSON.stringify(value));
          }
          if ('@type' in result) {
            expandedValue = [...asArray(result['@type']), ...asArray(expandedValue)];
          }
          break;
        }
        case '@graph': {
          expandedValue = asArray(expandElement(env, active, '@graph', value, baseUrl, options));
          break;
        }
        case '@included': {
          if (env.processingMode === 'json-ld-1.0') continue;
          expandedValue = asArray(
            expandElement(env, active, activeProperty, value, baseUrl, options),
          );
          for (const v of expandedValue) {
            if (!isObject(v) || '@value' in v || '@list' in v || '@set' in v) {
              fail('invalid @included value');
            }
          }
          if ('@included' in result) expandedValue = [...result['@included'], ...expandedValue];
          break;
        }
        case '@value': {
          if (inputType === '@json') {
            if (env.processingMode === 'json-ld-1.0') fail('invalid value object value');
            expandedValue = value;
          } else if (value === null || isScalar(value)) {
            expandedValue = value;
          } else if (
            options.frameExpansion &&
            ((isObject(value) && Object.keys(value).length === 0) ||
              (Array.isArray(value) && value.every(isScalar)))
          ) {
            expandedValue = value;
          } else {
            fail('invalid value object value');
          }
          if (expandedValue === null) {
            result['@value'] = null;
            continue;
          }
          break;
        }
        case '@language': {
          if (isString(value)) expandedValue = value;
          else if (
            options.frameExpansion &&
            ((isObject(value) && Object.keys(value).length === 0) ||
              (Array.isArray(value) && value.every(isString)))
          ) {
            expandedValue = value;
          } else fail('invalid language-tagged string');
          break;
        }
        case '@direction': {
          if (env.processingMode === 'json-ld-1.0') continue;
          if (value === 'ltr' || value === 'rtl') expandedValue = value;
          else if (
            options.frameExpansion &&
            ((isObject(value) && Object.keys(value).length === 0) ||
              (Array.isArray(value) && value.every(isString)))
          ) {
            expandedValue = value;
          } else fail('invalid base direction');
          break;
        }
        case '@index': {
          if (!isString(value)) fail('invalid @index value');
          expandedValue = value;
          break;
        }
        case '@list': {
          if (activeProperty === null || activeProperty === '@graph') continue;
          expandedValue = asArray(
            expandElement(env, active, activeProperty, value, baseUrl, options),
          );
          if (env.processingMode === 'json-ld-1.0' && expandedValue.some(isListObject)) {
            fail('list of lists');
          }
          break;
        }
        case '@set': {
          expandedValue = expandElement(env, active, activeProperty, value, baseUrl, options);
          break;
        }
        case '@reverse': {
          if (!isObject(value)) fail('invalid @reverse value');
          const ev = expandElement(env, active, '@reverse', value, baseUrl, options);
          if (isObject(ev)) {
            if ('@reverse' in ev) {
              for (const [property, items] of Object.entries(ev['@reverse'] as JsonObject)) {
                if (!hasOwn(result, property)) result[property] = [];
                result[property].push(...asArray(items));
              }
            }
            const others = Object.keys(ev).filter((k) => k !== '@reverse');
            if (others.length > 0) {
              const reverseMap: JsonObject = getOrInit(result, '@reverse', () => ({}));
              for (const property of others) {
                for (const item of asArray(ev[property])) {
                  if (isValueObject(item) || isListObject(item)) {
                    fail('invalid reverse property value');
                  }
                  getOrInit(reverseMap, property, () => []).push(item);
                }
              }
            }
          }
          continue;
        }
        case '@nest': {
          nests.push(key);
          continue;
        }
        case '@default': {
          if (options.frameExpansion) {
            expandedValue = expandElement(env, active, activeProperty, value, baseUrl, options);
          }
          break;
        }
        case '@embed':
        case '@explicit':
        case '@omitDefault':
        case '@requireAll': {
          if (options.frameExpansion) expandedValue = asArray(value);
          break;
        }
        default:
          break;
      }
      if (expandedValue !== undefined) result[expandedProperty] = expandedValue;
      continue;
    }
    // 13.5
    const def = active.terms.get(key);
    const container = def?.container ?? [];
    let expandedValue: Json;
    if (def?.type === '@json') {
      // 13.6
      expandedValue = { '@value': value, '@type': '@json' };
    } else if (container.includes('@language') && isObject(value)) {
      // 13.7
      expandedValue = [];
      let direction: string | null | undefined = active.direction;
      if (def !== undefined && 'direction' in def) direction = def.direction;
      const langs = options.ordered ? Object.keys(value).sort(compareStrings) : Object.keys(value);
      for (const language of langs) {
        for (const item of asArray(value[language])) {
          if (item === null) continue;
          if (!isString(item)) fail('invalid language map value');
          const v: JsonObject = { '@value': item, '@language': language };
          if (language === '@none' || expandIri(env, active, language, true) === '@none') {
            delete v['@language'];
          }
          if (direction !== null && direction !== undefined) v['@direction'] = direction;
          expandedValue.push(v);
        }
      }
    } else if (
      (container.includes('@index') || container.includes('@type') || container.includes('@id')) &&
      isObject(value)
    ) {
      // 13.8
      expandedValue = [];
      const indexKey = def?.index ?? '@index';
      const indexes = options.ordered
        ? Object.keys(value).sort(compareStrings)
        : Object.keys(value);
      for (const index of indexes) {
        let mapContext: ActiveContext;
        if (container.includes('@id') || container.includes('@type')) {
          mapContext = active.previous ?? active;
        } else {
          mapContext = active;
        }
        if (container.includes('@type')) {
          const indexDef = mapContext.terms.get(index);
          if (indexDef?.hasContext === true) {
            mapContext = processContext(
              env,
              mapContext,
              indexDef.context,
              indexDef.baseUrl ?? null,
            );
          }
        } else {
          mapContext = active;
        }
        const expandedIndex = expandIri(env, active, index, true);
        const indexValue = asArray(
          expandElement(env, mapContext, key, asArray(value[index]), baseUrl, options, true),
        );
        for (let item of indexValue) {
          if (container.includes('@graph') && !isGraphObject(item)) {
            item = { '@graph': asArray(item) };
          }
          if (container.includes('@index') && indexKey !== '@index' && expandedIndex !== '@none') {
            const reExpanded = expandValue(env, active, indexKey, index);
            const expandedIndexKey = expandIri(env, active, indexKey, true)!;
            const existing = hasOwn(item, expandedIndexKey) ? asArray(item[expandedIndexKey]) : [];
            item[expandedIndexKey] = [reExpanded, ...existing];
            if (isValueObject(item) && Object.keys(item).length > 1) {
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
          expandedValue.push(item);
        }
      }
    } else {
      // 13.9
      expandedValue = expandElement(env, active, key, value, baseUrl, options);
    }
    // 13.10
    if (expandedValue === null) continue;
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
    if (def?.reverse === true) {
      const reverseMap: JsonObject = getOrInit(result, '@reverse', () => ({}));
      for (const item of asArray(expandedValue)) {
        if (isValueObject(item) || isListObject(item)) fail('invalid reverse property value');
        getOrInit(reverseMap, expandedProperty, () => []).push(item);
      }
    } else {
      // 13.14
      getOrInit(result, expandedProperty, () => []).push(...asArray(expandedValue));
    }
  }
  // 14
  const nestKeys = options.ordered ? [...nests].sort(compareStrings) : nests;
  for (const nestKey of nestKeys) {
    for (const nested of asArray(element[nestKey])) {
      if (!isObject(nested)) fail('invalid @nest value');
      for (const k of Object.keys(nested)) {
        if (expandIri(env, active, k, true) === '@value') fail('invalid @nest value');
      }
      const nestDef = active.terms.get(nestKey);
      const nestContext =
        nestDef?.hasContext === true
          ? processContext(env, active, nestDef.context, nestDef.baseUrl ?? null, [], true)
          : active;
      expandObject(
        env,
        nestContext,
        typeScoped,
        activeProperty,
        nested,
        result,
        inputType,
        baseUrl,
        options,
      );
    }
  }
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
  const def = active.terms.get(activeProperty);
  // 1, 2
  if (def?.type === '@id' && isString(value)) {
    return { '@id': expandIri(env, active, value, false, true) };
  }
  if (def?.type === '@vocab' && isString(value)) {
    return { '@id': expandIri(env, active, value, true, true) };
  }
  // 3
  const result: JsonObject = { '@value': value };
  // 4
  if (
    def?.type !== undefined &&
    def.type !== '@id' &&
    def.type !== '@vocab' &&
    def.type !== '@none'
  ) {
    result['@type'] = def.type;
  } else if (isString(value)) {
    // 5
    const language = def !== undefined && 'language' in def ? def.language : active.language;
    const direction = def !== undefined && 'direction' in def ? def.direction : active.direction;
    if (language !== null && language !== undefined) result['@language'] = language;
    if (direction !== null && direction !== undefined) result['@direction'] = direction;
  }
  return result;
};
