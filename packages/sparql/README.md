# @thomasfosterau/effect-sparql

SPARQL 1.1 (and SPARQL 1.2) for [Effect](https://effect.website), built on
[`@thomasfosterau/effect-rdf`](../core): a complete parser and generator, the
SPARQL algebra with an optimizer, a streaming query and update engine over a
pluggable storage service, the standard results formats, a strongly-typed
query builder, and — on `effect/http` — a [SPARQL 1.1
Protocol](https://www.w3.org/TR/sparql11-protocol/) and [Graph Store HTTP
Protocol](https://www.w3.org/TR/sparql11-http-rdf-update/)
[server](#protocol-server) and [client](#protocol-client). Two subpaths build on the engine:
[SHACL-SPARQL](#shacl-sparql-thomasfosteraueffect-sparqlshacl) for the core's SHACL validator
(`/shacl`) and [knowledge-graph tools for `effect/ai`](#knowledge-graph-tools-thomasfosteraueffect-sparqlai)
(`/ai`).

- **`Parser`** — a compiled LL(1) grammar (on
  [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse),
  reusing the Turtle terminals of `@thomasfosterau/effect-turtle/Grammar`) for
  SPARQL 1.1 Query and Update plus SPARQL 1.2 (triple terms `<<( s p o )>>`, reified triples
  `<< s p o ~ r >>`, annotations `{| … |}`, `VERSION`, `@lang--dir`), with all
  static checks (blank node scoping, grouping, `BIND`/`AS` scoping, `VALUES`
  arity, `DELETE` blank nodes, …) and `SparqlParseError`s carrying
  line/column.
- **`Ast`** — typed AST (`Select`/`Construct`/`Ask`/`Describe`, all update
  operations) over core `Term`s, with constructors.
- **`Generator`** — prints any AST back to SPARQL; parse → print → parse is
  stable.
- **`Algebra`**, **`Translate`** — translation to the SPARQL algebra exactly
  per §18 (BGP, Path, Join, LeftJoin, Filter, Union, Graph, Extend, Minus,
  Group/aggregation, OrderBy, Project, Distinct, Reduced, Slice, Values,
  Service), S-expression formatting and tree utilities.
- **`Optimizer`** — semantics-preserving filter pushdown and BGP join
  ordering by selectivity (using store estimates when available).
- **`Expression`**, **`Functions`** — every SPARQL 1.1 operator and function
  (string, numeric, date/time, hashes, `RAND`/`NOW`/`UUID`/`STRUUID`/`BNODE`
  with per-query semantics), effective boolean value, XSD casts, the
  `ORDER BY` ordering, SPARQL 1.2 `TRIPLE`/`SUBJECT`/`PREDICATE`/`OBJECT`/
  `isTRIPLE`/`LANGDIR`/`hasLANG`/`hasLANGDIR`/`STRLANGDIR`, and extension
  functions registered by IRI.
- **`Store`** — the `QuadStore` service implemented by backends, and an
  in-memory `QuadStore` (`Store.layerMemory`) on the core `Dataset`.
- **`Engine`** — the `SparqlEngine` service: streaming `SELECT`, `ASK`,
  `CONSTRUCT`, `DESCRIBE` and atomic updates.
- **`Results`** — SPARQL results in JSON (via Effect `Schema`), XML, CSV and
  TSV: streaming serialisers and parsers, including triple terms and base
  directions; media-type lookup and `Accept` negotiation.
- **`QueryBuilder`**, **`TermSchema`** — an immutable, typed builder whose
  `SELECT` rows are typed from the projection, and schemas decoding terms to
  JS values (`TermSchema` re-exports core's `TermCodec`, so code that only
  decodes terms can depend on `@thomasfosterau/effect-rdf` alone).

## Querying

```ts
import { Effect, Layer, Stream } from 'effect';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Bindings, Engine, Store } from '@thomasfosterau/effect-sparql';

const data = Dataset.make(/* … quads … */);
const SparqlLive = Engine.layer({ baseIri: 'http://example.org/' }).pipe(
  Layer.provideMerge(Store.layerMemory(data)),
);

const program = Effect.gen(function* () {
  const engine = yield* Engine.SparqlEngine;

  // SELECT: a lazy Stream of solutions (LIMIT stops evaluation early).
  const result = yield* engine.select(`
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT ?name WHERE { ?p foaf:name ?name } ORDER BY ?name LIMIT 10`);
  yield* Stream.runForEach(result.bindings, (b) => Effect.log(Bindings.get(b, 'name')));

  const known = yield* engine.ask('ASK { ?s ?p ?o }');
  const triples = yield* engine.construct('CONSTRUCT WHERE { ?s ?p ?o }');

  yield* engine.update(`
    PREFIX ex: <http://example.org/>
    INSERT { ?s ex:seen true } WHERE { ?s ?p ?o }`);
});

Effect.runPromise(program.pipe(Effect.provide(SparqlLive)));
```

`EngineOptions`: `unionDefaultGraph` (the default graph is the union of all
graphs when there is no `FROM`), `baseIri`, `functions` (extension functions
by IRI), `service` (federation), `load` (`LOAD` support) and `optimize`.
`RequestOptions.dataset` overrides the dataset per request (the protocol's
`default-graph-uri` / `named-graph-uri`); `FROM`/`FROM NAMED` in the query
take precedence.

### Pre-bound variables

`RequestOptions.bindings` pre-binds variables (initial bindings) with the
"values insertion" semantics of SHACL-SPARQL and SPARQL `EXISTS`
(`Algebra.prebind`): the solution is joined into every BGP, property path and
`GRAPH ?g` pattern, so it is visible to every `FILTER` and `BIND` — unlike a
trailing `VALUES` clause.

```ts
const rows =
  yield *
  engine.select('SELECT $this WHERE { FILTER (isIRI($this)) }', {
    bindings: Bindings.make({ this: Term.namedNode('http://example.org/a') }),
  });
```

## Typed query builder

```ts
import { Schema, Stream } from 'effect';
import { Namespace } from '@thomasfosterau/effect-rdf';
import { QueryBuilder as Q, TermSchema } from '@thomasfosterau/effect-sparql';

const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const v = Q.vars('person', 'name', 'email'); // or the untyped proxy Q.v

const query = Q.select('person', 'name', Q.maybe('email'), Q.as(Q.strlen(v.name), 'length'))
  .where(Q.triple(v.person, foaf('name'), v.name))
  .optional(Q.triple(v.person, foaf('mbox'), v.email))
  .filter(Q.gt(Q.strlen(v.name), 3))
  .orderBy(Q.desc(v.name))
  .limit(10);

query.build(); // Ast.SelectQuery
query.toString(); // SPARQL text

// Stream<{ readonly person: GroundTerm; readonly name: GroundTerm;
//          readonly length: GroundTerm; readonly email?: GroundTerm }>
const rows = Q.execute(query);

// Decoding rows to JS values with schemas.
const people = Q.decode(
  query,
  Schema.Struct({ name: TermSchema.string, email: Schema.optional(TermSchema.iri) }),
);
```

## Results formats

```ts
import { Results } from '@thomasfosterau/effect-sparql';

const codec = Results.negotiate(request.headers.accept); // Option<ResultsCodec>
const body = Results.Json.serialize(selectResult); // Stream<string>
const parsed = yield * Results.Xml.parse(text); // ResultSet | BooleanResult
```

The TSV term syntax and CSV rows are parsed with
[`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
(a peer dependency, next to `effect`), using compiled grammars. A
`ResultsParseError` from the TSV or CSV parsers carries the 1-based `line`
and `column` of the error. `pnpm bench` times both parsers on every
SRX/SRJ result in the conformance suites, re-serialised as TSV and CSV,
plus a synthetic 20,000-row document.

`pnpm bench` also times the query and update parser on every `.rq` and `.ru`
file of the conformance suites (188 kB) and on two synthetic documents (a
222 kB query and a 117 kB update). On Node 22 it reads 4–6 MB/s (the suite in
about 40–50 ms, the query in about 55 ms and the update in about 20 ms),
1.4–1.8× slower than the hand-written parser it replaced, with identical
ASTs, errors and error positions on every suite file and on 8,000 mutated
copies of them.

## Extension points

These are the seams for the packages built on top of this one.

### Storage backends (`Store.QuadStore`)

A backend provides the `QuadStore` service:

| member                              | purpose                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `match(pattern)`                    | stream the quads matching a quad pattern (`undefined` = wildcard; `graph` may be the default graph) |
| `estimate?(pattern)`                | cheap cardinality estimate used by the optimizer to order joins                                     |
| `graphs`, `hasGraph`                | named graph listing (including empty graphs the backend tracks)                                     |
| `insert`, `delete`                  | quad updates                                                                                        |
| `createGraph`, `dropGraph`, `clear` | graph management for `CREATE`, `DROP`, `CLEAR`, `ADD`, `MOVE`, `COPY`                               |
| `transaction(effect)`               | run an effect atomically (each update request runs in one transaction)                              |
| `query?`                            | optional native algebra evaluation (`QueryCapability`)                                              |

### Native algebra evaluation (SPARQL-to-SQL)

`QueryCapability.evaluate(op, context)` is offered **every algebra node,
top-down**, before the generic evaluator handles it. Returning
`Option.some(stream)` takes over the whole subtree; `Option.none()` lets the
engine evaluate the node itself, offering its children again. A SQL backend
can therefore translate the largest subtrees it supports (BGPs, joins,
filters, …) to SQL and leave the rest (e.g. property paths, exotic functions)
to the engine. The `context` carries the `DatasetSpec` (default and named
graphs), the active graph, and `evaluate(op, graph?)` to delegate children
back to the engine. The algebra types live in `Algebra` (with `format`,
`transform`, `variables`, `certainVariables` helpers); internal variables
(blank nodes, path steps, aggregates) start with `@`.

### Federation (`SERVICE`) and `LOAD`

`EngineOptions.service` receives the endpoint IRI and the `Algebra.Service`
node (whose `pattern` holds the original syntax, printable with
`Generator.printPattern`) and returns the remote solutions — the hook for an
HTTP client (implemented by [`Federation`](#federation)).
`SERVICE ?endpoint { … }` is evaluated once per solution after `?endpoint`
has been bound by an earlier pattern. `EngineOptions.load` fetches documents
for `LOAD`.

### Protocol servers and clients

The [server](#protocol-server) and [client](#protocol-client) below are built
on these:

- `Parser.parse` accepts a query or an update; errors carry positions.
- `Results.codecs`, `Results.codecFor`, `Results.negotiate` and the streaming
  `serialize` functions implement the results side of the protocol; the
  parsers (`Results.Json.parse`, …) are what a client needs.
- `Engine.RequestOptions.dataset` maps the protocol's dataset parameters.
- `Generator.print` turns builder or parsed ASTs into query text for remote
  endpoints.

## Protocol server

A SPARQL 1.1 Protocol and Graph Store HTTP Protocol server built with
`effect/http` on top of the engine (`SparqlServer`, with `Protocol`,
`GraphStore`, `ServiceDescription`, `Options`, `ServerFormats` and
`ProtocolErrors`):

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
  JSON-LD, N3, TriG, N-Quads and RDF/JSON (`ServerFormats.layer`). Responses are
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
  a derived client (`SparqlApiClient`, below).

### Serving data

```ts
import { Layer } from 'effect';
import { NodeRuntime } from '@effect/platform-node';
import { Dataset } from '@thomasfosterau/effect-rdf';
import { SparqlServer } from '@thomasfosterau/effect-sparql';

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
import { Engine, ServerFormats, SparqlServer, Store } from '@thomasfosterau/effect-sparql';

const Server = SparqlServer.layer({ port: 3030, readOnly: true }).pipe(
  Layer.provide(Engine.layer({ unionDefaultGraph: true })),
  Layer.provide(Store.layerMemory()),
  Layer.provide(ServerFormats.layer),
);
```

### Mounting into an existing server

`SparqlServer.layerRoutes(options)` registers the routes on the
`HttpRouter`, and `SparqlServer.handler(options)` is the whole server as one
HTTP app (`Effect<HttpServerResponse, never, HttpServerRequest | …>`) that
dispatches on the configured paths:

```ts
import { Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';
import { SparqlServer } from '@thomasfosterau/effect-sparql';

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

### HttpApi definition and OpenAPI

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
import { SparqlApiBuilder, SparqlServer } from '@thomasfosterau/effect-sparql';

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

### Options

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

### Command line

The package installs an `effect-sparql-server` executable
(`bin/effect-sparql-server.mjs`):

```sh
effect-sparql-server --port 3030 --cors data.ttl more.trig
effect-sparql-server --read-only --timeout 10000 --graph-per-file a.ttl b.nt
```

Files are parsed by extension with the default formats; run
`effect-sparql-server --help` for every option (the help, `--version` and
`--completions <shell>` come from `effect/cli`). (From the repository:
`pnpm --filter @thomasfosterau/effect-sparql start -- data.ttl`.)

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

### Testing

`Testing.makeClient(options)` / `Testing.layerClient(options)` give an
`HttpClient` answered in-process by the server, and `Testing.fromApps`
routes requests to several in-process servers by origin — handy for testing
clients and federated queries without sockets.

```ts
import { Effect, Layer } from 'effect';
import { HttpClient } from 'effect/http';
import { SparqlServer, Testing } from '@thomasfosterau/effect-sparql';

const program = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get('http://localhost/sparql?query=ASK%20%7B%7D');
  return yield* response.text;
}).pipe(
  Effect.provide(Testing.layerClient().pipe(Layer.provide(SparqlServer.layerMemoryServices()))),
);
```

## Protocol client

A strongly-typed SPARQL 1.1 Protocol and Graph Store HTTP Protocol client
built on the `effect/http` `HttpClient` (`SparqlClient`, with `ResultsStream`,
`ClientFormats`, `ClientErrors`, `Federation` and `SparqlApiClient`):

- **Queries** as strings, parsed `Ast` values or `QueryBuilder` builders —
  the typed rows of `QueryBuilder.select(…)` flow through to `select`, and
  rows can be decoded with an Effect `Schema`.
- **Streaming**: `SELECT` results are parsed incrementally (JSON, XML,
  TSV and CSV) and emitted as a `Stream`; `CONSTRUCT` / `DESCRIBE`
  results are parsed with the `Serialization.Formats` parser for the response
  media type (N-Triples is preferred and parsed incrementally).
- **Updates** with `using-graph-uri` / `using-named-graph-uri`, and the
  **Graph Store Protocol**: `getGraph`, `hasGraph`, `putGraph`, `postGraph`,
  `createGraph`, `deleteGraph`.
- **Typed errors** (`SparqlClientError`): `HttpStatusError` (with the
  response body), `MalformedResponseError`, `UnsupportedMediaTypeError`,
  `TransportError`, `TimeoutError`, `ConfigurationError`.
- **Timeouts and retries** configured with a `Duration` and an Effect
  `Schedule` (transient failures only, by default).
- **Federation**: a `SERVICE` handler and a `LOAD` loader for the in-memory
  engine, so that it evaluates `SERVICE <url> { … }` remotely.
- **A derived client** (`SparqlApiClient`) generated with `HttpApiClient`
  from the server's `SparqlApi` definition, alongside the hand-written one.

### Querying an endpoint

```ts
import { Effect, Layer, Schedule, Schema, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Namespace } from '@thomasfosterau/effect-rdf';
import { QueryBuilder as Q, SparqlClient, TermSchema } from '@thomasfosterau/effect-sparql';

const ClientLive = SparqlClient.layer({
  endpoint: 'https://query.wikidata.org/sparql',
  headers: { 'user-agent': 'my-app/1.0' },
  method: 'auto', // GET for short queries, POST otherwise
  timeout: '30 seconds',
  retry: Schedule.max([Schedule.exponential('200 millis'), Schedule.recurs(3)]),
}).pipe(Layer.provide(FetchHttpClient.layer));

const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const v = Q.vars('person', 'name', 'mbox');
const query = Q.select('person', 'name', Q.maybe('mbox'))
  .where(Q.triple(v.person, foaf('name'), v.name))
  .optional(Q.triple(v.person, foaf('mbox'), v.mbox))
  .limit(10);

const program = Effect.gen(function* () {
  const client = yield* SparqlClient.SparqlClient;

  // Stream<{ person: GroundTerm; name: GroundTerm; mbox?: GroundTerm }>
  yield* Stream.runForEach(client.select(query), (row) => Effect.log(row.name));

  // Untyped rows from a string (or an Ast.Query).
  const rows = yield* Stream.runCollect(client.select('SELECT * { ?s ?p ?o } LIMIT 3'));

  // Rows decoded with a schema.
  const people = yield* Stream.runCollect(
    SparqlClient.decode(query, Schema.Struct({ name: TermSchema.string })),
  );

  const exists = yield* client.ask('ASK { ?s ?p ?o }');
  const graph = yield* client.constructDataset('CONSTRUCT WHERE { ?s ?p ?o } LIMIT 10');
  const triples = client.describe(Q.describe(foaf('Person'))); // Stream<Quad>

  // Protocol dataset parameters.
  yield* Stream.runDrain(
    client.select('SELECT * { ?s ?p ?o }', { defaultGraphs: ['http://example.org/g'] }),
  );
});

Effect.runPromise(program.pipe(Effect.provide(ClientLive)));
```

`selectAll` collects a result set with its variables, `results` exposes the
raw stream of events (`Variables`, `Solution`, `Boolean`), and `query`
evaluates any query form and dispatches on the response media type.

### Updates and the Graph Store

```ts
import { Effect } from 'effect';
import { Term } from '@thomasfosterau/effect-rdf';
import { SparqlClient } from '@thomasfosterau/effect-sparql';

const ClientLive = SparqlClient.layer({
  endpoint: 'http://localhost:3030/sparql',
  updateEndpoint: 'http://localhost:3030/sparql',
  graphStoreEndpoint: 'http://localhost:3030/rdf-graph-store',
});

const program = Effect.gen(function* () {
  const client = yield* SparqlClient.SparqlClient;
  yield* client.update('INSERT DATA { <urn:a> <urn:b> "c" }');
  yield* client.update('DELETE WHERE { ?s ?p ?o }', { usingGraphs: ['urn:g'] });

  const g = Term.namedNode('http://example.org/people');
  yield* client.putGraph(g, [
    Term.quad(Term.namedNode('urn:x'), Term.namedNode('urn:p'), Term.literal('v')),
  ]);
  yield* client.postGraph(g, [], { mediaType: 'text/turtle' });
  const dataset = yield* client.getGraphDataset(g);
  const exists = yield* client.hasGraph(g);
  const created = yield* client.createGraph([]); // POST to the store: the new graph's IRI
  yield* client.deleteGraph(g);
  yield* client.getGraphDataset('default');
});
```

### Derived client

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
import { SparqlApiClient } from '@thomasfosterau/effect-sparql';

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

### Client errors

```ts
const result = client.ask('ASK {').pipe(
  Effect.catchTag('HttpStatusError', (e) => Effect.logError(e.status, e.body)),
  Effect.catchTag('TimeoutError', () => Effect.succeed(false)),
);
```

`ClientErrors.isTransient` decides what `retry` retries (transport errors,
timeouts, `408`, `429`, `502`, `503`, `504`); override it with `retryWhile`.

### Federation

```ts
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Federation, Store } from '@thomasfosterau/effect-sparql';

// SERVICE <url> { … } is sent to the remote endpoint; LOAD <url> fetches
// documents over HTTP.
const EngineLive = Federation.layerEngine({ baseIri: 'http://example.org/' }).pipe(
  Layer.provide(Store.layerMemory()),
  Layer.provide(FetchHttpClient.layer),
);
```

`Federation.serviceHandler(config)` and `Federation.loader(config)` give the
`Engine.EngineOptions.service` / `load` functions on their own. Each remote
pattern is sent as `SELECT * WHERE { … }` with the prefixes of the original
query; `SERVICE SILENT` swallows failures, and `SERVICE ?endpoint` works once
`?endpoint` is bound by an earlier pattern.

### Client formats

The client uses the `Serialization.Formats` service when one is provided and
falls back to `ClientFormats.defaults` (N-Triples, Turtle, N-Quads, TriG, RDF/XML,
JSON-LD, N3, RDF/JSON). `ResultsStream` exposes the incremental results
parsers.

## SHACL-SPARQL (`@thomasfosterau/effect-sparql/shacl`)

[SHACL-SPARQL](https://www.w3.org/TR/shacl/#sparql-constraints) for
[`@thomasfosterau/effect-rdf/shacl`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/core#shacl-thomasfosteraueffect-rdfshacl), on
`@thomasfosterau/effect-sparql/shacl` (and `…/shacl/Evaluator`, `…/shacl/Query`),
evaluated with this package's engine. It implements the
`Sparql.SparqlConstraintEvaluator` service that the SHACL validator delegates
SPARQL features to, so the core's SHACL validator itself stays free of a
SPARQL dependency.

- **`Evaluator`**: `Evaluator.layer(options?)` / `Evaluator.make(options?)`
  providing the evaluator.
- **`Query`**: reading `sh:select` / `sh:ask` queries with their prefix
  declarations, the pre-binding restrictions and `$PATH` substitution.

Supported:

- SPARQL-based constraints (`sh:sparql` with `sh:select`, `sh:message`,
  `sh:deactivated`) on node and property shapes;
- SPARQL-based constraint components: parameters (mandatory and
  `sh:optional`), `sh:nodeValidator` / `sh:propertyValidator` (SELECT) and
  `sh:validator` (ASK), validator and component messages;
- SPARQL-based targets (`sh:SPARQLTarget`) and target types
  (`sh:SPARQLTargetType` with parameters) from SHACL Advanced Features;
- pre-bound `$this`, `$value` (ASK validators), `$currentShape`,
  `$shapesGraph` and parameters, with the exact pre-binding semantics of the
  specification (values insertion, see `Algebra.prebind` in
  `effect-sparql`) and its restrictions: `MINUS`, `VALUES`, `SERVICE`,
  `AS ?prebound` and sub-queries that drop pre-bound variables are failures;
- `$PATH` substitution with the property shape's path (any other use of
  `$PATH` is a failure);
- prefixes via `sh:prefixes` / `owl:imports` / `sh:declare` (conflicting
  declarations are failures);
- the result variables `?this`, `?value`, `?path`, `?message` and `?failure`;
- `{?var}` / `{$param}` placeholders in messages (substituted by the
  validator from the solution and parameters).

### Usage

```ts
import { Effect } from 'effect';
import { ValidationReport, Validator } from '@thomasfosterau/effect-rdf/shacl';
import { Evaluator } from '@thomasfosterau/effect-sparql/shacl';
import { Turtle } from '@thomasfosterau/effect-turtle';

const program = Effect.gen(function* () {
  const { dataset: shapes } = yield* Turtle.parse(`
    @prefix sh: <http://www.w3.org/ns/shacl#> .
    @prefix ex: <http://example.org/> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    ex: sh:declare [ sh:prefix "ex" ; sh:namespace "http://example.org/"^^xsd:anyURI ] .

    ex:PersonShape a sh:NodeShape ;
      sh:targetClass ex:Person ;
      sh:sparql [
        sh:prefixes ex: ;
        sh:message "{$this} is their own parent" ;
        sh:select """
          SELECT $this WHERE { $this ex:parent $this }
        """ ;
      ] .
  `);
  const { dataset: data } = yield* Turtle.parse(`
    @prefix ex: <http://example.org/> .
    ex:alice a ex:Person ; ex:parent ex:alice .
  `);
  const report = yield* Validator.validate(data, shapes);
  console.log(ValidationReport.format(report));
}).pipe(Effect.provide(Evaluator.layer()));
```

#### Constraint components

```turtle
ex:MaxWordsComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path ex:maxWords ] ;
  sh:message "Value has more than {$maxWords} words" ;
  sh:validator [
    a sh:SPARQLAskValidator ;
    sh:ask """ASK { FILTER (strlen(replace(str($value), "[^ ]", "")) < $maxWords) }""" ;
  ] .

ex:BookShape a sh:NodeShape ;
  sh:targetClass ex:Book ;
  sh:property [ sh:path ex:title ; ex:maxWords 8 ] .
```

#### Options

```ts
Evaluator.layer({
  // The IRI of the named graph holding the shapes graph ($shapesGraph).
  shapesGraphIri: 'urn:x-shacl:shapesGraph',
  // Options of the SPARQL engine, e.g. extension functions.
  engine: { functions },
});
```

The data graph is the default graph of the queried dataset (named graphs of
the data are merged into it, as the core validator sees them). Per data graph
the evaluator builds one in-memory store and caches compiled queries.

## Knowledge-graph tools (`@thomasfosterau/effect-sparql/ai`)

On `@thomasfosterau/effect-sparql/ai` (and `…/ai/Tools`, `…/ai/Mcp`):
knowledge-graph tools for [Effect AI](https://effect.website) (`effect/ai`): a
`Toolkit` that lets a language model explore and query an RDF dataset through
this package's engine, and the same tools as an
[MCP](https://modelcontextprotocol.io/specification) server registration for
any MCP client.

```sh
pnpm add effect @thomasfosterau/effect-rdf @thomasfosterau/effect-sparql
```

### Tools

| Tool                | Parameters        | Result                                                                                  |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `sparql_query`      | `query`, `limit?` | SELECT: SPARQL JSON results; ASK: `isTrue`; CONSTRUCT / DESCRIBE: Turtle; `isTruncated` |
| `describe_resource` | `iri`, `limit?`   | the triples whose subject is `iri`, as Turtle; `isTruncated`                            |
| `list_classes`      | `limit?`          | `[{ iri, count }]`: types in use and declared `rdfs:Class` / `owl:Class`                |
| `list_properties`   | `limit?`          | `[{ iri, count }]`: predicates in use and declared properties                           |
| `search_labels`     | `text`, `limit?`  | `[{ iri, label }]`: `rdfs:label` / `skos:prefLabel` containing `text` (any case)        |
| `sparql_update`     | `update`          | `{ isApplied }` — only in `Tools.toolkitWithUpdate`                                     |

`Tools.toolkit` holds the five read-only tools; `Tools.toolkitWithUpdate` adds
`sparql_update`. `Tools.layer(options)` / `Tools.layerWithUpdate(options)`
provide their handlers over the `SparqlEngine` service.

### With a language model

```ts
import { Effect, Layer } from 'effect';
import { LanguageModel } from 'effect/ai';
import { Engine } from '@thomasfosterau/effect-sparql';
import { Tools } from '@thomasfosterau/effect-sparql/ai';

const answer = (question: string) =>
  Effect.gen(function* () {
    const toolkit = yield* Tools.toolkit;
    const response = yield* LanguageModel.generateText({ prompt: question, toolkit });
    return response.text;
  });

// Provide a `LanguageModel` (e.g. from @effect/ai-openai), the tool handlers and an engine.
const ToolsLive = Tools.layer({ maxRows: 50 }).pipe(Layer.provide(Engine.layerMemory()));
```

### As an MCP server

`Mcp.layer(options)` registers the read-only tools with the `McpServer` in
context; add a transport and an engine:

```ts
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { McpProtocol, McpServer } from 'effect/ai';
import { Engine } from '@thomasfosterau/effect-sparql';
import { Mcp } from '@thomasfosterau/effect-sparql/ai';

Mcp.layer().pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: 'knowledge-graph',
      version: '1.0.0',
      protocols: [McpProtocol.v2025_11_25],
    }),
  ),
  Layer.provide(Engine.layerMemory()),
  Layer.provide(NodeServices.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
```

### Safety

Tool input is written by a model, so treat it as untrusted:

- **Read-only by default.** `sparql_query` only accepts queries; updates need
  the separate `toolkitWithUpdate` (or `Mcp.layerWithUpdate`).
- **Bounded.** Every result is capped at `maxRows` (default 100) rows or
  triples and says whether it was truncated; every call times out after
  `timeout` (default 10 seconds).
- **No federation.** Queries with `SERVICE` are refused unless
  `federation: true` (and the engine has a federation handler).
- **Errors go back to the model** as a `SparqlToolError` (or a parameter
  validation error), so it can correct its query.

## Conformance

The W3C test suites are run from `.test-suites/rdf-tests/sparql` (or
`$RDF_TEST_SUITES`), using the `@thomasfosterau/effect-turtle`,
`effect-ntriples` and `effect-rdfxml` packages to read manifests and data:

- **Syntax**: 574 / 574 (SPARQL 1.0, 1.1 query and update, 1.2) — every
  positive test also round-trips through `Generator.print`.
- **Evaluation**: 707 / 707 runnable query, update and CSV/TSV result tests
  (SPARQL 1.0, 1.1, 1.2). Result sets are compared up to blank node renaming
  (numeric literals by value); ordered results check the `ORDER BY` keys.
  Skipped (77): `sparql11/entailment` (70; entailment regimes are not
  supported) and `sparql11/service` (7; federation needs remote endpoints,
  so these run over HTTP below).
- **Evaluation over HTTP** (`test/HttpEvalConformance.test.ts`): the same
  707 / 707 runnable tests pass with each test's data loaded into an
  in-process server and every query sent by the client, with results parsed
  from JSON, XML and TSV. Skipped: `sparql11/entailment` and
  `sparql11/service` (below).
- **Federation** (`sparql11/service`): 7 / 7, with one in-process server per
  endpoint (the servers are federated themselves, for nested `SERVICE`).

The protocol suites in `.test-suites/rdf-tests/sparql/sparql11` are run
in-process against the server (`test/ProtocolConformance.test.ts`), reading
the HTTP requests and expected responses from the manifests — once against
`SparqlServer.handler` and once against the `SparqlApi` routes
(`SparqlApiBuilder`), with the same results:

- **SPARQL 1.1 Protocol** (`protocol`): 34 / 34 on both.
- **Graph Store Protocol** (`graph-store-protocol`, direct and indirect
  identification, graph creation by `POST`, `multipart/form-data`): 14 / 14
  on both (13 listed tests plus `head_non_existing_direct`, which the
  manifest defines but does not list).
- **Service Description** (`service-description`): 3 / 3 on both (the
  manifest has no machine-readable requests; the three checks are
  implemented directly).
- **Skipped**: `http-rdf-update` — deprecated (`dawg:Deprecated`, superseded
  by `graph-store-protocol`), its requests are prose-only and depend on state
  it never creates.

**SHACL-SPARQL** (`/shacl`): the W3C SHACL test suite (`.test-suites/data-shapes`, or
`$RDF_TEST_SUITES`): all **22 / 22** SHACL-SPARQL tests (`sparql/`: node,
property, component and pre-binding tests) pass, and all 98 Core tests pass
with the evaluator installed.

**Knowledge-graph tools** (`/ai`): there is no conformance suite for tools; the tests
(`test/ai/`) drive every handler against an in-memory engine and round-trip the tools through `McpTest`.
