# effect-rdf

An [Effect](https://effect.website)-native toolkit for RDF 1.2 / RDF-star:
an immutable data model, parsers and serialisers for every common syntax,
a SPARQL 1.1 / 1.2 engine, and SHACL and ShEx validation. Every package is
self-contained TypeScript built on Effect 4 — typed errors, `Stream`s,
services and layers, `Schema` integration — and is checked against the W3C
and community conformance suites.

## Packages

| Package                                                        | Purpose                                                                                                                                                         | Specification                                                                                                                                                     | Conformance                                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`@thomasfosterau/effect-rdf`](packages/core)                  | Core: terms, quads, immutable indexed `Dataset`, IRIs, prefix maps, vocabularies, XSD, RDFS, isomorphism, serialisation interfaces                              | [RDF 1.2 Concepts](https://www.w3.org/TR/rdf12-concepts/), [RDF Schema](https://www.w3.org/TR/rdf12-schema/)                                                      | Unit tests (the syntax packages exercise it against the RDF suites)                                                                 |
| [`@thomasfosterau/effect-ntriples`](packages/ntriples)         | N-Triples and N-Quads: strict and streaming parsers, canonical serialisers                                                                                      | [N-Triples](https://www.w3.org/TR/rdf12-n-triples/), [N-Quads](https://www.w3.org/TR/rdf12-n-quads/)                                                              | Full W3C rdf11 / rdf12 suites (syntax and canonicalisation)                                                                         |
| [`@thomasfosterau/effect-turtle`](packages/turtle)             | Turtle and TriG parsers / pretty-printers (RDF 1.2 triple terms, reifiers, annotations); test-manifest reader                                                   | [Turtle](https://www.w3.org/TR/rdf12-turtle/), [TriG](https://www.w3.org/TR/rdf12-trig/)                                                                          | Every W3C rdf11 / rdf12 syntax and evaluation test; positive tests round-trip                                                       |
| [`@thomasfosterau/effect-n3`](packages/n3)                     | Notation3 model, parser, serialiser, dataset mapping and a forward-chaining reasoner                                                                            | [Notation3](https://w3c.github.io/N3/spec/)                                                                                                                       | W3C N3 CG syntax suites (documented skip list); reasoner suite 76 / 89                                                              |
| [`@thomasfosterau/effect-jsonld`](packages/jsonld)             | JSON-LD 1.1 processor: expansion, compaction, flattening, framing, RDF conversion, document loaders                                                             | [JSON-LD 1.1 API](https://www.w3.org/TR/json-ld11-api/), [Framing](https://www.w3.org/TR/json-ld11-framing/)                                                      | W3C expand, compact, flatten, toRdf, fromRdf, remote-doc and framing suites (skips only JSON-LD 1.0-only and generalized-RDF tests) |
| [`@thomasfosterau/effect-rdfxml`](packages/rdfxml)             | RDF/XML parser and serialiser on a small namespace-aware XML parser (with Exclusive XML Canonicalization)                                                       | [RDF 1.2 XML Syntax](https://www.w3.org/TR/rdf12-xml/)                                                                                                            | Every W3C RDF 1.1 and RDF 1.2 RDF/XML test                                                                                          |
| [`@thomasfosterau/effect-rdfjson`](packages/rdfjson)           | RDF/JSON codec built on Effect `Schema`                                                                                                                         | [RDF 1.1 JSON Alternate Serialization](https://www.w3.org/TR/rdf-json/)                                                                                           | Unit tests (no W3C suite exists)                                                                                                    |
| [`@thomasfosterau/effect-sparql`](packages/sparql)             | SPARQL parser, generator, algebra, optimiser, streaming query / update engine, results formats, typed builder                                                   | [SPARQL 1.1 Query](https://www.w3.org/TR/sparql11-query/) / [Update](https://www.w3.org/TR/sparql11-update/), [SPARQL 1.2](https://www.w3.org/TR/sparql12-query/) | Syntax 574 / 574; evaluation 707 / 707 runnable (entailment and `SERVICE` tests skipped)                                            |
| [`@thomasfosterau/effect-shacl`](packages/shacl)               | SHACL Core validator: typed shapes graphs, paths, validation reports, `Schema` integration                                                                      | [SHACL](https://www.w3.org/TR/shacl/)                                                                                                                             | 98 / 98 Core tests                                                                                                                  |
| [`@thomasfosterau/effect-shacl-sparql`](packages/shacl-sparql) | SHACL-SPARQL: SPARQL-based constraints, constraint components and targets on the SPARQL engine                                                                  | [SHACL-SPARQL](https://www.w3.org/TR/shacl/#sparql-constraints), [SHACL-AF targets](https://www.w3.org/TR/shacl-af/#targets)                                      | 22 / 22 SHACL-SPARQL tests (and the 98 Core tests with the evaluator)                                                               |
| [`@thomasfosterau/effect-shex`](packages/shex)                 | ShEx: ShExC / ShExJ / ShExR, validation with shape maps and semantic actions                                                                                    | [ShEx 2.1](https://shex.io/shex-semantics/)                                                                                                                       | shexTest: schemas 484 / 484, validation 1309 / 1309, negative syntax 105 / 105, negative structure 19 / 19                          |
| [`@thomasfosterau/effect-sparql-sql`](packages/sparql-sql)     | SQL storage backend for the SPARQL engine on `effect/sql` (SQLite, PostgreSQL): term dictionary with triple terms, `QuadStore`, SPARQL-to-SQL `QueryCapability` | [SPARQL 1.1 Query](https://www.w3.org/TR/sparql11-query/)                                                                                                         | evaluation 707 / 707 runnable on SQLite and on PostgreSQL (PGlite)                                                                  |
| `@thomasfosterau/effect-sparql-server`                         | SPARQL 1.1 Protocol + Graph Store Protocol server over `effect/http`, with content negotiation, service description, timeouts, read-only mode and a CLI         | [SPARQL 1.1 Protocol](https://www.w3.org/TR/sparql11-protocol/), [Graph Store Protocol](https://www.w3.org/TR/sparql11-http-rdf-update/)                          | protocol 34/34, graph store 14/14, service description 3/3                                                                          |
| `@thomasfosterau/effect-sparql-client`                         | Strongly-typed SPARQL client over `effect/http` `HttpClient`: typed builder rows, streaming results, Graph Store operations, `SERVICE` federation               | [SPARQL 1.1 Protocol](https://www.w3.org/TR/sparql11-protocol/)                                                                                                   | 707/707 evaluation tests over HTTP; `service` 7/7                                                                                   |

Each package has a README with its API and usage examples.

## Install

The packages are published under the `@thomasfosterau` scope and have
`effect` (4.x) as a peer dependency (`effect-sparql` and `effect-shex`
also have `@thomasfosterau/effect-parse`):

```sh
pnpm add effect @thomasfosterau/effect-rdf @thomasfosterau/effect-turtle
pnpm add @thomasfosterau/effect-parse @thomasfosterau/effect-sparql @thomasfosterau/effect-shacl @thomasfosterau/effect-shacl-sparql
```

## Quick tour

Parse Turtle into a `Dataset`, query it with the typed SPARQL builder,
validate it with SHACL (including a SHACL-SPARQL constraint) and serialise it
as JSON-LD. This example is type-checked and run by the test suite
([`packages/shacl-sparql/test/readme-example.test.ts`](packages/shacl-sparql/test/readme-example.test.ts)).

```ts
import { Effect, Layer, Schema, Stream } from 'effect';
import { Namespace, PrefixMap } from '@thomasfosterau/effect-rdf';
import { JsonLd } from '@thomasfosterau/effect-jsonld';
import { ValidationReport, Validator } from '@thomasfosterau/effect-shacl';
import { Evaluator } from '@thomasfosterau/effect-shacl-sparql';
import { Engine, QueryBuilder as Q, Store, TermSchema } from '@thomasfosterau/effect-sparql';
import { Turtle } from '@thomasfosterau/effect-turtle';

const ex = Namespace.make('http://example.org/');

const data = `
  @prefix ex: <http://example.org/> .
  ex:alice a ex:Person ; ex:name "Alice" ; ex:age 42 ; ex:knows ex:bob .
  ex:bob a ex:Person ; ex:name "Bob" ; ex:age -1 .
`;

const shapes = `
  @prefix sh: <http://www.w3.org/ns/shacl#> .
  @prefix ex: <http://example.org/> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
  ex:PersonShape a sh:NodeShape ;
    sh:targetClass ex:Person ;
    sh:property [ sh:path ex:name ; sh:minCount 1 ; sh:datatype xsd:string ] ;
    sh:property [
      sh:path ex:age ; sh:datatype xsd:integer ; sh:minInclusive 0 ;
      sh:message "{$this} has an invalid age: {?value}" ;
    ] ;
    # A SHACL-SPARQL constraint: nobody knows themselves.
    sh:sparql [
      sh:message "{$this} knows themselves" ;
      sh:select "SELECT $this WHERE { $this <http://example.org/knows> $this }" ;
    ] .
`;

const program = Effect.gen(function* () {
  // 1. Parse Turtle into a core Dataset.
  const { dataset } = yield* Turtle.parse(data);

  // 2. Query it with the typed SPARQL query builder (rows are typed from the projection).
  const v = Q.vars('person', 'name', 'age');
  const query = Q.select('name', 'age')
    .where(Q.triple(v.person, ex('name'), v.name), Q.triple(v.person, ex('age'), v.age))
    .orderBy(Q.asc(v.name));
  const people = yield* Q.decode(
    query,
    Schema.Struct({ name: TermSchema.string, age: TermSchema.integer }),
  ).pipe(
    Stream.runCollect,
    Effect.provide(Engine.layer().pipe(Layer.provide(Store.layerMemory(dataset)))),
  );
  // [{ name: 'Alice', age: 42 }, { name: 'Bob', age: -1 }]

  // 3. Validate it with SHACL; the evaluator layer enables SHACL-SPARQL.
  const shapesGraph = (yield* Turtle.parse(shapes)).dataset;
  const report = yield* Validator.validate(dataset, shapesGraph).pipe(
    Effect.provide(Evaluator.layer()),
  );
  // report.conforms === false: "http://example.org/bob has an invalid age: -1"

  // 4. Serialise it as JSON-LD (compacted with the given prefixes).
  const jsonld = yield* JsonLd.serialize(dataset, {
    prefixes: PrefixMap.make({ ex: 'http://example.org/' }),
  });

  return { people, report: ValidationReport.format(report), jsonld };
});

Effect.runPromise(program).then(console.log);
```

## Development

The repository is a pnpm workspace driven by [Vite+](https://viteplus.dev)
(`vp`). Node ≥ 22.18 is required.

```sh
vp install                    # install dependencies
./scripts/fetch-test-suites.sh # clone the conformance suites into .test-suites (git-ignored)
vp check                      # format check, lint and type-check (vp check --fix to format)
vp test                       # all unit and conformance tests
vp run -r build               # build every package (vp pack → dist/)
```

Inside a package directory the same commands apply to that package only
(e.g. `cd packages/sparql && vp test`). Conformance tests read the suites
from `.test-suites/` or `$RDF_TEST_SUITES` (`rdf-tests`, `json-ld-api`,
`json-ld-framing`, `data-shapes`, `shexTest`, `N3`) and are skipped when the
suites are absent. CI runs `vp check`, fetches the suites, then runs
`vp test` and `vp run -r build`.

See [AGENTS.md](AGENTS.md) for the repository conventions.

## Architecture

```
effect-rdf (core) ── Term · Dataset · Serialization · Formats · PrefixMap · Rdfs · Isomorphism
 ├─ syntaxes: effect-ntriples · effect-turtle · effect-n3 · effect-jsonld · effect-rdfxml · effect-rdfjson
 ├─ effect-sparql ── QuadStore / QueryCapability ←─ effect-sparql-sql, protocol server / client
 ├─ effect-shacl ── SparqlConstraintEvaluator ←─ effect-shacl-sparql (uses effect-sparql)
 └─ effect-shex
```

### Core types

`Term` is the RDF 1.2 term model: `NamedNode`, `BlankNode`, `Literal` (with
language tags and base directions), `Triple` (triple terms), `DefaultGraph`
and SPARQL `Variable`s, plus `Quad`. Terms are immutable values implementing
Effect's `Equal` and `Hash`; each carries a canonical `key` (its N-Triples
form). `Dataset` is a persistent, indexed set of quads (Effect `HashMap`s
with per-position indexes) with pattern matching, set operations, RDF list
helpers and a `Schema`. `Isomorphism.isomorphic` compares datasets up to
blank node renaming; `Rdfs` provides class/property reasoning and
entailment; `Iri`, `PrefixMap`, `Namespace`, `Vocab` and `Xsd` cover IRIs,
prefixes, vocabularies and datatypes; `RdfJs` converts to and from RDF/JS.

### Serialization interfaces

Every syntax package implements `Serialization.Parser`,
`Serialization.Serializer` and `Serialization.Codec` (built with
`makeParser` / `makeSerializer` / `makeCodec` / `makeFormat`) and exports
`format`, `parser`, `serializer`, `codec`, `parse(input, options?)` and
`serialize(quads, options?)`. Parsing fails with `RdfParseError` (carrying
`line` / `column`), serialising with `RdfSerializeError`. A codec also
exposes a `Schema` transforming `string ⇄ Dataset` (`Serialization.toSchema`).

### `Formats` service

`Serialization.Formats` is a registry of parsers and serializers, built from
codecs with `Serialization.layer(Turtle.codec, JsonLd.codec, …)`. It looks
formats up by media type (`parserFor`, `serializerFor`) or file extension
(`parserForExtension`) and performs HTTP content negotiation
(`parseAccept`, `negotiate`) — the basis for protocol servers.

### Extension points

- **`Store.QuadStore`** (effect-sparql): the storage service the SPARQL engine
  runs on — `match`, optional `estimate`, graph management, `insert` /
  `delete` and `transaction`. `Store.layerMemory` provides the in-memory store
  over a core `Dataset`.
- **`Store.QueryCapability`**: an optional `QuadStore.query` member that is
  offered every algebra node top-down and may evaluate whole subtrees
  natively (e.g. translate BGPs, joins and filters to SQL), delegating the
  rest back to the engine.
- **`Engine.EngineOptions`**: `service` (federation for `SERVICE`), `load`
  (`LOAD`), extension `functions`; `RequestOptions` carries the per-request
  dataset and pre-bound variables.
- **`Sparql.SparqlConstraintEvaluator`** (effect-shacl): how the SHACL
  validator evaluates SHACL-SPARQL, implemented by `effect-shacl-sparql`, so
  the core validator has no SPARQL dependency.
- **`DocumentLoader`** (effect-jsonld): remote context and document loading.

## License

[MIT](LICENSE)
