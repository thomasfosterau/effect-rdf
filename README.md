# effect-rdf

An [Effect](https://effect.website)-native RDF 1.2 / RDF-star toolkit: an immutable data model, parsers and serialisers for every common syntax, a SPARQL 1.1 / 1.2 engine, and SHACL and ShEx validation, checked against the W3C and community conformance suites.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add effect @thomasfosterau/effect-rdf @thomasfosterau/effect-parse
```

`@thomasfosterau/effect-parse`, `@thomasfosterau/effect-xml` and `@thomasfosterau/effect-ext` are optional peers, needed only by some subpaths (see the [package README](packages/core/README.md)).

## Usage

```ts
import * as Effect from 'effect/Effect';
import { Turtle } from '@thomasfosterau/effect-rdf/turtle';

const program = Effect.gen(function* () {
  const { dataset } = yield* Turtle.parse('<urn:a> <urn:b> "c" .');
  return dataset.size; // 1
});
```

## Packages

| Package                                                                | What it is                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`@thomasfosterau/effect-rdf`](packages/core/README.md)                | The toolkit: data model at the root, one subpath per syntax and engine (`/turtle`, `/jsonld`, `/sparql`, `/shacl`, `/shex`, …) |
| [`@thomasfosterau/effect-sparql-node`](packages/sparql-node/README.md) | The Node SPARQL Protocol server, CLI and typed `SparqlApi`                                                                     |

## More

- [Guide](docs/guide.md): a tour, tracing and the architecture; each subpath's guide is in [`packages/core/docs/`](packages/core/docs/).
- [Contributing](docs/CONTRIBUTING.md), [publishing](docs/PUBLISHING.md), [security](docs/SECURITY.md).

## License

[MIT](LICENSE.md)
