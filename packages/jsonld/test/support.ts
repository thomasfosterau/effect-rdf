/**
 * Helpers for the W3C JSON-LD conformance tests: a minimal N-Quads reader,
 * JSON-LD object comparison and a file-backed document loader.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as DocumentLoader from '../src/DocumentLoader.ts';
import * as JsonLdError from '../src/JsonLdError.ts';
import type { Json } from '../src/internal/util.ts';

export type { Json };

export const SUITES =
  process.env['RDF_TEST_SUITES'] ?? path.resolve(import.meta.dirname, '../../../.test-suites');

// -----------------------------------------------------------------------------
// JSON text
// -----------------------------------------------------------------------------

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeUnknownSync(JsonText);

/** Parses JSON text (`JSON.parse` semantics); throws on invalid JSON. */
export const parseJsonText = (text: string): Json => decodeJsonText(text);

/** Renders a value as JSON text (`JSON.stringify` semantics). */
export const toJsonText = (value: Json, space?: number): string =>
  Result.getOrElse(
    Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown, { space }))(value),
    () => String(value),
  );

// -----------------------------------------------------------------------------
// N-Quads
// -----------------------------------------------------------------------------

const unescape = (s: string): string =>
  s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_, u, U, c) => {
    if (u !== undefined) return String.fromCodePoint(parseInt(u, 16));
    if (U !== undefined) return String.fromCodePoint(parseInt(U, 16));
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

const TERM =
  /\s*(?:<([^>]*)>|_:([^\s.]+(?:\.[^\s.]+)*)|"((?:[^"\\]|\\.)*)"(?:@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*)|\^\^<([^>]*)>)?)/y;

class BadNQuadsLine extends Schema.TaggedError<BadNQuadsLine>()('BadNQuadsLine', {
  message: Schema.String,
}) {}

export const parseNQuads = (text: string): Array<Term.Quad> => {
  const quads: Array<Term.Quad> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const terms: Array<Term.Term> = [];
    TERM.lastIndex = 0;
    let rest = line;
    for (;;) {
      TERM.lastIndex = 0;
      const m = TERM.exec(rest);
      if (m === null) break;
      rest = rest.slice(m[0].length);
      if (m[1] !== undefined) terms.push(Term.namedNode(unescape(m[1])));
      else if (m[2] !== undefined) terms.push(Term.blankNode(m[2]));
      else {
        const value = unescape(m[3]!);
        if (m[4] !== undefined) terms.push(Term.literal(value, m[4]));
        else if (m[5] !== undefined)
          terms.push(Term.literal(value, Term.namedNode(unescape(m[5]))));
        else terms.push(Term.literal(value));
      }
    }
    if (rest.trim() !== '.') throw new BadNQuadsLine({ message: `Bad N-Quads line: ${line}` });
    const [s, p, o, g] = terms;
    quads.push(
      Term.quad(
        s as Term.Subject,
        p as Term.NamedNode,
        o as Term.Object,
        (g as Term.Graph | undefined) ?? Term.defaultGraph,
      ),
    );
  }
  return quads;
};

// -----------------------------------------------------------------------------
// JSON-LD object comparison
// -----------------------------------------------------------------------------

export const jsonLdEqual = (a: Json, b: Json, key: string | null = null): boolean => {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    if (key === '@list') return a.every((x, i) => jsonLdEqual(x, b[i]));
    const used = Array.from({ length: b.length }, () => false);
    outer: for (const x of a) {
      for (let i = 0; i < b.length; i++) {
        if (!used[i] && jsonLdEqual(x, b[i], key)) {
          used[i] = true;
          continue outer;
        }
      }
      return false;
    }
    return true;
  }
  if (typeof a === 'object' && a !== null) {
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in b)) return false;
      const va = a[k];
      const vb = b[k];
      if (k === '@language' && typeof va === 'string' && typeof vb === 'string') {
        if (va.toLowerCase() !== vb.toLowerCase()) return false;
        continue;
      }
      if (!jsonLdEqual(va, vb, k)) return false;
    }
    return true;
  }
  return false;
};

// -----------------------------------------------------------------------------
// Document loader backed by the test-suite files
// -----------------------------------------------------------------------------

export interface RemoteOptions {
  readonly contentType?: string;
  readonly httpLink?: string | ReadonlyArray<string>;
  readonly redirectTo?: string;
  readonly httpStatus?: number;
}

const contentTypeFor = (file: string): string => {
  if (file.endsWith('.jsonld')) return 'application/ld+json';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.html')) return 'text/html';
  return 'application/octet-stream';
};

export const makeLoader = (
  baseUrl: string,
  dir: string,
  input?: { readonly url: string; readonly options: RemoteOptions },
): DocumentLoader.Loader =>
  DocumentLoader.fromFetch((url) =>
    Effect.suspend(() => {
      const hash = url.indexOf('#');
      const bare = hash === -1 ? url : url.slice(0, hash);
      const fragment = hash === -1 ? '' : url.slice(hash);
      let finalUrl = bare;
      let contentType: string | undefined;
      let link: string | ReadonlyArray<string> | undefined;
      if (input !== undefined && bare === input.url) {
        const o = input.options;
        if (o.redirectTo !== undefined) finalUrl = new URL(o.redirectTo, baseUrl).href;
        contentType = o.contentType;
        link = o.httpLink;
      }
      if (!finalUrl.startsWith(baseUrl)) {
        return Effect.fail(JsonLdError.make('loading document failed', url));
      }
      const file = path.join(dir, finalUrl.slice(baseUrl.length));
      if (!fs.existsSync(file)) {
        return Effect.fail(JsonLdError.make('loading document failed', `${url} (404)`));
      }
      return Effect.succeed({
        url: finalUrl + fragment,
        status: 200,
        contentType: contentType ?? contentTypeFor(file),
        link,
        body: fs.readFileSync(file, 'utf8'),
      });
    }),
  );
