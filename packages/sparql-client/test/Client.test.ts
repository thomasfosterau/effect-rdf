/**
 * End-to-end tests: the client against the server package, in-process.
 */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import {
  Dataset,
  Isomorphism,
  Namespace,
  Serialization,
  Term,
  Xsd,
} from '@thomasfosterau/effect-rdf';
import { Parser, QueryBuilder as Q, Store, TermSchema } from '@thomasfosterau/effect-sparql';
import { SparqlServer, Testing } from '@thomasfosterau/effect-sparql-server';
import * as Formats from '../src/Formats.ts';
import * as SparqlClient from '../src/SparqlClient.ts';

const ex = Namespace.make('http://example.org/');
const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');

const data = Dataset.make(
  Term.quad(ex('alice'), foaf('name'), Term.literal('Alice')),
  Term.quad(ex('alice'), foaf('age'), Xsd.integer(30)),
  Term.quad(ex('alice'), foaf('mbox'), Term.namedNode('mailto:alice@example.org')),
  Term.quad(ex('bob'), foaf('name'), Term.literal('Bob')),
  Term.quad(ex('bob'), foaf('age'), Xsd.integer(25)),
  Term.quad(ex('carol'), foaf('name'), Term.literal('Carol', 'en'), ex('g1')),
);

const ENDPOINT = 'http://sparql.test/sparql';
const GSP = 'http://sparql.test/rdf-graph-store';

/** A fresh server (in-memory store) and a client talking to it in-process. */
const makeLayer = (
  config: Partial<SparqlClient.Config> = {},
  serverOptions: Parameters<typeof Testing.layerClient>[0] = {},
) =>
  SparqlClient.layer({ endpoint: ENDPOINT, graphStoreEndpoint: GSP, ...config }).pipe(
    Layer.provide(Testing.layerClient(serverOptions)),
    Layer.provideMerge(SparqlServer.layerMemoryServices(data)),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, SparqlClient.SparqlClient | Store.QuadStore>,
  config?: Partial<SparqlClient.Config>,
  serverOptions?: Parameters<typeof Testing.layerClient>[0],
) => Effect.provide(effect, makeLayer(config, serverOptions));

const lexical = (t: Term.GroundTerm | undefined) =>
  t === undefined || t._tag === 'Triple' ? undefined : t.value;

describe('SparqlClient ↔ SparqlServer', () => {
  it.effect('streams SELECT rows for string, AST and builder queries', () =>
    run(
      Effect.gen(function* () {
        const client = yield* SparqlClient.SparqlClient;
        const text = `PREFIX foaf: <http://xmlns.com/foaf/0.1/>
          SELECT ?name WHERE { ?p foaf:name ?name } ORDER BY ?name`;
        const rows = yield* Stream.runCollect(client.select(text));
        expect(rows.map((r) => lexical(r['name']))).toEqual(['Alice', 'Bob']);

        const ast = yield* Parser.parseQuery(text);
        const fromAst = yield* Stream.runCollect(client.select(ast));
        expect(fromAst).toHaveLength(2);

        const v = Q.vars('person', 'name', 'mbox');
        const query = Q.select('person', 'name', Q.maybe('mbox'))
          .where(Q.triple(v.person, foaf('name'), v.name))
          .optional(Q.triple(v.person, foaf('mbox'), v.mbox))
          .orderBy(v.name);
        // Typed rows: `person` and `name` are required, `mbox` is optional.
        const typed: ReadonlyArray<{
          readonly person: Term.GroundTerm;
          readonly name: Term.GroundTerm;
          readonly mbox?: Term.GroundTerm | undefined;
        }> = yield* Stream.runCollect(client.select(query));
        expect(typed.map((r) => lexical(r.name))).toEqual(['Alice', 'Bob']);
        expect(lexical(typed[0]!.mbox)).toBe('mailto:alice@example.org');
        expect(typed[1]!.mbox).toBeUndefined();

        const all = yield* client.selectAll(query);
        expect(all.variables).toEqual(['person', 'name', 'mbox']);
        expect(all.bindings).toHaveLength(2);
      }),
    ),
  );

  it.effect('decodes rows with a Schema', () =>
    run(
      Effect.gen(function* () {
        const v = Q.vars('name', 'age');
        const query = Q.select('name', 'age')
          .where(
            Q.triple(Q.variable('p'), foaf('name'), v.name),
            Q.triple(Q.variable('p'), foaf('age'), v.age),
          )
          .orderBy(v.age);
        const people = yield* Stream.runCollect(
          SparqlClient.decode(
            query,
            Schema.Struct({ name: TermSchema.string, age: TermSchema.number }),
          ),
        );
        expect(people).toEqual([
          { name: 'Bob', age: 25 },
          { name: 'Alice', age: 30 },
        ]);
        const error = yield* Effect.flip(
          Stream.runCollect(SparqlClient.decode(query, Schema.Struct({ name: TermSchema.number }))),
        );
        expect(error._tag).toBe('SchemaError');
      }),
    ),
  );

  [
    'application/sparql-results+json',
    'application/sparql-results+xml',
    'text/tab-separated-values',
    'text/csv',
  ].forEach((accept) => {
    it.effect(`round-trips results as ${accept}`, () =>
      run(
        Effect.gen(function* () {
          const client = yield* SparqlClient.SparqlClient;
          const rows = yield* Stream.runCollect(
            client.select('SELECT ?s ?p ?o WHERE { ?s ?p ?o } ORDER BY ?s ?p ?o'),
          );
          expect(rows).toHaveLength(5);
          // CSV loses term kinds, so only the other formats are compared as graphs.
          const isomorphicRows = () => {
            const expected = Dataset.filter(data, (q) => q.graph._tag === 'DefaultGraph');
            // SAFETY: the query projects `?s ?p ?o` from the default graph, so the row holds a
            // subject, an IRI predicate and an object.
            const quads = rows.map((r) =>
              Term.quad(r['s'] as Term.Subject, r['p'] as Term.NamedNode, r['o'] as Term.Object),
            );
            return Isomorphism.isomorphic(Dataset.fromIterable(quads), expected);
          };
          expect(accept === 'text/csv' || isomorphicRows()).toBe(true);
          expect(yield* client.ask('ASK { ?s ?p "Bob" }')).toBe(true);
          expect(
            yield* client.ask(Q.ask().where(Q.triple(Q.variable('s'), Q.variable('p'), 'Nobody'))),
          ).toBe(false);
        }),
        { resultsAccept: accept },
      ),
    );
  });

  it.effect('streams CONSTRUCT / DESCRIBE results in every format', () =>
    Effect.gen(function* () {
      const formats = Formats.defaults;
      yield* Effect.forEach(
        formats.parsers,
        Effect.fnUntraced(function* (parser) {
          yield* run(
            Effect.gen(function* () {
              const client = yield* SparqlClient.SparqlClient;
              const dataset = yield* client.constructDataset('CONSTRUCT WHERE { ?s ?p ?o }');
              const expected = Dataset.filter(data, (q) => q.graph._tag === 'DefaultGraph');
              assert.isTrue(Isomorphism.isomorphic(dataset, expected), parser.format.name);
              const described = yield* Stream.runCollect(client.describe(Q.describe(ex('alice'))));
              expect(described).toHaveLength(3);
            }).pipe(
              Effect.provideService(Serialization.Formats, {
                parsers: [parser],
                serializers: formats.serializers,
              }),
            ),
          );
        }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect('query() dispatches on the response type', () =>
    run(
      Effect.gen(function* () {
        const client = yield* SparqlClient.SparqlClient;
        const select = yield* client.query('SELECT * { ?s ?p "Bob" }');
        expect(select._tag).toBe('ResultSet');
        const ask = yield* client.query('ASK {}');
        expect(ask).toEqual({ _tag: 'Boolean', value: true });
        const graph = yield* client.query('CONSTRUCT WHERE { ?s ?p "Bob" }');
        expect(graph._tag === 'Graph' && graph.dataset.size).toBe(1);
      }),
    ),
  );

  it.effect('sends dataset parameters with GET, POST and auto', () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        ['get', 'post', 'auto'] as const,
        Effect.fnUntraced(function* (method) {
          yield* run(
            Effect.gen(function* () {
              const client = yield* SparqlClient.SparqlClient;
              const rows = yield* Stream.runCollect(
                client.select('SELECT ?name { ?s ?p ?name }', { defaultGraphs: [ex('g1')] }),
              );
              expect(rows.map((r) => lexical(r['name']))).toEqual(['Carol']);
              const named = yield* Stream.runCollect(
                client.select('SELECT ?g { GRAPH ?g { ?s ?p ?o } }', {
                  namedGraphs: ['http://example.org/g1'],
                }),
              );
              expect(named).toHaveLength(1);
              // A long query is sent with POST in auto mode.
              const long = `SELECT * { ?s ?p ?o FILTER(?o != "${'x'.repeat(3000)}") }`;
              expect(yield* Stream.runCollect(client.select(long))).toHaveLength(5);
            }),
            { method },
          );
        }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect('runs updates with USING parameters', () =>
    run(
      Effect.gen(function* () {
        const client = yield* SparqlClient.SparqlClient;
        yield* client.update(
          'PREFIX foaf: <http://xmlns.com/foaf/0.1/> INSERT DATA { <http://example.org/dave> foaf:name "Dave" }',
        );
        expect(yield* client.ask('ASK { ?s ?p "Dave" }')).toBe(true);
        yield* SparqlClient.update(
          Parser.parseUpdateUnsafe(
            'INSERT { ?s <http://example.org/inG1> true } WHERE { ?s ?p ?o }',
          ),
          { usingGraphs: [ex('g1')] },
        );
        const rows = yield* Stream.runCollect(
          client.select('SELECT ?s { ?s <http://example.org/inG1> true }'),
        );
        expect(rows.map((r) => lexical(r['s']))).toEqual(['http://example.org/carol']);
        // The server's store sees the changes.
        const store = yield* Store.QuadStore;
        expect(yield* Effect.map(Store.toDataset(store), (d) => d.size)).toBe(8);
      }),
    ),
  );

  it.effect('uses the Graph Store Protocol', () =>
    run(
      Effect.gen(function* () {
        const client = yield* SparqlClient.SparqlClient;
        const g = ex('people');
        const triples = [
          Term.quad(ex('x'), foaf('name'), Term.literal('X')),
          Term.quad(Term.blankNode(), foaf('knows'), ex('x')),
        ];
        expect(yield* client.hasGraph(g)).toBe(false);
        yield* client.putGraph(g, triples);
        expect(yield* client.hasGraph(g)).toBe(true);
        const fetched = yield* client.getGraphDataset(g);
        expect(Isomorphism.isomorphic(fetched, Dataset.fromIterable(triples))).toBe(true);
        yield* client.postGraph(g, [Term.quad(ex('y'), foaf('name'), Term.literal('Y'))], {
          mediaType: 'text/turtle',
        });
        expect((yield* client.getGraphDataset(g)).size).toBe(3);
        const fromQuery = yield* Stream.runCollect(
          client.select(
            'SELECT ?n { GRAPH <http://example.org/people> { ?s <http://xmlns.com/foaf/0.1/name> ?n } }',
          ),
        );
        expect(fromQuery).toHaveLength(2);
        yield* client.deleteGraph(g);
        expect(yield* client.hasGraph(g)).toBe(false);
        const missing = yield* Effect.flip(client.getGraphDataset(g));
        expect(missing._tag === 'HttpStatusError' && missing.status).toBe(404);

        const created = yield* client.createGraph(triples, { mediaType: 'application/ld+json' });
        expect(created.value.startsWith(`${GSP}/`)).toBe(true);
        expect((yield* client.getGraphDataset(created)).size).toBe(2);

        const def = yield* client.getGraphDataset('default');
        expect(def.size).toBe(5);
        yield* client.putGraph('default', [], { mediaType: 'application/rdf+xml' });
        expect((yield* client.getGraphDataset('default')).size).toBe(0);
      }),
    ),
  );

  it.effect('reports server errors with their status and body', () =>
    run(
      Effect.gen(function* () {
        const client = yield* SparqlClient.SparqlClient;
        const syntax = yield* Effect.flip(Stream.runCollect(client.select('SELECT * {')));
        expect(syntax._tag).toBe('HttpStatusError');
        assert(syntax._tag === 'HttpStatusError');
        expect(syntax.status).toBe(400);
        expect(syntax.body).toMatch(/line 1/);
        expect(syntax.message).toMatch(/status 400/);
        const update = yield* Effect.flip(client.update('CREATE GRAPH <http://example.org/g1>'));
        expect(update._tag === 'HttpStatusError' && update.status).toBe(400);
      }),
      {},
      { readOnly: false },
    ).pipe(
      Effect.andThen(
        run(
          Effect.gen(function* () {
            const client = yield* SparqlClient.SparqlClient;
            const forbidden = yield* Effect.flip(client.update('CLEAR ALL'));
            expect(forbidden._tag === 'HttpStatusError' && forbidden.status).toBe(403);
            const noGsp = yield* Effect.flip(client.putGraph('default', []));
            expect(noGsp._tag === 'HttpStatusError' && noGsp.status).toBe(405);
          }),
          {},
          { readOnly: true },
        ),
      ),
    ),
  );

  it.effect('fails Graph Store operations without a graph store endpoint', () =>
    Effect.gen(function* () {
      const client = yield* SparqlClient.SparqlClient;
      const error = yield* Effect.flip(client.getGraphDataset('default'));
      expect(error._tag).toBe('ConfigurationError');
    }).pipe(
      Effect.provide(
        SparqlClient.layer({ endpoint: ENDPOINT }).pipe(
          Layer.provide(Testing.layerClient()),
          Layer.provide(SparqlServer.layerMemoryServices(data)),
        ),
      ),
    ),
  );

  it.effect('prints AST updates and builder queries', () =>
    Effect.sync(() => {
      const update = Parser.parseUpdateUnsafe('CLEAR GRAPH <http://example.org/g>');
      expect(SparqlClient.toSparql(update)).toContain('CLEAR GRAPH');
      const q = Q.select('x').where(Q.triple(Q.variable('x'), foaf('name'), 'X'));
      expect(SparqlClient.toSparql(q)).toBe(q.toString());
    }),
  );
});
