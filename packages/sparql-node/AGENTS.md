# @thomasfosterau/effect-sparql-node

The Node runtime boundary for effect-rdf's `/sparql`: the `node:http` server, the CLI and the `SparqlApi` `HttpApi`.

## Boundary

- Peers: `effect` (`catalogs.platform-node-peers`), `@thomasfosterau/effect-parse`, `@thomasfosterau/effect-xml`. Dependencies: `@thomasfosterau/effect-rdf` (through its published subpaths only) and `@effect/platform-node`.
- `Cli.ts`, `NodeSparqlServer.ts` and `bin/` are the only files that import `@effect/platform-node` or `node:*`.

## Invariants

- The `effect` floor is `^4.1.2`: `@effect/platform-node` declares it, and `SparqlApi` passes `HttpApiSchema.StreamUint8Array` a list of content types, which 4.0 does not accept.
- `SparqlApi.ts` is the shared definition and imports nothing Node. `SparqlApiBuilder` serves it by delegating to effect-rdf's `SparqlServer`; the protocol suites (`test/ProtocolConformance.test.ts`) run against both servers.
- Every CLI flag has a `SPARQL_SERVER_*` environment variable; a flag wins over the environment, which wins over the default.
