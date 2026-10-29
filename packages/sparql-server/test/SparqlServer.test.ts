import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { Dataset, Isomorphism, Serialization, Term } from '@thomasfosterau/effect-rdf';
import { Engine, Results, Store } from '@thomasfosterau/effect-sparql';
import * as Cli from '../src/Cli.ts';
import * as Formats from '../src/Formats.ts';
import type * as Options from '../src/Options.ts';
import * as Protocol from '../src/Protocol.ts';
import * as SparqlServer from '../src/SparqlServer.ts';
import * as Testing from '../src/Testing.ts';

/** The value of an `Option` the test expects to be present. */
const some = <A>(option: Option.Option<A>, label: string): A =>
  Option.getOrElse(option, () => assert.fail(`${label}: expected a value`));

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);
const data = Dataset.make(
  Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
  Term.quad(ex('bob'), ex('name'), Term.literal('Bob')),
  Term.quad(ex('carol'), ex('name'), Term.literal('Carol', 'en')),
  Term.quad(ex('alice'), ex('knows'), ex('bob'), ex('g1')),
);

const BASE = 'http://localhost';

const formats = Effect.runSync(
  Effect.provide(Effect.service(Serialization.Formats), Formats.layer),
);

const withServer = <A, E>(
  f: (client: HttpClient.HttpClient) => Effect.Effect<A, E>,
  options?: Options.Options,
  services: Layer.Layer<SparqlServer.Requirements> = SparqlServer.layerMemoryServices(data),
) =>
  Effect.gen(function* () {
    const client = yield* Testing.makeClient(options);
    return yield* f(client);
  }).pipe(Effect.provide(services));

const get = (client: HttpClient.HttpClient, path: string, headers: Record<string, string> = {}) =>
  client.execute(HttpClientRequest.get(`${BASE}${path}`, { headers }));

const post = (
  client: HttpClient.HttpClient,
  path: string,
  body: string,
  contentType: string | undefined,
  headers: Record<string, string> = {},
) => {
  let request = HttpClientRequest.post(`${BASE}${path}`, { headers }).pipe(
    HttpClientRequest.bodyText(body),
    HttpClientRequest.removeHeader('content-type'),
  );
  if (contentType !== undefined) {
    request = HttpClientRequest.setHeader(request, 'content-type', contentType);
  }
  return client.execute(request);
};

const q = (query: string) => `/sparql?query=${encodeURIComponent(query)}`;

const mediaType = (r: HttpClientResponse.HttpClientResponse) =>
  (r.headers['content-type'] ?? '').split(';')[0]!.trim();

const SELECT = 'SELECT ?s ?name WHERE { ?s <http://example.org/name> ?name } ORDER BY ?name';

describe('SPARQL endpoint', () => {
  it.effect('negotiates SELECT result formats', () =>
    withServer((client) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          Results.codecs,
          Effect.fnUntraced(function* (codec) {
            const r = yield* get(client, q(SELECT), { accept: codec.format.mediaType });
            expect(r.status).toBe(200);
            expect(mediaType(r)).toBe(codec.format.mediaType);
            const parsed = yield* codec.parse(yield* r.text);
            assert(parsed._tag === 'ResultSet');
            expect(parsed.bindings).toHaveLength(3);
          }),
          { concurrency: 1, discard: true },
        );
        // Default: JSON.
        const r = yield* get(client, q(SELECT));
        expect(mediaType(r)).toBe('application/sparql-results+json');
        // Wildcards and q-values.
        const xml = yield* get(client, q(SELECT), {
          accept: 'text/html;q=0.9, application/sparql-results+xml',
        });
        expect(mediaType(xml)).toBe('application/sparql-results+xml');
      }),
    ),
  );

  it.effect('answers ASK in JSON and XML', () =>
    withServer((client) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          ['application/sparql-results+json', 'application/sparql-results+xml'],
          Effect.fnUntraced(function* (accept) {
            const r = yield* get(client, q('ASK { ?s ?p "Bob" }'), { accept });
            const parsed = yield* some(Results.codecFor(accept), accept).parse(yield* r.text);
            expect(parsed).toEqual({ _tag: 'Boolean', value: true });
          }),
          { concurrency: 1, discard: true },
        );
      }),
    ),
  );

  it.effect('negotiates CONSTRUCT / DESCRIBE graph formats', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const construct = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
        const expected = Dataset.filter(data, (quad) => quad.graph._tag === 'DefaultGraph');
        yield* Effect.forEach(
          formats.serializers,
          Effect.fnUntraced(function* (serializer) {
            const r = yield* get(client, q(construct), { accept: serializer.format.mediaType });
            expect(r.status).toBe(200);
            expect(mediaType(r)).toBe(serializer.format.mediaType);
            const parser = some(Serialization.parserFor(formats, mediaType(r)), mediaType(r));
            const parsed = yield* parser.parse(yield* r.text, { baseIri: BASE });
            expect(Isomorphism.isomorphic(parsed.dataset, expected)).toBe(true);
          }),
          { concurrency: 1, discard: true },
        );
        const d = yield* get(client, q('DESCRIBE <http://example.org/alice>'));
        expect(mediaType(d)).toBe('text/turtle');
        expect(yield* d.text).toContain('Alice');
      }),
    ),
  );

  it.effect('answers 406 when no format is acceptable', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const r = yield* get(client, q(SELECT), { accept: 'image/png' });
        expect(r.status).toBe(406);
        const c = yield* get(client, q('CONSTRUCT WHERE { ?s ?p ?o }'), {
          accept: 'application/sparql-results+json',
        });
        expect(c.status).toBe(406);
      }),
    ),
  );

  it.effect('accepts POST queries (form and direct) with dataset parameters', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const form = yield* post(
          client,
          '/sparql',
          `query=${encodeURIComponent('SELECT * { ?s ?p ?o }')}&default-graph-uri=${encodeURIComponent('http://example.org/g1')}`,
          'application/x-www-form-urlencoded',
        );
        expect(form.status).toBe(200);
        const set = yield* Results.Json.parse(yield* form.text);
        expect(set._tag === 'ResultSet' && set.bindings.length).toBe(1);
        const direct = yield* post(
          client,
          `/sparql?named-graph-uri=${encodeURIComponent('http://example.org/g1')}`,
          'SELECT ?g { GRAPH ?g { ?s ?p ?o } }',
          'application/sparql-query; charset=UTF-8',
        );
        const named = yield* Results.Json.parse(yield* direct.text);
        expect(named._tag === 'ResultSet' && named.bindings.length).toBe(1);
      }),
    ),
  );

  it.effect('protocol dataset overrides FROM', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const r = yield* get(
          client,
          `${q('SELECT * FROM <http://example.org/g1> { ?s ?p ?o }')}&default-graph-uri=${encodeURIComponent('http://example.org/nothing')}`,
        );
        const set = yield* Results.Json.parse(yield* r.text);
        expect(set._tag === 'ResultSet' && set.bindings.length).toBe(0);
      }),
    ),
  );

  it.effect('rejects malformed requests', () =>
    withServer((client) =>
      Effect.gen(function* () {
        expect((yield* get(client, q('SELECT * {'))).status).toBe(400);
        const syntax = yield* get(client, q('SELECT * {'));
        expect(yield* syntax.text).toMatch(/line 1/);
        expect((yield* get(client, `${q('ASK {}')}&query=x`)).status).toBe(400);
        expect(
          (yield* get(client, `/sparql?update=${encodeURIComponent('CLEAR ALL')}`)).status,
        ).toBe(400);
        expect((yield* post(client, '/sparql', 'ASK {}', undefined)).status).toBe(415);
        expect((yield* post(client, '/sparql', 'ASK {}', 'text/plain')).status).toBe(415);
        expect(
          (yield* post(client, '/sparql', 'ASK {}', 'application/sparql-query; charset=UTF-16'))
            .status,
        ).toBe(415);
        expect(
          (yield* post(
            client,
            '/sparql',
            `query=${encodeURIComponent('ASK {}')}&update=${encodeURIComponent('CLEAR ALL')}`,
            'application/x-www-form-urlencoded',
          )).status,
        ).toBe(400);
        const put = yield* client.execute(HttpClientRequest.put(`${BASE}/sparql`));
        expect(put.status).toBe(405);
        expect(put.headers['allow']).toBe('GET, POST');
        expect((yield* get(client, '/nowhere')).status).toBe(404);
      }),
    ),
  );

  it.effect('runs updates and reports conflicts and errors', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const r = yield* post(
          client,
          '/sparql',
          'INSERT DATA { <http://example.org/dave> <http://example.org/name> "Dave" }',
          'application/sparql-update',
        );
        expect(r.status).toBe(204);
        const check = yield* get(client, q('ASK { ?s ?p "Dave" }'));
        expect(yield* check.text).toContain('true');
        const form = yield* post(
          client,
          '/sparql',
          `update=${encodeURIComponent('CREATE GRAPH <http://example.org/g1>')}`,
          'application/x-www-form-urlencoded',
        );
        expect(form.status).toBe(400);
        const conflict = yield* post(
          client,
          `/sparql?using-graph-uri=${encodeURIComponent('http://example.org/g1')}`,
          'WITH <http://example.org/g1> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }',
          'application/sparql-update',
        );
        expect(conflict.status).toBe(400);
        // using-graph-uri scopes the WHERE clause.
        const using = yield* post(
          client,
          `/sparql?using-graph-uri=${encodeURIComponent('http://example.org/g1')}`,
          'INSERT { ?s <http://example.org/seen> true } WHERE { ?s ?p ?o }',
          'application/sparql-update',
        );
        expect(using.status).toBe(204);
        const seen = yield* get(client, q('SELECT ?s { ?s <http://example.org/seen> true }'));
        const set = yield* Results.Json.parse(yield* seen.text);
        expect(set._tag === 'ResultSet' && set.bindings.length).toBe(1);
      }),
    ),
  );

  it.effect('supports a separate update endpoint', () =>
    withServer(
      (client) =>
        Effect.gen(function* () {
          expect(
            (yield* post(client, '/sparql', 'CLEAR ALL', 'application/sparql-update')).status,
          ).toBe(415);
          expect(
            (yield* post(client, '/update', 'CLEAR ALL', 'application/sparql-update')).status,
          ).toBe(204);
          expect((yield* get(client, `/update?query=${encodeURIComponent('ASK {}')}`)).status).toBe(
            400,
          );
        }),
      { updatePath: '/update' },
    ),
  );

  it.effect('read-only mode', () =>
    withServer(
      (client) =>
        Effect.gen(function* () {
          expect(
            (yield* post(client, '/sparql', 'CLEAR ALL', 'application/sparql-update')).status,
          ).toBe(403);
          const put = yield* client.execute(
            HttpClientRequest.put(`${BASE}/rdf-graph-store?default`).pipe(
              HttpClientRequest.bodyText('<a:a> <a:b> <a:c> .', 'text/turtle'),
            ),
          );
          expect(put.status).toBe(405);
          expect((yield* get(client, '/rdf-graph-store?default')).status).toBe(200);
          const sd = yield* get(client, '/sparql');
          expect(yield* sd.text).not.toContain('SPARQL11Update');
        }),
      { readOnly: true },
    ),
  );

  it.effect('limits results with maxResults', () =>
    withServer(
      (client) =>
        Effect.gen(function* () {
          const r = yield* get(client, q(SELECT));
          const set = yield* Results.Json.parse(yield* r.text);
          expect(set._tag === 'ResultSet' && set.bindings.length).toBe(2);
          const c = yield* get(client, q('CONSTRUCT WHERE { ?s ?p ?o }'), {
            accept: 'application/n-triples',
          });
          expect((yield* c.text).trim().split('\n')).toHaveLength(2);
        }),
      { maxResults: 2 },
    ),
  );

  it.live('answers 503 when a query exceeds the timeout', () => {
    // A store whose matches take a long time.
    const slow = Layer.effect(
      Store.QuadStore,
      Effect.map(Store.makeMemory(data), (store) => ({
        ...store,
        estimate: undefined,
        match: (pattern: Store.QuadPattern) =>
          Stream.concat(
            Stream.fromEffect(Effect.sleep('2 seconds')).pipe(Stream.drain),
            store.match(pattern),
          ),
      })),
    );
    const services = Layer.mergeAll(Engine.layer().pipe(Layer.provideMerge(slow)), Formats.layer);
    return withServer(
      (client) =>
        Effect.gen(function* () {
          const r = yield* get(client, q(SELECT));
          expect(r.status).toBe(503);
          const c = yield* get(client, q('CONSTRUCT WHERE { ?s ?p ?o }'));
          expect(c.status).toBe(503);
        }),
      { queryTimeout: '50 millis' },
      services,
    );
  });

  it.effect('reports evaluation errors before the first result as 500', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const r = yield* get(
          client,
          q('SELECT * { SERVICE <http://remote.example/sparql> { ?s ?p ?o } }'),
        );
        expect(r.status).toBe(500);
        expect(yield* r.text).toContain('SERVICE');
      }),
    ),
  );

  it.effect('serves a service description', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const r = yield* get(client, '/sparql', { accept: 'application/n-triples' });
        expect(r.status).toBe(200);
        const text = yield* r.text;
        expect(text).toContain(
          '<http://www.w3.org/ns/sparql-service-description#endpoint> <http://localhost/sparql>',
        );
        expect(text).toContain('<http://example.org/g1>');
        const head = yield* client.execute(HttpClientRequest.head(`${BASE}/sparql`));
        expect(head.status).toBe(200);
      }),
    ),
  );

  it.effect('adds CORS headers and answers preflight requests', () =>
    withServer(
      (client) =>
        Effect.gen(function* () {
          const r = yield* get(client, q('ASK {}'), { origin: 'http://app.example' });
          expect(r.headers['access-control-allow-origin']).toBe('http://app.example');
          const pre = yield* client.execute(
            HttpClientRequest.options(`${BASE}/sparql`, {
              headers: {
                origin: 'http://app.example',
                'access-control-request-headers': 'content-type',
              },
            }),
          );
          expect(pre.status).toBe(204);
          expect(pre.headers['access-control-allow-methods']).toContain('POST');
          expect(pre.headers['access-control-allow-headers']).toBe('content-type');
          const other = yield* get(client, q('ASK {}'), { origin: 'http://evil.example' });
          expect(other.headers['access-control-allow-origin']).toBeUndefined();
        }),
      { cors: { allowedOrigins: ['http://app.example'] } },
    ),
  );

  it.effect('uses the endpoint URL as the base IRI', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const r = yield* get(client, q('SELECT (<rel> AS ?x) {}'));
        const set = yield* Results.Json.parse(yield* r.text);
        expect(
          set._tag === 'ResultSet' &&
            (set.bindings[0]!.map.get('x') as Term.NamedNode | undefined)?.value,
        ).toBe('http://localhost/rel');
      }),
    ),
  );
});

describe('Graph Store Protocol', () => {
  const gsp = '/rdf-graph-store';
  const put = (client: HttpClient.HttpClient, target: string, body: string, ct = 'text/turtle') =>
    client.execute(
      HttpClientRequest.put(`${BASE}${gsp}${target}`).pipe(HttpClientRequest.bodyText(body, ct)),
    );

  it.effect('PUT, GET, POST, DELETE and HEAD on named and default graphs', () =>
    withServer((client) =>
      Effect.gen(function* () {
        const g = `?graph=${encodeURIComponent('http://example.org/g2')}`;
        expect((yield* put(client, g, '<http://a> <http://b> <http://c> .')).status).toBe(201);
        expect((yield* put(client, g, '<http://a> <http://b> <http://d> .')).status).toBe(204);
        const r = yield* get(client, `${gsp}${g}`, { accept: 'application/n-triples' });
        expect(yield* r.text).toBe('<http://a> <http://b> <http://d> .\n');
        const p = yield* client.execute(
          HttpClientRequest.post(`${BASE}${gsp}${g}`).pipe(
            HttpClientRequest.bodyText(
              '{"@id":"http://a","http://b":{"@id":"http://e"}}',
              'application/ld+json',
            ),
          ),
        );
        expect(p.status).toBe(204);
        const after = yield* get(client, `${gsp}${g}`, { accept: 'application/n-triples' });
        expect((yield* after.text).trim().split('\n')).toHaveLength(2);
        expect((yield* client.execute(HttpClientRequest.head(`${BASE}${gsp}${g}`))).status).toBe(
          200,
        );
        expect((yield* client.execute(HttpClientRequest.delete(`${BASE}${gsp}${g}`))).status).toBe(
          204,
        );
        expect((yield* get(client, `${gsp}${g}`)).status).toBe(404);
        expect((yield* client.execute(HttpClientRequest.head(`${BASE}${gsp}${g}`))).status).toBe(
          404,
        );
        expect((yield* client.execute(HttpClientRequest.delete(`${BASE}${gsp}${g}`))).status).toBe(
          404,
        );
        // The default graph.
        const d = yield* get(client, `${gsp}?default`, { accept: 'application/n-triples' });
        expect((yield* d.text).trim().split('\n')).toHaveLength(3);
        expect(
          (yield* client.execute(HttpClientRequest.delete(`${BASE}${gsp}?default`))).status,
        ).toBe(204);
        const empty = yield* get(client, `${gsp}?default`, { accept: 'application/n-triples' });
        expect((yield* empty.text).trim()).toBe('');
      }),
    ),
  );

  it.effect('direct graph identification and graph creation by POST', () =>
    withServer((client) =>
      Effect.gen(function* () {
        expect((yield* put(client, '/people/1', '<#me> <http://b> "x" .')).status).toBe(201);
        // Relative IRIs resolve against the graph IRI.
        const check = yield* get(
          client,
          q(
            'ASK { GRAPH <http://localhost/rdf-graph-store/people/1> { <http://localhost/rdf-graph-store/people/1#me> ?p ?o } }',
          ),
        );
        expect(yield* check.text).toContain('true');
        const created = yield* client.execute(
          HttpClientRequest.post(`${BASE}${gsp}`).pipe(
            HttpClientRequest.bodyText('<http://a> <http://b> "new" .', 'application/n-triples'),
          ),
        );
        expect(created.status).toBe(201);
        const location = created.headers['location']!;
        expect(location.startsWith('http://localhost/rdf-graph-store/')).toBe(true);
        const fetched = yield* get(client, `${gsp}?graph=${encodeURIComponent(location)}`, {
          accept: 'application/n-triples',
        });
        expect(yield* fetched.text).toContain('"new"');
        const direct = yield* client.execute(HttpClientRequest.get(location));
        expect(direct.status).toBe(200);
      }),
    ),
  );

  it.effect('rejects bad requests', () =>
    withServer((client) =>
      Effect.gen(function* () {
        expect((yield* put(client, '?default', 'not turtle', 'text/turtle')).status).toBe(400);
        expect((yield* put(client, '?default', 'x', 'application/x-unknown')).status).toBe(415);
        expect(
          (yield* put(client, '?default', 'x', 'text/turtle; charset=ISO-8859-1')).status,
        ).toBe(415);
        expect((yield* get(client, `${gsp}?default&graph=x`)).status).toBe(400);
        expect((yield* get(client, `${gsp}`)).status).toBe(400);
        expect((yield* get(client, `${gsp}?default`, { accept: 'image/png' })).status).toBe(406);
        const patch = yield* client.execute(HttpClientRequest.patch(`${BASE}${gsp}?default`));
        expect(patch.status).toBe(405);
      }),
    ),
  );
});

describe('Protocol', () => {
  it('parses content types', () => {
    expect(Protocol.parseContentType('Text/Turtle; Charset="UTF-8"')).toEqual({
      mediaType: 'text/turtle',
      parameters: { charset: 'UTF-8' },
    });
    expect(Protocol.parseContentType(undefined)).toBeUndefined();
    expect(Protocol.isNonUtf8(Protocol.parseContentType('a/b; charset=utf8')!)).toBe(false);
    expect(Protocol.isNonUtf8(Protocol.parseContentType('a/b; charset=latin1')!)).toBe(true);
  });
});

describe('CLI', () => {
  it.effect('parses arguments', () =>
    Effect.gen(function* () {
      const args = yield* Cli.parse(['-p', '8080', '--read-only', '--timeout', '1000', 'a.ttl']);
      expect(args.serve.port).toBe(8080);
      expect(args.serve.readOnly).toBe(true);
      expect(args.serve.queryTimeout).toBe(1000);
      expect(args.files).toEqual(['a.ttl']);
      const error = yield* Effect.flip(Cli.parse(['--port', 'x']));
      expect(error._tag).toBe('CliError');
      const unknown = yield* Effect.flip(Cli.parse(['--nope']));
      expect(unknown._tag).toBe('CliError');
    }),
  );
});

describe('Node server', () => {
  it.effect('serves over a real socket via the HttpRouter', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const r = yield* client.execute(
        HttpClientRequest.get(`/sparql/?query=${encodeURIComponent('ASK { ?s ?p "Alice" }')}`),
      );
      expect(r.status).toBe(200);
      expect(yield* r.text).toContain('true');
      const g = yield* client.execute(
        HttpClientRequest.get('/rdf-graph-store?default', {
          headers: { accept: 'application/n-triples' },
        }),
      );
      expect(g.status).toBe(200);
      const direct = yield* client.execute(HttpClientRequest.get('/rdf-graph-store/missing'));
      expect(direct.status).toBe(404);
    }).pipe(
      Effect.provide(
        SparqlServer.layerServe({ logging: false }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(SparqlServer.layerMemoryServices(data)),
        ),
      ),
    ),
  );
});
