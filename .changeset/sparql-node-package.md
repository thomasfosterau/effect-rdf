---
'@thomasfosterau/effect-sparql-node': minor
---

New package: the Node side of `@thomasfosterau/effect-rdf/sparql`. `NodeSparqlServer.layer` / `layerMemory` serve effect-rdf's platform-neutral `SparqlServer` on a `node:http` socket (through `@effect/platform-node`); `Cli` and the `effect-sparql-server` executable serve RDF files from the command line; `SparqlApi` describes the SPARQL 1.1 Protocol and Graph Store HTTP Protocol as an Effect `HttpApi` (with its OpenAPI document), served by `SparqlApiBuilder` (`makeTestClient` is an in-process client for its routes) and with the derived `SparqlApiClient`. Peers: `effect` `^4.1.2` (its `@effect/platform-node` 4.1.2 dependency requires it, and `SparqlApi` uses 4.1's list of content types per response stream) and `@thomasfosterau/effect-parse` `^0.4.0`. Service keys: `@thomasfosterau/effect-sparql-node/SparqlApiClient` and `…/SparqlApi/SchemaFallback`.
