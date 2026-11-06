# @thomasfosterau/effect-sparql

The SPARQL 1.1 / 1.2 engine: parser (an LL(1) `effect-parse` grammar), AST and generator, algebra translation and optimizer, expression and function library, a streaming query / update `Engine` over the pluggable `QuadStore` service (and its `QueryCapability` extension point), the results formats and a typed `QueryBuilder`. On top of the engine, the same package ships:

- **the server** — a SPARQL 1.1 Protocol and Graph Store HTTP Protocol server on `effect/http` (`SparqlServer`, `Protocol`, `GraphStore`, `ServiceDescription`, `Options`, `ServerFormats`, `ProtocolErrors`), with content negotiation over the `Serialization.Formats` service, service description, read-only mode, time limits, its `HttpApi` definition (`SparqlApi`, served by `SparqlApiBuilder`), a `Testing` harness and a CLI (`Cli`, `bin/effect-sparql-server.mjs`);
- **the client** — a typed Protocol and Graph Store client on `effect/http` `HttpClient` (`SparqlClient`, `ClientErrors`, `ClientFormats`, `ResultsStream`): string, `Ast` or `QueryBuilder` queries with typed (optionally `Schema`-decoded) rows, streaming result parsing, updates, Graph Store operations, typed errors, timeouts and retries, `Federation` (`SERVICE` / `LOAD` for the in-memory engine) and `SparqlApiClient` derived from `SparqlApi`;
- **`/shacl`** (`src/shacl/`, formerly `effect-shacl-sparql`) — SHACL-SPARQL: implements the core's `@thomasfosterau/effect-rdf/shacl` `Sparql.SparqlConstraintEvaluator` (`Evaluator.layer` / `make`) for `sh:sparql` constraints, SPARQL-based constraint components and SHACL-AF SPARQL targets; `Query` reads `sh:select` / `sh:ask` with prefixes, pre-binding and `$PATH` substitution;
- **`/ai`** (`src/ai/`, formerly `effect-sparql-ai`) — knowledge-graph tools for `effect/ai`: `Tools` (the `sparql_query`, `describe_resource`, `list_classes`, `list_properties`, `search_labels` and opt-in `sparql_update` tools, the read-only `toolkit` / `toolkitWithUpdate`, and handler layers over `SparqlEngine`) and `Mcp` (their `McpServer.toolkit` registration).

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Runtime dependencies: `@effect/platform-node` (the server's Node listener and CLI). Imports from this workspace: core (its `/rdfjson` and `/shacl` subpaths included), jsonld, n3, ntriples, rdfxml, turtle — `.fallowrc.json` zone `sparql`.

Entry points: every `src/*.ts` is `./<Module>`; the `/shacl` and `/ai` subpaths are `./shacl` / `./ai` (their `index.ts` barrels) and `./shacl/<Module>` / `./ai/<Module>`, not on the root barrel. A subpath imports the engine through relative paths (`../Engine.ts`), never through the package's own name; the engine never imports a subpath.

## Invariants

- **Parse → generate → parse is stable,** and every static check of the specification (blank-node scoping, grouping, `BIND` scoping, `VALUES` arity, …) is a `SparqlParseError` with `line` / `column`.
- **The algebra is §18 exactly;** the optimizer is semantics-preserving (filter pushdown, join ordering by store estimates). The W3C evaluation suite (707 / 707 runnable) is the oracle; entailment tests are skipped with reasons, and `SERVICE` tests run over HTTP (`Federation.test.ts`).
- **Storage is a service:** the engine talks to `QuadStore` only; a backend may claim whole subtrees through `QueryCapability` (`effect-sparql-sql` does), and must return the same solutions.
- **Per-query semantics** for `NOW`, `RAND`, `UUID`, `STRUUID` and `BNODE` (one `NOW` per query).
- **Status codes are the protocol's:** `400` / `403` / `405` (with `Allow`) / `406` / `415` / `500` / `503` as the README lists; the protocol (34 / 34), graph store (14 / 14) and service description (3 / 3) suites pin them.
- **Responses stream,** but the status waits for the first solution, so errors and timeouts before it get a proper status code.
- **`SparqlApi.ts` is the shared `HttpApi` definition** (`SparqlApiClient` imports it): it must not import `SparqlServer.ts`, `Cli.ts` or anything Node. `SparqlApiBuilder` serves it with raw handlers delegating to `SparqlServer`, plus fallback routes (`405`, CORS, direct identification) and the `SchemaFallback` middleware; the conformance suites run against both.
- **`Cli.ts` and the listener are the Node runtime boundary** (with `bin/`); everything else is `effect/http` and runs under any `HttpServer`, and no module but those two imports `@effect/platform-node` or `node:*`. Of the server modules, the client imports only `SparqlApi` and `ProtocolErrors` (in `SparqlApiClient.ts`), which never reach Node.
- **Results stream on the client:** JSON, XML, TSV and CSV `SELECT` results and N-Triples graphs are parsed incrementally.
- **`SparqlApiClient` is derived from `SparqlApi`** with `HttpApiClient`; its failures are the generated client's (`ProtocolError`, `HttpClientError`, `SchemaError`) plus `MalformedResponseError` / `UnsupportedMediaTypeError`.
- **Every failure of `SparqlClient` is a `SparqlClientError` member** (`HttpStatusError` with the body, `MalformedResponseError`, `UnsupportedMediaTypeError`, `TransportError`, `TimeoutError`, `ConfigurationError`); retries apply to transient failures only by default.
- **707 / 707 evaluation tests also pass over HTTP** (client against an in-process server); `service` 7 / 7.

### `/shacl`

- **Pre-binding follows the specification exactly** (values insertion, `Algebra.prebind`), and its restrictions — `MINUS`, `VALUES`, `SERVICE`, `AS ?prebound`, sub-queries dropping pre-bound variables — are failures.
- **22 / 22 SHACL-SPARQL tests pass, and the 98 Core tests with the evaluator installed.**
- **`test/readme-example.test.ts` is the root README's quick tour:** change both together.

### `/ai`

- **Tool input is untrusted (model-generated).** `sparql_query` is read-only (it only parses queries), updates need the separate `toolkitWithUpdate`, every result is capped at `maxRows` and reports `isTruncated`, every call has a `timeout`, and `SERVICE` is refused unless `federation: true`. `SECURITY.md` states these; a change to any of them updates it.
- **Failures are returned to the model** (`failureMode: 'return'`, `SparqlToolError`), never thrown into the conversation.
- **Tool I/O is plain JSON:** SPARQL JSON results, Turtle text, IRIs as strings — the same shapes over `LanguageModel` and MCP.
- **The floor:** only `Tool`, `Toolkit` and `McpServer.toolkit` are used from `effect/ai`; transports (`McpServer.layerStdio` / `layerHttp`) are the caller's, since their options changed after rc.118. `McpTest` (4.1+) is test-only.

## Terms

- **Pre-binding** — SHACL-SPARQL's values insertion (`Algebra.prebind`); **solution** — a `Bindings` row.
- **Constraint component** (`/shacl`) — a SPARQL-defined, parameterised constraint (`sh:ConstraintComponent`).
- **Tool** / **toolkit** (`/ai`) — `effect/ai`'s `Tool.make` definitions and their `Toolkit`; **MCP** — the Model Context Protocol.
- **Federation** — evaluating `SERVICE <url> { … }` by sending the group to that endpoint.
- **Direct / indirect identification** — Graph Store addressing by URL path vs `?graph=<iri>`.
- **`Errors` / `ProtocolErrors` / `ClientErrors`** — the engine's evaluation and update errors, the server's HTTP-status `ProtocolError`, and the client's `SparqlClientError` members. **`ServerFormats` / `ClientFormats`** — the server's default codecs (Turtle first, for negotiation) and the client's (N-Triples first, parsed incrementally).
