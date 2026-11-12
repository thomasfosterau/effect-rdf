# @thomasfosterau/effect-sparql-node

The Node side of `@thomasfosterau/effect-rdf/sparql`: `NodeSparqlServer` (the platform-neutral `SparqlServer` on a `node:http` socket, through `@effect/platform-node`'s `NodeHttpServer`), the `effect-sparql-server` command (`Cli`, `bin/effect-sparql-server.mjs`), and the two protocols as an Effect `HttpApi` (`SparqlApi`, served by `SparqlApiBuilder`, with the derived `SparqlApiClient`). These were part of `effect-sparql` before it was merged into effect-rdf, unpublished.

## Boundary

Peers: `effect` (`catalogs.platform-node-peers`, `^4.1.2`), `@thomasfosterau/effect-parse` and `@thomasfosterau/effect-xml` (effect-rdf's `/sparql` needs both). Runtime dependencies: `@thomasfosterau/effect-rdf` (imported only through its published subpaths, `@thomasfosterau/effect-rdf/sparql/<Module>`), `@effect/platform-node`. `.fallowrc.json` zone `sparql-node`, which may import `core` only. Nothing in the workspace imports it.

Entry points: every `src/*.ts` is `./<Module>`, and `.` re-exports them as namespaces.

## Invariants

- **This package is the Node runtime boundary.** `Cli.ts`, `NodeSparqlServer.ts` and `bin/` are the only files that import `@effect/platform-node` or `node:*`; effect-rdf imports neither (its `test/ModuleGraph.test.ts`).
- **Why the floor is `^4.1.2`:** `@effect/platform-node` 4.1.2 declares it, and `SparqlApi` gives `HttpApiSchema.StreamUint8Array` a list of content types (a 4.1 form, #60). On 4.0 a stream takes one content type, and the derived client would reject every response format but the first, so the `HttpApi` stays here rather than in effect-rdf.
- **`SparqlApi.ts` is the shared `HttpApi` definition** (`SparqlApiClient` imports it): it must not import `Cli.ts`, `NodeSparqlServer.ts` or anything Node. `SparqlApiBuilder` serves it with raw handlers delegating to effect-rdf's `SparqlServer`, plus fallback routes (`405`, CORS, direct identification) and the `SchemaFallback` middleware; `SparqlApiBuilder.makeTestClient` is an in-process client for those routes. The protocol suites run against both servers (`test/ProtocolConformance.test.ts`): Protocol 34 / 34, Graph Store 14 / 14, Service Description 3 / 3.
- **`SparqlApiClient` is derived from `SparqlApi`** with `HttpApiClient`; its failures are the generated client's (`ProtocolError`, `HttpClientError`, `SchemaError`) plus `MalformedResponseError` / `UnsupportedMediaTypeError`.
- **Every CLI flag has a `SPARQL_SERVER_*` environment variable;** a flag wins over the environment, which wins over the default (`test/Cli.test.ts`).

## Terms

- **Derived client** — `SparqlApiClient`, generated from the `SparqlApi` definition, beside effect-rdf's hand-written `SparqlClient`.
