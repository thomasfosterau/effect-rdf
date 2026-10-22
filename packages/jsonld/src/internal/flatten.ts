/**
 * Node Map Generation and Flattening (JSON-LD 1.1 API §7).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
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
export type NodeMap = Record<string, Record<string, JsonObject>>;

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
  activeSubject: string | JsonObject | null = null,
  activeProperty: string | null = null,
  list: JsonObject | null = null,
): void => {
  // 1
  if (Array.isArray(element)) {
    for (const item of element) {
      generateNodeMap(item, nodeMap, issuer, activeGraph, activeSubject, activeProperty, list);
    }
    return;
  }
  // 2
  const graph = getOrInit(nodeMap, activeGraph, () => ({}));
  const subjectNode =
    activeSubject === null || isObject(activeSubject) ? null : graph[activeSubject];
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
    if (list === null) {
      const values: Array<Json> = getOrInit(subjectNode!, activeProperty!, () => []);
      addUnique(values, element);
    } else {
      list['@list'].push(element);
    }
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
      result,
    );
    if (list === null) {
      getOrInit(subjectNode!, activeProperty!, () => []).push(result);
    } else {
      list['@list'].push(result);
    }
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
  if (!hasOwn(graph, id)) graph[id] = { '@id': id };
  const node = graph[id]!;
  // 6.5
  if (isObject(activeSubject)) {
    const values: Array<Json> = getOrInit(node, activeProperty!, () => []);
    addUnique(values, activeSubject);
  } else if (activeProperty !== null) {
    // 6.6
    const reference = { '@id': id };
    if (list === null) {
      const values: Array<Json> = getOrInit(subjectNode!, activeProperty!, () => []);
      addUnique(values, reference);
    } else {
      list['@list'].push(reference);
    }
  }
  // 6.7
  if ('@type' in element) {
    const types: Array<Json> = getOrInit(node, '@type', () => []);
    for (const t of asArray(element['@type'])) if (!types.includes(t)) types.push(t);
  }
  // 6.8
  if ('@index' in element) {
    if ('@index' in node && node['@index'] !== element['@index']) fail('conflicting indexes');
    node['@index'] = element['@index'];
  }
  // 6.9
  if ('@reverse' in element) {
    const referenced = { '@id': id };
    const reverseMap: JsonObject = element['@reverse'];
    for (const property of Object.keys(reverseMap)) {
      for (const value of asArray(reverseMap[property])) {
        generateNodeMap(value, nodeMap, issuer, activeGraph, referenced, property);
      }
    }
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
  for (const key of Arr.sort(Object.keys(element), compareStrings)) {
    if (
      key === '@id' ||
      key === '@type' ||
      key === '@index' ||
      key === '@reverse' ||
      key === '@graph' ||
      key === '@included'
    ) {
      continue;
    }
    let property = key;
    if (isBlankNodeId(property)) property = issuer.issue(property);
    if (!hasOwn(node, property)) node[property] = [];
    generateNodeMap(element[key], nodeMap, issuer, activeGraph, id, property);
  }
};

/**
 * Flattening algorithm (without the final compaction).
 *
 * @internal
 */
export const flattenExpanded = (expanded: Json, ordered: boolean): Array<JsonObject> => {
  const nodeMap: NodeMap = {};
  nodeMap['@default'] = {};
  generateNodeMap(expanded, nodeMap, new IdIssuer());
  const defaultGraph = nodeMap['@default']!;
  const named = Object.keys(nodeMap).filter((g) => g !== '@default');
  const graphNames = ordered ? Arr.sort(named, compareStrings) : named;
  for (const graphName of graphNames) {
    const graph = nodeMap[graphName]!;
    const entry = getOrInit(defaultGraph, graphName, () => ({ '@id': graphName }));
    const nodes: Array<JsonObject> = (entry['@graph'] = []);
    const ids = ordered ? Arr.sort(Object.keys(graph), compareStrings) : Object.keys(graph);
    for (const id of ids) {
      const node = graph[id]!;
      if (!isOnlyId(node)) nodes.push(node);
    }
  }
  const flattened: Array<JsonObject> = [];
  const ids = ordered
    ? Arr.sort(Object.keys(defaultGraph), compareStrings)
    : Object.keys(defaultGraph);
  for (const id of ids) {
    const node = defaultGraph[id]!;
    if (!isOnlyId(node)) flattened.push(node);
  }
  return flattened;
};

const isOnlyId = (node: JsonObject): boolean => {
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === '@id';
};

/** @internal */
export const mergeNodeMaps = (graphs: NodeMap) => {
  const merged: Record<string, JsonObject> = {};
  for (const graphName of Arr.sort(Object.keys(graphs), compareStrings)) {
    const graph = graphs[graphName]!;
    for (const id of Arr.sort(Object.keys(graph), compareStrings)) {
      const node = graph[id]!;
      const mergedNode = getOrInit(merged, id, () => ({ '@id': id }));
      for (const property of Arr.sort(Object.keys(node), compareStrings)) {
        if (property === '@id') continue;
        if (property === '@type' || property.startsWith('@')) {
          if (property === '@type') {
            const types: Array<Json> = getOrInit(mergedNode, '@type', () => []);
            for (const t of node['@type']) if (!types.includes(t)) types.push(t);
          } else {
            mergedNode[property] = structuredClone(node[property]);
          }
          continue;
        }
        const values: Array<Json> = getOrInit(mergedNode, property, () => []);
        for (const v of node[property]) {
          if (!values.some((x) => deepEqual(x, v))) values.push(structuredClone(v));
        }
      }
    }
  }
  return merged;
};
