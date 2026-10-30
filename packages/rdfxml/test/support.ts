/**
 * Minimal readers for the W3C test-suite manifests (a Turtle subset) and
 * N-Triples expected results, so the conformance tests do not depend on
 * the Turtle package.
 */
import { assert } from '@effect/vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Dataset, Iri, Term } from '@thomasfosterau/effect-rdf';

// -----------------------------------------------------------------------------
// N-Triples
// -----------------------------------------------------------------------------

const unescape = (s: string): string =>
  s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_, u4, u8, c) => {
    if (u4 !== undefined) return String.fromCodePoint(parseInt(u4, 16));
    if (u8 !== undefined) return String.fromCodePoint(parseInt(u8, 16));
    switch (c) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return c;
    }
  });

/** Parses an N-Triples document (including RDF 1.2 triple terms). */
export const parseNTriples = (input: string, bnodePrefix = 'nt_'): Dataset.Dataset => {
  const quads: Array<Term.Quad> = [];
  let pos = 0;
  const ws = () => {
    for (;;) {
      while (pos < input.length && /[ \t\r\n]/.test(input[pos]!)) pos++;
      if (input[pos] === '#') {
        while (pos < input.length && input[pos] !== '\n') pos++;
      } else return;
    }
  };
  const term = (): Term.Term => {
    ws();
    if (input.startsWith('<<(', pos)) {
      pos += 3;
      // SAFETY: the test's N-Triples reader parses a subject here.
      const s = term() as Term.Subject;
      // SAFETY: the test's N-Triples reader parses an IRI predicate here.
      const p = term() as Term.NamedNode;
      // SAFETY: the test's N-Triples reader parses an object here.
      const o = term() as Term.Object;
      ws();
      if (!input.startsWith(')>>', pos)) assert.fail(`Expected )>> at ${pos}`);
      pos += 3;
      return Term.triple(s, p, o);
    }
    const c = input[pos];
    if (c === '<') {
      const end = input.indexOf('>', pos);
      const iri = unescape(input.slice(pos + 1, end));
      pos = end + 1;
      return Term.namedNode(iri);
    }
    if (c === '_') {
      const m = /^_:([^\s)]+)/.exec(input.slice(pos))!;
      pos += m[0].length;
      let label = m[1]!;
      if (label.endsWith('.')) {
        label = label.slice(0, -1);
        pos--;
      }
      return Term.blankNode(bnodePrefix + label);
    }
    if (c === '"') {
      let i = pos + 1;
      let raw = '';
      while (input[i] !== '"') {
        if (input[i] === '\\') {
          raw += input.slice(i, i + 2);
          i += 2;
        } else raw += input[i++];
      }
      pos = i + 1;
      const value = unescape(raw);
      if (input[pos] === '@') {
        const m = /^@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*?)(?:--(ltr|rtl))?(?=[\s.)])/.exec(
          input.slice(pos),
        )!;
        pos += m[0].length;
        // SAFETY: the regex only captures `ltr` or `rtl`.
        return m[2] !== undefined
          ? Term.literal(value, { language: m[1]!, direction: m[2] as Term.Direction })
          : Term.literal(value, m[1]);
      }
      if (input.startsWith('^^', pos)) {
        pos += 2;
        // SAFETY: the `^^` datatype is an IRI.
        return Term.literal(value, term() as Term.NamedNode);
      }
      return Term.literal(value);
    }
    assert.fail(`Unexpected character '${c}' at ${pos}`);
  };
  for (;;) {
    ws();
    if (pos >= input.length) break;
    // SAFETY: the test's N-Triples reader parses a subject here.
    const s = term() as Term.Subject;
    // SAFETY: the test's N-Triples reader parses an IRI predicate here.
    const p = term() as Term.NamedNode;
    // SAFETY: the test's N-Triples reader parses an object here.
    const o = term() as Term.Object;
    ws();
    if (input[pos] !== '.') assert.fail(`Expected . at ${pos}`);
    pos++;
    quads.push(Term.quad(s, p, o));
  }
  return Dataset.fromIterable(quads);
};

// -----------------------------------------------------------------------------
// Manifests (a Turtle subset)
// -----------------------------------------------------------------------------

interface Value {
  readonly kind: 'iri' | 'literal' | 'list' | 'bnode';
  readonly value: string;
  readonly items: ReadonlyArray<Value>;
}

type Graph = Map<string, Map<string, Array<Value>>>;

const tokenize = (src: string): Array<string> => {
  const tokens: Array<string> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '<') {
      const end = src.indexOf('>', i);
      tokens.push(src.slice(i, end + 1));
      i = end + 1;
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      tokens.push(`"${src.slice(i + 3, end)}`);
      i = end + 3;
      i = skipSuffix(src, i);
    } else if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      tokens.push(`"${src.slice(i + 1, j)}`);
      i = skipSuffix(src, j + 1);
    } else if ('()[];,'.includes(c)) {
      tokens.push(c);
      i++;
    } else {
      let j = i;
      while (j < src.length && !/[\s()[\];,]/.test(src[j]!)) j++;
      let tok = src.slice(i, j);
      if (tok.endsWith('.') && tok.length > 1) {
        tokens.push(tok.slice(0, -1));
        tok = '.';
      }
      tokens.push(tok);
      i = j;
    }
  }
  return tokens;
};

const skipSuffix = (src: string, i: number): number => {
  if (src[i] === '@') {
    while (i < src.length && /[@A-Za-z0-9-]/.test(src[i]!)) i++;
  } else if (src.startsWith('^^', i)) {
    i += 2;
    if (src[i] === '<') i = src.indexOf('>', i) + 1;
    else while (i < src.length && !/[\s;,.)\]]/.test(src[i]!)) i++;
  }
  return i;
};

const parseManifestGraph = (src: string, base: string): Graph => {
  const tokens = tokenize(src);
  const prefixes = new Map<string, string>();
  const graph: Graph = new Map();
  let k = 0;
  let bnodes = 0;
  const add = (s: string, p: string, o: Value) => {
    let preds = graph.get(s);
    if (preds === undefined) graph.set(s, (preds = new Map()));
    let values = preds.get(p);
    if (values === undefined) preds.set(p, (values = []));
    values.push(o);
  };
  const iri = (tok: string): string => {
    if (tok.startsWith('<')) return Iri.resolve(tok.slice(1, -1), base);
    if (tok === 'a') return 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const i = tok.indexOf(':');
    const ns = prefixes.get(tok.slice(0, i));
    if (ns === undefined) assert.fail(`Unknown prefix in ${tok}`);
    return ns + tok.slice(i + 1);
  };
  const object = (): Value => {
    const tok = tokens[k++]!;
    if (tok.startsWith('"')) return { kind: 'literal', value: tok.slice(1), items: [] };
    if (tok === '(') {
      const items: Array<Value> = [];
      while (tokens[k] !== ')') items.push(object());
      k++;
      return { kind: 'list', value: '', items };
    }
    if (tok === '[') {
      const id = `_:m${bnodes++}`;
      if (tokens[k] !== ']') predicateObjectList(id);
      k++; // ]
      return { kind: 'bnode', value: id, items: [] };
    }
    if (tok === 'true' || tok === 'false' || /^[0-9]/.test(tok))
      return { kind: 'literal', value: tok, items: [] };
    return { kind: 'iri', value: iri(tok), items: [] };
  };
  const predicateObjectList = (subject: string) => {
    for (;;) {
      const p = iri(tokens[k++]!);
      for (;;) {
        add(subject, p, object());
        if (tokens[k] === ',') k++;
        else break;
      }
      if (tokens[k] === ';') {
        while (tokens[k] === ';') k++;
        if (tokens[k] === '.' || tokens[k] === ']') return;
      } else return;
    }
  };
  while (k < tokens.length) {
    const tok = tokens[k]!;
    if (tok === '@prefix' || tok === 'PREFIX') {
      const p = tokens[k + 1]!;
      prefixes.set(p.slice(0, -1), Iri.resolve(tokens[k + 2]!.slice(1, -1), base));
      k += tok === '@prefix' ? 4 : 3;
      continue;
    }
    if (tok === '@base' || tok === 'BASE') {
      k += tok === '@base' ? 3 : 2;
      continue;
    }
    const subject = iri(tokens[k++]!);
    if (tokens[k] !== '.') predicateObjectList(subject);
    if (tokens[k] !== '.') assert.fail(`Expected . but found ${tokens[k]}`);
    k++;
  }
  return graph;
};

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFT = 'http://www.w3.org/ns/rdftest#';

export interface TestCase {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Local path of the input document. */
  readonly action: string;
  /** Local path of the expected result, if any. */
  readonly result: string | undefined;
  /** The base IRI to parse with (the assumed test base location). */
  readonly baseIri: string;
}

/** Reads a manifest (following `mf:include`) and returns its test cases. */
export const readManifest = (file: string): Array<TestCase> => {
  const fileUrl = `file://${path.resolve(file)}`;
  const graph = parseManifestGraph(fs.readFileSync(file, 'utf8'), fileUrl);
  const out: Array<TestCase> = [];
  for (const [subject, preds] of graph) {
    const types = preds.get(RDF_TYPE) ?? [];
    if (!types.some((t) => t.kind === 'iri' && t.value === `${MF}Manifest`)) continue;
    // SAFETY: `mf:assumedTestBase` is an IRI string.
    const assumed = preds.get(`${MF}assumedTestBase`)?.[0]?.value;
    for (const inc of preds.get(`${MF}include`) ?? []) {
      if (inc.kind !== 'list') continue;
      for (const item of inc.items) {
        // SAFETY: list items in the manifest are IRIs, which carry a `value`.
        out.push(...readManifest((item as { value: string }).value.replace(/^file:\/\//, '')));
      }
    }
    for (const entries of preds.get(`${MF}entries`) ?? []) {
      if (entries.kind !== 'list') continue;
      for (const entry of entries.items) {
        // SAFETY: list items in the manifest are IRIs, which carry a `value`.
        const id = (entry as { value: string }).value;
        const e = graph.get(id);
        if (e === undefined) continue;
        const type = (e.get(RDF_TYPE)?.[0]?.value ?? '').replace(RDFT, '');
        const action = e.get(`${MF}action`)?.[0]?.value ?? '';
        const result = e.get(`${MF}result`)?.[0]?.value;
        const rel = (u: string) => u.slice(fileUrl.lastIndexOf('/') + 1);
        out.push({
          id,
          name: e.get(`${MF}name`)?.[0]?.value ?? id,
          type,
          action: action.replace(/^file:\/\//, ''),
          result: result?.replace(/^file:\/\//, ''),
          baseIri: assumed !== undefined ? Iri.resolve(rel(action), assumed) : action,
        });
      }
    }
    void subject;
  }
  return out;
};
