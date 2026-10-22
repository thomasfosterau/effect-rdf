# @thomasfosterau/effect-sparql-client

A typed SPARQL 1.1 Protocol and Graph Store client on `effect/http` `HttpClient`: string, `Ast` or `QueryBuilder` queries with typed (optionally `Schema`-decoded) rows, streaming result parsing, updates, Graph Store operations, typed errors, timeouts and retries, and `Federation` (`SERVICE` / `LOAD` for the in-memory engine).

## Boundary

Peers: `effect`. Imports from this workspace: core, jsonld, n3, ntriples, rdfjson, rdfxml, sparql, turtle (tests also use sparql-server) — `.fallowrc.json` zone `sparql-client`.

## Invariants

- **Results stream:** JSON, XML, TSV and CSV `SELECT` results and N-Triples graphs are parsed incrementally.
- **Every failure is a `SparqlClientError` member** (`HttpStatusError` with the body, `MalformedResponseError`, `UnsupportedMediaTypeError`, `TransportError`, `TimeoutError`, `ConfigurationError`); retries apply to transient failures only by default.
- **707 / 707 evaluation tests pass over HTTP** against an in-process `effect-sparql-server`; `service` 7 / 7. The declaration build uses `tsconfig.build.json` (src only) because the tests import the sparql package's test support.

## Terms

- **Federation** — evaluating `SERVICE <url> { … }` by sending the group to that endpoint.
