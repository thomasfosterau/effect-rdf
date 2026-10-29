/**
 * Compaction Algorithms (JSON-LD 1.1 API §6).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import {
  type ActiveContext,
  applyTypeScopedContexts,
  type ContainerEntry,
  type Env,
  type InverseContext,
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
} from './util.ts';

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
  activeProperty: string | null,
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
    for (const item of element) {
      const compacted = compactElement(env, active, activeProperty, item, options);
      if (compacted !== null) result.push(compacted);
    }
    const container = activeProperty === null ? [] : containerOf(active, activeProperty);
    if (
      result.length !== 1 ||
      !options.compactArrays ||
      activeProperty === '@graph' ||
      activeProperty === '@set' ||
      container.includes('@list') ||
      container.includes('@set')
    ) {
      return result;
    }
    return result[0];
  }
  // The property-scoped context is looked up before reverting a
  // non-propagated (type-scoped) context.
  const propDef = activeProperty === null ? undefined : active.terms.get(activeProperty);
  // 5
  if (active.previous !== undefined) {
    const keys = Object.keys(element);
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
  if (isListObject(element) && containerOf(active, activeProperty).includes('@list')) {
    return compactElement(env, active, activeProperty, element['@list'], options);
  }
  // 9
  const insideReverse = activeProperty === '@reverse';
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
  const keys = options.ordered
    ? Arr.sort(Object.keys(element), compareStrings)
    : Object.keys(element);
  for (const expandedProperty of keys) {
    const expandedValue = element[expandedProperty];
    // 12.1
    if (expandedProperty === '@id') {
      const compactedValue = isString(expandedValue)
        ? compactIri(env, active, expandedValue, null, false, false, options)
        : expandedValue;
      const alias = compactIri(env, active, '@id', null, true, false, options);
      result[alias] = compactedValue;
      continue;
    }
    // 12.2
    if (expandedProperty === '@type') {
      let compactedValue: Json;
      if (isString(expandedValue)) {
        compactedValue = compactIri(env, typeScoped, expandedValue, null, true, false, options);
      } else {
        compactedValue = (expandedValue as Array<string>).map((t) =>
          compactIri(env, typeScoped, t, null, true, false, options),
        );
      }
      const alias = compactIri(env, active, '@type', null, true, false, options);
      const asArr =
        (env.processingMode !== 'json-ld-1.0' && containerOf(active, alias).includes('@set')) ||
        !options.compactArrays;
      addValue(result, alias, compactedValue, asArr);
      if (!asArr && Array.isArray(result[alias]) && result[alias].length === 1) {
        result[alias] = result[alias][0];
      }
      continue;
    }
    // 12.3
    if (expandedProperty === '@reverse') {
      const compactedValue = compactElement(env, active, '@reverse', expandedValue, options);
      for (const property of Object.keys(compactedValue)) {
        const def = active.terms.get(property);
        if (def?.reverse === true) {
          const asArr = def.container.includes('@set') || !options.compactArrays;
          addValue(result, property, compactedValue[property], asArr);
          delete compactedValue[property];
        }
      }
      if (Arr.isReadonlyArrayNonEmpty(Object.keys(compactedValue))) {
        const alias = compactIri(env, active, '@reverse', null, true, false, options);
        result[alias] = compactedValue;
      }
      continue;
    }
    // 12.4
    if (expandedProperty === '@preserve') {
      const compactedValue = compactElement(env, active, activeProperty, expandedValue, options);
      if (!(Array.isArray(expandedValue) && Arr.isReadonlyArrayEmpty(expandedValue))) {
        result['@preserve'] = compactedValue;
      }
      continue;
    }
    // 12.5
    if (expandedProperty === '@index' && containerOf(active, activeProperty).includes('@index')) {
      continue;
    }
    // 12.6
    if (
      expandedProperty === '@direction' ||
      expandedProperty === '@index' ||
      expandedProperty === '@language' ||
      expandedProperty === '@value'
    ) {
      const alias = compactIri(env, active, expandedProperty, null, true, false, options);
      result[alias] = expandedValue;
      continue;
    }
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
    for (const expandedItem of asArray(expandedValue)) {
      const itemActiveProperty = compactIri(
        env,
        active,
        expandedProperty,
        expandedItem,
        true,
        insideReverse,
        options,
      );
      const nestResult = nestResultFor(env, active, result, itemActiveProperty, options);
      const container = containerOf(active, itemActiveProperty);
      const asArr =
        container.includes('@set') ||
        itemActiveProperty === '@graph' ||
        itemActiveProperty === '@list' ||
        !options.compactArrays;
      const inner = isListObject(expandedItem)
        ? expandedItem['@list']
        : isGraphObject(expandedItem)
          ? expandedItem['@graph']
          : expandedItem;
      let compactedItem = compactElement(env, active, itemActiveProperty, inner, options);
      // 12.8.7
      if (isListObject(expandedItem)) {
        compactedItem = asArray(compactedItem);
        if (!container.includes('@list')) {
          const listAlias = compactIri(env, active, '@list', null, true, false, options);
          compactedItem = { [listAlias]: compactedItem };
          if ('@index' in expandedItem) {
            const indexAlias = compactIri(env, active, '@index', null, true, false, options);
            compactedItem[indexAlias] = expandedItem['@index'];
          }
          addValue(nestResult, itemActiveProperty, compactedItem, asArr);
        } else {
          nestResult[itemActiveProperty] = compactedItem;
        }
        continue;
      }
      // 12.8.8
      if (isGraphObject(expandedItem)) {
        if (container.includes('@graph') && container.includes('@id')) {
          const mapObject: JsonObject = getOrInit(nestResult, itemActiveProperty, () => ({}));
          const mapKey =
            '@id' in expandedItem
              ? compactIri(env, active, expandedItem['@id'], null, false, false, options)
              : compactIri(env, active, '@none', null, true, false, options);
          addValue(mapObject, mapKey, compactedItem, asArr);
        } else if (
          container.includes('@graph') &&
          container.includes('@index') &&
          isSimpleGraphObject(expandedItem)
        ) {
          const mapObject: JsonObject = getOrInit(nestResult, itemActiveProperty, () => ({}));
          const mapKey =
            '@index' in expandedItem
              ? expandedItem['@index']
              : compactIri(env, active, '@none', null, true, false, options);
          addValue(mapObject, mapKey, compactedItem, asArr);
        } else if (container.includes('@graph') && isSimpleGraphObject(expandedItem)) {
          if (Array.isArray(compactedItem) && compactedItem.length > 1) {
            compactedItem = {
              [compactIri(env, active, '@included', null, true, false, options)]: compactedItem,
            };
          }
          addValue(nestResult, itemActiveProperty, compactedItem, asArr);
        } else {
          compactedItem = {
            [compactIri(env, active, '@graph', null, true, false, options)]: compactedItem,
          };
          if ('@id' in expandedItem) {
            compactedItem[compactIri(env, active, '@id', null, true, false, options)] = compactIri(
              env,
              active,
              expandedItem['@id'],
              null,
              false,
              false,
              options,
            );
          }
          if ('@index' in expandedItem) {
            compactedItem[compactIri(env, active, '@index', null, true, false, options)] =
              expandedItem['@index'];
          }
          addValue(nestResult, itemActiveProperty, compactedItem, asArr);
        }
        continue;
      }
      // 12.8.9
      if (
        (container.includes('@language') ||
          container.includes('@index') ||
          container.includes('@id') ||
          container.includes('@type')) &&
        !container.includes('@graph')
      ) {
        const mapObject: JsonObject = getOrInit(nestResult, itemActiveProperty, () => ({}));
        const which = container.includes('@language')
          ? '@language'
          : container.includes('@index')
            ? '@index'
            : container.includes('@id')
              ? '@id'
              : '@type';
        let containerKey = compactIri(env, active, which, null, true, false, options);
        const indexKey = active.terms.get(itemActiveProperty)?.index ?? '@index';
        let mapKey: Json = undefined;
        if (container.includes('@language') && '@value' in expandedItem) {
          compactedItem = expandedItem['@value'];
          mapKey = expandedItem['@language'];
        } else if (container.includes('@index') && indexKey === '@index') {
          mapKey = expandedItem['@index'];
        } else if (container.includes('@index')) {
          containerKey =
            isObject(compactedItem) && hasOwn(compactedItem, indexKey)
              ? indexKey
              : compactIri(
                  env,
                  active,
                  expandIri(env, active, indexKey, true) ?? indexKey,
                  null,
                  true,
                  false,
                  options,
                );
          const values = isObject(compactedItem) ? asArray(compactedItem[containerKey] ?? []) : [];
          mapKey =
            Arr.isReadonlyArrayNonEmpty(values) && isString(values[0]) ? values[0] : undefined;
          if (mapKey !== undefined) {
            const rest = values.slice(1);
            delete compactedItem[containerKey];
            if (Arr.isReadonlyArrayNonEmpty(rest))
              addValue(compactedItem, containerKey, rest, false);
          }
        } else if (container.includes('@id')) {
          mapKey = compactedItem[containerKey];
          delete compactedItem[containerKey];
        } else {
          const values = asArray(compactedItem[containerKey] ?? []);
          mapKey = values[0];
          const rest = values.slice(1);
          delete compactedItem[containerKey];
          if (Arr.isReadonlyArrayNonEmpty(rest)) addValue(compactedItem, containerKey, rest, false);
          if (rest.length === 1 && Array.isArray(compactedItem[containerKey])) {
            compactedItem[containerKey] = compactedItem[containerKey][0];
          }
          const remaining = Object.keys(compactedItem);
          if (
            remaining.length === 1 &&
            expandIri(env, active, remaining[0]!, true) === '@id' &&
            '@id' in expandedItem
          ) {
            compactedItem = compactElement(
              env,
              active,
              itemActiveProperty,
              { '@id': expandedItem['@id'] },
              options,
            );
          }
        }
        if (mapKey === undefined || mapKey === null) {
          mapKey = compactIri(env, active, '@none', null, true, false, options);
        }
        addValue(mapObject, mapKey, compactedItem, asArr);
        continue;
      }
      // 12.8.10
      addValue(nestResult, itemActiveProperty, compactedItem, asArr);
    }
  }
  return result;
};

const nestResultFor = (
  env: Env,
  active: ActiveContext,
  result: JsonObject,
  itemActiveProperty: string,
  options: CompactOptions,
): JsonObject => {
  const nestTerm = active.terms.get(itemActiveProperty)?.nest;
  if (nestTerm === undefined) return result;
  if (nestTerm !== '@nest' && expandIri(env, active, nestTerm, true) !== '@nest') {
    fail('invalid @nest value');
  }
  void options;
  if (!isObject(result[nestTerm])) result[nestTerm] = {};
  return result[nestTerm];
};

/** @internal */
export const containerOf = (active: ActiveContext, term: string | null): Array<string> =>
  term === null ? [] : (active.terms.get(term)?.container ?? []);

/** Terms ordered shortest first, then lexicographically. */
const shortestTermFirst: Order.Order<string> = Order.combine(
  Order.mapInput(Order.Number, (term: string) => term.length),
  compareStrings,
);

/**
 * Inverse Context Creation algorithm.
 *
 * @internal
 */
export const inverseContext = (active: ActiveContext): InverseContext => {
  if (active.inverse !== undefined) return active.inverse;
  const result: InverseContext = new Map();
  const defaultLanguage = active.language !== undefined ? active.language.toLowerCase() : '@none';
  const terms = Arr.sort(active.terms.keys(), shortestTermFirst);
  for (const term of terms) {
    const def = active.terms.get(term)!;
    if (def.iri === null) continue;
    const container = Arr.isReadonlyArrayEmpty(def.container)
      ? '@none'
      : Arr.sort(def.container, Order.String).join('');
    let containerMap = result.get(def.iri);
    if (containerMap === undefined) {
      containerMap = Object.create(null) as Record<string, ContainerEntry>;
      result.set(def.iri, containerMap);
    }
    let entry: ContainerEntry | undefined = containerMap[container];
    if (entry === undefined) {
      entry = {
        '@language': Object.create(null),
        '@type': Object.create(null),
        '@any': { '@none': term },
      };
      containerMap[container] = entry;
    }
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
  }
  active.inverse = result;
  return result;
};

const selectTerm = (
  active: ActiveContext,
  iri: string,
  containers: ReadonlyArray<string>,
  typeLanguage: '@type' | '@language' | '@any',
  preferredValues: ReadonlyArray<string>,
): string | null => {
  const inverse = inverseContext(active);
  const containerMap = inverse.get(iri)!;
  for (const container of containers) {
    const entry = containerMap[container];
    if (entry === undefined) continue;
    const valueMap = entry[typeLanguage];
    for (const item of preferredValues) {
      const term = valueMap[item];
      if (term !== undefined) return term;
    }
  }
  return null;
};

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
  if (vocab && inverse.has(iri)) {
    const defaultLanguage =
      active.direction !== undefined
        ? `${active.language ?? ''}_${active.direction}`.toLowerCase()
        : active.language !== undefined
          ? active.language.toLowerCase()
          : '@none';
    if (isObject(value) && '@preserve' in value) value = asArray(value['@preserve'])[0];
    const containers: Array<string> = [];
    let typeLanguage: '@type' | '@language' | '@any' = '@language';
    let typeLanguageValue: string | null = '@null';
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
      let commonType: string | null = null;
      let commonLanguage: string | null = null;
      if (Arr.isReadonlyArrayEmpty(list)) commonLanguage = defaultLanguage;
      for (const item of list) {
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
        if (commonLanguage === null) commonLanguage = itemLanguage;
        else if (itemLanguage !== commonLanguage && isValueObject(item)) commonLanguage = '@none';
        if (commonType === null) commonType = itemType;
        else if (itemType !== commonType) commonType = '@none';
        if (commonLanguage === '@none' && commonType === '@none') break;
      }
      if (commonLanguage === null) commonLanguage = '@none';
      if (commonType === null) commonType = '@none';
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
          typeLanguageValue = value['@type'];
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
      Object.keys(value).length === 1 &&
      '@value' in value
    ) {
      containers.push('@language', '@language@set');
    }
    if (typeLanguageValue === null) typeLanguageValue = '@null';
    const preferredValues: Array<string> = [];
    if (typeLanguageValue === '@reverse') preferredValues.push('@reverse');
    if (
      (typeLanguageValue === '@id' || typeLanguageValue === '@reverse') &&
      isObject(value) &&
      '@id' in value
    ) {
      const compactedId = compactIri(env, active, value['@id'], null, true, false, options);
      const def = active.terms.get(compactedId);
      if (def !== undefined && def.iri === value['@id']) {
        preferredValues.push('@vocab', '@id', '@none');
      } else {
        preferredValues.push('@id', '@vocab', '@none');
      }
    } else {
      preferredValues.push(typeLanguageValue, '@none');
      if (isListObject(value) && Arr.isReadonlyArrayEmpty(value['@list'])) typeLanguage = '@any';
    }
    preferredValues.push('@any');
    // Iterates a copy: the loop appends to `preferredValues`.
    for (const pv of Arr.copy(preferredValues)) {
      const i = pv.indexOf('_');
      if (i !== -1) preferredValues.push(pv.slice(i));
    }
    const term = selectTerm(active, iri, containers, typeLanguage, preferredValues);
    if (term !== null) return term;
  }
  // 5
  if (vocab && active.vocab !== undefined) {
    if (iri.startsWith(active.vocab) && iri.length > active.vocab.length) {
      const suffix = iri.slice(active.vocab.length);
      if (!active.terms.has(suffix)) return suffix;
    }
  }
  // 6, 7
  let compactIriResult: string | null = null;
  for (const [term, def] of active.terms) {
    if (def.iri === null || def.iri === iri || !iri.startsWith(def.iri) || !def.prefix) {
      continue;
    }
    const candidate = `${term}:${iri.slice(def.iri.length)}`;
    const candidateDef = active.terms.get(candidate);
    if (
      (compactIriResult === null ||
        candidate.length < compactIriResult.length ||
        (candidate.length === compactIriResult.length && candidate < compactIriResult)) &&
      (candidateDef === undefined || (candidateDef.iri === iri && value === null))
    ) {
      compactIriResult = candidate;
    }
  }
  // 8
  if (compactIriResult !== null) return compactIriResult;
  // 9
  const colon = iri.indexOf(':');
  if (colon > 0) {
    const scheme = iri.slice(0, colon);
    const def = active.terms.get(scheme);
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
  activeProperty: string | null,
  value: JsonObject,
  options: CompactOptions,
): Json => {
  const def = activeProperty === null ? undefined : active.terms.get(activeProperty);
  const container = def?.container ?? [];
  const typeMapping = def?.type;
  const language = def !== undefined && 'language' in def ? def.language : active.language;
  const direction = def !== undefined && 'direction' in def ? def.direction : active.direction;
  const keys = Object.keys(value);
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
  for (const key of keys) {
    if (key === '@index' && !preserveIndex) continue;
    const alias = compactIri(env, active, key, null, true, false, options);
    result[alias] =
      key === '@type'
        ? compactIri(env, active, value[key], null, true, false, options)
        : value[key];
  }
  return result;
};
