/**
 * RDF conversion: Deserialize JSON-LD to RDF and Serialize RDF as JSON-LD
 * (JSON-LD 1.1 API §8).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Result from 'effect/Result';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import { type NodeMap, generateNodeMap } from './flatten.ts';
import {
  I18N,
  IdIssuer,
  type Json,
  type JsonObject,
  RDF_DIRECTION,
  RDF_FIRST,
  RDF_JSON,
  RDF_LANGUAGE,
  RDF_LANG_STRING,
  RDF_LIST,
  RDF_NIL,
  RDF_REST,
  RDF_TYPE,
  RDF_VALUE,
  XSD_BOOLEAN,
  XSD_DOUBLE,
  XSD_INTEGER,
  XSD_STRING,
  canonicalJson,
  compareStrings,
  deepEqual,
  fail,
  isBlankNodeId,
  isListObject,
  isObject,
  isValueObject,
  isWellFormedIri,
  isWellFormedLanguage,
  getOrInit,
  hasOwn,
} from './util.ts';
import { parseJson } from './json.ts';
import * as Predicate from 'effect/Predicate';

/** @internal */
export type RdfDirection = 'i18n-datatype' | 'compound-literal';

/** @internal */
export interface ToRdfOptions {
  readonly produceGeneralizedRdf: boolean;
  readonly rdfDirection: RdfDirection | null;
}

const blankNode = (id: string): Term.BlankNode => Term.blankNode(id.slice(2));

const toResource = (id: string): Term.NamedNode | Term.BlankNode | null => {
  if (isBlankNodeId(id)) return blankNode(id);
  if (isWellFormedIri(id)) return Term.namedNode(id);
  return null;
};

/**
 * Converts expanded JSON-LD to quads.
 *
 * @internal
 */
export const toRdf = (expanded: Json, options: ToRdfOptions): Array<Term.Quad> => {
  const issuer = new IdIssuer();
  const nodeMap: NodeMap = { '@default': {} };
  generateNodeMap(expanded, nodeMap, issuer);
  const quads: Array<Term.Quad> = [];
  for (const graphName of Arr.sort(Object.keys(nodeMap), compareStrings)) {
    let graphTerm: Term.Graph;
    if (graphName === '@default') graphTerm = Term.defaultGraph;
    else {
      const g = toResource(graphName);
      if (g === null) continue;
      graphTerm = g;
    }
    const graph = nodeMap[graphName]!;
    for (const subject of Arr.sort(Object.keys(graph), compareStrings)) {
      const s = toResource(subject);
      if (s === null) continue;
      const node = graph[subject]!;
      for (const property of Arr.sort(Object.keys(node), compareStrings)) {
        const values: Array<Json> = node[property];
        if (property === '@type') {
          for (const type of values) {
            const o = toResource(type);
            if (o !== null) quads.push(Term.quad(s, Term.namedNode(RDF_TYPE), o, graphTerm));
          }
          continue;
        }
        if (property.startsWith('@')) continue;
        // Blank node predicates (generalized RDF) cannot be represented by
        // the core term model, so they are always skipped.
        if (isBlankNodeId(property) || !isWellFormedIri(property)) continue;
        const p = Term.namedNode(property);
        for (const item of values) {
          const listTriples: Array<[Term.Subject, Term.NamedNode, Term.Object]> = [];
          const o = objectToRdf(item, listTriples, issuer, options);
          if (o !== null) quads.push(Term.quad(s, p, o, graphTerm));
          for (const [ls, lp, lo] of listTriples) quads.push(Term.quad(ls, lp, lo, graphTerm));
        }
      }
    }
  }
  return quads;
};

const toDoubleString = (n: number): string => n.toExponential(15).replace(/(\d)0*e\+?/, '$1E');

const objectToRdf = (
  item: Json,
  triples: Array<[Term.Subject, Term.NamedNode, Term.Object]>,
  issuer: IdIssuer,
  options: ToRdfOptions,
): Term.Object | null => {
  // 1, 2
  if (!isValueObject(item) && !isListObject(item)) {
    return toResource(item['@id']);
  }
  // 3
  if (isListObject(item)) return listToRdf(item['@list'], triples, issuer, options);
  // 4
  let value = item['@value'];
  let datatype: string | null = item['@type'] ?? null;
  // 6
  if (datatype !== null && datatype !== '@json' && !isWellFormedIri(datatype)) return null;
  // 7
  if ('@language' in item && !isWellFormedLanguage(item['@language'])) return null;
  // 8
  if (datatype === '@json') {
    value = canonicalJson(value);
    datatype = RDF_JSON;
  } else if (Predicate.isBoolean(value)) {
    value = value ? 'true' : 'false';
    datatype ??= XSD_BOOLEAN;
  } else if (
    Predicate.isNumber(value) &&
    (!Number.isInteger(value) || Math.abs(value) >= 1e21 || datatype === XSD_DOUBLE)
  ) {
    value = toDoubleString(value);
    datatype ??= XSD_DOUBLE;
  } else if (Predicate.isNumber(value)) {
    value = value.toFixed(0);
    datatype ??= XSD_INTEGER;
  } else if (datatype === null) {
    datatype = '@language' in item ? RDF_LANG_STRING : XSD_STRING;
  }
  // 13
  if ('@direction' in item && options.rdfDirection !== null) {
    const language = '@language' in item ? String(item['@language']).toLowerCase() : '';
    if (options.rdfDirection === 'i18n-datatype') {
      return Term.literal(
        String(value),
        Term.namedNode(`${I18N}${language}_${item['@direction']}`),
      );
    }
    const literal = blankNode(issuer.issue());
    triples.push([literal, Term.namedNode(RDF_VALUE), Term.literal(String(value))]);
    if ('@language' in item) {
      triples.push([literal, Term.namedNode(RDF_LANGUAGE), Term.literal(language)]);
    }
    triples.push([literal, Term.namedNode(RDF_DIRECTION), Term.literal(item['@direction'])]);
    return literal;
  }
  // 14
  if ('@language' in item) return Term.literal(String(value), String(item['@language']));
  return Term.literal(String(value), Term.namedNode(datatype));
};

const listToRdf = (
  list: Array<JsonObject>,
  triples: Array<[Term.Subject, Term.NamedNode, Term.Object]>,
  issuer: IdIssuer,
  options: ToRdfOptions,
): Term.Object => {
  if (Arr.isReadonlyArrayEmpty(list)) return Term.namedNode(RDF_NIL);
  const bnodes = list.map(() => blankNode(issuer.issue()));
  const first = Term.namedNode(RDF_FIRST);
  const rest = Term.namedNode(RDF_REST);
  for (let i = 0; i < list.length; i++) {
    const subject = bnodes[i]!;
    const embedded: Array<[Term.Subject, Term.NamedNode, Term.Object]> = [];
    const o = objectToRdf(list[i]!, embedded, issuer, options);
    if (o !== null) triples.push([subject, first, o]);
    triples.push([subject, rest, bnodes[i + 1] ?? Term.namedNode(RDF_NIL)]);
    triples.push(...embedded);
  }
  return bnodes[0]!;
};

// -----------------------------------------------------------------------------
// fromRdf
// -----------------------------------------------------------------------------

/** @internal */
export interface FromRdfOptions {
  readonly rdfDirection: RdfDirection | null;
  readonly useNativeTypes: boolean;
  readonly useRdfType: boolean;
  readonly ordered: boolean;
  readonly processingMode: 'json-ld-1.0' | 'json-ld-1.1';
}

const termId = (t: Term.Term): string => {
  switch (t._tag) {
    case 'BlankNode':
      return `_:${t.value}`;
    case 'NamedNode':
      return t.value;
    case 'DefaultGraph':
      return '@default';
    default:
      return t.key;
  }
};

interface Usage {
  readonly node: JsonObject;
  readonly property: string;
  readonly value: JsonObject;
}

const DOUBLE_RE = /^(\+|-)?([0-9]+(\.[0-9]*)?|\.[0-9]+)([Ee](\+|-)?[0-9]+)?$|^(\+|-)?INF$|^NaN$/;

/**
 * Serialize RDF as JSON-LD algorithm.
 *
 * @internal
 */
export const fromRdf = (quads: Iterable<Term.Quad>, options: FromRdfOptions): Array<JsonObject> => {
  const defaultGraph: Record<string, JsonObject> = {};
  const graphMap: Record<string, Record<string, JsonObject>> = {};
  graphMap['@default'] = defaultGraph;
  const referencedOnce: Record<string, Usage | false> = {};
  const compoundLiteralSubjects: Record<string, Set<string>> = {};
  const nilUsages: Record<string, Array<Usage>> = {};
  const seen = new Set<string>();
  for (const q of quads) {
    if (seen.has(q.key)) continue;
    seen.add(q.key);
    const name = termId(q.graph);
    const nodeMap = getOrInit(graphMap, name, () => ({}));
    const compoundMap = getOrInit(compoundLiteralSubjects, name, () => new Set());
    const usages = getOrInit(nilUsages, name, () => []);
    if (name !== '@default' && !hasOwn(defaultGraph, name)) defaultGraph[name] = { '@id': name };
    const subject = termId(q.subject);
    const predicate = q.predicate.value;
    const object = q.object;
    const node = getOrInit(nodeMap, subject, () => ({ '@id': subject }));
    if (options.rdfDirection === 'compound-literal' && predicate === RDF_DIRECTION) {
      compoundMap.add(subject);
    }
    const isResource = object._tag === 'NamedNode' || object._tag === 'BlankNode';
    const objectId = isResource ? termId(object) : '';
    if (isResource && !hasOwn(nodeMap, objectId)) nodeMap[objectId] = { '@id': objectId };
    if (predicate === RDF_TYPE && isResource && !options.useRdfType) {
      const types: Array<string> = getOrInit(node, '@type', () => []);
      if (!types.includes(objectId)) types.push(objectId);
      continue;
    }
    const value = rdfToObject(object, options);
    const values: Array<Json> = getOrInit(node, predicate, () => []);
    let stored = value;
    const existing = values.find((v) => deepEqual(v, value));
    if (existing === undefined) values.push(value);
    else stored = existing;
    if (isResource && objectId === RDF_NIL) {
      usages.push({ node, property: predicate, value: stored });
    } else if (isResource && hasOwn(referencedOnce, objectId)) {
      referencedOnce[objectId] = false;
    } else if (object._tag === 'BlankNode') {
      referencedOnce[objectId] = { node, property: predicate, value: stored };
    }
  }
  for (const name of Object.keys(graphMap)) {
    const graphObject = graphMap[name]!;
    // 6.1
    for (const cl of compoundLiteralSubjects[name] ?? []) {
      const clEntry = referencedOnce[cl];
      if (!clEntry) continue;
      const { node, property } = clEntry;
      const clNode = graphObject[cl];
      delete graphObject[cl];
      if (clNode === undefined) continue;
      for (const clReference of node[property] as Array<JsonObject>) {
        if (clReference['@id'] !== cl) continue;
        delete clReference['@id'];
        clReference['@value'] = clNode[RDF_VALUE]?.[0]?.['@value'];
        if (RDF_LANGUAGE in clNode) {
          const lang = clNode[RDF_LANGUAGE][0]['@value'];
          if (!Predicate.isString(lang) || !isWellFormedLanguage(lang)) {
            fail('invalid language-tagged string');
          }
          clReference['@language'] = lang;
        }
        if (RDF_DIRECTION in clNode) {
          const dir = clNode[RDF_DIRECTION][0]['@value'];
          if (dir !== 'ltr' && dir !== 'rtl') fail('invalid base direction');
          clReference['@direction'] = dir;
        }
      }
    }
    // 6.2 - 6.4
    if (!(RDF_NIL in graphObject)) continue;
    for (const usage of nilUsages[name] ?? []) {
      let { node, property, value: head } = usage;
      const list: Array<Json> = [];
      const listNodes: Array<string> = [];
      while (property === RDF_REST && isWellFormedListNode(node, referencedOnce)) {
        list.push(node[RDF_FIRST][0]);
        listNodes.push(node['@id']);
        const nodeUsage = referencedOnce[node['@id']] as Usage;
        node = nodeUsage.node;
        property = nodeUsage.property;
        head = nodeUsage.value;
        if (!isBlankNodeId(node['@id'])) break;
      }
      delete head['@id'];
      list.reverse();
      head['@list'] = list;
      for (const id of listNodes) delete graphObject[id];
    }
  }
  const result: Array<JsonObject> = [];
  const subjects = options.ordered
    ? Arr.sort(Object.keys(defaultGraph), compareStrings)
    : Object.keys(defaultGraph);
  for (const subject of subjects) {
    const node = defaultGraph[subject]!;
    if (hasOwn(graphMap, subject) && subject !== '@default') {
      const nodes: Array<JsonObject> = (node['@graph'] = []);
      const graph = graphMap[subject]!;
      const keys = options.ordered
        ? Arr.sort(Object.keys(graph), compareStrings)
        : Object.keys(graph);
      for (const k of keys) {
        const n = graph[k]!;
        if (!(Object.keys(n).length === 1 && '@id' in n)) nodes.push(n);
      }
    }
    if (!(Object.keys(node).length === 1 && '@id' in node)) result.push(node);
  }
  return result;
};

const isWellFormedListNode = (
  node: JsonObject,
  referencedOnce: Record<string, Usage | false>,
): boolean => {
  const id = node['@id'];
  if (!isBlankNodeId(id)) return false;
  if (!isObject(referencedOnce[id])) return false;
  const first = node[RDF_FIRST];
  const rest = node[RDF_REST];
  if (!Array.isArray(first) || first.length !== 1) return false;
  if (!Array.isArray(rest) || rest.length !== 1) return false;
  for (const k of Object.keys(node)) {
    if (k === '@id' || k === RDF_FIRST || k === RDF_REST) continue;
    if (k === '@type') {
      const t = node['@type'];
      if (Array.isArray(t) && t.length === 1 && t[0] === RDF_LIST) continue;
    }
    return false;
  }
  return true;
};

const rdfToObject = (object: Term.Object, options: FromRdfOptions): JsonObject => {
  if (object._tag === 'NamedNode' || object._tag === 'BlankNode') return { '@id': termId(object) };
  if (object._tag !== 'Literal') return { '@id': termId(object) };
  const result: JsonObject = {};
  let converted: Json = object.value;
  let type: string | null = null;
  const datatype = object.datatype.value;
  if (options.processingMode !== 'json-ld-1.0' && datatype === RDF_JSON) {
    converted = Result.getOrElse(parseJson(converted), () => fail('invalid JSON literal'));
    type = '@json';
  } else if (options.useNativeTypes) {
    if (datatype === XSD_STRING) {
      // keep
    } else if (datatype === XSD_BOOLEAN) {
      if (converted === 'true' || converted === '1') converted = true;
      else if (converted === 'false' || converted === '0') converted = false;
      else type = datatype;
    } else if (datatype === XSD_INTEGER && /^[+-]?[0-9]+$/.test(converted)) {
      const n = Number(converted);
      if (Number.isSafeInteger(n)) converted = n;
      else type = datatype;
    } else if (datatype === XSD_DOUBLE && DOUBLE_RE.test(converted)) {
      const n = Number(converted.replace(/INF$/, 'Infinity'));
      if (Number.isFinite(n)) converted = n;
      else type = datatype;
    } else if (object.language === '') {
      type = datatype;
    }
  }
  if (type === '@json') {
    // handled
  } else if (datatype.startsWith(I18N) && options.rdfDirection === 'i18n-datatype') {
    const fragment = datatype.slice(I18N.length);
    const i = fragment.indexOf('_');
    const language = i === -1 ? fragment : fragment.slice(0, i);
    if (language !== '') result['@language'] = language;
    if (i !== -1) result['@direction'] = fragment.slice(i + 1);
    type = null;
  } else if (object.language !== '') {
    result['@language'] = object.language;
    if (object.direction !== undefined) result['@direction'] = object.direction;
    type = null;
  } else if (!options.useNativeTypes && datatype !== XSD_STRING && type === null) {
    type = datatype;
  }
  result['@value'] = converted;
  if (type !== null) result['@type'] = type;
  return result;
};
