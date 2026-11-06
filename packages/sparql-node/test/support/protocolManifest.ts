/**
 * Reads the W3C SPARQL Protocol / Graph Store Protocol test manifests, whose
 * tests are sequences of HTTP requests (`ht:` vocabulary) with expected
 * responses.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as HashSet from 'effect/HashSet';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Turtle } from '@thomasfosterau/effect-rdf/turtle';

export const suitesDir =
  process.env.RDF_TEST_SUITES ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.test-suites');

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const HT = 'http://www.w3.org/2011/http#';
const CNT = 'http://www.w3.org/2011/content#';
const UT = 'http://www.w3.org/2009/sparql/tests/test-update#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const DAWGT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#';
const DAWG = 'http://www.w3.org/2001/sw/DataAccess/tests/test-dawg#';

export interface ExpectedResponse {
  /** Local names of `hts:` status resources, e.g. `StatusCode2xx`, `Created`. */
  readonly statuses: ReadonlyArray<string>;
  readonly expectedBoolean: Option.Option<boolean>;
  readonly expectedFormat: Option.Option<string>;
  readonly expectedLocation: Option.Option<string>;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Option.Option<string>;
}

export interface RequestSpec {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Option.Option<string>;
  readonly response: ExpectedResponse;
}

export interface ProtocolTest {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly approval: Option.Option<string>;
  readonly authority: string;
  readonly requires: ReadonlyArray<string>;
  readonly graphData: ReadonlyArray<{ readonly file: string; readonly name: string }>;
  readonly requests: ReadonlyArray<RequestSpec>;
  /** Whether the test is defined in the manifest but missing from `mf:entries`. */
  readonly unlisted: boolean;
}

const local = (iri: string) => iri.replace(/.*[#/]/, '');
const str = (t: Term.Object | Term.Subject): string => (Term.isTriple(t) ? '' : t.value);

const nn = (iri: string) => Term.namedNode(iri);

export const readManifest = (file: string): Array<ProtocolTest> => {
  const base = pathToFileURL(file).href;
  const { dataset } = Effect.runSync(
    Turtle.parse(fs.readFileSync(file, 'utf8'), { baseIri: base }),
  );
  const objects = (s: Term.Term, p: string): Array<Term.Object> =>
    Term.isNamedNode(s) || Term.isBlankNode(s) ? [...Dataset.objectsOf(dataset, s, nn(p))] : [];
  const object = (s: Term.Term, p: string): Option.Option<Term.Object> => Arr.head(objects(s, p));
  const value = (s: Term.Term, p: string): Option.Option<string> => Option.map(object(s, p), str);
  const valueOr = (s: Term.Term, p: string, fallback: string): string =>
    Option.getOrElse(value(s, p), () => fallback);
  const list = (head: Option.Option<Term.Object>): Array<Term.Object> =>
    Arr.fromOption(head).flatMap((h) =>
      Arr.fromIterable(Option.getOrElse(Dataset.list(dataset, h), () => [])),
    );
  const headers = (s: Term.Term): Array<readonly [string, string]> =>
    list(object(s, `${HT}headers`)).map(
      (h) => [valueOr(h, `${HT}fieldName`, ''), valueOr(h, `${HT}fieldValue`, '')] as const,
    );
  const body = (s: Term.Term): Option.Option<string> =>
    Option.flatMap(object(s, `${HT}body`), (b) => value(b, `${CNT}chars`));

  const found = Arr.head(Dataset.subjectsOf(dataset, nn(`${RDF}type`), nn(`${MF}Manifest`)));
  if (Option.isNone(found)) return [];
  const manifest = found.value;
  const included = list(object(manifest, `${MF}include`)).flatMap((include) =>
    readManifest(fileURLToPath(str(include))),
  );
  const listed = list(object(manifest, `${MF}entries`));
  const listedKeys = HashSet.fromIterable(listed.map((e) => e.key));
  const unlisted = ['ProtocolTest', 'GraphStoreProtocolTest'].flatMap((type) =>
    Dataset.subjectsOf(dataset, nn(`${RDF}type`), nn(`${MF}${type}`)).filter(
      (s) => !HashSet.has(listedKeys, s.key),
    ),
  );
  const tests = [...listed, ...unlisted].flatMap((entry): Array<ProtocolTest> => {
    const maybeAction = object(entry, `${MF}action`);
    if (Option.isNone(maybeAction)) return [];
    const action = maybeAction.value;
    const requests = list(object(action, `${HT}requests`)).map((r): RequestSpec => {
      const resp = Option.getOrElse(object(r, `${HT}resp`), () =>
        assert.fail(`${r.key} has no ht:resp`),
      );
      return {
        method: valueOr(r, `${HT}methodName`, 'GET'),
        path: valueOr(r, `${HT}absolutePath`, '/'),
        headers: headers(r),
        body: body(r),
        response: {
          statuses: objects(resp, `${MF}expectedStatus`).map((t) => local(str(t))),
          expectedBoolean: Option.map(value(resp, `${MF}expectedBoolean`), (b) => b === 'true'),
          expectedFormat: value(resp, `${MF}expectedFormat`),
          expectedLocation: value(resp, `${MF}expectedLocation`),
          headers: headers(resp),
          body: body(resp),
        },
      };
    });
    return [
      {
        id: str(entry),
        name: valueOr(entry, `${MF}name`, local(str(entry))),
        type: local(valueOr(entry, `${RDF}type`, '')),
        approval: Option.map(
          Option.orElse(value(entry, `${DAWGT}approval`), () => value(entry, `${DAWG}approval`)),
          local,
        ),
        authority: valueOr(action, `${HT}connectionAuthority`, 'www.example'),
        requires: objects(entry, `${MF}requires`).map((t) => local(str(t))),
        graphData: objects(entry, `${UT}graphData`).map((g) => ({
          file: fileURLToPath(valueOr(g, `${UT}graph`, '')),
          name: valueOr(g, `${RDFS}label`, ''),
        })),
        requests,
        unlisted: !HashSet.has(listedKeys, entry.key),
      },
    ];
  });
  return [...included, ...tests];
};

const STATUS_CODES: Readonly<Record<string, number>> = {
  OK: 200,
  Created: 201,
  Accepted: 202,
  NoContent: 204,
  BadRequest: 400,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  UnsupportedMediaType: 415,
};

export const statusMatches = (status: number, expected: ReadonlyArray<string>): boolean =>
  Arr.isReadonlyArrayEmpty(expected) ||
  expected.some((e) => {
    const cls = /^StatusCode(\d)xx$/.exec(e);
    if (cls !== null) return Math.floor(status / 100) === Number(cls[1]);
    return Option.contains(Record.get(STATUS_CODES, e), status);
  });
