/**
 * Minimal readers for the W3C test-suite manifests (a Turtle subset) and
 * N-Triples expected results, so the conformance tests do not depend on
 * the Turtle package.
 */
import { assert } from '@effect/vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Arr from 'effect/Array';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import { Dataset, Iri, Serialization, Term } from '@thomasfosterau/effect-rdf';
import { RdfXml, Xml } from '../src/index.ts';

// -----------------------------------------------------------------------------
// N-Triples
// -----------------------------------------------------------------------------

/** The characters of the one-letter escapes that stand for another character. */
const ESCAPED: Record.ReadonlyRecord<string, string> = {
  t: '\t',
  n: '\n',
  r: '\r',
  b: '\b',
  f: '\f',
};

/**
 * Replaces each escape; `\uXXXX` and `\UXXXXXXXX` (the only ones longer than
 * two characters) by their code points.
 */
const unescape = (s: string): string =>
  s.replace(/\\(?:u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (m: string) => {
    const c = m.slice(1);
    return m.length > 2
      ? String.fromCodePoint(parseInt(m.slice(2), 16))
      : Option.getOrElse(Record.get(ESCAPED, c), () => c);
  });

/**
 * The tokens of an N-Triples line: triple-term brackets, IRIs, blank nodes
 * (a label's final `.` is the statement's), literals with their language tag
 * or datatype, `.`, and anything else one character at a time. White space
 * and comments are matched and dropped.
 */
const NT_TOKEN_RE =
  /\s+|#.*|<<\(|\)>>|<[^>]*>|_:[^\s)]+|"(?:[^"\\]|\\.)*"(?:@[a-zA-Z]+(?:-[a-zA-Z0-9]+)*(?:--(?:ltr|rtl))?|\^\^<[^>]*>)?|./g;

const NT_LITERAL_RE =
  /^"((?:[^"\\]|\\.)*)"(?:@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*)(?:--(ltr|rtl))?|\^\^<([^>]*)>)?$/;

const ntTokens = (line: string): Array<string> =>
  (line.match(NT_TOKEN_RE) ?? []).flatMap((tok) =>
    /^\s/.test(tok) || tok.startsWith('#')
      ? []
      : tok.startsWith('_:') && tok.endsWith('.')
        ? [tok.slice(0, -1), '.']
        : [tok],
  );

/** Parses one N-Triples statement (or a blank or comment line, which has none). */
const parseStatement = (line: string, bnodePrefix: string): Array<Term.Quad> => {
  const tokens = ntTokens(line);
  let k = 0;
  const next = (): string => tokens[k++] ?? assert.fail(`Unexpected end of line in ${line}`);
  const term = (): Term.Term => {
    const tok = next();
    if (tok === '<<(') {
      const t = Term.triple(subject(), predicate(), object());
      if (next() !== ')>>') assert.fail(`Expected )>> in ${line}`);
      return t;
    }
    if (tok.startsWith('<')) return Term.namedNode(unescape(tok.slice(1, -1)));
    if (tok.startsWith('_:')) return Term.blankNode(bnodePrefix + tok.slice(2));
    const m = NT_LITERAL_RE.exec(tok);
    if (m === null) return assert.fail(`Unexpected token '${tok}' in ${line}`);
    const value = unescape(m[1] ?? '');
    const [, , language, direction, datatype] = m;
    if (language !== undefined) {
      return direction === 'ltr' || direction === 'rtl'
        ? Term.literal(value, { language, direction })
        : Term.literal(value, language);
    }
    return datatype === undefined
      ? Term.literal(value)
      : Term.literal(value, Term.namedNode(unescape(datatype)));
  };
  const subject = (): Term.Subject => {
    const t = term();
    return Term.isSubject(t) ? t : assert.fail(`Expected a subject in ${line}`);
  };
  const predicate = (): Term.NamedNode => {
    const t = term();
    return Term.isNamedNode(t) ? t : assert.fail(`Expected a predicate in ${line}`);
  };
  const object = (): Term.Object => {
    const t = term();
    return Term.isObject(t) ? t : assert.fail(`Expected an object in ${line}`);
  };
  if (Arr.isReadonlyArrayEmpty(tokens)) return [];
  const quad = Term.quad(subject(), predicate(), object());
  if (next() !== '.') assert.fail(`Expected . in ${line}`);
  if (k !== tokens.length) assert.fail(`Unexpected '${tokens[k]}' after . in ${line}`);
  return [quad];
};

/** Parses an N-Triples document (including RDF 1.2 triple terms). */
export const parseNTriples = (input: string, bnodePrefix = 'nt_'): Dataset.Dataset =>
  Dataset.fromIterable(
    input.split(/\r?\n|\r/).flatMap((line) => parseStatement(line, bnodePrefix)),
  );

// -----------------------------------------------------------------------------
// Manifests (a Turtle subset)
// -----------------------------------------------------------------------------

interface Value {
  readonly kind: 'iri' | 'literal' | 'list' | 'bnode';
  readonly value: string;
  readonly items: ReadonlyArray<Value>;
}

type Graph = MutableHashMap.MutableHashMap<
  string,
  MutableHashMap.MutableHashMap<string, Array<Value>>
>;

/** A string's language tag or datatype, which the manifest reader skips. */
const SUFFIX = String.raw`(?:@[@A-Za-z0-9-]*|\^\^(?:<[^>]*>|[^\s;,.)\]]*))?`;

/**
 * The tokens of a manifest: white space and comments (dropped), IRIs, long
 * and short strings (`"` and their unescaped content, suffix dropped),
 * punctuation, and any other run of characters (a final `.` split off).
 */
const MANIFEST_TOKEN_RE = new RegExp(
  String.raw`\s+|#[^\n]*|<[^>]*>|"""([\s\S]*?)"""${SUFFIX}|"((?:[^"\\]|\\.)*)"${SUFFIX}|[()[\];,]|[^\s()[\];,]+`,
  'g',
);

const tokenize = (src: string): Array<string> =>
  Array.from(src.matchAll(MANIFEST_TOKEN_RE), (m): ReadonlyArray<string> => {
    const [tok, long, short] = m;
    if (long !== undefined) return [`"${long}`];
    if (short !== undefined) return [`"${short}`];
    if (/^\s/.test(tok) || tok.startsWith('#')) return [];
    return tok.endsWith('.') && tok.length > 1 ? [tok.slice(0, -1), '.'] : [tok];
  }).flat();

const parseManifestGraph = (src: string, base: string): Graph => {
  const tokens = tokenize(src);
  const prefixes = MutableHashMap.empty<string, string>();
  const graph: Graph = MutableHashMap.empty();
  let k = 0;
  let bnodes = 0;
  const next = (): string => tokens[k++] ?? assert.fail('Unexpected end of manifest');
  const add = (s: string, p: string, o: Value) => {
    const preds = Option.getOrElse(MutableHashMap.get(graph, s), () => {
      const fresh = MutableHashMap.empty<string, Array<Value>>();
      MutableHashMap.set(graph, s, fresh);
      return fresh;
    });
    const values = Option.getOrElse(MutableHashMap.get(preds, p), () => {
      const fresh: Array<Value> = [];
      MutableHashMap.set(preds, p, fresh);
      return fresh;
    });
    values.push(o);
  };
  const iri = (tok: string): string => {
    if (tok.startsWith('<')) return Iri.resolve(tok.slice(1, -1), base);
    if (tok === 'a') return 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const i = tok.indexOf(':');
    const ns = Option.getOrElse(MutableHashMap.get(prefixes, tok.slice(0, i)), () =>
      assert.fail(`Unknown prefix in ${tok}`),
    );
    return ns + tok.slice(i + 1);
  };
  const listItems = (items: Array<Value>): Array<Value> => {
    if (tokens[k] === ')') return items;
    items.push(object());
    return listItems(items);
  };
  const object = (): Value => {
    const tok = next();
    if (tok.startsWith('"')) return { kind: 'literal', value: tok.slice(1), items: [] };
    if (tok === '(') {
      const items = listItems([]);
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
  const objectList = (subject: string, p: string): void => {
    add(subject, p, object());
    if (tokens[k] === ',') {
      k++;
      objectList(subject, p);
    }
  };
  const skipSemicolons = (): void => {
    if (tokens[k] === ';') {
      k++;
      skipSemicolons();
    }
  };
  const predicateObjectList = (subject: string): void => {
    objectList(subject, iri(next()));
    if (tokens[k] !== ';') return;
    skipSemicolons();
    if (tokens[k] !== '.' && tokens[k] !== ']') predicateObjectList(subject);
  };
  const statements = (): void => {
    if (k >= tokens.length) return;
    const tok = tokens[k] ?? assert.fail('Unexpected end of manifest');
    if (tok === '@prefix' || tok === 'PREFIX') {
      const p = tokens[k + 1] ?? assert.fail('Unexpected end of manifest');
      const nsToken = tokens[k + 2] ?? assert.fail('Unexpected end of manifest');
      MutableHashMap.set(prefixes, p.slice(0, -1), Iri.resolve(nsToken.slice(1, -1), base));
      k += tok === '@prefix' ? 4 : 3;
    } else if (tok === '@base' || tok === 'BASE') {
      k += tok === '@base' ? 3 : 2;
    } else {
      const subject = iri(next());
      if (tokens[k] !== '.') predicateObjectList(subject);
      if (tokens[k] !== '.') assert.fail(`Expected . but found ${tokens[k]}`);
      k++;
    }
    statements();
  };
  statements();
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
  readonly result: Option.Option<string>;
  /** The base IRI to parse with (the assumed test base location). */
  readonly baseIri: string;
}

const values = (
  preds: MutableHashMap.MutableHashMap<string, Array<Value>>,
  p: string,
): ReadonlyArray<Value> => Option.getOrElse(MutableHashMap.get(preds, p), () => []);

/** The value of the first object of `p`, if any. */
const first = (
  preds: MutableHashMap.MutableHashMap<string, Array<Value>>,
  p: string,
): Option.Option<string> => Option.map(Arr.head(values(preds, p)), (v) => v.value);

/** The items of the lists among the objects of `p`. */
const listed = (
  preds: MutableHashMap.MutableHashMap<string, Array<Value>>,
  p: string,
): ReadonlyArray<Value> => values(preds, p).flatMap((v) => (v.kind === 'list' ? v.items : []));

const localPath = (url: string) => url.replace(/^file:\/\//, '');

/** Reads a manifest (following `mf:include`) and returns its test cases. */
export const readManifest = (file: string): Array<TestCase> => {
  const fileUrl = `file://${path.resolve(file)}`;
  const graph = parseManifestGraph(fs.readFileSync(file, 'utf8'), fileUrl);
  const rel = (u: string) => u.slice(fileUrl.lastIndexOf('/') + 1);
  return Arr.fromIterable(MutableHashMap.values(graph)).flatMap((preds) => {
    if (!values(preds, RDF_TYPE).some((t) => t.kind === 'iri' && t.value === `${MF}Manifest`)) {
      return [];
    }
    const assumed = first(preds, `${MF}assumedTestBase`);
    const included = listed(preds, `${MF}include`).flatMap((item) =>
      readManifest(localPath(item.value)),
    );
    const entries = listed(preds, `${MF}entries`).flatMap((entry): Array<TestCase> => {
      const id = entry.value;
      const e = MutableHashMap.get(graph, id);
      if (Option.isNone(e)) return [];
      const type = Option.getOrElse(first(e.value, RDF_TYPE), () => '').replace(RDFT, '');
      const action = Option.getOrElse(first(e.value, `${MF}action`), () => '');
      return [
        {
          id,
          name: Option.getOrElse(first(e.value, `${MF}name`), () => id),
          type,
          action: localPath(action),
          result: Option.map(first(e.value, `${MF}result`), localPath),
          baseIri: Option.match(assumed, {
            onNone: () => action,
            onSome: (a) => Iri.resolve(rel(action), a),
          }),
        },
      ];
    });
    return Arr.appendAll(included, entries);
  });
};

// -----------------------------------------------------------------------------
// Streamed and whole-document parsing
// -----------------------------------------------------------------------------

/** What a parse produced, in a form `toEqual` compares exactly (the base is `''` when unset). */
export type Outcome =
  | {
      readonly _tag: 'Parsed';
      readonly nquads: string;
      readonly prefixes: ReadonlyArray<readonly [string, string]>;
      readonly baseIri: string;
    }
  | { readonly _tag: 'Failed'; readonly error: string };

const outcome = (
  exit: Exit.Exit<Serialization.ParseResult, Serialization.RdfParseError>,
): Outcome =>
  Exit.isSuccess(exit)
    ? {
        _tag: 'Parsed',
        nquads: Dataset.toNQuads(exit.value.dataset),
        prefixes: Array.from(exit.value.prefixes.prefixes),
        baseIri: exit.value.baseIri ?? '',
      }
    : {
        _tag: 'Failed',
        error: Option.match(Cause.findErrorOption(exit.cause), {
          onNone: () => Cause.pretty(exit.cause),
          onSome: (e) => `${e.message} @ ${e.line}:${e.column}`,
        }),
      };

/** A document parsed both ways. */
export interface BothWays {
  readonly streamed: Outcome;
  readonly whole: Outcome;
}

/**
 * Parses `input` both as `RdfXml.parse` does (converting node elements as
 * the XML is read) and by parsing the whole XML document first, which
 * `RdfXml.parse` must agree with exactly.
 */
export const parseBothWays = (input: string, options: RdfXml.ParseOptions): BothWays => ({
  streamed: outcome(Effect.runSyncExit(RdfXml.parse(input, options))),
  whole: outcome(
    Effect.runSyncExit(
      Xml.parse(input).pipe(
        Effect.mapError(
          (e) =>
            new Serialization.RdfParseError({
              format: 'RDF/XML',
              message: e.message,
              line: e.line,
              column: e.column,
            }),
        ),
        Effect.flatMap((doc) => RdfXml.parseDocument(doc, options)),
      ),
    ),
  ),
});
