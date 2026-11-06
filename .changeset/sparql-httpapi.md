---
'@thomasfosterau/effect-sparql-node': minor
---

Describe the SPARQL 1.1 Protocol and Graph Store HTTP Protocol as an Effect `effect/http-api` definition (#60).

- Server: `SparqlApi` is the `HttpApi` (groups `sparql` and `graphStore`) with every request and response media type, the protocol's error statuses and `openApi` for its OpenAPI document; `SparqlApiBuilder.layerRoutes` serves it with `HttpApiBuilder`, delegating to the existing protocol code so behaviour is identical (the conformance suites run against both servers), with fallback routes for `405`, CORS preflights and direct graph identification; `SparqlApiBuilder.makeTestClient` is an in-process client for those routes.
- Client: `SparqlApiClient` is a client derived from `SparqlApi` with `HttpApiClient`, with helpers that parse results and graphs (`results`, `construct`, `update`, `readGraph`, `writeGraph`), alongside the hand-written `SparqlClient`.

`effect/http-api` is `@stability unstable` in Effect 4.
