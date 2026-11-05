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
- **An `effect/http-api` definition** (`SparqlApi`) of both protocols, served
  by `SparqlApiBuilder` with the same behaviour, with an OpenAPI document and
  a derived client in
  [`@thomasfosterau/effect-sparql-client`](../sparql-client).

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

## HttpApi definition and OpenAPI

`SparqlApi` describes both protocols as an Effect `HttpApi`, so the
endpoints, their parameters, request and response media types and error
statuses are typed and documented in one place:

- group `sparql`: `query` (`GET` with `query`, `default-graph-uri`,
  `named-graph-uri`; without `query` it answers the service description) and
  `post` (`POST` with an `application/x-www-form-urlencoded`,
  `application/sparql-query` or `application/sparql-update` body; `200` with
  results or `204` after an update);
- group `graphStore`: `get`, `head`, `put`, `post` and `delete` with
  `graph=<iri>` or `default`, bodies under every RDF media type of
  `Formats.codecs`;
- responses are byte streams listing every format
  (`SparqlApi.queryMediaTypes`, `SparqlApi.rdfMediaTypes`); errors are
  `text/plain` messages decoded into `Errors.ProtocolError` at `400`, `403`,
  `404`, `405`, `406`, `415`, `500` and `503`.

`SparqlApi.make({ path, graphStorePath })` builds it at other paths and
`SparqlApi.openApi(api)` returns its OpenAPI document.

`SparqlApiBuilder.layerRoutes(options)` serves it with `HttpApiBuilder`. Its
handlers are raw (`handleRaw`) and run the same code as `SparqlServer`:
`Accept` is negotiated and bodies are read by the protocol internals, so
statuses, headers and messages are identical. Methods the API does not
declare (`405` with `Allow`), CORS preflights and graphs identified directly
by a URL below the graph store go to plain `HttpRouter` fallback routes, and
the `SparqlApi.SchemaFallback` middleware hands a request whose parameters
fail the API's schemas (e.g. a repeated `query`) to the protocol handler, so
it gets the protocol's own `400`. The conformance suites run against both
servers. `effect/http-api` is `@stability unstable` in Effect 4.

```ts
import { Layer } from 'effect';
import { HttpRouter } from 'effect/http';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';
import { SparqlApiBuilder, SparqlServer } from '@thomasfosterau/effect-sparql-server';

const Main = HttpRouter.serve(SparqlApiBuilder.layerRoutes({ openapiPath: '/openapi.json' })).pipe(
  Layer.provide(SparqlServer.layerMemoryServices()),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8080 })),
);
```

`SparqlApiBuilder.layerServe(options)` is the same with request logging, and
`layerHandlers` / `layerSchemaFallback` / `layerFallback` are the pieces, for
mounting the API next to other `HttpApiBuilder` groups. The API takes the
options of `SparqlServer` except `updatePath` (updates go to the query
endpoint) and `graphStorePath: false`. `Testing.makeApiClient(options)` is an
in-process `HttpClient` for the API routes.

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
`effect-sparql-server --help` for every option (the help, `--version` and
`--completions <shell>` come from `effect/cli`). (From the repository:
`pnpm --filter @thomasfosterau/effect-sparql-server start -- data.ttl`.)

Every flag can also be set by an environment variable — `SPARQL_SERVER_`
followed by the flag name in upper snake case — which suits containers. A flag
on the command line wins over the environment, which wins over the default:

| Flag                    | Environment variable                | Default            |
| ----------------------- | ----------------------------------- | ------------------ |
| `-p`, `--port`          | `SPARQL_SERVER_PORT`                | `3030`             |
| `--host`                | `SPARQL_SERVER_HOST`                | all interfaces     |
| `--path`                | `SPARQL_SERVER_PATH`                | `/sparql`          |
| `--update-path`         | `SPARQL_SERVER_UPDATE_PATH`         | the query path     |
| `--graph-store`         | `SPARQL_SERVER_GRAPH_STORE`         | `/rdf-graph-store` |
| `--no-graph-store`      | `SPARQL_SERVER_NO_GRAPH_STORE`      | `false`            |
| `--read-only`           | `SPARQL_SERVER_READ_ONLY`           | `false`            |
| `--timeout`             | `SPARQL_SERVER_TIMEOUT`             | none               |
| `--max-results`         | `SPARQL_SERVER_MAX_RESULTS`         | none               |
| `--cors`                | `SPARQL_SERVER_CORS`                | `false`            |
| `--union-default-graph` | `SPARQL_SERVER_UNION_DEFAULT_GRAPH` | `false`            |
| `--graph-per-file`      | `SPARQL_SERVER_GRAPH_PER_FILE`      | `false`            |
| `--base-url`            | `SPARQL_SERVER_BASE_URL`            | the request origin |

```sh
SPARQL_SERVER_PORT=8080 SPARQL_SERVER_READ_ONLY=true effect-sparql-server data.ttl
```

Programmatically, `Cli.command` is the `effect/cli` command, `Cli.parse(argv)`
validates arguments (and the environment) into `Cli.Arguments`, and
`Cli.run(argv, { version })` runs the server.

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
responses from the manifests — once against `SparqlServer.handler` and once
against the `SparqlApi` routes, with the same results:

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
