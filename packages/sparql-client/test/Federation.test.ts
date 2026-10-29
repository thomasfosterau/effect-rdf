/**
 * Federated queries: the in-memory engine evaluates `SERVICE` patterns
 * through the client against in-process servers. Includes the W3C
 * `sparql11/service` evaluation tests.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Order from 'effect/Order';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as HttpClient from 'effect/http/HttpClient';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import { Engine, Results, Store } from '@thomasfosterau/effect-sparql';
import { SparqlServer, Testing } from '@thomasfosterau/effect-sparql-server';
import { Manifest, Turtle } from '@thomasfosterau/effect-turtle';
import * as Federation from '../src/Federation.ts';
import * as Formats from '../src/Formats.ts';

const suitesDir =
  process.env.RDF_TEST_SUITES ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.test-suites');
const serviceDir = path.join(suitesDir, 'rdf-tests', 'sparql', 'sparql11', 'service');
const exists = fs.existsSync(serviceDir);

const QT = 'http://www.w3.org/2001/sw/DataAccess/tests/test-query#';
const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';

const readTurtle = (file: string): Dataset.Dataset =>
  Effect.runSync(Turtle.parse(fs.readFileSync(file, 'utf8'), { baseIri: pathToFileURL(file).href }))
    .dataset;

/**
 * An HttpClient routing requests to one in-memory server per endpoint
 * origin. The servers are federated themselves (through the same client), so
 * that remote patterns may contain nested `SERVICE` patterns.
 */
const endpoints = (servers: Readonly<Record<string, Dataset.Dataset>>) =>
  Effect.gen(function* () {
    const apps: Record<string, Parameters<typeof Testing.fromApps>[0][string]> = {};
    const client = Testing.fromApps(apps);
    yield* Effect.forEach(
      Object.entries(servers),
      Effect.fnUntraced(function* ([endpoint, data]) {
        const url = new URL(endpoint);
        const context = yield* Layer.build(
          Layer.mergeAll(
            Federation.layerEngine().pipe(
              Layer.provideMerge(Store.layerMemory(data)),
              Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
            ),
            Formats.layer,
          ),
        );
        apps[url.origin] = Testing.provideServices(
          SparqlServer.handler({ path: url.pathname as `/${string}` }),
          context,
        );
      }),
      { concurrency: 1, discard: true },
    );
    return client;
  });

const federatedEngine = (
  local: Dataset.Dataset,
  servers: Readonly<Record<string, Dataset.Dataset>>,
) =>
  Layer.unwrap(
    Effect.map(endpoints(servers), (client) =>
      Federation.layerEngine().pipe(
        Layer.provide(Store.layerMemory(local)),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      ),
    ),
  );

const sortedKeys = (bindings: ReadonlyArray<{ readonly key: string }>) =>
  Arr.sort(
    bindings.map((b) => b.key),
    Order.String,
  );

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);

describe('Federation', () => {
  it.effect('evaluates SERVICE patterns remotely and joins the results', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      const result = yield* engine.select(`
        SELECT ?person ?name ?age WHERE {
          ?person <http://example.org/age> ?age .
          SERVICE <http://remote.test/sparql> { ?person <http://example.org/name> ?name }
        } ORDER BY ?name`);
      const rows = yield* Stream.runCollect(result.bindings);
      expect(rows.map((b) => (b.map.get('name') as Term.Literal).value)).toEqual(['Alice', 'Bob']);

      const silent = yield* engine.select(
        'SELECT * { ?s ?p ?o SERVICE SILENT <http://down.test/sparql> { ?s ?q ?r } }',
      );
      expect(yield* Stream.runCollect(silent.bindings)).toHaveLength(2);

      const failing = yield* engine.select(
        'SELECT * { SERVICE <http://down.test/sparql> { ?s ?q ?r } }',
      );
      const error = yield* Effect.flip(Stream.runCollect(failing.bindings));
      expect(error._tag).toBe('EvaluationError');
      expect(error.message).toContain('502');
    }).pipe(
      Effect.provide(
        federatedEngine(
          Dataset.make(
            Term.quad(ex('alice'), ex('age'), Term.literal('30')),
            Term.quad(ex('bob'), ex('age'), Term.literal('25')),
          ),
          {
            'http://remote.test/sparql': Dataset.make(
              Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
              Term.quad(ex('bob'), ex('name'), Term.literal('Bob')),
              Term.quad(ex('carol'), ex('name'), Term.literal('Carol')),
            ),
          },
        ),
      ),
    ),
  );

  it.effect('loads remote documents with LOAD', () =>
    Effect.gen(function* () {
      const engine = yield* Engine.SparqlEngine;
      yield* engine.update(
        'LOAD <http://docs.test/rdf-graph-store?default> INTO GRAPH <http://example.org/copy>',
      );
      expect(yield* engine.ask('ASK { GRAPH <http://example.org/copy> { ?s ?p "Remote" } }')).toBe(
        true,
      );
      const error = yield* Effect.flip(
        engine.update('LOAD <http://docs.test/rdf-graph-store?graph=urn:missing>'),
      );
      expect(error._tag).toBe('UpdateError');
      yield* engine.update('LOAD SILENT <http://nowhere.test/doc.ttl>');
    }).pipe(
      Effect.provide(
        federatedEngine(Dataset.empty, {
          'http://docs.test/sparql': Dataset.make(
            Term.quad(ex('r'), ex('label'), Term.literal('Remote')),
          ),
        }),
      ),
    ),
  );

  it('builds the remote query with the prefixes of the original query', () => {
    const query = Federation.serviceQuery({
      _tag: 'Service',
      name: ex('sparql'),
      silent: false,
      input: { _tag: 'Bgp', patterns: [] },
      pattern: {
        _tag: 'Group',
        patterns: [
          {
            _tag: 'Bgp',
            triples: [
              {
                _tag: 'TriplePattern',
                subject: Term.variable('s'),
                predicate: ex('p'),
                object: Term.variable('o'),
              },
            ],
          },
        ],
      },
      prefixes: { ex: 'http://example.org/' },
    });
    expect(query).toContain('PREFIX ex: <http://example.org/>');
    expect(query).toContain('SELECT * WHERE {');
    expect(query).toContain('?s ex:p ?o');
  });
});

// -----------------------------------------------------------------------------
// W3C sparql11/service tests
// -----------------------------------------------------------------------------

interface ServiceTest {
  readonly name: string;
  readonly query: string;
  readonly data: ReadonlyArray<string>;
  readonly serviceData: ReadonlyArray<{
    readonly endpoint: string;
    readonly data: ReadonlyArray<string>;
  }>;
  readonly result: string;
}

const loadTests = (): Array<ServiceTest> => {
  if (!exists) return [];
  const file = path.join(serviceDir, 'manifest.ttl');
  const manifest = Effect.runSync(
    Manifest.parse(fs.readFileSync(file, 'utf8'), pathToFileURL(file).href),
  );
  const ds = manifest.dataset;
  const objects = (s: Term.Term, p: string) =>
    s._tag === 'NamedNode' || s._tag === 'BlankNode'
      ? Dataset.objectsOf(ds, s, Term.namedNode(p))
      : [];
  const iri = (t: Term.Term | undefined) =>
    t !== undefined && t._tag === 'NamedNode' ? t.value : '';
  return manifest.entries.map((entry) => {
    const action = objects(entry.node, `${MF}action`)[0]!;
    return {
      name: entry.name,
      query: fileURLToPath(iri(objects(action, `${QT}query`)[0])),
      data: objects(action, `${QT}data`).map((t) => fileURLToPath(iri(t))),
      serviceData: objects(action, `${QT}serviceData`).map((sd) => ({
        endpoint: iri(objects(sd, `${QT}endpoint`)[0]),
        data: objects(sd, `${QT}data`).map((t) => fileURLToPath(iri(t))),
      })),
      result: fileURLToPath(
        Option.getOrElse(entry.result, () => assert.fail(`${entry.name} has no result`)),
      ),
    };
  });
};

const serviceTests = loadTests();

describe.skipIf(!exists)('W3C SPARQL 1.1 federated query (sparql11/service)', () => {
  serviceTests.forEach((t) => {
    it.effect(t.name, () =>
      Effect.gen(function* () {
        const engine = yield* Engine.SparqlEngine;
        const query = fs.readFileSync(t.query, 'utf8');
        const result = yield* Results.collect(
          yield* engine.select(query, { baseIri: pathToFileURL(t.query).href }),
        );
        const expected = yield* Results.Xml.parse(fs.readFileSync(t.result, 'utf8'));
        assert(expected._tag === 'ResultSet', 'Expected a result set');
        const hasBlankNodes = expected.bindings.some((b) =>
          Array.from(b.map.values()).some((v) => v._tag === 'BlankNode'),
        );
        const toGraph = (
          rows: ReadonlyArray<{ readonly map: ReadonlyMap<string, Term.GroundTerm> }>,
        ) =>
          Dataset.fromIterable(
            rows.flatMap((row, i) =>
              Array.from(row.map, ([k, v]) =>
                Term.quad(
                  Term.namedNode(`urn:row:${i}`),
                  Term.namedNode(`urn:var:${k}`),
                  v as Term.Object,
                ),
              ),
            ),
          );
        // Blank node labels differ between runs, so those results are compared as graphs.
        expect(
          !hasBlankNodes ||
            Isomorphism.isomorphic(toGraph(result.bindings), toGraph(expected.bindings)),
        ).toBe(true);
        expect(hasBlankNodes ? [] : sortedKeys(result.bindings)).toEqual(
          hasBlankNodes ? [] : sortedKeys(expected.bindings),
        );
      }).pipe(
        Effect.provide(
          federatedEngine(
            Dataset.fromIterable(t.data.flatMap((f) => Array.from(readTurtle(f)))),
            Object.fromEntries(
              t.serviceData.map((sd) => [
                sd.endpoint,
                Dataset.fromIterable(sd.data.flatMap((f) => Array.from(readTurtle(f)))),
              ]),
            ),
          ),
        ),
      ),
    );
  });
});
