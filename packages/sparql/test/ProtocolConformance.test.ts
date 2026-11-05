/**
 * Runs the W3C SPARQL 1.1 Protocol, Graph Store Protocol and Service
 * Description tests against the server in-process: once against
 * `SparqlServer.handler` and once against the `SparqlApi` routes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Predicate from 'effect/Predicate';
import * as Layer from 'effect/Layer';
import type * as Scope from 'effect/Scope';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Option from 'effect/Option';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpMethod from 'effect/http/HttpMethod';
import { Dataset, Isomorphism, Serialization, Term } from '@thomasfosterau/effect-rdf';
import { NTriples } from '@thomasfosterau/effect-ntriples';
import { Results } from '../src/index.ts';
import * as ServerFormats from '../src/ServerFormats.ts';
import * as SparqlServer from '../src/SparqlServer.ts';
import * as Testing from '../src/Testing.ts';
import { withLayer } from './support/layer.ts';
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
  Effect.scoped(
    Effect.map(Layer.build(ServerFormats.layer), (context) =>
      Context.get(context, Serialization.Formats),
    ),
  ),
);

const loadGraphData = (t: ProtocolTest): Dataset.Dataset =>
  Dataset.fromIterable(
    t.graphData.flatMap((g) => {
      const text = fs.readFileSync(g.file, 'utf8');
      const parsed = Effect.runSync(NTriples.parse(text));
      return Array.from(
        parsed.dataset,
        (q) => new Term.Quad(q.subject, q.predicate, q.object, Term.namedNode(g.name)),
      );
    }),
  );

const mediaType = (ct?: string) => ((ct ?? '').split(';')[0] ?? '').trim().toLowerCase();

const parseRdf = (contentType: string | undefined, text: string, baseIri: string) => {
  const parser = Serialization.parserFor(formatsService, mediaType(contentType));
  if (Option.isNone(parser)) return Effect.fail(`No parser for ${contentType}`);
  return Effect.map(parser.value.parse(text, { baseIri }), (r) => r.dataset);
};

const toRequest = (
  spec: RequestSpec,
  authority: string,
  vars: MutableHashMap.MutableHashMap<string, string>,
) => {
  const sub = (s: string) => Array.from(vars).reduce((out, [k, v]) => out.split(k).join(v), s);
  // The protocol tests' methods are HTTP method names.
  assert(HttpMethod.isHttpMethod(spec.method), `Unknown HTTP method ${spec.method}`);
  const request = HttpClientRequest.make(spec.method)(`http://${authority}${sub(spec.path)}`);
  const withBody = Option.match(spec.body, {
    onNone: () => request,
    onSome: (body) =>
      HttpClientRequest.bodyText(request, sub(body)).pipe(
        HttpClientRequest.removeHeader('content-type'),
      ),
  });
  return spec.headers.reduce(
    (r, [name, value]) => HttpClientRequest.setHeader(r, name, value),
    withBody,
  );
};

type MakeClient = Effect.Effect<
  HttpClient.HttpClient,
  never,
  SparqlServer.Requirements | Scope.Scope
>;

const servers: ReadonlyArray<readonly [string, MakeClient]> = [
  ['SparqlServer.handler', Testing.makeClient(SERVER_OPTIONS)],
  ['SparqlApi', Testing.makeApiClient(SERVER_OPTIONS)],
];

const runTest = (t: ProtocolTest, makeClient: MakeClient) =>
  Effect.gen(function* () {
    const client = yield* makeClient;
    const vars = MutableHashMap.empty<string, string>();
    yield* Effect.forEach(
      t.requests.entries(),
      Effect.fnUntraced(function* ([i, spec]) {
        const request = toRequest(spec, t.authority, vars);
        const response = yield* client.execute(request);
        const text = yield* response.text;
        const label = `request ${i + 1}: ${spec.method} ${spec.path} -> ${response.status} ${text.slice(0, 300)}`;
        assert.strictEqual(statusMatches(response.status, spec.response.statuses), true, label);
        const contentType = response.headers['content-type'];
        if (Option.isSome(spec.response.expectedLocation)) {
          const location = response.headers['location'];
          assert.isDefined(location, label);
          MutableHashMap.set(vars, spec.response.expectedLocation.value, location);
        }
        spec.response.headers.forEach(([name, value]) => {
          if (name.toLowerCase() === 'content-type') {
            assert.strictEqual(mediaType(contentType), mediaType(value), label);
          }
        });
        const expectedBoolean = Option.getOrUndefined(spec.response.expectedBoolean);
        if (Option.isSome(spec.response.expectedFormat)) {
          const format = spec.response.expectedFormat.value;
          if (format === 'boolean' || format === 'tabular') {
            const codec = Results.codecFor(contentType ?? '');
            assert.strictEqual(Option.isSome(codec), true, label);
            const parsed = yield* Option.getOrElse(codec, () => assert.fail(label)).parse(text);
            assert.strictEqual(parsed._tag, format === 'boolean' ? 'Boolean' : 'ResultSet', label);
            if (expectedBoolean !== undefined && Predicate.isTagged(parsed, 'Boolean')) {
              assert.strictEqual(parsed.value, expectedBoolean, label);
            }
          } else if (format === 'RDF') {
            yield* parseRdf(contentType, text, request.url);
          }
        } else if (expectedBoolean !== undefined) {
          const parsed = yield* Option.getOrElse(Results.codecFor(contentType ?? ''), () =>
            assert.fail(label),
          ).parse(text);
          assert.strictEqual(
            Predicate.isTagged(parsed, 'Boolean') && parsed.value,
            expectedBoolean,
            label,
          );
        }
        const expectedBody = spec.response.body;
        if (Option.isSome(expectedBody) && spec.method !== 'HEAD') {
          const expectedType =
            spec.response.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ??
            'text/turtle';
          const url = request.url;
          const expected = yield* parseRdf(expectedType, expectedBody.value, url);
          const actual = yield* parseRdf(contentType, text, url);
          assert.isTrue(
            Isomorphism.isomorphic(actual, expected),
            `${label}\nexpected:\n${Dataset.toNQuads(expected)}\nactual:\n${Dataset.toNQuads(actual)}`,
          );
        }
      }),
      { concurrency: 1, discard: true },
    );
  }).pipe(withLayer(SparqlServer.layerMemoryServices(loadGraphData(t))));

const protocolTests = exists ? readManifest(path.join(sparql11, 'protocol', 'manifest.ttl')) : [];
const gspTests = exists
  ? readManifest(path.join(sparql11, 'graph-store-protocol', 'manifest.ttl'))
  : [];

servers.forEach(([server, makeClient]) => {
  describe.skipIf(!exists)(`SPARQL 1.1 Protocol (${server})`, () => {
    protocolTests.forEach((t) => {
      it.effect(`${t.id.replace(/.*#/, '')}: ${t.name}`, () => runTest(t, makeClient));
    });
  });

  describe.skipIf(!exists)(`SPARQL 1.1 Graph Store Protocol (${server})`, () => {
    gspTests.forEach((t) => {
      const unlisted = t.unlisted ? ' (defined but not listed in mf:entries)' : '';
      it.effect(`${t.id.replace(/.*#/, '')}: ${t.name}${unlisted}`, () => runTest(t, makeClient));
    });
  });
});

// -----------------------------------------------------------------------------
// Service description (the manifest has no machine-readable requests)
// -----------------------------------------------------------------------------

const SD = 'http://www.w3.org/ns/sparql-service-description#';
const RDF_TYPE = Term.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

const fetchDescription = (makeClient: MakeClient, accept?: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient;
    const get = HttpClientRequest.get('http://www.example/sparql');
    const request = accept === undefined ? get : HttpClientRequest.setHeader(get, 'accept', accept);
    const response = yield* client.execute(request);
    const text = yield* response.text;
    const dataset = yield* parseRdf(
      response.headers['content-type'],
      text,
      'http://www.example/sparql',
    );
    return { response, dataset };
  }).pipe(withLayer(SparqlServer.layerMemoryServices()));

servers.forEach(([server, makeClient]) => {
  describe.skipIf(!exists)(`SPARQL 1.1 Service Description (${server})`, () => {
    it.effect('returns-rdf: GET on endpoint returns RDF', () =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [undefined, 'text/turtle', 'application/rdf+xml', 'application/ld+json'],
          Effect.fnUntraced(function* (accept) {
            const { response, dataset } = yield* fetchDescription(makeClient, accept);
            expect(response.status).toBe(200);
            expect(dataset.size).toBeGreaterThan(0);
          }),
          { concurrency: 1, discard: true },
        );
      }),
    );

    it.effect(
      'has-endpoint-triple: Service description contains a matching sd:endpoint triple',
      () =>
        Effect.gen(function* () {
          const { dataset } = yield* fetchDescription(makeClient, 'text/turtle');
          const matches = Dataset.match(dataset, {
            predicate: Term.namedNode(`${SD}endpoint`),
            object: Term.namedNode('http://www.example/sparql'),
          });
          expect(matches.length).toBeGreaterThan(0);
        }),
    );

    it.effect('conforms-to-schema: Service description conforms to schema', () =>
      Effect.gen(function* () {
        const { dataset } = yield* fetchDescription(makeClient, 'text/turtle');
        const services = Dataset.subjectsOf(dataset, RDF_TYPE, Term.namedNode(`${SD}Service`));
        expect(services.length).toBeGreaterThan(0);
        services.forEach((s) => {
          // Every service has an endpoint and supported languages from the sd: vocabulary.
          expect(Dataset.objectsOf(dataset, s, Term.namedNode(`${SD}endpoint`)).length).toBe(1);
          const languages = Dataset.objectsOf(dataset, s, Term.namedNode(`${SD}supportedLanguage`));
          expect(languages.length).toBeGreaterThan(0);
          languages.forEach((l) => {
            expect([`${SD}SPARQL10Query`, `${SD}SPARQL11Query`, `${SD}SPARQL11Update`]).toContain(
              Term.isNamedNode(l) ? l.value : '',
            );
          });
          Dataset.objectsOf(dataset, s, Term.namedNode(`${SD}defaultDataset`)).forEach((ds) => {
            // An `sd:defaultDataset` value is a node, so it can be a subject.
            assert(Term.isSubject(ds), 'Expected a node');
            expect(
              Dataset.has(dataset, Term.quad(ds, RDF_TYPE, Term.namedNode(`${SD}Dataset`))),
            ).toBe(true);
          });
        });
      }),
    );
  });
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
