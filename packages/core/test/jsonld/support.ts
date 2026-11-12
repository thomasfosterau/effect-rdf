/**
 * Helpers for the W3C JSON-LD conformance tests: a minimal N-Quads reader,
 * JSON-LD object comparison and a file-backed document loader.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Effect from 'effect/Effect';
import * as Match from 'effect/Match';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as DocumentLoader from '../../src/jsonld/DocumentLoader.ts';
import * as JsonLdError from '../../src/jsonld/JsonLdError.ts';
import type { Json } from '../../src/jsonld/internal/util.ts';
import * as Predicate from 'effect/Predicate';
import * as Record from 'effect/Record';

export type { Json };

export const SUITES =
  process.env['RDF_TEST_SUITES'] ?? path.resolve(import.meta.dirname, '../../../../.test-suites');

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

const echar: (c: string) => string = Match.type<string>().pipe(
  Match.when('t', () => '\t'),
  Match.when('n', () => '\n'),
  Match.when('r', () => '\r'),
  Match.when('b', () => '\b'),
  Match.when('f', () => '\f'),
  Match.orElse((c) => c),
);

const unescape = (s: string): string =>
  s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_, u, U, c) => {
    if (u !== undefined) return String.fromCodePoint(parseInt(u, 16));
    if (U !== undefined) return String.fromCodePoint(parseInt(U, 16));
    return echar(c);
  });

const TERM =
  /\s*(?:<([^>]*)>|_:([^\s.]+(?:\.[^\s.]+)*)|"((?:[^"\\]|\\.)*)"(?:@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*)|\^\^<([^>]*)>)?)/gy;

class BadNQuadsLine extends Schema.TaggedError<BadNQuadsLine, { readonly brand: unique symbol }>()(
  'BadNQuadsLine',
  {
    message: Schema.String,
  },
) {}

const termOf = (m: RegExpMatchArray): Term.Term => {
  if (m[1] !== undefined) return Term.namedNode(unescape(m[1]));
  if (m[2] !== undefined) return Term.blankNode(m[2]);
  const value = unescape(m[3] ?? '');
  if (m[4] !== undefined) return Term.literal(value, m[4]);
  if (m[5] !== undefined) return Term.literal(value, Term.namedNode(unescape(m[5])));
  return Term.literal(value);
};

export const parseNQuads = (text: string): Array<Term.Quad> =>
  text.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return [];
    // `TERM` is sticky and global: its matches are the terms that follow one another from the
    // start of the line.
    const matches = Array.from(line.matchAll(TERM));
    const rest = line.slice(matches.reduce((n, m) => n + m[0].length, 0));
    const bad = new BadNQuadsLine({ message: `Bad N-Quads line: ${line}` });
    if (rest.trim() !== '.') throw bad;
    const [s, p, o, g] = matches.map(termOf);
    if (
      !Term.isSubject(s) ||
      !Term.isNamedNode(p) ||
      !Term.isObject(o) ||
      (g !== undefined && !Term.isGraph(g))
    ) {
      throw bad;
    }
    return [Term.quad(s, p, o, g ?? Term.defaultGraph)];
  });

// -----------------------------------------------------------------------------
// JSON-LD object comparison
// -----------------------------------------------------------------------------

export const jsonLdEqual = (a: Json, b: Json, key?: string): boolean => {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    if (key === '@list') return a.every((x, i) => jsonLdEqual(x, b[i]));
    // Each item of `a` matches the first item of `b` not matched yet.
    const used = Array.from({ length: b.length }, () => false);
    return a.every((x) => {
      const i = b.findIndex((y, j) => !used[j] && jsonLdEqual(x, y, key));
      if (i === -1) return false;
      used[i] = true;
      return true;
    });
  }
  if (Predicate.isObject(a)) {
    if (!Predicate.isObject(b)) return false;
    const ka = Record.keys(a);
    if (ka.length !== Record.keys(b).length) return false;
    return ka.every((k) => {
      if (!(k in b)) return false;
      const va = a[k];
      const vb = b[k];
      if (k === '@language' && Predicate.isString(va) && Predicate.isString(vb)) {
        return va.toLowerCase() === vb.toLowerCase();
      }
      return jsonLdEqual(va, vb, k);
    });
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
      // The test's own input is served with the test's HTTP options.
      const o: RemoteOptions = input !== undefined && bare === input.url ? input.options : {};
      const finalUrl = o.redirectTo !== undefined ? new URL(o.redirectTo, baseUrl).href : bare;
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
        contentType: o.contentType ?? contentTypeFor(file),
        link: o.httpLink,
        body: fs.readFileSync(file, 'utf8'),
      });
    }),
  );
