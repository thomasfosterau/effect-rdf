/**
 * Node Map Generation and Flattening (JSON-LD 1.1 API §7).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import {
  type Json,
  type JsonObject,
  IdIssuer,
  addUnique,
  asArray,
  compareStrings,
  deepEqual,
  fail,
  isBlankNodeId,
  isListObject,
  isObject,
  isValueObject,
  getOrInit,
  hasOwn,
} from './util.ts';

/** @internal */
export type NodeMap = globalThis.Record<string, globalThis.Record<string, JsonObject>>;

/**
 * Adds `item` to the active list or, outside a list, to the active property
 * of the active subject (once, when `unique`).
 */
const addToTarget = (
  graph: globalThis.Record<string, JsonObject>,
  activeSubject: Option.Option<string | JsonObject>,
  activeProperty: Option.Option<string>,
  list: Option.Option<JsonObject>,
  item: Json,
  unique: boolean,
): void => {
  if (Option.isSome(list)) {
    list.value['@list'].push(item);
    return;
  }
  if (Option.isNone(activeSubject) || Option.isNone(activeProperty)) return;
  const subject = activeSubject.value;
  if (isObject(subject)) return;
  const values: Array<Json> = getOrInit(graph[subject] ?? {}, activeProperty.value, () => []);
  if (unique) addUnique(values, item);
  else values.push(item);
};

/**
 * Node Map Generation algorithm.
 *
 * @internal
 */
export const generateNodeMap = (
  element: Json,
  nodeMap: NodeMap,
  issuer: IdIssuer,
  activeGraph = '@default',
  activeSubject: Option.Option<string | JsonObject> = Option.none(),
  activeProperty: Option.Option<string> = Option.none(),
  list: Option.Option<JsonObject> = Option.none(),
): void => {
  // 1
  if (Array.isArray(element)) {
    element.forEach((item) =>
      generateNodeMap(item, nodeMap, issuer, activeGraph, activeSubject, activeProperty, list),
    );
    return;
  }
  // 2
  const graph: globalThis.Record<string, JsonObject> = getOrInit(nodeMap, activeGraph, () => ({}));
  // 3
  if ('@type' in element) {
    const type = element['@type'];
    element['@type'] = Array.isArray(type)
      ? type.map((t: string) => (isBlankNodeId(t) ? issuer.issue(t) : t))
      : isBlankNodeId(type)
        ? issuer.issue(type)
        : type;
  }
  // 4
  if (isValueObject(element)) {
    addToTarget(graph, activeSubject, activeProperty, list, element, true);
    return;
  }
  // 5
  if (isListObject(element)) {
    const result: JsonObject = { '@list': [] };
    generateNodeMap(
      element['@list'],
      nodeMap,
      issuer,
      activeGraph,
      activeSubject,
      activeProperty,
      Option.some(result),
    );
    addToTarget(graph, activeSubject, activeProperty, list, result, false);
    return;
  }
  // 6
  let id: string;
  if ('@id' in element) {
    id = element['@id'];
    // A node whose @id expanded to null (e.g. an ignored keyword-like IRI)
    // cannot be identified and is dropped.
    if (id === null) return;
    if (isBlankNodeId(id)) id = issuer.issue(id);
  } else {
    id = issuer.issue();
  }
  const node: JsonObject = getOrInit(graph, id, () => ({ '@id': id }));
  // 6.5
  if (Option.isSome(activeSubject) && isObject(activeSubject.value)) {
    if (Option.isSome(activeProperty)) {
      const values: Array<Json> = getOrInit(node, activeProperty.value, () => []);
      addUnique(values, activeSubject.value);
    }
  } else if (Option.isSome(activeProperty)) {
    // 6.6
    addToTarget(graph, activeSubject, activeProperty, list, { '@id': id }, true);
  }
  // 6.7
  if ('@type' in element) {
    const types: Array<Json> = getOrInit(node, '@type', () => []);
    asArray(element['@type']).forEach((t) => {
      if (!types.includes(t)) types.push(t);
    });
  }
  // 6.8
  if ('@index' in element) {
    if ('@index' in node && node['@index'] !== element['@index']) fail('conflicting indexes');
    node['@index'] = element['@index'];
  }
  // 6.9
  if ('@reverse' in element) {
    const referenced = Option.some({ '@id': id });
    const reverseMap: JsonObject = element['@reverse'];
    Record.keys(reverseMap).forEach((property) => {
      const reverseProperty = Option.some(property);
      asArray(reverseMap[property]).forEach((value) =>
        generateNodeMap(value, nodeMap, issuer, activeGraph, referenced, reverseProperty),
      );
    });
  }
  // 6.10
  if ('@graph' in element) {
    generateNodeMap(element['@graph'], nodeMap, issuer, id);
  }
  // 6.11
  if ('@included' in element) {
    generateNodeMap(element['@included'], nodeMap, issuer, activeGraph);
  }
  // 6.12
  const subject = Option.some(id);
  Arr.sort(Record.keys(element), compareStrings).forEach((key) => {
    if (
      key === '@id' ||
      key === '@type' ||
      key === '@index' ||
      key === '@reverse' ||
      key === '@graph' ||
      key === '@included'
    ) {
      return;
    }
    const property = isBlankNodeId(key) ? issuer.issue(key) : key;
    if (!hasOwn(node, property)) node[property] = [];
    generateNodeMap(element[key], nodeMap, issuer, activeGraph, subject, Option.some(property));
  });
};

/** The nodes of a graph that say more than their `@id`, in key order (sorted when `ordered`). */
const nodesOf = (
  graph: globalThis.Record<string, JsonObject>,
  ordered: boolean,
): Array<JsonObject> => {
  const ids = ordered ? Arr.sort(Record.keys(graph), compareStrings) : Record.keys(graph);
  const nodes: Array<JsonObject> = [];
  ids.forEach((id) => {
    const node = graph[id];
    if (node !== undefined && !isOnlyId(node)) nodes.push(node);
  });
  return nodes;
};

/**
 * Flattening algorithm (without the final compaction).
 *
 * @internal
 */
export const flattenExpanded = (expanded: Json, ordered: boolean): Array<JsonObject> => {
  const defaultGraph: globalThis.Record<string, JsonObject> = {};
  const nodeMap: NodeMap = { '@default': defaultGraph };
  generateNodeMap(expanded, nodeMap, new IdIssuer());
  const named = Record.keys(nodeMap).filter((g) => g !== '@default');
  const graphNames = ordered ? Arr.sort(named, compareStrings) : named;
  graphNames.forEach((graphName) => {
    const entry = getOrInit(defaultGraph, graphName, () => ({ '@id': graphName }));
    entry['@graph'] = nodesOf(nodeMap[graphName] ?? {}, ordered);
  });
  return nodesOf(defaultGraph, ordered);
};

const isOnlyId = (node: JsonObject): boolean => {
  const keys = Record.keys(node);
  return keys.length === 1 && keys[0] === '@id';
};

/** @internal */
export const mergeNodeMaps = (graphs: NodeMap) => {
  const merged: globalThis.Record<string, JsonObject> = {};
  Arr.sort(Record.keys(graphs), compareStrings).forEach((graphName) => {
    const graph = graphs[graphName] ?? {};
    Arr.sort(Record.keys(graph), compareStrings).forEach((id) => {
      const node = graph[id] ?? {};
      const mergedNode = getOrInit(merged, id, () => ({ '@id': id }));
      Arr.sort(Record.keys(node), compareStrings).forEach((property) => {
        if (property === '@id') return;
        if (property === '@type') {
          const types: Array<Json> = getOrInit(mergedNode, '@type', () => []);
          asArray(node['@type']).forEach((t) => {
            if (!types.includes(t)) types.push(t);
          });
          return;
        }
        if (property.startsWith('@')) {
          mergedNode[property] = structuredClone(node[property]);
          return;
        }
        const values: Array<Json> = getOrInit(mergedNode, property, () => []);
        asArray(node[property]).forEach((v) => {
          if (!values.some((x) => deepEqual(x, v))) values.push(structuredClone(v));
        });
      });
    });
  });
  return merged;
};
