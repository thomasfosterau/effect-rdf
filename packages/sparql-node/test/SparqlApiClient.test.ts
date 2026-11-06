/**
 * The client derived from the `SparqlApi` definition, against the server
 * package in-process: both the `SparqlApi` routes and `SparqlServer.handler`.
 */
import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import type * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import * as HttpClient from 'effect/http/HttpClient';
import { Dataset, Isomorphism, Term } from '@thomasfosterau/effect-rdf';
import { Bindings, SparqlServer, Testing } from '@thomasfosterau/effect-rdf/sparql';
import * as SparqlApiBuilder from '../src/SparqlApiBuilder.ts';
import * as SparqlApiClient from '../src/SparqlApiClient.ts';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);
const data = Dataset.make(
  Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
  Term.quad(ex('bob'), ex('name'), Term.literal('Bob')),
  Term.quad(ex('carol'), ex('name'), Term.literal('Carol'), ex('g1')),
);

const NAMES = 'SELECT ?name WHERE { ?s <http://example.org/name> ?name } ORDER BY ?name';

const servers: ReadonlyArray<
  readonly [
    string,
    Effect.Effect<HttpClient.HttpClient, never, SparqlServer.Requirements | Scope.Scope>,
  ]
> = [
  ['SparqlApi routes', SparqlApiBuilder.makeTestClient()],
  ['SparqlServer.handler', Testing.makeClient()],
];

const names = (events: ReadonlyArray<{ readonly _tag: string }>) =>
  events.flatMap((event) =>
    'bindings' in event && Bindings.isBindings(event.bindings)
      ? Option.match(Bindings.get(event.bindings, 'name'), {
          onNone: () => [],
          onSome: (term) => (Term.isLiteral(term) ? [term.value] : []),
        })
      : [],
  );

servers.forEach(([server, makeHttpClient]) => {
  const withClient = <A, E>(f: (client: SparqlApiClient.Client) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(SparqlServer.layerMemoryServices(data));
      const http = yield* Effect.provideContext(makeHttpClient, services);
      const context = yield* Layer.build(
        SparqlApiClient.layer({ baseUrl: 'http://sparql.test' }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      );
      const client = yield* Effect.provideContext(SparqlApiClient.SparqlApiClient, context);
      return yield* f(client);
    }).pipe(Effect.scoped);

  describe(`SparqlApiClient (${server})`, () => {
    it.effect('streams SELECT results over GET and POST', () =>
      withClient((client) =>
        Effect.gen(function* () {
          const viaGet = yield* Stream.runCollect(SparqlApiClient.results(client, NAMES));
          expect(viaGet[0]).toEqual({ _tag: 'Variables', variables: ['name'] });
          expect(names(viaGet)).toEqual(['Alice', 'Bob']);
          const viaPost = yield* Stream.runCollect(
            SparqlApiClient.results(client, NAMES, { method: 'post', accept: 'text/csv' }),
          );
          expect(names(viaPost)).toEqual(['Alice', 'Bob']);
          const named = yield* Stream.runCollect(
            SparqlApiClient.results(client, NAMES, {
              defaultGraphs: ['http://example.org/g1'],
            }),
          );
          expect(names(named)).toEqual(['Carol']);
          const ask = yield* Stream.runCollect(SparqlApiClient.results(client, 'ASK {}'));
          expect(ask.at(-1)).toEqual({ _tag: 'Boolean', value: true });
        }),
      ),
    );

    it.effect('returns raw bodies with their media type', () =>
      withClient((client) =>
        Effect.gen(function* () {
          const body = yield* SparqlApiClient.query(client, NAMES, {
            accept: 'application/sparql-results+xml',
          });
          expect(body.mediaType).toBe('application/sparql-results+xml');
          const text = yield* Stream.mkString(Stream.decodeText(body.bytes));
          expect(text).toContain('<sparql');
          const [description, response] = yield* client.sparql.query({
            query: {},
            headers: { accept: 'text/turtle' },
            responseMode: 'decoded-and-response',
          });
          expect(response.status).toBe(200);
          expect(yield* Stream.mkString(Stream.decodeText(description))).toContain('sd:Service');
        }),
      ),
    );

    it.effect('parses CONSTRUCT results', () =>
      withClient((client) =>
        Effect.gen(function* () {
          const graph = yield* SparqlApiClient.construct(
            client,
            'CONSTRUCT { ?s <http://example.org/label> ?name } WHERE { ?s <http://example.org/name> ?name }',
          );
          expect(graph.size).toBe(2);
        }),
      ),
    );

    it.effect('sends updates as direct bodies and as forms', () =>
      withClient((client) =>
        Effect.gen(function* () {
          yield* SparqlApiClient.update(
            client,
            'INSERT DATA { <http://example.org/dave> <http://example.org/name> "Dave" }',
          );
          yield* client.sparql.post({
            query: {},
            headers: {},
            payload: {
              update: 'DELETE DATA { <http://example.org/bob> <http://example.org/name> "Bob" }',
            },
          });
          const events = yield* Stream.runCollect(SparqlApiClient.results(client, NAMES));
          expect(names(events)).toEqual(['Alice', 'Dave']);
          const form = yield* client.sparql.post({
            query: {},
            headers: { accept: 'application/sparql-results+json' },
            payload: { query: NAMES },
          });
          assert.isDefined(form);
        }),
      ),
    );

    it.effect('reads and writes graphs', () =>
      withClient((client) =>
        Effect.gen(function* () {
          const target = { graph: 'http://example.org/g2' };
          yield* SparqlApiClient.writeGraph(
            client,
            target,
            '<http://example.org/a> <http://example.org/b> "c" .',
          );
          yield* SparqlApiClient.writeGraph(
            client,
            target,
            '<http://example.org/a> <http://example.org/b> "d" .\n',
            { mediaType: 'application/n-triples', method: 'post' },
          );
          const graph = yield* SparqlApiClient.readGraph(client, target, {
            accept: 'application/n-triples',
          });
          const expected = Dataset.make(
            Term.quad(ex('a'), ex('b'), Term.literal('c')),
            Term.quad(ex('a'), ex('b'), Term.literal('d')),
          );
          expect(Isomorphism.isomorphic(graph, expected)).toBe(true);
          const defaults = yield* SparqlApiClient.readGraph(client, 'default');
          expect(defaults.size).toBe(2);
          yield* client.graphStore.delete({ query: target });
          const missing = yield* Effect.flip(SparqlApiClient.readGraph(client, target));
          expect(missing).toMatchObject({ _tag: 'ProtocolError', status: 404 });
        }),
      ),
    );

    it.effect('decodes protocol errors with their status and message', () =>
      withClient((client) =>
        Effect.gen(function* () {
          const syntax = yield* Effect.flip(SparqlApiClient.query(client, 'SELECT WHERE {'));
          expect(syntax).toMatchObject({ _tag: 'ProtocolError', status: 400 });
          expect(syntax.message).toContain('Syntax error');
          const notAcceptable = yield* Effect.flip(
            SparqlApiClient.query(client, NAMES, { accept: 'image/png' }),
          );
          expect(notAcceptable).toMatchObject({ _tag: 'ProtocolError', status: 406 });
        }),
      ),
    );
  });
});
