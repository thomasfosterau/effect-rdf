/**
 * Runs the W3C SPARQL 1.1 Protocol, Graph Store Protocol and Service
 * Description tests against the server in-process.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import { Dataset, Isomorphism, Serialization, Term } from '@thomasfosterau/effect-rdf';
import { NTriples } from '@thomasfosterau/effect-ntriples';
import { Results } from '@thomasfosterau/effect-sparql';
import * as Formats from '../src/Formats.ts';
import * as SparqlServer from '../src/SparqlServer.ts';
import * as Testing from '../src/Testing.ts';
import {
  type ProtocolTest,
  readManifest,
  type RequestSpec,
  statusMatches,
  suitesDir,
} from './support/protocolManifest.ts';

const sparql11 = path.join(suitesDir, 'rdf-tests', 'sparql', 'sparql11');
const exists = fs.existsSync(sparql11);

const SERVER_OPTIONS = { path: '/sparql', graphStorePath: '/gsp' } as const;

const formatsService = Effect.runSync(
  Effect.provide(Effect.service(Serialization.Formats), Formats.layer),
);

const loadGraphData = (t: ProtocolTest): Dataset.Dataset => {
  const quads: Array<Term.Quad> = [];
  for (const g of t.graphData) {
    const text = fs.readFileSync(g.file, 'utf8');
    const parsed = Effect.runSync(NTriples.parse(text));
    for (const q of parsed.dataset) {
      quads.push(new Term.Quad(q.subject, q.predicate, q.object, Term.namedNode(g.name)));
    }
  }
  return Dataset.fromIterable(quads);
};

const mediaType = (ct: string | undefined) => (ct ?? '').split(';')[0]!.trim().toLowerCase();

const parseRdf = (contentType: string | undefined, text: string, baseIri: string) => {
  const parser = Serialization.parserFor(formatsService, mediaType(contentType));
  if (Option.isNone(parser)) return Effect.fail(`No parser for ${contentType}`);
  return Effect.map(parser.value.parse(text, { baseIri }), (r) => r.dataset);
};

const toRequest = (spec: RequestSpec, authority: string, vars: Map<string, string>) => {
  const sub = (s: string) => {
    let out = s;
    for (const [k, v] of vars) out = out.split(k).join(v);
    return out;
  };
  // SAFETY: the protocol tests' methods are valid HTTP method names; `HttpClientRequest.make` only
  // needs the literal type.
  let request = HttpClientRequest.make(spec.method as 'GET')(
    `http://${authority}${sub(spec.path)}`,
  );
  if (spec.body !== undefined) {
    request = HttpClientRequest.bodyText(request, sub(spec.body)).pipe(
      HttpClientRequest.removeHeader('content-type'),
    );
  }
  for (const [name, value] of spec.headers) {
    request = HttpClientRequest.setHeader(request, name, value);
  }
  return request;
};

const runTest = (t: ProtocolTest) =>
  Effect.gen(function* () {
    const client = yield* Testing.makeClient(SERVER_OPTIONS);
    const vars = new Map<string, string>();
    yield* Effect.forEach(
      t.requests.entries(),
      Effect.fnUntraced(function* ([i, spec]) {
        const request = toRequest(spec, t.authority, vars);
        const response = yield* client.execute(request);
        const text = yield* response.text;
        const label = `request ${i + 1}: ${spec.method} ${spec.path} -> ${response.status} ${text.slice(0, 300)}`;
        assert.strictEqual(statusMatches(response.status, spec.response.statuses), true, label);
        const contentType = response.headers['content-type'];
        if (spec.response.expectedLocation !== undefined) {
          const location = response.headers['location'];
          assert.isDefined(location, label);
          vars.set(spec.response.expectedLocation, location!);
        }
        for (const [name, value] of spec.response.headers) {
          if (name.toLowerCase() === 'content-type') {
            assert.strictEqual(mediaType(contentType), mediaType(value), label);
          }
        }
        if (spec.response.expectedFormat !== undefined) {
          const format = spec.response.expectedFormat;
          if (format === 'boolean' || format === 'tabular') {
            const codec = Results.codecFor(contentType ?? '');
            assert.strictEqual(Option.isSome(codec), true, label);
            const parsed = yield* Option.getOrElse(codec, () => assert.fail(label)).parse(text);
            assert.strictEqual(parsed._tag, format === 'boolean' ? 'Boolean' : 'ResultSet', label);
            if (spec.response.expectedBoolean !== undefined && parsed._tag === 'Boolean') {
              assert.strictEqual(parsed.value, spec.response.expectedBoolean, label);
            }
          } else if (format === 'RDF') {
            yield* parseRdf(contentType, text, request.url);
          }
        } else if (spec.response.expectedBoolean !== undefined) {
          const parsed = yield* Option.getOrElse(Results.codecFor(contentType ?? ''), () =>
            assert.fail(label),
          ).parse(text);
          assert.strictEqual(
            parsed._tag === 'Boolean' && parsed.value,
            spec.response.expectedBoolean,
            label,
          );
        }
        if (spec.response.body !== undefined && spec.method !== 'HEAD') {
          const expectedType =
            spec.response.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ??
            'text/turtle';
          const url = request.url;
          const expected = yield* parseRdf(expectedType, spec.response.body, url);
          const actual = yield* parseRdf(contentType, text, url);
          assert.isTrue(
            Isomorphism.isomorphic(actual, expected),
            `${label}\nexpected:\n${Dataset.toNQuads(expected)}\nactual:\n${Dataset.toNQuads(actual)}`,
          );
        }
      }),
      { concurrency: 1, discard: true },
    );
  }).pipe(Effect.provide(SparqlServer.layerMemoryServices(loadGraphData(t))));

const protocolTests = exists ? readManifest(path.join(sparql11, 'protocol', 'manifest.ttl')) : [];
const gspTests = exists
  ? readManifest(path.join(sparql11, 'graph-store-protocol', 'manifest.ttl'))
  : [];

describe.skipIf(!exists)('SPARQL 1.1 Protocol', () => {
  protocolTests.forEach((t) => {
    it.effect(`${t.id.replace(/.*#/, '')}: ${t.name}`, () => runTest(t));
  });
});

describe.skipIf(!exists)('SPARQL 1.1 Graph Store Protocol', () => {
  gspTests.forEach((t) => {
    const unlisted = t.unlisted ? ' (defined but not listed in mf:entries)' : '';
    it.effect(`${t.id.replace(/.*#/, '')}: ${t.name}${unlisted}`, () => runTest(t));
  });
});

// -----------------------------------------------------------------------------
// Service description (the manifest has no machine-readable requests)
// -----------------------------------------------------------------------------

const SD = 'http://www.w3.org/ns/sparql-service-description#';
const RDF_TYPE = Term.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

const fetchDescription = (accept: string | undefined) =>
  Effect.gen(function* () {
    const client = yield* Testing.makeClient(SERVER_OPTIONS);
    let request = HttpClientRequest.get('http://www.example/sparql');
    if (accept !== undefined) request = HttpClientRequest.setHeader(request, 'accept', accept);
    const response = yield* client.execute(request);
    const text = yield* response.text;
    const dataset = yield* parseRdf(
      response.headers['content-type'],
      text,
      'http://www.example/sparql',
    );
    return { response, dataset };
  }).pipe(Effect.provide(SparqlServer.layerMemoryServices()));

describe.skipIf(!exists)('SPARQL 1.1 Service Description', () => {
  it.effect('returns-rdf: GET on endpoint returns RDF', () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [undefined, 'text/turtle', 'application/rdf+xml', 'application/ld+json'],
        Effect.fnUntraced(function* (accept) {
          const { response, dataset } = yield* fetchDescription(accept);
          expect(response.status).toBe(200);
          expect(dataset.size).toBeGreaterThan(0);
        }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect('has-endpoint-triple: Service description contains a matching sd:endpoint triple', () =>
    Effect.gen(function* () {
      const { dataset } = yield* fetchDescription('text/turtle');
      const matches = Dataset.match(dataset, {
        predicate: Term.namedNode(`${SD}endpoint`),
        object: Term.namedNode('http://www.example/sparql'),
      });
      expect(matches.length).toBeGreaterThan(0);
    }),
  );

  it.effect('conforms-to-schema: Service description conforms to schema', () =>
    Effect.gen(function* () {
      const { dataset } = yield* fetchDescription('text/turtle');
      const services = Dataset.subjectsOf(dataset, RDF_TYPE, Term.namedNode(`${SD}Service`));
      expect(services.length).toBeGreaterThan(0);
      for (const s of services) {
        // Every service has an endpoint and supported languages from the sd: vocabulary.
        expect(Dataset.objectsOf(dataset, s, Term.namedNode(`${SD}endpoint`)).length).toBe(1);
        const languages = Dataset.objectsOf(dataset, s, Term.namedNode(`${SD}supportedLanguage`));
        expect(languages.length).toBeGreaterThan(0);
        for (const l of languages) {
          expect([`${SD}SPARQL10Query`, `${SD}SPARQL11Query`, `${SD}SPARQL11Update`]).toContain(
            l._tag === 'NamedNode' ? l.value : '',
          );
        }
        for (const ds of Dataset.objectsOf(dataset, s, Term.namedNode(`${SD}defaultDataset`))) {
          // SAFETY: an `sd:defaultDataset` value is a node, so it can be a subject.
          expect(
            Dataset.has(
              dataset,
              Term.quad(ds as Term.Subject, RDF_TYPE, Term.namedNode(`${SD}Dataset`)),
            ),
          ).toBe(true);
        }
      }
    }),
  );
});

/**
 * `sparql11/http-rdf-update` is not run: its tests are deprecated
 * (`dawg:Deprecated`, superseded by `graph-store-protocol`), describe their
 * requests only in prose comments, and depend on state the suite never sets
 * up (e.g. deleting `person/2.ttl`, which no earlier test creates).
 */
export const skippedSuites = {
  'sparql11/http-rdf-update': 'Deprecated in favour of sparql11/graph-store-protocol',
};
