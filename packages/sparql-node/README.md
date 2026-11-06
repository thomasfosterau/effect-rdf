# @thomasfosterau/effect-sparql-node

The Node side of [`@thomasfosterau/effect-rdf/sparql`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/core#sparql-thomasfosteraueffect-rdfsparql):

- **`NodeSparqlServer`** — the platform-neutral SPARQL 1.1 Protocol and Graph
  Store HTTP Protocol server (`SparqlServer` in effect-rdf) on a `node:http`
  socket, through `@effect/platform-node`'s `NodeHttpServer`: `layer(options)`
  and `layerMemory(options)` (over an in-memory store).
- **`Cli`** and the `effect-sparql-server` executable — serve RDF files from
  the command line.
- **`SparqlApi`**, **`SparqlApiBuilder`**, **`SparqlApiClient`** — the two
  protocols as an Effect `HttpApi` definition with an OpenAPI document, the
  routes that serve it with `SparqlServer`'s behaviour, and the client derived
  from it.

```sh
pnpm add effect @thomasfosterau/effect-parse @thomasfosterau/effect-rdf @thomasfosterau/effect-sparql-node
```

Peers: `effect` (`^4.1.2`: its runtime dependency `@effect/platform-node`
needs it, and `SparqlApi` declares a list of response content types per
stream, a 4.1 form of `HttpApiSchema.StreamUint8Array`) and
`@thomasfosterau/effect-parse` (the SPARQL parser behind effect-rdf's
`/sparql`). `@thomasfosterau/effect-rdf` and `@effect/platform-node` are
dependencies.

## Serving data

```ts
import { Layer } from 'effect';
import { NodeRuntime } from '@effect/platform-node';
import { Dataset } from '@thomasfosterau/effect-rdf';
import { NodeSparqlServer } from '@thomasfosterau/effect-sparql-node';

const data: Dataset.Dataset = /* … */ Dataset.empty;

// SPARQL endpoint on /sparql, graph store on /rdf-graph-store.
const Server = NodeSparqlServer.layerMemory({
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
import { Engine, ServerFormats, Store } from '@thomasfosterau/effect-rdf/sparql';
import { NodeSparqlServer } from '@thomasfosterau/effect-sparql-node';

const Server = NodeSparqlServer.layer({ port: 3030, readOnly: true }).pipe(
  Layer.provide(Engine.layer({ unionDefaultGraph: true })),
  Layer.provide(Store.layerMemory()),
  Layer.provide(ServerFormats.layer),
);
```

`NodeSparqlServer` takes the options of `SparqlServer` (see effect-rdf's
README) plus `port` and `host`. To mount the routes into a server of your own,
or to serve them on another platform, use `SparqlServer.layerRoutes`,
`SparqlServer.handler` or `SparqlServer.layerServe` from
`@thomasfosterau/effect-rdf/sparql`.

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
  `ServerFormats.codecs`;
- responses are byte streams listing every format
  (`SparqlApi.queryMediaTypes`, `SparqlApi.rdfMediaTypes`); errors are
  `text/plain` messages decoded into `ProtocolErrors.ProtocolError` at `400`, `403`,
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
import { SparqlServer } from '@thomasfosterau/effect-rdf/sparql';
import { SparqlApiBuilder } from '@thomasfosterau/effect-sparql-node';

const Main = HttpRouter.serve(SparqlApiBuilder.layerRoutes({ openapiPath: '/openapi.json' })).pipe(
  Layer.provide(SparqlServer.layerMemoryServices()),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8080 })),
);
```

`SparqlApiBuilder.layerServe(options)` is the same with request logging, and
`layerHandlers` / `layerSchemaFallback` / `layerFallback` are the pieces, for
mounting the API next to other `HttpApiBuilder` groups. The API takes the
options of `SparqlServer` except `updatePath` (updates go to the query
endpoint) and `graphStorePath: false`. `SparqlApiBuilder.makeTestClient(options)` is an
in-process `HttpClient` for the API routes.

## Command line

This package installs an `effect-sparql-server` executable
(`bin/effect-sparql-server.mjs`):

```sh
effect-sparql-server --port 3030 --cors data.ttl more.trig
effect-sparql-server --read-only --timeout 10000 --graph-per-file a.ttl b.nt
```

Files are parsed by extension with the default formats; run
`effect-sparql-server --help` for every option (the help, `--version` and
`--completions <shell>` come from `effect/cli`). (From the repository:
`pnpm --filter @thomasfosterau/effect-sparql-node start -- data.ttl`.)

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

## Derived client

`SparqlApiClient.make(options)` derives a client with `HttpApiClient` from
the server's `SparqlApi` definition (above): one typed method
per endpoint (`client.sparql.query`, `client.sparql.post`,
`client.graphStore.get` / `head` / `put` / `post` / `delete`), returning
response bodies as byte streams and failing with the server's
`ProtocolErrors.ProtocolError` (with the status and message) on error statuses. The
helpers send the common requests and parse the bodies with `ResultsStream`
and `ClientFormats.defaults`:

```ts
import { Effect, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { SparqlApiClient } from '@thomasfosterau/effect-sparql-node';

const program = Effect.gen(function* () {
  const client = yield* SparqlApiClient.SparqlApiClient;
  // Raw: the generated method, with `responseMode` to see the response.
  const [body, response] = yield* client.sparql.query({
    query: { query: 'ASK {}' },
    headers: { accept: 'application/sparql-results+json' },
    responseMode: 'decoded-and-response',
  });
  // Parsed: SELECT / ASK events, CONSTRUCT graphs, updates, Graph Store.
  const events = yield* Stream.runCollect(SparqlApiClient.results(client, 'SELECT * { ?s ?p ?o }'));
  yield* SparqlApiClient.update(client, 'INSERT DATA { <urn:a> <urn:b> <urn:c> }');
  yield* SparqlApiClient.writeGraph(client, { graph: 'urn:g' }, '<urn:a> <urn:b> "c" .');
  return yield* SparqlApiClient.readGraph(client, { graph: 'urn:g' });
}).pipe(
  Effect.provide(SparqlApiClient.layer({ baseUrl: 'https://example.org' })),
  Effect.provide(FetchHttpClient.layer),
);
```

`options.paths` targets a server at other paths and `transformClient` adds
retries or authentication. Direct bodies are tagged payloads
(`{ _tag: 'DirectQuery', query }`, `{ _tag: 'DirectUpdate', update }`),
forms are plain records, and Graph Store bodies are `{ mediaType, document }`.
It works against `SparqlServer.handler` too: the definition describes the
same protocol. `effect/http-api` is `@stability unstable` in Effect 4.

## Conformance

The SPARQL 1.1 Protocol suites (`.test-suites/rdf-tests/sparql/sparql11`, or
`$RDF_TEST_SUITES`) run in-process (`test/ProtocolConformance.test.ts`), once
against `SparqlServer.handler` and once against the `SparqlApi` routes, with
the same results: Protocol 34 / 34, Graph Store Protocol 14 / 14, Service
Description 3 / 3 (the deprecated `http-rdf-update` suite is skipped). The
tests of `SparqlApi`, `SparqlApiClient` (against both servers), the CLI and
the Node server sit beside it in `test/`.

## License

MIT
