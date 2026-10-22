# @thomasfosterau/effect-sparql-server

A SPARQL 1.1 Protocol and Graph Store HTTP Protocol server on `effect/http` and the `effect-sparql` engine, with content negotiation over the `Serialization.Formats` service, service description, read-only mode, time limits, a `Testing` harness and a CLI (`bin/effect-sparql-server.mjs`).

## Boundary

Peers: `effect`. Runtime dependencies: `@effect/platform-node`. Imports from this workspace: core, jsonld, n3, ntriples, rdfjson, rdfxml, sparql, turtle — `.fallowrc.json` zone `sparql-server`.

## Invariants

- **Status codes are the protocol's:** `400` / `403` / `405` (with `Allow`) / `406` / `415` / `500` / `503` as the README lists; the protocol (34 / 34), graph store (14 / 14) and service description (3 / 3) suites pin them.
- **Responses stream,** but the status waits for the first solution, so errors and timeouts before it get a proper status code.
- **`Cli.ts` and the listener are the Node runtime boundary;** everything else is `effect/http` and runs under any `HttpServer`.

## Terms

- **Direct / indirect identification** — Graph Store addressing by URL path vs `?graph=<iri>`.
