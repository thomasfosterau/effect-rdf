# @thomasfosterau/effect-sparql-node

The Node side of [`@thomasfosterau/effect-rdf/sparql`](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/sparql.md): a SPARQL 1.1 Protocol and Graph Store server on `node:http`, the `effect-sparql-server` command, and the typed `SparqlApi` `HttpApi` definition with its server and derived client.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add effect @thomasfosterau/effect-parse @thomasfosterau/effect-xml @thomasfosterau/effect-rdf @thomasfosterau/effect-sparql-node
```

`effect` (`^4.1.2`, which `@effect/platform-node` needs), `@thomasfosterau/effect-parse` and `@thomasfosterau/effect-xml` are peers.

## Example

```sh
effect-sparql-server --port 3030 data.ttl
```

## Entry points

| Module                                             | What it holds                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `NodeSparqlServer`                                 | The protocol server on a `node:http` socket (`layer`, `layerMemory`)    |
| `Cli`                                              | The `effect-sparql-server` command                                      |
| `SparqlApi`, `SparqlApiBuilder`, `SparqlApiClient` | The protocols as an `HttpApi` (with OpenAPI), its routes and its client |

Each is also a subpath (`@thomasfosterau/effect-sparql-node/SparqlApi`, …). Usage and conformance: [guide](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/sparql-node/docs/guide.md).

## License

[MIT](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/sparql-node/LICENSE.md)
