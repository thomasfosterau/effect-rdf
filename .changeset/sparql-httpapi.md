---
'@thomasfosterau/effect-sparql-server': minor
'@thomasfosterau/effect-sparql-client': minor
---

Describe the SPARQL 1.1 Protocol and Graph Store HTTP Protocol as an Effect `effect/http-api` definition (#60).

- sparql-server: `SparqlApi` is the `HttpApi` (groups `sparql` and `graphStore`) with every request and response media type, the protocol's error statuses and `openApi` for its OpenAPI document; `SparqlApiBuilder.layerRoutes` serves it with `HttpApiBuilder`, delegating to the existing protocol code so behaviour is identical (the conformance suites run against both servers), with fallback routes for `405`, CORS preflights and direct graph identification; `Testing.makeApiClient` is an in-process client for those routes.
- sparql-client: `SparqlApiClient` is a client derived from `SparqlApi` with `HttpApiClient`, with helpers that parse results and graphs (`results`, `construct`, `update`, `readGraph`, `writeGraph`), alongside the hand-written `SparqlClient`. The package now depends on `@thomasfosterau/effect-sparql-server` for the shared definition.

`effect/http-api` is `@stability unstable` in Effect 4.
