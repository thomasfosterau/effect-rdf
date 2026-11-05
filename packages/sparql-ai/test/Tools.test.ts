import { describe, expect, it, layer } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Order from 'effect/Order';
import * as Stream from 'effect/Stream';
import { McpProtocol, McpTest, type Tool } from 'effect/ai';
import * as Dataset from '@thomasfosterau/effect-rdf/Dataset';
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Engine from '@thomasfosterau/effect-sparql/Engine';
import * as Store from '@thomasfosterau/effect-sparql/Store';
import { Mcp, Tools } from '../src/index.ts';

const EX = 'http://example.org/';
const RDF_TYPE = Term.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const LABEL = Term.namedNode('http://www.w3.org/2000/01/rdf-schema#label');
const ex = (local: string) => Term.namedNode(`${EX}${local}`);

const data = Dataset.make(
  Term.quad(ex('alice'), RDF_TYPE, ex('Person')),
  Term.quad(ex('bob'), RDF_TYPE, ex('Person')),
  Term.quad(ex('acme'), RDF_TYPE, ex('Company')),
  Term.quad(ex('alice'), LABEL, Term.literal('Alice Liddell', 'en')),
  Term.quad(ex('bob'), LABEL, Term.literal('Bob')),
  Term.quad(ex('alice'), ex('knows'), ex('bob')),
  Term.quad(ex('alice'), ex('worksFor'), ex('acme')),
);

// The engine over the data, and the handlers of a toolkit with small limits.
const engine = Layer.effect(
  Engine.SparqlEngine,
  Effect.map(Store.makeMemory(data), (store) => Engine.make(store)),
);
const readOnly = Tools.layer({ maxRows: 2 }).pipe(Layer.provideMerge(engine));
const withUpdate = Tools.layerWithUpdate().pipe(Layer.provideMerge(engine));

// Calls a tool and returns its decoded result (a success or the `SparqlToolError` the model sees).
type AllTools = (typeof Tools.toolkitWithUpdate)['tools'];
type ReadOnlyTools = (typeof Tools.toolkit)['tools'];

const call = <Name extends keyof AllTools>(
  name: Name,
  params: Tool.ParametersEncoded<AllTools[Name]>,
) =>
  Effect.gen(function* () {
    const handlers = yield* Tools.toolkitWithUpdate;
    const stream = yield* handlers.handle(name, params);
    const results = yield* Stream.runCollect(stream);
    const last = results[results.length - 1];
    return { failed: last?.isFailure ?? true, value: last?.result };
  });

const callReadOnly = <Name extends keyof ReadOnlyTools>(
  name: Name,
  params: Tool.ParametersEncoded<ReadOnlyTools[Name]>,
) =>
  Effect.gen(function* () {
    const handlers = yield* Tools.toolkit;
    const stream = yield* handlers.handle(name, params);
    const results = yield* Stream.runCollect(stream);
    const last = results[results.length - 1];
    return { failed: last?.isFailure ?? true, value: last?.result };
  });

layer(readOnly)('read-only tools', (test) => {
  test.effect('sparql_query returns SPARQL JSON results, truncated to the row limit', () =>
    Effect.gen(function* () {
      const result = yield* callReadOnly('sparql_query', {
        query: `SELECT ?s WHERE { ?s a <${EX}Person> } ORDER BY ?s`,
      });
      expect(result.failed).toBe(false);
      expect(result.value).toMatchObject({
        type: 'select',
        results: {
          head: { vars: ['s'] },
          results: {
            bindings: [
              { s: { type: 'uri', value: `${EX}alice` } },
              { s: { type: 'uri', value: `${EX}bob` } },
            ],
          },
        },
        isTruncated: false,
      });
      const all = yield* callReadOnly('sparql_query', { query: 'SELECT * WHERE { ?s ?p ?o }' });
      expect(all.failed).toBe(false);
      expect(all.value).toMatchObject({ type: 'select', isTruncated: true });
    }),
  );

  test.effect('sparql_query answers ASK and returns graphs as Turtle', () =>
    Effect.gen(function* () {
      const ask = yield* callReadOnly('sparql_query', {
        query: `ASK { <${EX}alice> <${EX}knows> ?x }`,
      });
      expect(ask.failed).toBe(false);
      expect(ask.value).toEqual({ type: 'ask', isTrue: true });
      const graph = yield* callReadOnly('sparql_query', {
        query: `CONSTRUCT { ?s <${EX}knows> ?o } WHERE { ?s <${EX}knows> ?o }`,
      });
      expect(graph.failed).toBe(false);
      expect(graph.value).toMatchObject({ type: 'graph', isTruncated: false });
      expect(graph.value).toMatchObject({ turtle: expect.stringContaining(`${EX}bob`) });
    }),
  );

  test.effect('refuses updates, SERVICE and syntax errors with a SparqlToolError', () =>
    Effect.gen(function* () {
      const update = yield* callReadOnly('sparql_query', {
        query: `INSERT DATA { <${EX}x> <${EX}p> 1 }`,
      });
      expect(update.failed).toBe(true);
      expect(update.value).toMatchObject({ _tag: 'SparqlToolError' });
      const service = yield* callReadOnly('sparql_query', {
        query: 'SELECT * WHERE { SERVICE <http://other.example/sparql> { ?s ?p ?o } }',
      });
      expect(service.failed).toBe(true);
      expect(service.value).toMatchObject({ message: expect.stringContaining('SERVICE') });
    }),
  );

  test.effect('describe_resource, list_classes, list_properties and search_labels', () =>
    Effect.gen(function* () {
      const described = yield* callReadOnly('describe_resource', { iri: `${EX}alice`, limit: 10 });
      expect(described.failed).toBe(false);
      // Alice has four triples; the server caps every result at `maxRows` (2).
      expect(described.value).toMatchObject({ isTruncated: true });
      expect(described.value).toMatchObject({ turtle: expect.stringContaining(`${EX}knows`) });
      // Invalid parameters come back to the model as a failure, like a tool error.
      const invalid = yield* callReadOnly('describe_resource', { iri: 'not an iri' });
      expect(invalid.failed).toBe(true);
      expect(invalid.value).toMatchObject({ _tag: 'AiError' });
      const classes = yield* callReadOnly('list_classes', {});
      expect(classes.failed).toBe(false);
      expect(classes.value).toEqual([
        { iri: `${EX}Person`, count: 2 },
        { iri: `${EX}Company`, count: 1 },
      ]);
      const properties = yield* callReadOnly('list_properties', { limit: 1 });
      expect(properties.failed).toBe(false);
      expect(properties.value).toEqual([
        { iri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', count: 3 },
      ]);
      const found = yield* callReadOnly('search_labels', { text: 'liddell' });
      expect(found.failed).toBe(false);
      expect(found.value).toEqual([{ iri: `${EX}alice`, label: 'Alice Liddell' }]);
      const quoted = yield* callReadOnly('search_labels', { text: '" } SELECT' });
      expect(quoted.failed).toBe(false);
      expect(quoted.value).toEqual([]);
    }),
  );
});

layer(withUpdate)('sparql_update', (test) => {
  test.effect('runs updates only in toolkitWithUpdate', () =>
    Effect.gen(function* () {
      const done = yield* call('sparql_update', {
        update: `INSERT DATA { <${EX}carol> a <${EX}Person> }`,
      });
      expect(done.failed).toBe(false);
      expect(done.value).toEqual({ isApplied: true });
      const count = yield* call('sparql_query', {
        query: `SELECT ?s WHERE { ?s a <${EX}Person> }`,
      });
      expect(count.failed).toBe(false);
      expect(count.value).toMatchObject({
        results: {
          results: {
            bindings: expect.arrayContaining([{ s: { type: 'uri', value: `${EX}carol` } }]),
          },
        },
      });
      expect('sparql_update' in Tools.toolkit.tools).toBe(false);
    }),
  );
});

describe('Mcp', () => {
  it.effect('serves the read-only tools to an MCP client', () =>
    Effect.gen(function* () {
      const client = yield* McpTest.makeClient(Mcp.layer().pipe(Layer.provide(engine)), {
        protocols: [McpProtocol.v2025_11_25],
      });
      const tools = yield* client.listTools();
      expect(
        Arr.sort(
          tools.tools.map((t) => t.name),
          Order.String,
        ),
      ).toEqual([
        'describe_resource',
        'list_classes',
        'list_properties',
        'search_labels',
        'sparql_query',
      ]);
      const result = yield* client.callTool({ name: 'search_labels', arguments: { text: 'bob' } });
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining(`${EX}bob`) }),
      ]);
    }).pipe(Effect.scoped),
  );
});
