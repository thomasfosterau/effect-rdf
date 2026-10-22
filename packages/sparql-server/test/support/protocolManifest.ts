/**
 * Reads the W3C SPARQL Protocol / Graph Store Protocol test manifests, whose
 * tests are sequences of HTTP requests (`ht:` vocabulary) with expected
 * responses.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Turtle } from '@thomasfosterau/effect-turtle';

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
  readonly expectedBoolean: boolean | undefined;
  readonly expectedFormat: string | undefined;
  readonly expectedLocation: string | undefined;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string | undefined;
}

export interface RequestSpec {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string | undefined;
  readonly response: ExpectedResponse;
}

export interface ProtocolTest {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly approval: string | undefined;
  readonly authority: string;
  readonly requires: ReadonlyArray<string>;
  readonly graphData: ReadonlyArray<{ readonly file: string; readonly name: string }>;
  readonly requests: ReadonlyArray<RequestSpec>;
  /** Whether the test is defined in the manifest but missing from `mf:entries`. */
  readonly unlisted: boolean;
}

const local = (iri: string) => iri.replace(/.*[#/]/, '');
const str = (t: Term.Object | Term.Subject): string => (t._tag === 'Triple' ? '' : t.value);

export const readManifest = (file: string): Array<ProtocolTest> => {
  const base = pathToFileURL(file).href;
  const { dataset } = Effect.runSync(
    Turtle.parse(fs.readFileSync(file, 'utf8'), { baseIri: base }),
  );
  const nn = (iri: string) => Term.namedNode(iri);
  const objects = (s: Term.Term, p: string): Array<Term.Object> =>
    s._tag === 'NamedNode' || s._tag === 'BlankNode'
      ? [...Dataset.objectsOf(dataset, s, nn(p))]
      : [];
  const object = (s: Term.Term, p: string): Term.Object | undefined => objects(s, p)[0];
  const value = (s: Term.Term, p: string): string | undefined =>
    (() => {
      const o = object(s, p);
      return o === undefined ? undefined : str(o);
    })();
  const list = (head: Term.Object | undefined): Array<Term.Object> =>
    head === undefined ? [] : [...Option.getOrElse(Dataset.list(dataset, head), () => [])];
  const headers = (s: Term.Term): Array<readonly [string, string]> =>
    list(object(s, `${HT}headers`)).map(
      (h) => [value(h, `${HT}fieldName`) ?? '', value(h, `${HT}fieldValue`) ?? ''] as const,
    );
  const body = (s: Term.Term): string | undefined => {
    const b = object(s, `${HT}body`);
    return b === undefined ? undefined : value(b, `${CNT}chars`);
  };

  const manifest = Dataset.subjectsOf(dataset, nn(`${RDF}type`), nn(`${MF}Manifest`))[0];
  if (manifest === undefined) return [];
  const out: Array<ProtocolTest> = [];
  for (const include of list(object(manifest, `${MF}include`))) {
    out.push(...readManifest(fileURLToPath(str(include))));
  }
  const listed = list(object(manifest, `${MF}entries`));
  const listedKeys = new Set(listed.map((e) => e.key));
  const unlisted = ['ProtocolTest', 'GraphStoreProtocolTest'].flatMap((type) =>
    Dataset.subjectsOf(dataset, nn(`${RDF}type`), nn(`${MF}${type}`)).filter(
      (s) => !listedKeys.has(s.key),
    ),
  );
  for (const entry of [...listed, ...unlisted]) {
    const action = object(entry, `${MF}action`);
    if (action === undefined) continue;
    const requests = list(object(action, `${HT}requests`)).map((r): RequestSpec => {
      const resp = object(r, `${HT}resp`)!;
      return {
        method: value(r, `${HT}methodName`) ?? 'GET',
        path: value(r, `${HT}absolutePath`) ?? '/',
        headers: headers(r),
        body: body(r),
        response: {
          statuses: objects(resp, `${MF}expectedStatus`).map((t) => local(str(t))),
          expectedBoolean:
            value(resp, `${MF}expectedBoolean`) === undefined
              ? undefined
              : value(resp, `${MF}expectedBoolean`) === 'true',
          expectedFormat: value(resp, `${MF}expectedFormat`),
          expectedLocation: value(resp, `${MF}expectedLocation`),
          headers: headers(resp),
          body: body(resp),
        },
      };
    });
    out.push({
      id: str(entry),
      name: value(entry, `${MF}name`) ?? local(str(entry)),
      type: local(value(entry, `${RDF}type`) ?? ''),
      approval: (() => {
        const a = value(entry, `${DAWGT}approval`) ?? value(entry, `${DAWG}approval`);
        return a === undefined ? undefined : local(a);
      })(),
      authority: value(action, `${HT}connectionAuthority`) ?? 'www.example',
      requires: objects(entry, `${MF}requires`).map((t) => local(str(t))),
      graphData: objects(entry, `${UT}graphData`).map((g) => ({
        file: fileURLToPath(value(g, `${UT}graph`) ?? ''),
        name: value(g, `${RDFS}label`) ?? '',
      })),
      requests,
      unlisted: !listedKeys.has(entry.key),
    });
  }
  return out;
};

const STATUS_CODES = new Map<string, number>([
  ['OK', 200],
  ['Created', 201],
  ['Accepted', 202],
  ['NoContent', 204],
  ['BadRequest', 400],
  ['Forbidden', 403],
  ['NotFound', 404],
  ['MethodNotAllowed', 405],
  ['NotAcceptable', 406],
  ['UnsupportedMediaType', 415],
]);

export const statusMatches = (status: number, expected: ReadonlyArray<string>): boolean =>
  expected.length === 0 ||
  expected.some((e) => {
    const cls = /^StatusCode(\d)xx$/.exec(e);
    if (cls !== null) return Math.floor(status / 100) === Number(cls[1]);
    return STATUS_CODES.get(e) === status;
  });
