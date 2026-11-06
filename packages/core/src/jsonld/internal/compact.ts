/**
 * Compaction Algorithms (JSON-LD 1.1 API §6).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Order from 'effect/Order';
import * as Record from 'effect/Record';
import {
  type ActiveContext,
  applyTypeScopedContexts,
  type ContainerEntry,
  type Env,
  type InverseContext,
  type TermDefinition,
  expandIri,
  processContext,
} from './context.ts';
import { removeBase } from './iri.ts';
import {
  type Json,
  type JsonObject,
  addValue,
  asArray,
  compareStrings,
  fail,
  isGraphObject,
  isListObject,
  isObject,
  isScalar,
  isSimpleGraphObject,
  isString,
  isValueObject,
  getOrInit,
  hasOwn,
  pushAll,
  type ActiveProperty,
  REVERSE_PROPERTY,
  isProperty,
} from './util.ts';

/** The definition of `term`, read where a missing definition reads as its defaults. */
const definitionOf = (active: ActiveContext, term: string) =>
  // `termOf` without its `Option`: a string key's entry is in the map's `backing`.
  active.terms.backing.get(term);

/** @internal */
export interface CompactOptions {
  readonly compactArrays: boolean;
  readonly ordered: boolean;
  readonly compactToRelative: boolean;
}

/**
 * Compaction Algorithm.
 *
 * @internal
 */
export const compactElement = (
  env: Env,
  active: ActiveContext,
  activeProperty: ActiveProperty,
  element: Json,
  options: CompactOptions,
): Json => {
  // 1
  const typeScoped = active;
  // 2
  if (isScalar(element) || element === null) return element;
  // 3
  if (Array.isArray(element)) {
    const result: Array<Json> = [];
    element.forEach((item) => {
      const compacted = compactElement(env, active, activeProperty, item, options);
      if (compacted !== null) result.push(compacted);
    });
    const container = activeContainer(active, activeProperty);
    if (
      result.length !== 1 ||
      !options.compactArrays ||
      isProperty(activeProperty, '@graph') ||
      isProperty(activeProperty, '@set') ||
      container.includes('@list') ||
      container.includes('@set')
    ) {
      return result;
    }
    return result[0];
  }
  // The property-scoped context is looked up before reverting a
  // non-propagated (type-scoped) context.
  const propDef = activeDefinition(active, activeProperty);
  // 5
  if (active.previous !== undefined) {
    const keys = Record.keys(element);
    if (!('@value' in element) && !(keys.length === 1 && keys[0] === '@id')) {
      active = active.previous;
    }
  }
  // 6
  if (propDef?.hasContext === true) {
    active = processContext(env, active, propDef.context, propDef.baseUrl ?? null, [], true);
  }
  // 7
  if ('@value' in element || '@id' in element) {
    const compacted = compactValue(env, active, activeProperty, element, options);
    if (isScalar(compacted) || compacted === null || propDef?.type === '@json') {
      // A value object with null @value never reaches here after expansion.
      if (isScalar(compacted) || propDef?.type === '@json') return compacted;
    }
  }
  // 8
  if (isListObject(element) && activeContainer(active, activeProperty).includes('@list')) {
    return compactElement(env, active, activeProperty, element['@list'], options);
  }
  // 9
  const insideReverse = isProperty(activeProperty, '@reverse');
  // 10
  const result: JsonObject = {};
  // 11
  if ('@type' in element) {
    const compactedTypes = Arr.sort(
      asArray(element['@type']).map((t: string) =>
        compactIri(env, typeScoped, t, null, true, false, options),
      ),
      compareStrings,
    );
    active = applyTypeScopedContexts(env, active, typeScoped, compactedTypes);
  }
  // 12
  const scope: Scope = { env, active, typeScoped, activeProperty, options, result, insideReverse };
  const keys = options.ordered
    ? Arr.sort(Record.keys(element), compareStrings)
    : Record.keys(element);
  keys.forEach((expandedProperty) => {
    const expandedValue = element[expandedProperty];
    if (!compactKeywordEntry(scope, expandedProperty, expandedValue)) {
      compactPropertyEntry(scope, expandedProperty, expandedValue);
    }
  });
  return result;
};

/** What the compaction of one element's entries reads (step 12). */
interface Scope {
  readonly env: Env;
  readonly active: ActiveContext;
  readonly typeScoped: ActiveContext;
  readonly activeProperty: ActiveProperty;
  readonly options: CompactOptions;
  readonly result: JsonObject;
  readonly insideReverse: boolean;
}

/** The IRI compaction of a keyword (as a vocabulary term) in the active context. */
const aliasOf = (scope: Scope, keyword: string): string =>
  compactIri(scope.env, scope.active, keyword, null, true, false, scope.options);

/** Steps 12.1 - 12.6: a keyword entry. Returns false for an entry they leave to 12.7. */
const compactKeywordEntry = (
  scope: Scope,
  expandedProperty: string,
  expandedValue: Json,
): boolean => {
  const { env, active, activeProperty, options, result } = scope;
  // A refinement chain: this runs for every entry of every element compacted.
  if (expandedProperty === '@id') {
    // 12.1
    result[aliasOf(scope, '@id')] = isString(expandedValue)
      ? compactIri(env, active, expandedValue, null, false, false, options)
      : expandedValue;
  } else if (expandedProperty === '@type') {
    compactTypeEntry(scope, expandedValue);
  } else if (expandedProperty === '@reverse') {
    compactReverseEntry(scope, expandedValue);
  } else if (expandedProperty === '@preserve') {
    // 12.4
    const compactedValue = compactElement(env, active, activeProperty, expandedValue, options);
    if (!(Array.isArray(expandedValue) && Arr.isReadonlyArrayEmpty(expandedValue))) {
      result['@preserve'] = compactedValue;
    }
  } else if (expandedProperty === '@index') {
    // 12.5, 12.6
    if (!activeContainer(active, activeProperty).includes('@index')) {
      result[aliasOf(scope, expandedProperty)] = expandedValue;
    }
  } else if (
    expandedProperty === '@direction' ||
    expandedProperty === '@language' ||
    expandedProperty === '@value'
  ) {
    // 12.6
    result[aliasOf(scope, expandedProperty)] = expandedValue;
  } else {
    return false;
  }
  return true;
};

/** Step 12.2: `@type`. */
const compactTypeEntry = (scope: Scope, expandedValue: Json): void => {
  const { env, active, typeScoped, options, result } = scope;
  // A `@type` value that is not a string is an array of IRIs after expansion.
  const types: Array<string> = isString(expandedValue) ? [] : expandedValue;
  const compactedValue: Json = isString(expandedValue)
    ? compactIri(env, typeScoped, expandedValue, null, true, false, options)
    : types.map((t) => compactIri(env, typeScoped, t, null, true, false, options));
  const alias = aliasOf(scope, '@type');
  const asArr =
    (env.processingMode !== 'json-ld-1.0' && containerOf(active, alias).includes('@set')) ||
    !options.compactArrays;
  addValue(result, alias, compactedValue, asArr);
  if (!asArr && Array.isArray(result[alias]) && result[alias].length === 1) {
    result[alias] = result[alias][0];
  }
};

/** Step 12.3: `@reverse`. */
const compactReverseEntry = (scope: Scope, expandedValue: Json): void => {
  const { env, active, options, result } = scope;
  const compactedValue = compactElement(env, active, REVERSE_PROPERTY, expandedValue, options);
  Record.keys(compactedValue).forEach((property) => {
    const def = definitionOf(active, property);
    if (def?.reverse === true) {
      const asArr = def.container.includes('@set') || !options.compactArrays;
      addValue(result, property, compactedValue[property], asArr);
      delete compactedValue[property];
    }
  });
  if (Arr.isReadonlyArrayNonEmpty(Record.keys(compactedValue))) {
    result[aliasOf(scope, '@reverse')] = compactedValue;
  }
};

/** Steps 12.7 and 12.8: a property entry. */
const compactPropertyEntry = (
  scope: Scope,
  expandedProperty: string,
  expandedValue: Json,
): void => {
  const { env, active, options, result, insideReverse } = scope;
  // 12.7
  if (Array.isArray(expandedValue) && Arr.isReadonlyArrayEmpty(expandedValue)) {
    const itemActiveProperty = compactIri(
      env,
      active,
      expandedProperty,
      expandedValue,
      true,
      insideReverse,
      options,
    );
    const nestResult = nestResultFor(env, active, result, itemActiveProperty, options);
    addValue(nestResult, itemActiveProperty, [], true);
  }
  // 12.8
  asArray(expandedValue).forEach((expandedItem) =>
    compactPropertyItem(scope, expandedProperty, expandedItem),
  );
};

/** Where step 12.8 puts one compacted item. */
interface ItemTarget {
  /** The item active property. */
  readonly property: string;
  readonly nestResult: JsonObject;
  readonly container: Array<string>;
  readonly asArr: boolean;
}

/** Step 12.8: one item of a property entry. */
const compactPropertyItem = (scope: Scope, expandedProperty: string, expandedItem: Json): void => {
  const { env, active, options, result, insideReverse } = scope;
  const property = compactIri(
    env,
    active,
    expandedProperty,
    expandedItem,
    true,
    insideReverse,
    options,
  );
  const container = containerOf(active, property);
  const target: ItemTarget = {
    property,
    nestResult: nestResultFor(env, active, result, property, options),
    container,
    asArr:
      container.includes('@set') ||
      property === '@graph' ||
      property === '@list' ||
      !options.compactArrays,
  };
  const inner = isListObject(expandedItem)
    ? expandedItem['@list']
    : isGraphObject(expandedItem)
      ? expandedItem['@graph']
      : expandedItem;
  const compactedItem = compactElement(env, active, Option.some(property), inner, options);
  if (isListObject(expandedItem)) compactListItem(scope, target, expandedItem, compactedItem);
  else if (isGraphObject(expandedItem)) {
    compactGraphItem(scope, target, expandedItem, compactedItem);
  } else if (
    (container.includes('@language') ||
      container.includes('@index') ||
      container.includes('@id') ||
      container.includes('@type')) &&
    !container.includes('@graph')
  ) {
    compactMapItem(scope, target, expandedItem, compactedItem);
  } else {
    // 12.8.10
    addValue(target.nestResult, property, compactedItem, target.asArr);
  }
};

/** Step 12.8.7: a list object. */
const compactListItem = (
  scope: Scope,
  target: ItemTarget,
  expandedItem: JsonObject,
  compacted: Json,
): void => {
  const items = asArray(compacted);
  if (target.container.includes('@list')) {
    target.nestResult[target.property] = items;
    return;
  }
  const compactedItem: JsonObject = { [aliasOf(scope, '@list')]: items };
  if ('@index' in expandedItem) compactedItem[aliasOf(scope, '@index')] = expandedItem['@index'];
  addValue(target.nestResult, target.property, compactedItem, target.asArr);
};

/** Step 12.8.8: a graph object. */
const compactGraphItem = (
  scope: Scope,
  target: ItemTarget,
  expandedItem: JsonObject,
  compactedItem: Json,
): void => {
  const { env, active, options } = scope;
  const { container, nestResult, property, asArr } = target;
  if (container.includes('@graph') && container.includes('@id')) {
    const mapObject: JsonObject = getOrInit(nestResult, property, () => ({}));
    const mapKey =
      '@id' in expandedItem
        ? compactIri(env, active, expandedItem['@id'], null, false, false, options)
        : aliasOf(scope, '@none');
    addValue(mapObject, mapKey, compactedItem, asArr);
  } else if (
    container.includes('@graph') &&
    container.includes('@index') &&
    isSimpleGraphObject(expandedItem)
  ) {
    const mapObject: JsonObject = getOrInit(nestResult, property, () => ({}));
    const mapKey = '@index' in expandedItem ? expandedItem['@index'] : aliasOf(scope, '@none');
    addValue(mapObject, mapKey, compactedItem, asArr);
  } else if (container.includes('@graph') && isSimpleGraphObject(expandedItem)) {
    const value =
      Array.isArray(compactedItem) && compactedItem.length > 1
        ? { [aliasOf(scope, '@included')]: compactedItem }
        : compactedItem;
    addValue(nestResult, property, value, asArr);
  } else {
    const value: JsonObject = { [aliasOf(scope, '@graph')]: compactedItem };
    if ('@id' in expandedItem) {
      value[aliasOf(scope, '@id')] = compactIri(
        env,
        active,
        expandedItem['@id'],
        null,
        false,
        false,
        options,
      );
    }
    if ('@index' in expandedItem) value[aliasOf(scope, '@index')] = expandedItem['@index'];
    addValue(nestResult, property, value, asArr);
  }
};

/** A compacted item and the key of the map entry it goes under (none: `@none`). */
interface MapEntry {
  readonly key: Json;
  readonly value: Json;
}

/** Step 12.8.9: an item of a language, index, id or type map. */
const compactMapItem = (
  scope: Scope,
  target: ItemTarget,
  expandedItem: JsonObject,
  compactedItem: Json,
): void => {
  const { container, nestResult, property, asArr } = target;
  const mapObject: JsonObject = getOrInit(nestResult, property, () => ({}));
  const indexKey = definitionOf(scope.active, property)?.index ?? '@index';
  let entry: MapEntry;
  if (container.includes('@language') && '@value' in expandedItem) {
    entry = { key: expandedItem['@language'], value: expandedItem['@value'] };
  } else if (container.includes('@language')) {
    // Not a value object: read like a type map, under the `@language` alias.
    entry = typeMapEntry(scope, target, expandedItem, compactedItem, '@language');
  } else if (container.includes('@index') && indexKey === '@index') {
    entry = { key: expandedItem['@index'], value: compactedItem };
  } else if (container.includes('@index')) {
    entry = indexPropertyEntry(scope, indexKey, compactedItem);
  } else if (container.includes('@id')) {
    const idKey = aliasOf(scope, '@id');
    entry = { key: compactedItem[idKey], value: compactedItem };
    delete compactedItem[idKey];
  } else {
    entry = typeMapEntry(scope, target, expandedItem, compactedItem, '@type');
  }
  const key = entry.key === undefined || entry.key === null ? aliasOf(scope, '@none') : entry.key;
  addValue(mapObject, key, entry.value, asArr);
};

/** Step 12.8.9.8: an index map on a property (`@index` names a property). */
const indexPropertyEntry = (scope: Scope, indexKey: string, compactedItem: Json): MapEntry => {
  const { env, active } = scope;
  const containerKey =
    isObject(compactedItem) && hasOwn(compactedItem, indexKey)
      ? indexKey
      : aliasOf(scope, expandIri(env, active, indexKey, true) ?? indexKey);
  const values = isObject(compactedItem) ? asArray(compactedItem[containerKey] ?? []) : [];
  const key = Arr.isReadonlyArrayNonEmpty(values) && isString(values[0]) ? values[0] : undefined;
  if (key !== undefined) {
    const rest = values.slice(1);
    delete compactedItem[containerKey];
    if (Arr.isReadonlyArrayNonEmpty(rest)) addValue(compactedItem, containerKey, rest, false);
  }
  return { key, value: compactedItem };
};

/** Step 12.8.9.10: a type map (the map's keys are the values of `keyword`). */
const typeMapEntry = (
  scope: Scope,
  target: ItemTarget,
  expandedItem: JsonObject,
  compactedItem: Json,
  keyword: '@type' | '@language',
): MapEntry => {
  const { env, active, options } = scope;
  const containerKey = aliasOf(scope, keyword);
  const values = asArray(compactedItem[containerKey] ?? []);
  const rest = values.slice(1);
  delete compactedItem[containerKey];
  if (Arr.isReadonlyArrayNonEmpty(rest)) addValue(compactedItem, containerKey, rest, false);
  if (rest.length === 1 && Array.isArray(compactedItem[containerKey])) {
    compactedItem[containerKey] = compactedItem[containerKey][0];
  }
  const remaining = Record.keys(compactedItem);
  const [only] = remaining;
  const onlyId =
    remaining.length === 1 &&
    only !== undefined &&
    expandIri(env, active, only, true) === '@id' &&
    '@id' in expandedItem;
  return {
    key: values[0],
    value: onlyId
      ? compactElement(
          env,
          active,
          Option.some(target.property),
          { '@id': expandedItem['@id'] },
          options,
        )
      : compactedItem,
  };
};

const nestResultFor = (
  env: Env,
  active: ActiveContext,
  result: JsonObject,
  itemActiveProperty: string,
  options: CompactOptions,
): JsonObject => {
  const nestTerm = definitionOf(active, itemActiveProperty)?.nest;
  if (nestTerm === undefined) return result;
  if (nestTerm !== '@nest' && expandIri(env, active, nestTerm, true) !== '@nest') {
    fail('invalid @nest value');
  }
  void options;
  if (!isObject(result[nestTerm])) result[nestTerm] = {};
  return result[nestTerm];
};

/** @internal */
export const containerOf = (active: ActiveContext, term: string): Array<string> =>
  definitionOf(active, term)?.container ?? [];

/** The definition of the active property (none at the top level). */
const activeDefinition = (active: ActiveContext, activeProperty: ActiveProperty) =>
  Option.isNone(activeProperty) ? undefined : definitionOf(active, activeProperty.value);

/** The container mapping of the active property (none at the top level). */
const activeContainer = (active: ActiveContext, activeProperty: ActiveProperty): Array<string> =>
  activeDefinition(active, activeProperty)?.container ?? [];

/** Term definitions ordered by their term: shortest first, then lexicographically. */
const shortestTermFirst: Order.Order<readonly [string, TermDefinition]> = Order.mapInput(
  Order.combine(
    Order.mapInput(Order.Number, (term: string) => term.length),
    compareStrings,
  ),
  ([term]) => term,
);

const emptyEntry = (term: string): ContainerEntry => {
  // Prototype-less records: a language or type value is never mistaken for an
  // `Object.prototype` member.
  const language: globalThis.Record<string, string> = Object.create(null);
  const type: globalThis.Record<string, string> = Object.create(null);
  return { '@language': language, '@type': type, '@any': { '@none': term } };
};

/**
 * Inverse Context Creation algorithm.
 *
 * @internal
 */
export const inverseContext = (active: ActiveContext): InverseContext => {
  if (active.inverse !== undefined) return active.inverse;
  const result: InverseContext = MutableHashMap.empty();
  const defaultLanguage = active.language !== undefined ? active.language.toLowerCase() : '@none';
  Arr.sort(active.terms, shortestTermFirst).forEach(([term, def]) => {
    const iri = def.iri;
    if (iri === null) return;
    const container = Arr.isReadonlyArrayEmpty(def.container)
      ? '@none'
      : Arr.sort(def.container, Order.String).join('');
    const containerMap = Option.getOrElse(MutableHashMap.get(result, iri), () => {
      const created: globalThis.Record<string, ContainerEntry> = Object.create(null);
      MutableHashMap.set(result, iri, created);
      return created;
    });
    const entry = containerMap[container] ?? emptyEntry(term);
    containerMap[container] = entry;
    const typeMap = entry['@type'];
    const languageMap = entry['@language'];
    if (def.reverse) {
      typeMap['@reverse'] ??= term;
    } else if (def.type === '@none') {
      languageMap['@any'] ??= term;
      typeMap['@any'] ??= term;
    } else if (def.type !== undefined) {
      typeMap[def.type] ??= term;
    } else if ('language' in def && 'direction' in def) {
      let langDir: string;
      if (def.language != null && def.direction != null) {
        langDir = `${def.language}_${def.direction}`.toLowerCase();
      } else if (def.language != null) {
        langDir = def.language.toLowerCase();
      } else if (def.direction != null) {
        langDir = `_${def.direction}`;
      } else {
        langDir = '@null';
      }
      languageMap[langDir] ??= term;
    } else if ('language' in def) {
      const language = def.language == null ? '@null' : def.language.toLowerCase();
      languageMap[language] ??= term;
    } else if ('direction' in def) {
      const direction = def.direction == null ? '@none' : `_${def.direction}`;
      languageMap[direction] ??= term;
    } else if (active.direction !== undefined) {
      const langDir =
        active.language !== undefined
          ? `${active.language}_${active.direction}`.toLowerCase()
          : `_${active.direction}`;
      languageMap[langDir] ??= term;
      languageMap['@none'] ??= term;
      typeMap['@none'] ??= term;
    } else {
      languageMap[defaultLanguage] ??= term;
      languageMap['@none'] ??= term;
      typeMap['@none'] ??= term;
    }
  });
  active.inverse = result;
  return result;
};

const selectTerm = (
  containerMap: globalThis.Record<string, ContainerEntry>,
  containers: ReadonlyArray<string>,
  typeLanguage: '@type' | '@language' | '@any',
  preferredValues: ReadonlyArray<string>,
): Option.Option<string> =>
  Arr.findFirst(containers, (container) => {
    const entry = containerMap[container];
    if (entry === undefined) return Option.none();
    const valueMap = entry[typeLanguage];
    return Arr.findFirst(preferredValues, (item) => Option.fromUndefinedOr(valueMap[item]));
  });

/** The `_direction` suffix of a preferred language value (none without one). */
const directionSuffix = (pv: string): Array<string> => {
  const i = pv.indexOf('_');
  return i === -1 ? [] : [pv.slice(i)];
};

/** A compact IRI candidate is chosen when it is shorter (or as short and earlier) than the best. */
const isBetterCompactIri = (candidate: string, best: Option.Option<string>): boolean =>
  Option.isNone(best) ||
  candidate.length < best.value.length ||
  (candidate.length === best.value.length && candidate < best.value);

/**
 * IRI Compaction algorithm.
 *
 * @internal
 */
export const compactIri = (
  env: Env,
  active: ActiveContext,
  iri: string,
  value: Json = null,
  vocab = false,
  reverse = false,
  options?: CompactOptions,
): string => {
  // 1
  if (iri === null) return iri;
  // 2, 3
  const inverse = inverseContext(active);
  // 4
  const containerMap = vocab ? MutableHashMap.get(inverse, iri) : Option.none();
  if (Option.isSome(containerMap)) {
    const defaultLanguage =
      active.direction !== undefined
        ? `${active.language ?? ''}_${active.direction}`.toLowerCase()
        : active.language !== undefined
          ? active.language.toLowerCase()
          : '@none';
    if (isObject(value) && '@preserve' in value) value = asArray(value['@preserve'])[0];
    const containers: Array<string> = [];
    let typeLanguage: '@type' | '@language' | '@any' = '@language';
    let typeLanguageValue = '@null';
    if (isObject(value) && '@index' in value && !isGraphObject(value)) {
      containers.push('@index', '@index@set');
    }
    if (reverse) {
      typeLanguage = '@type';
      typeLanguageValue = '@reverse';
      containers.push('@set');
    } else if (isListObject(value)) {
      if (!('@index' in value)) containers.push('@list');
      const list: Array<Json> = value['@list'];
      // An empty list has the default language and no common type.
      let commonType = '@none';
      let commonLanguage = defaultLanguage;
      // Stops once neither a common language nor a common type remains.
      list.every((item, i) => {
        let itemLanguage = '@none';
        let itemType = '@none';
        if (isValueObject(item)) {
          if ('@direction' in item) {
            itemLanguage = `${item['@language'] ?? ''}_${item['@direction']}`.toLowerCase();
          } else if ('@language' in item) {
            itemLanguage = String(item['@language']).toLowerCase();
          } else if ('@type' in item) {
            itemType = item['@type'];
          } else {
            itemLanguage = '@null';
          }
        } else {
          itemType = '@id';
        }
        if (i === 0) {
          commonLanguage = itemLanguage;
          commonType = itemType;
        } else {
          if (itemLanguage !== commonLanguage && isValueObject(item)) commonLanguage = '@none';
          if (itemType !== commonType) commonType = '@none';
        }
        return !(commonLanguage === '@none' && commonType === '@none');
      });
      if (commonType !== '@none') {
        typeLanguage = '@type';
        typeLanguageValue = commonType;
      } else {
        typeLanguageValue = commonLanguage;
      }
    } else if (isGraphObject(value)) {
      if ('@index' in value) containers.push('@graph@index', '@graph@index@set');
      if ('@id' in value) containers.push('@graph@id', '@graph@id@set');
      containers.push('@graph', '@graph@set', '@set');
      if (!('@index' in value)) containers.push('@graph@index', '@graph@index@set');
      if (!('@id' in value)) containers.push('@graph@id', '@graph@id@set');
      containers.push('@index', '@index@set');
      typeLanguage = '@type';
      typeLanguageValue = '@id';
    } else {
      if (isValueObject(value)) {
        if ('@direction' in value && !('@index' in value)) {
          typeLanguageValue = `${value['@language'] ?? ''}_${value['@direction']}`.toLowerCase();
          containers.push('@language', '@language@set');
        } else if ('@language' in value && !('@index' in value)) {
          typeLanguageValue = String(value['@language']).toLowerCase();
          containers.push('@language', '@language@set');
        } else if ('@type' in value) {
          typeLanguageValue = value['@type'] ?? '@null';
          typeLanguage = '@type';
        }
      } else {
        typeLanguage = '@type';
        typeLanguageValue = '@id';
        containers.push('@id', '@id@set', '@type', '@set@type');
      }
      containers.push('@set');
    }
    containers.push('@none');
    if (env.processingMode !== 'json-ld-1.0' && (!isObject(value) || !('@index' in value))) {
      containers.push('@index', '@index@set');
    }
    if (
      env.processingMode !== 'json-ld-1.0' &&
      isObject(value) &&
      Record.keys(value).length === 1 &&
      '@value' in value
    ) {
      containers.push('@language', '@language@set');
    }
    const preferredValues: Array<string> = [];
    if (typeLanguageValue === '@reverse') preferredValues.push('@reverse');
    if (
      (typeLanguageValue === '@id' || typeLanguageValue === '@reverse') &&
      isObject(value) &&
      '@id' in value
    ) {
      const compactedId = compactIri(env, active, value['@id'], null, true, false, options);
      if (definitionOf(active, compactedId)?.iri === value['@id']) {
        preferredValues.push('@vocab', '@id', '@none');
      } else {
        preferredValues.push('@id', '@vocab', '@none');
      }
    } else {
      preferredValues.push(typeLanguageValue, '@none');
      if (isListObject(value) && Arr.isReadonlyArrayEmpty(value['@list'])) typeLanguage = '@any';
    }
    preferredValues.push('@any');
    pushAll(preferredValues, preferredValues.flatMap(directionSuffix));
    const term = selectTerm(containerMap.value, containers, typeLanguage, preferredValues);
    if (Option.isSome(term)) return term.value;
  }
  // 5
  if (vocab && active.vocab !== undefined) {
    if (iri.startsWith(active.vocab) && iri.length > active.vocab.length) {
      const suffix = iri.slice(active.vocab.length);
      if (!MutableHashMap.has(active.terms, suffix)) return suffix;
    }
  }
  // 6, 7
  let compactIriResult = Option.none<string>();
  MutableHashMap.forEach(active.terms, (def, term) => {
    const prefixIri = def.iri;
    if (prefixIri === null || prefixIri === iri || !iri.startsWith(prefixIri) || !def.prefix) {
      return;
    }
    const candidate = `${term}:${iri.slice(prefixIri.length)}`;
    const candidateDef = definitionOf(active, candidate);
    if (
      isBetterCompactIri(candidate, compactIriResult) &&
      (candidateDef === undefined || (candidateDef.iri === iri && value === null))
    ) {
      compactIriResult = Option.some(candidate);
    }
  });
  // 8
  if (Option.isSome(compactIriResult)) return compactIriResult.value;
  // 9
  const colon = iri.indexOf(':');
  if (colon > 0) {
    const scheme = iri.slice(0, colon);
    const def = definitionOf(active, scheme);
    if (def !== undefined && def.prefix && !iri.slice(colon + 1).startsWith('//')) {
      fail('IRI confused with prefix', iri);
    }
  }
  // 10
  if (!vocab && (options?.compactToRelative ?? true)) {
    return removeBase(active.base, iri);
  }
  // 11
  return iri;
};

/**
 * Value Compaction algorithm.
 *
 * @internal
 */
export const compactValue = (
  env: Env,
  active: ActiveContext,
  activeProperty: ActiveProperty,
  value: JsonObject,
  options: CompactOptions,
): Json => {
  const def = activeDefinition(active, activeProperty);
  const container = def?.container ?? [];
  const typeMapping = def?.type;
  const language = def !== undefined && 'language' in def ? def.language : active.language;
  const direction = def !== undefined && 'direction' in def ? def.direction : active.direction;
  const keys = Record.keys(value);
  // 6
  if ('@id' in value) {
    if (keys.every((k) => k === '@id' || k === '@index')) {
      const indexOk = !('@index' in value) || container.includes('@index');
      if (indexOk && typeMapping === '@id') {
        return compactIri(env, active, value['@id'], null, false, false, options);
      }
      if (indexOk && typeMapping === '@vocab') {
        return compactIri(env, active, value['@id'], null, true, false, options);
      }
    }
    return value;
  }
  const preserveIndex = '@index' in value && !container.includes('@index');
  if (!preserveIndex) {
    if ('@type' in value && value['@type'] === typeMapping) return value['@value'];
    if (typeMapping === '@none' || '@type' in value) {
      // value compaction disabled
    } else if (!isString(value['@value'])) {
      if (!('@language' in value) && !('@direction' in value)) return value['@value'];
    } else {
      const langMatch =
        '@language' in value
          ? language != null && String(value['@language']).toLowerCase() === language.toLowerCase()
          : language == null;
      const dirMatch =
        '@direction' in value ? value['@direction'] === direction : direction == null;
      if (langMatch && dirMatch) return value['@value'];
    }
  }
  const result: JsonObject = {};
  keys.forEach((key) => {
    if (key === '@index' && !preserveIndex) return;
    const alias = compactIri(env, active, key, null, true, false, options);
    result[alias] =
      key === '@type'
        ? compactIri(env, active, value[key], null, true, false, options)
        : value[key];
  });
  return result;
};
