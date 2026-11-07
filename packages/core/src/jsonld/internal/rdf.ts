/**
 * RDF conversion: Deserialize JSON-LD to RDF and Serialize RDF as JSON-LD
 * (JSON-LD 1.1 API §8).
 *
 * @internal
 */
import * as Arr from 'effect/Array';
import * as Iterable from 'effect/Iterable';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as MutableHashSet from 'effect/MutableHashSet';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';
import * as Term from '../../Term.ts';
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
  loop,
} from './util.ts';
import { parseJson } from './json.ts';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';

/** @internal */
export type RdfDirection = 'i18n-datatype' | 'compound-literal' | 'rdf-1.2';

/** @internal */
export interface ToRdfOptions {
  readonly produceGeneralizedRdf: boolean;
  readonly rdfDirection: Option.Option<RdfDirection>;
}

const blankNode = (id: string): Term.BlankNode => Term.blankNode(id.slice(2));

/**
 * The nodes of the IRIs seen by the current `toRdf` (none for an IRI that
 * is not well-formed), so that an IRI that recurs (a property, a type, a
 * datatype, a node) is validated and made into a node once. `toRdf` runs
 * synchronously, and empties it before and after.
 */
const iriNodes = MutableHashMap.empty<string, Option.Option<Term.NamedNode>>();

/** The node of an IRI, if it is well-formed. */
const iriNode = (iri: string): Option.Option<Term.NamedNode> => {
  const cached = MutableHashMap.get(iriNodes, iri);
  if (Option.isSome(cached)) return cached.value;
  const node = isWellFormedIri(iri) ? Option.some(Term.namedNode(iri)) : Option.none();
  MutableHashMap.set(iriNodes, iri, node);
  return node;
};

const toResource = (id: string): Option.Option<Term.NamedNode | Term.BlankNode> =>
  isBlankNodeId(id) ? Option.some(blankNode(id)) : iriNode(id);

type Triple = readonly [Term.Subject, Term.NamedNode, Term.Object];

/**
 * Converts expanded JSON-LD to quads.
 *
 * @internal
 */
export const toRdf = (expanded: Json, options: ToRdfOptions): Array<Term.Quad> => {
  const issuer = new IdIssuer();
  MutableHashMap.clear(iriNodes);
  const rdfType = Term.namedNode(RDF_TYPE);
  const nodeMap: NodeMap = { '@default': {} };
  generateNodeMap(expanded, nodeMap, issuer);
  const quads: Array<Term.Quad> = [];
  Arr.sort(Record.keys(nodeMap), compareStrings).forEach((graphName) => {
    const graphTerm: Option.Option<Term.Graph> =
      graphName === '@default' ? Option.some(Term.defaultGraph) : toResource(graphName);
    const graph = nodeMap[graphName];
    if (Option.isNone(graphTerm) || graph === undefined) return;
    const g = graphTerm.value;
    Arr.sort(Record.keys(graph), compareStrings).forEach((subject) => {
      const s = toResource(subject);
      const node = graph[subject];
      if (Option.isNone(s) || node === undefined) return;
      Arr.sort(Record.keys(node), compareStrings).forEach((property) => {
        const values: Array<Json> = node[property];
        if (property === '@type') {
          values.forEach((type) => {
            const o = toResource(type);
            if (Option.isSome(o)) quads.push(Term.quad(s.value, rdfType, o.value, g));
          });
          return;
        }
        if (property.startsWith('@')) return;
        // Blank node predicates (generalized RDF) cannot be represented by
        // the core term model, so they are always skipped.
        const p = isBlankNodeId(property) ? Option.none() : iriNode(property);
        if (Option.isNone(p)) return;
        values.forEach((item) => {
          const listTriples: Array<Triple> = [];
          const o = objectToRdf(item, listTriples, issuer, options);
          if (Option.isSome(o)) quads.push(Term.quad(s.value, p.value, o.value, g));
          listTriples.forEach(([ls, lp, lo]) => quads.push(Term.quad(ls, lp, lo, g)));
        });
      });
    });
  });
  MutableHashMap.clear(iriNodes);
  return quads;
};

const toDoubleString = (n: number): string => n.toExponential(15).replace(/(\d)0*e\+?/, '$1E');

const objectToRdf = (
  item: Json,
  triples: Array<Triple>,
  issuer: IdIssuer,
  options: ToRdfOptions,
): Option.Option<Term.Object> => {
  // 1, 2
  if (!isValueObject(item) && !isListObject(item)) {
    return toResource(item['@id']);
  }
  // 3
  if (isListObject(item)) return Option.some(listToRdf(item['@list'], triples, issuer, options));
  // 4
  let value = item['@value'];
  const type = item['@type'];
  const typed = type !== undefined && type !== null;
  // 6
  if (typed && type !== '@json' && Option.isNone(iriNode(type))) return Option.none();
  // 7
  if ('@language' in item && !isWellFormedLanguage(item['@language'])) return Option.none();
  // 8
  let datatype: string;
  if (type === '@json') {
    value = canonicalJson(value);
    datatype = RDF_JSON;
  } else if (Predicate.isBoolean(value)) {
    value = value ? 'true' : 'false';
    datatype = typed ? type : XSD_BOOLEAN;
  } else if (
    Predicate.isNumber(value) &&
    (!Number.isInteger(value) || Math.abs(value) >= 1e21 || type === XSD_DOUBLE)
  ) {
    value = toDoubleString(value);
    datatype = typed ? type : XSD_DOUBLE;
  } else if (Predicate.isNumber(value)) {
    value = value.toFixed(0);
    datatype = typed ? type : XSD_INTEGER;
  } else {
    datatype = typed ? type : '@language' in item ? RDF_LANG_STRING : XSD_STRING;
  }
  // RDF 1.2 (w3c/json-ld-syntax#488): `@language` + `@direction` is a directional
  // language-tagged string. Without a language there is none, so the direction is dropped, as
  // when `rdfDirection` is unset.
  if (
    '@direction' in item &&
    Option.isSome(options.rdfDirection) &&
    options.rdfDirection.value === 'rdf-1.2'
  ) {
    return Option.some(
      '@language' in item
        ? Term.literal(String(value), {
            language: String(item['@language']),
            direction: item['@direction'],
          })
        : Term.literal(String(value)),
    );
  }
  // 13
  if ('@direction' in item && Option.isSome(options.rdfDirection)) {
    const language = '@language' in item ? String(item['@language']).toLowerCase() : '';
    if (options.rdfDirection.value === 'i18n-datatype') {
      return Option.some(
        Term.literal(String(value), Term.namedNode(`${I18N}${language}_${item['@direction']}`)),
      );
    }
    const literal = blankNode(issuer.issue());
    triples.push([literal, Term.namedNode(RDF_VALUE), Term.literal(String(value))]);
    if ('@language' in item) {
      triples.push([literal, Term.namedNode(RDF_LANGUAGE), Term.literal(language)]);
    }
    triples.push([literal, Term.namedNode(RDF_DIRECTION), Term.literal(item['@direction'])]);
    return Option.some(literal);
  }
  // 14
  if ('@language' in item) {
    return Option.some(Term.literal(String(value), String(item['@language'])));
  }
  return Option.some(
    Term.literal(
      String(value),
      Option.getOrElse(iriNode(datatype), () => Term.namedNode(datatype)),
    ),
  );
};

const listToRdf = (
  list: Array<JsonObject>,
  triples: Array<Triple>,
  issuer: IdIssuer,
  options: ToRdfOptions,
): Term.Object => {
  const nil = Term.namedNode(RDF_NIL);
  const bnodes = list.map(() => blankNode(issuer.issue()));
  const first = Term.namedNode(RDF_FIRST);
  const rest = Term.namedNode(RDF_REST);
  bnodes.forEach((subject, i) => {
    const embedded: Array<Triple> = [];
    const o = objectToRdf(list[i], embedded, issuer, options);
    if (Option.isSome(o)) triples.push([subject, first, o.value]);
    triples.push([subject, rest, bnodes[i + 1] ?? nil]);
    embedded.forEach((triple) => triples.push(triple));
  });
  return bnodes[0] ?? nil;
};

// -----------------------------------------------------------------------------
// fromRdf
// -----------------------------------------------------------------------------

/** @internal */
export interface FromRdfOptions {
  readonly rdfDirection: Option.Option<RdfDirection>;
  readonly useNativeTypes: boolean;
  readonly useRdfType: boolean;
  readonly ordered: boolean;
  readonly processingMode: 'json-ld-1.0' | 'json-ld-1.1';
}

// A refinement chain: `termId` runs for every term of every quad converted.
const termId = (t: Term.Term): string =>
  Term.isBlankNode(t)
    ? `_:${t.value}`
    : Term.isNamedNode(t)
      ? t.value
      : Term.isDefaultGraph(t)
        ? '@default'
        : t.key;

/** A walk up an `rdf:rest` chain from a usage of `rdf:nil` (fromRdf §8.6, step 6.4). */
interface ListWalk {
  readonly node: JsonObject;
  readonly property: string;
  readonly head: JsonObject;
  /** The walk reached a node that is not a blank node, and stops there. */
  readonly done: boolean;
}

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
  const defaultGraph: globalThis.Record<string, JsonObject> = {};
  const graphMap: globalThis.Record<string, globalThis.Record<string, JsonObject>> = {};
  graphMap['@default'] = defaultGraph;
  const referencedOnce: globalThis.Record<string, Usage | false> = {};
  const compoundLiteralSubjects: globalThis.Record<
    string,
    MutableHashSet.MutableHashSet<string>
  > = {};
  const nilUsages: globalThis.Record<string, Array<Usage>> = {};
  const seen = MutableHashSet.empty<string>();
  const compoundLiterals =
    Option.isSome(options.rdfDirection) && options.rdfDirection.value === 'compound-literal';
  Iterable.forEach(quads, (q) => {
    // One `add` per quad: a duplicate leaves the size unchanged.
    const before = MutableHashSet.size(seen);
    if (MutableHashSet.size(MutableHashSet.add(seen, q.key)) === before) return;
    const name = termId(q.graph);
    const nodeMap = getOrInit(graphMap, name, () => ({}));
    const compoundMap = getOrInit(compoundLiteralSubjects, name, () => MutableHashSet.empty());
    const usages = getOrInit(nilUsages, name, () => []);
    if (name !== '@default' && !hasOwn(defaultGraph, name)) defaultGraph[name] = { '@id': name };
    const subject = termId(q.subject);
    const predicate = q.predicate.value;
    const object = q.object;
    const node = getOrInit(nodeMap, subject, () => ({ '@id': subject }));
    if (compoundLiterals && predicate === RDF_DIRECTION) {
      MutableHashSet.add(compoundMap, subject);
    }
    const isBlank = Term.isBlankNode(object);
    const isResource = isBlank || Term.isNamedNode(object);
    const objectId = isResource ? termId(object) : '';
    if (isResource && !hasOwn(nodeMap, objectId)) nodeMap[objectId] = { '@id': objectId };
    if (predicate === RDF_TYPE && isResource && !options.useRdfType) {
      const types: Array<string> = getOrInit(node, '@type', () => []);
      if (!types.includes(objectId)) types.push(objectId);
      return;
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
    } else if (isBlank) {
      referencedOnce[objectId] = { node, property: predicate, value: stored };
    }
  });
  Record.keys(graphMap).forEach((name) => {
    const graphObject = graphMap[name];
    if (graphObject === undefined) return;
    // 6.1
    Iterable.forEach(compoundLiteralSubjects[name] ?? [], (cl) => {
      const clEntry = referencedOnce[cl];
      if (!clEntry) return;
      const { node, property } = clEntry;
      const clNode = graphObject[cl];
      delete graphObject[cl];
      if (clNode === undefined) return;
      // The property of a node object in the node map holds an array of node references
      // (JSON-LD fromRdf §8.6).
      const references: Array<JsonObject> = node[property];
      references.forEach((clReference) => {
        if (clReference['@id'] !== cl) return;
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
      });
    });
    // 6.2 - 6.4
    if (!(RDF_NIL in graphObject)) return;
    (nilUsages[name] ?? []).forEach((usage) => {
      const list: Array<Json> = [];
      const listNodes: Array<string> = [];
      const { head } = loop<ListWalk>(
        { node: usage.node, property: usage.property, head: usage.value, done: false },
        (walk) => {
          const { node } = walk;
          if (walk.done || walk.property !== RDF_REST) return Option.none();
          if (!isWellFormedListNode(node, referencedOnce)) return Option.none();
          // `isWellFormedListNode` checked that this node is referenced exactly once, so it has
          // a usage entry.
          const nodeUsage = referencedOnce[node['@id']];
          if (!nodeUsage) return Option.none();
          list.push(node[RDF_FIRST][0]);
          listNodes.push(node['@id']);
          return Option.some({
            node: nodeUsage.node,
            property: nodeUsage.property,
            head: nodeUsage.value,
            done: !isBlankNodeId(nodeUsage.node['@id']),
          });
        },
      );
      delete head['@id'];
      list.reverse();
      head['@list'] = list;
      listNodes.forEach((id) => {
        delete graphObject[id];
      });
    });
  });
  const result: Array<JsonObject> = [];
  const subjects = options.ordered
    ? Arr.sort(Record.keys(defaultGraph), compareStrings)
    : Record.keys(defaultGraph);
  subjects.forEach((subject) => {
    const node = defaultGraph[subject];
    if (node === undefined) return;
    const graph = graphMap[subject];
    if (hasOwn(graphMap, subject) && subject !== '@default' && graph !== undefined) {
      const nodes: Array<JsonObject> = (node['@graph'] = []);
      const keys = options.ordered
        ? Arr.sort(Record.keys(graph), compareStrings)
        : Record.keys(graph);
      keys.forEach((k) => {
        const n = graph[k];
        if (n !== undefined && !isOnlyId(n)) nodes.push(n);
      });
    }
    if (!isOnlyId(node)) result.push(node);
  });
  return result;
};

const isOnlyId = (n: JsonObject): boolean => Record.keys(n).length === 1 && '@id' in n;

const isWellFormedListNode = (
  node: JsonObject,
  referencedOnce: globalThis.Record<string, Usage | false>,
): boolean => {
  const id = node['@id'];
  if (!isBlankNodeId(id)) return false;
  if (!isObject(referencedOnce[id])) return false;
  const first = node[RDF_FIRST];
  const rest = node[RDF_REST];
  if (!Array.isArray(first) || first.length !== 1) return false;
  if (!Array.isArray(rest) || rest.length !== 1) return false;
  return Record.keys(node).every((k) => {
    if (k === '@id' || k === RDF_FIRST || k === RDF_REST) return true;
    const t = node['@type'];
    return k === '@type' && Array.isArray(t) && t.length === 1 && t[0] === RDF_LIST;
  });
};

const rdfToObject = (object: Term.Object, options: FromRdfOptions): JsonObject => {
  if (!Term.isLiteral(object)) return { '@id': termId(object) };
  const result: JsonObject = {};
  let converted: Json = object.value;
  let type = Option.none<string>();
  const datatype = object.datatype.value;
  const isJson = options.processingMode !== 'json-ld-1.0' && datatype === RDF_JSON;
  if (isJson) {
    converted = Result.getOrElse(parseJson(converted), () => fail('invalid JSON literal'));
    type = Option.some('@json');
  } else if (options.useNativeTypes) {
    if (datatype === XSD_STRING) {
      // keep
    } else if (datatype === XSD_BOOLEAN) {
      if (converted === 'true' || converted === '1') converted = true;
      else if (converted === 'false' || converted === '0') converted = false;
      else type = Option.some(datatype);
    } else if (datatype === XSD_INTEGER && /^[+-]?[0-9]+$/.test(converted)) {
      const n = Number(converted);
      if (Number.isSafeInteger(n)) converted = n;
      else type = Option.some(datatype);
    } else if (datatype === XSD_DOUBLE && DOUBLE_RE.test(converted)) {
      const n = Number(converted.replace(/INF$/, 'Infinity'));
      if (Number.isFinite(n)) converted = n;
      else type = Option.some(datatype);
    } else if (object.language === '') {
      type = Option.some(datatype);
    }
  }
  if (isJson) {
    // handled
  } else if (
    datatype.startsWith(I18N) &&
    Option.isSome(options.rdfDirection) &&
    options.rdfDirection.value === 'i18n-datatype'
  ) {
    const fragment = datatype.slice(I18N.length);
    const i = fragment.indexOf('_');
    const language = i === -1 ? fragment : fragment.slice(0, i);
    if (language !== '') result['@language'] = language;
    if (i !== -1) result['@direction'] = fragment.slice(i + 1);
    type = Option.none();
  } else if (object.language !== '') {
    result['@language'] = object.language;
    if (object.direction !== undefined) result['@direction'] = object.direction;
    type = Option.none();
  } else if (!options.useNativeTypes && datatype !== XSD_STRING && Option.isNone(type)) {
    type = Option.some(datatype);
  }
  result['@value'] = converted;
  if (Option.isSome(type)) result['@type'] = type.value;
  return result;
};
