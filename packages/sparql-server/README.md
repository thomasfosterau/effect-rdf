# @thomasfosterau/effect-sparql-server

A [SPARQL 1.1 Protocol](https://www.w3.org/TR/sparql11-protocol/) and
[Graph Store HTTP Protocol](https://www.w3.org/TR/sparql11-http-rdf-update/)
server for [Effect](https://effect.website), built with `effect/http` on top
of the engine of [`@thomasfosterau/effect-sparql`](../sparql).

- **Queries** with `GET` (`?query=`), `POST` form-encoded and `POST`
  `application/sparql-query`; **updates** with `POST` form-encoded and `POST`
  `application/sparql-update`.
- The protocol's dataset parameters: `default-graph-uri` / `named-graph-uri`
  (overriding `FROM` / `FROM NAMED`) and `using-graph-uri` /
  `using-named-graph-uri` (rejected with `400` when the update has `USING` or
  `WITH`).
- Errors as specified: `400` for syntax errors, repeated or conflicting
  parameters; `405` (with `Allow`) for other methods; `415` for missing or
  unsupported content types and non-UTF-8 charsets; `406` when no acceptable
  result format exists; `403` for updates in read-only mode; `503` when a
  query exceeds its time limit; `500` for evaluation failures.
- **Content negotiation**: SPARQL results as JSON, XML, CSV or TSV;
  `CONSTRUCT` / `DESCRIBE` results and graphs in every syntax of the core
  `Serialization.Formats` service — by default Turtle, N-Triples, RDF/XML,
  JSON-LD, N3, TriG, N-Quads and RDF/JSON (`Formats.layer`). Responses are
  **streamed** as the engine produces solutions; the server waits for the
  first solution before sending the status, so errors (and timeouts) raised
  before it get a proper status code.
- **Graph Store Protocol**: `GET`, `HEAD`, `PUT`, `POST` and `DELETE` on
  `?default`, `?graph=<iri>` (indirect identification) and on any URL below
  the graph store (direct identification); `POST` to the graph store creates
  a graph (`201 Created` with `Location`); bodies are parsed by
  `Content-Type`, including `multipart/form-data`.
- **Service description** (SPARQL 1.1 Service Description) on `GET` without
  a query, in any RDF syntax.
- **Configurable**: endpoint paths, read-only mode, query and update
  timeouts, maximum result size, CORS, request logging and tracing spans
  (`SparqlServer.query`, `SparqlServer.update`, `SparqlServer.graphStore`).
- Usable as a plain HTTP app, as `HttpRouter` routes to mount in your own
  server, or as a complete Node server — plus a small CLI.

## Serving data

```ts
import { Layer } from 'effect';
import { NodeRuntime } from '@effect/platform-node';
import { Dataset } from '@thomasfosterau/effect-rdf';
import { SparqlServer } from '@thomasfosterau/effect-sparql-server';

const data: Dataset.Dataset = /* … */ Dataset.empty;

// SPARQL endpoint on /sparql, graph store on /rdf-graph-store.
const Server = SparqlServer.layerMemory({
  port: 3030,
  data,
  queryTimeout: '30 seconds',
  maxResults: 100_000,
  cors: true,
});

Layer.launch(Server).pipe(NodeRuntime.runMain);
```

With your own store or engine (e.g. a SQL backend), provide the
`SparqlEngine`, `QuadStore` and `Serialization.Formats` services:

```ts
import { Layer } from 'effect';
import { Engine, Store } from '@thomasfosterau/effect-sparql';
import { Formats, SparqlServer } from '@thomasfosterau/effect-sparql-server';

const Server = SparqlServer.layer({ port: 3030, readOnly: true }).pipe(
  Layer.provide(Engine.layer({ unionDefaultGraph: true })),
  Layer.provide(Store.layerMemory()),
  Layer.provide(Formats.layer),
);
```

## Mounting into an existing server

`SparqlServer.layerRoutes(options)` registers the routes on the
`HttpRouter`, and `SparqlServer.handler(options)` is the whole server as one
HTTP app (`Effect<HttpServerResponse, never, HttpServerRequest | …>`) that
dispatches on the configured paths:

```ts
import { Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';
import { SparqlServer } from '@thomasfosterau/effect-sparql-server';

const Routes = Layer.mergeAll(
  HttpRouter.add('GET', '/health', HttpServerResponse.text('ok')),
  SparqlServer.layerRoutes({ path: '/api/sparql', graphStorePath: '/api/graphs' }),
);

const Main = HttpRouter.serve(Routes).pipe(
  Layer.provide(SparqlServer.layerMemoryServices()),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8080 })),
);
```

`HttpRouter.toWebHandler` turns the same routes into a `fetch`-style handler
for serverless runtimes.

## Options

| option               | default            | meaning                                                                   |
| -------------------- | ------------------ | ------------------------------------------------------------------------- |
| `path`               | `/sparql`          | query endpoint (also the update endpoint unless `updatePath` is set)      |
| `updatePath`         | `path`             | separate update endpoint                                                  |
| `graphStorePath`     | `/rdf-graph-store` | Graph Store Protocol root, or `false`                                     |
| `baseUrl`            | from `Host`        | public origin, for request URLs, base IRIs and directly identified graphs |
| `baseIri`            | endpoint URL       | base IRI of queries and updates                                           |
| `readOnly`           | `false`            | reject updates (`403`) and graph store writes (`405`)                     |
| `queryTimeout`       | none               | `Duration` limit for queries (`503`; a streaming response is aborted)     |
| `updateTimeout`      | none               | `Duration` limit for updates (`503`)                                      |
| `maxResults`         | none               | truncate results to this many solutions / triples                         |
| `cors`               | off                | `true` or `{ allowedOrigins, allowedHeaders, exposedHeaders, maxAge, … }` |
| `logging`            | `false`            | log requests in `handler` / `layerRoutes` (`layer` logs via `HttpRouter`) |
| `serviceDescription` | `true`             | serve the service description on `GET` without a query                    |
| `unionDefaultGraph`  | `false`            | advertise `sd:UnionDefaultGraph`                                          |
| `federation`         | `false`            | advertise `sd:BasicFederatedQuery`                                        |
| `prefixes`           | `{}`               | prefixes used when serialising graphs                                     |

## Command line

```sh
effect-sparql-server --port 3030 --cors data.ttl more.trig
effect-sparql-server --read-only --timeout 10000 --graph-per-file a.ttl b.nt
```

Files are parsed by extension with the default formats; run
`effect-sparql-server --help` for every option. (From the repository:
`pnpm --filter @thomasfosterau/effect-sparql-server start -- data.ttl`.)

## Testing

`Testing.makeClient(options)` / `Testing.layerClient(options)` give an
`HttpClient` answered in-process by the server, and `Testing.fromApps`
routes requests to several in-process servers by origin — handy for testing
clients and federated queries without sockets.

```ts
import { Effect, Layer } from 'effect';
import { HttpClient } from 'effect/http';
import { SparqlServer, Testing } from '@thomasfosterau/effect-sparql-server';

const program = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get('http://localhost/sparql?query=ASK%20%7B%7D');
  return yield* response.text;
}).pipe(
  Effect.provide(Testing.layerClient().pipe(Layer.provide(SparqlServer.layerMemoryServices()))),
);
```

## Conformance

The W3C suites in `.test-suites/rdf-tests/sparql/sparql11` (or
`$RDF_TEST_SUITES`) are run in-process against the server
(`test/ProtocolConformance.test.ts`), reading the HTTP requests and expected
responses from the manifests:

- **SPARQL 1.1 Protocol** (`protocol`): 34 / 34.
- **Graph Store Protocol** (`graph-store-protocol`, direct and indirect
  identification, graph creation by `POST`, `multipart/form-data`): 14 / 14
  (13 listed tests plus `head_non_existing_direct`, which the manifest
  defines but does not list).
- **Service Description** (`service-description`): 3 / 3 (the manifest has
  no machine-readable requests; the three checks are implemented directly).
- **Skipped**: `http-rdf-update` — deprecated (`dawg:Deprecated`, superseded
  by `graph-store-protocol`), its requests are prose-only and depend on state
  it never creates.

The client package additionally runs the 707 SPARQL query/update evaluation
tests through server and client (in JSON, XML and TSV) and the `service`
federation tests against federated servers.
