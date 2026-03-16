# effect-rdf

An experimental **RDF-star** toolkit written in [Effect](https://effect.website/).

## Features

- **Fully typed** RDF data model — `IRI`, `BlankNode`, `Literal`, `Triple`, `Quad`
- **RDF-star** support — triples as subjects/objects (quoted triples)
- **Structural equality** and hashing via Effect's `Data` module
- **Effect-native services** — `Dataset`, `Parser`, and `Serializer` are all `Context.Tag` services backed by `Layer`s, enabling dependency injection and testability
- **Common vocabularies** built-in — `rdf`, `rdfs`, `owl`, `xsd`, `dcterms`, `foaf`, `skos`, `schema`
- **N-Triples / N-Quads** serialization out of the box

## Quick Start

```bash
bun install
bun test
```

## Usage

```typescript
import { Effect } from "effect"
import * as IRI from "effect-rdf/IRI"
import * as Literal from "effect-rdf/Literal"
import * as Quad from "effect-rdf/Quad"
import * as Dataset from "effect-rdf/Dataset"
import { RDF, SCHEMA } from "effect-rdf"

const program = Effect.gen(function* () {
  const dataset = yield* Dataset.Dataset

  // Build some triples
  const alice = IRI.makeUnsafe("https://example.org/alice")
  yield* dataset.add(Quad.make(alice, RDF.type, SCHEMA.Person))
  yield* dataset.add(Quad.make(alice, SCHEMA.name, Literal.string("Alice")))

  // Query by subject
  const aliceQuads = yield* dataset.match({ subject: alice })
  return aliceQuads
})

const result = await Effect.runPromise(
  program.pipe(Effect.provide(Dataset.make()))
)
```

## Modules

| Module | Description |
|--------|-------------|
| `IRI` | IRI value type, smart constructor, type-guard |
| `BlankNode` | BlankNode value type, `make`, `generateFresh` |
| `Literal` | Literal with datatype/language; helpers: `string`, `langString`, `integer`, `boolean`, `double`, `dateTime` |
| `Triple` | RDF triple (subject–predicate–object); RDF-star aware |
| `Quad` | Quad (triple + graph); `DefaultGraph`; `matchesPattern` |
| `Term` | Union types: `Subject`, `Predicate`, `RdfObject`, `GraphName`, `Term` |
| `Dataset` | `Context.Tag` service + in-memory `Layer` |
| `Parser` | `Context.Tag` service stub (N-Triples, N-Quads, Turtle, TriG) |
| `Serializer` | `Context.Tag` service; built-in N-Triples/N-Quads `nquads` layer |
| `Namespace` | `namespace()` factory + pre-built constants: `RDF`, `RDFS`, `OWL`, `XSD`, `DCTERMS`, `FOAF`, `SKOS`, `SCHEMA` |
| `Errors` | `InvalidIRIError`, `InvalidLiteralError`, `ParseError`, `SerializeError` |

## Design Principles

- **Effect idioms throughout**: errors are `Data.TaggedError` subclasses; services are `Context.Tag` + `Layer`; state uses `Ref`.
- **Structural equality**: all value types (`IRI`, `BlankNode`, `Literal`, `Triple`, `Quad`) use `Data.TaggedClass` so `Equal.equals` works correctly.
- **Incremental**: the `Parser.unimplemented` and `Serializer.unimplemented` layers let you wire the service into your dependency graph today while concrete parsers are added incrementally.

## License

MIT
