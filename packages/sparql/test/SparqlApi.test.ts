import { assert, describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Match from 'effect/Match';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import type * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import type * as OpenApi from 'effect/http-api/OpenApi';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Bindings, Results } from '../src/index.ts';
import * as Protocol from '../src/Protocol.ts';
import * as SparqlApi from '../src/SparqlApi.ts';
import type * as SparqlApiBuilder from '../src/SparqlApiBuilder.ts';
import * as SparqlServer from '../src/SparqlServer.ts';
import * as Testing from '../src/Testing.ts';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);
const data = Dataset.make(
  Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
  Term.quad(ex('bob'), ex('name'), Term.literal('Bob')),
);

const BASE = 'http://localhost';

const withApi = <A, E>(
  f: (client: HttpClient.HttpClient) => Effect.Effect<A, E>,
  options?: SparqlApiBuilder.ApiOptions,
  services: Layer.Layer<SparqlServer.Requirements> = SparqlServer.layerMemoryServices(data),
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(services);
    const client = yield* Effect.provideContext(Testing.makeApiClient(options), context);
    return yield* f(client);
  }).pipe(Effect.scoped);

const send = (
  client: HttpClient.HttpClient,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS',
  path: string,
  options: {
    readonly body?: string | undefined;
    readonly contentType?: string | undefined;
    readonly headers?: Record<string, string> | undefined;
  } = {},
) => {
  let request = HttpClientRequest.make(method)(`${BASE}${path}`, {
    headers: options.headers ?? {},
  });
  if (options.body !== undefined) {
    request = HttpClientRequest.bodyText(request, options.body).pipe(
      HttpClientRequest.removeHeader('content-type'),
    );
  }
  if (options.contentType !== undefined) {
    request = HttpClientRequest.setHeader(request, 'content-type', options.contentType);
  }
  return client.execute(request);
};

const mediaType = (r: HttpClientResponse.HttpClientResponse) =>
  ((r.headers['content-type'] ?? '').split(';')[0] ?? '').trim();

const q = (query: string) => `/sparql?query=${encodeURIComponent(query)}`;

const NAMES = 'SELECT ?name WHERE { ?s <http://example.org/name> ?name } ORDER BY ?name';

const names = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const codec = Option.getOrElse(Results.codecFor(mediaType(response)), () =>
      assert.fail(`no results codec for ${mediaType(response)}`),
    );
    const parsed = yield* codec.parse(yield* response.text);
    return Match.value(parsed).pipe(
      Match.tag('ResultSet', (set) =>
        set.bindings.map((row) =>
          Option.match(Bindings.get(row, 'name'), {
            onNone: () => '',
            onSome: (t) => (Term.isLiteral(t) ? t.value : ''),
          }),
        ),
      ),
      Match.orElse(() => assert.fail('expected a result set')),
    );
  });

const contentTypes = (content?: OpenApi.OpenApiSpecContent) => Record.keys(content ?? {});

const statuses = (responses?: OpenApi.OpenAPISpecResponses) =>
  Record.keys(responses ?? {}).map(Number);

const METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] as const;

const methods = (item?: OpenApi.OpenAPISpecPathItem) =>
  METHODS.filter((method) => item?.[method] !== undefined);

describe('SparqlApi definition', () => {
  const spec = SparqlApi.openApi();

  it('documents both endpoints and their methods', () => {
    expect(Record.keys(spec.paths).toSorted()).toEqual(['/rdf-graph-store', '/sparql']);
    expect(methods(spec.paths['/sparql'])).toEqual(['get', 'post']);
    expect(methods(spec.paths['/rdf-graph-store'])).toEqual([
      'delete',
      'get',
      'head',
      'post',
      'put',
    ]);
  });

  it('lists the three request media types of a POST to the SPARQL endpoint', () => {
    const body = spec.paths['/sparql']?.post?.requestBody;
    expect(contentTypes(body?.content).toSorted()).toEqual([
      Protocol.SPARQL_QUERY,
      Protocol.SPARQL_UPDATE,
      Protocol.FORM,
    ]);
  });

  it('lists every response media type of a query', () => {
    const get = spec.paths['/sparql']?.get?.responses[200]?.content;
    const post = spec.paths['/sparql']?.post?.responses[200]?.content;
    const every = [...SparqlApi.resultsMediaTypes, ...SparqlApi.rdfMediaTypes];
    expect(contentTypes(get)).toEqual(expect.arrayContaining(every));
    expect(contentTypes(post)).toEqual(expect.arrayContaining(every));
    expect(contentTypes(get)).toEqual(SparqlApi.queryMediaTypes);
    expect(spec.paths['/sparql']?.post?.responses[204]).toBeDefined();
  });

  it('lists every RDF media type of Graph Store bodies and responses', () => {
    const gsp = spec.paths['/rdf-graph-store'];
    expect(contentTypes(gsp?.get?.responses[200]?.content)).toEqual(SparqlApi.rdfMediaTypes);
    expect(contentTypes(gsp?.put?.requestBody?.content)).toEqual(SparqlApi.rdfMediaTypes);
    expect(contentTypes(gsp?.post?.requestBody?.content)).toEqual(SparqlApi.rdfMediaTypes);
    expect(SparqlApi.rdfMediaTypes).toContain('text/turtle');
    expect(SparqlApi.resultsMediaTypes).toContain('application/sparql-results+json');
  });

  it('documents the protocol error statuses', () => {
    expect(statuses(spec.paths['/sparql']?.post?.responses)).toEqual(
      expect.arrayContaining([400, 403, 406, 415, 500, 503]),
    );
    expect(statuses(spec.paths['/rdf-graph-store']?.put?.responses)).toEqual(
      expect.arrayContaining([201, 204, 400, 404, 405, 415, 500]),
    );
    expect(statuses(spec.paths['/rdf-graph-store']?.get?.responses)).toEqual(
      expect.arrayContaining([400, 404, 406, 500]),
    );
    expect(contentTypes(spec.paths['/sparql']?.get?.responses[400]?.content)).toEqual([
      'text/plain',
    ]);
  });

  it('builds the API at other paths', () => {
    const other = SparqlApi.openApi(SparqlApi.make({ path: '/q', graphStorePath: '/store' }));
    expect(Record.keys(other.paths).toSorted()).toEqual(['/q', '/store']);
  });
});

describe('SparqlApiBuilder', () => {
  it.effect('answers GET, form and direct POST queries', () =>
    withApi((client) =>
      Effect.gen(function* () {
        const viaGet = yield* send(client, 'GET', q(NAMES));
        expect(viaGet.status).toBe(200);
        expect(mediaType(viaGet)).toBe('application/sparql-results+json');
        expect(yield* names(viaGet)).toEqual(['Alice', 'Bob']);

        const viaForm = yield* send(client, 'POST', '/sparql', {
          body: `query=${encodeURIComponent(NAMES)}`,
          contentType: Protocol.FORM,
          headers: { accept: 'text/csv' },
        });
        expect(viaForm.status).toBe(200);
        expect(mediaType(viaForm)).toBe('text/csv');
        expect(yield* names(viaForm)).toEqual(['Alice', 'Bob']);

        const direct = yield* send(client, 'POST', '/sparql', {
          body: NAMES,
          contentType: `${Protocol.SPARQL_QUERY}; charset=utf-8`,
        });
        expect(direct.status).toBe(200);
        expect(yield* names(direct)).toEqual(['Alice', 'Bob']);
      }),
    ),
  );

  it.effect('applies updates and answers 204', () =>
    withApi((client) =>
      Effect.gen(function* () {
        const update = yield* send(client, 'POST', '/sparql', {
          body: 'INSERT DATA { <http://example.org/carol> <http://example.org/name> "Carol" }',
          contentType: Protocol.SPARQL_UPDATE,
        });
        expect(update.status).toBe(204);
        const form = yield* send(client, 'POST', '/sparql', {
          body: `update=${encodeURIComponent('DELETE DATA { <http://example.org/bob> <http://example.org/name> "Bob" }')}`,
          contentType: Protocol.FORM,
        });
        expect(form.status).toBe(204);
        expect(yield* names(yield* send(client, 'GET', q(NAMES)))).toEqual(['Alice', 'Carol']);
      }),
    ),
  );

  it.effect('answers the service description on GET without a query', () =>
    withApi((client) =>
      Effect.gen(function* () {
        const response = yield* send(client, 'GET', '/sparql', {
          headers: { accept: 'text/turtle' },
        });
        expect(response.status).toBe(200);
        expect(mediaType(response)).toBe('text/turtle');
        expect(yield* response.text).toContain('sparql-service-description');
      }),
    ),
  );

  it.effect('answers 405 with Allow for methods the API does not declare', () =>
    withApi((client) =>
      Effect.gen(function* () {
        const put = yield* send(client, 'PUT', '/sparql', { body: '', contentType: 'text/plain' });
        expect(put.status).toBe(405);
        expect(put.headers['allow']).toBe('GET, POST');
        const patch = yield* send(client, 'PATCH', '/rdf-graph-store?default');
        expect(patch.status).toBe(405);
        expect(patch.headers['allow']).toContain('PUT');
      }),
    ),
  );

  it.effect('answers 415 for an unsupported request media type', () =>
    withApi((client) =>
      Effect.gen(function* () {
        const response = yield* send(client, 'POST', '/sparql', {
          body: NAMES,
          contentType: 'text/plain',
        });
        expect(response.status).toBe(415);
        expect(yield* response.text).toContain('Unsupported Content-Type');
        const charset = yield* send(client, 'POST', '/sparql', {
          body: NAMES,
          contentType: `${Protocol.SPARQL_QUERY}; charset=latin1`,
        });
        expect(charset.status).toBe(415);
        const gsp = yield* send(client, 'PUT', '/rdf-graph-store?default', {
          body: 'x',
          contentType: 'image/png',
        });
        expect(gsp.status).toBe(415);
      }),
    ),
  );

  it.effect('answers 406 when no format is acceptable', () =>
    withApi((client) =>
      Effect.gen(function* () {
        const response = yield* send(client, 'GET', q(NAMES), { headers: { accept: 'image/png' } });
        expect(response.status).toBe(406);
        const gsp = yield* send(client, 'GET', '/rdf-graph-store?default', {
          headers: { accept: 'image/png' },
        });
        expect(gsp.status).toBe(406);
      }),
    ),
  );

  it.effect('answers 400 for a malformed query and 403 for updates when read-only', () =>
    withApi(
      (client) =>
        Effect.gen(function* () {
          const bad = yield* send(client, 'GET', q('SELECT WHERE {'));
          expect(bad.status).toBe(400);
          expect(mediaType(bad)).toBe('text/plain');
          const update = yield* send(client, 'POST', '/sparql', {
            body: 'CLEAR ALL',
            contentType: Protocol.SPARQL_UPDATE,
          });
          expect(update.status).toBe(403);
          const write = yield* send(client, 'PUT', '/rdf-graph-store?default', {
            body: '',
            contentType: 'text/turtle',
          });
          expect(write.status).toBe(405);
        }),
      { readOnly: true },
    ),
  );

  it.effect('reads and writes graphs, indirectly and directly identified', () =>
    withApi((client) =>
      Effect.gen(function* () {
        const graph = encodeURIComponent('http://example.org/g');
        const put = yield* send(client, 'PUT', `/rdf-graph-store?graph=${graph}`, {
          body: '<http://example.org/a> <http://example.org/b> "c" .',
          contentType: 'text/turtle',
        });
        expect(put.status).toBe(201);
        const read = yield* send(client, 'GET', `/rdf-graph-store?graph=${graph}`, {
          headers: { accept: 'application/n-triples' },
        });
        expect(read.status).toBe(200);
        expect(mediaType(read)).toBe('application/n-triples');
        expect(yield* read.text).toContain('"c"');

        const created = yield* send(client, 'POST', '/rdf-graph-store', {
          body: '<http://example.org/a> <http://example.org/b> "d" .',
          contentType: 'text/turtle',
        });
        expect(created.status).toBe(201);
        const location = created.headers['location'] ?? '';
        expect(location.startsWith(`${BASE}/rdf-graph-store/`)).toBe(true);
        const direct = yield* send(client, 'GET', new URL(location).pathname);
        expect(direct.status).toBe(200);
        expect(yield* direct.text).toContain('"d"');

        const removed = yield* send(client, 'DELETE', `/rdf-graph-store?graph=${graph}`);
        expect(removed.status).toBe(204);
        const gone = yield* send(client, 'GET', `/rdf-graph-store?graph=${graph}`);
        expect(gone.status).toBe(404);
      }),
    ),
  );

  it.effect('serves other paths, the OpenAPI document and 404 elsewhere', () =>
    withApi(
      (client) =>
        Effect.gen(function* () {
          const query = yield* send(client, 'GET', `/q?query=${encodeURIComponent(NAMES)}`);
          expect(query.status).toBe(200);
          const store = yield* send(client, 'GET', '/store?default');
          expect(store.status).toBe(200);
          const openapi = yield* send(client, 'GET', '/openapi.json');
          expect(openapi.status).toBe(200);
          const document = yield* openapi.json;
          expect(document).toHaveProperty(['paths', '/q']);
          expect((yield* send(client, 'GET', '/qx')).status).toBe(404);
          expect((yield* send(client, 'GET', '/sparql')).status).toBe(404);
        }),
      { path: '/q', graphStorePath: '/store', openapiPath: '/openapi.json' },
    ),
  );

  it.effect('answers CORS preflights through the fallback routes', () =>
    withApi(
      (client) =>
        Effect.gen(function* () {
          const preflight = yield* send(client, 'OPTIONS', '/sparql', {
            headers: { origin: 'http://example.com', 'access-control-request-method': 'POST' },
          });
          expect(preflight.status).toBe(204);
          expect(preflight.headers['access-control-allow-origin']).toBe('*');
          const query = yield* send(client, 'GET', q(NAMES));
          expect(query.headers['access-control-allow-origin']).toBe('*');
        }),
      { cors: true },
    ),
  );
});
