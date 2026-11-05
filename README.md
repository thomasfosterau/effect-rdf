# effect-rdf

An [Effect](https://effect.website)-native toolkit for RDF 1.2 / RDF-star:
an immutable data model, parsers and serialisers for every common syntax,
a SPARQL 1.1 / 1.2 engine, and SHACL and ShEx validation. Every package is
self-contained TypeScript built on Effect 4 — typed errors, `Stream`s,
services and layers, `Schema` integration — and is checked against the W3C
and community conformance suites.

## Packages

| Package                                                        | Purpose                                                                                                                                                                                                                                                                   | Specification                                                                                                                                                                                                                                                                                               | Conformance                                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@thomasfosterau/effect-rdf`](packages/core)                  | Core: terms, quads, immutable indexed `Dataset`, IRIs, prefix maps, vocabularies, XSD, RDFS, isomorphism, serialisation interfaces                                                                                                                                        | [RDF 1.2 Concepts](https://www.w3.org/TR/rdf12-concepts/), [RDF Schema](https://www.w3.org/TR/rdf12-schema/)                                                                                                                                                                                                | Unit tests (the syntax packages exercise it against the RDF suites)                                                                                                               |
| [`@thomasfosterau/effect-ntriples`](packages/ntriples)         | N-Triples and N-Quads: strict and streaming parsers, canonical serialisers                                                                                                                                                                                                | [N-Triples](https://www.w3.org/TR/rdf12-n-triples/), [N-Quads](https://www.w3.org/TR/rdf12-n-quads/)                                                                                                                                                                                                        | Full W3C rdf11 / rdf12 suites (syntax and canonicalisation)                                                                                                                       |
| [`@thomasfosterau/effect-turtle`](packages/turtle)             | Turtle and TriG parsers / pretty-printers (RDF 1.2 triple terms, reifiers, annotations); test-manifest reader                                                                                                                                                             | [Turtle](https://www.w3.org/TR/rdf12-turtle/), [TriG](https://www.w3.org/TR/rdf12-trig/)                                                                                                                                                                                                                    | Every W3C rdf11 / rdf12 syntax and evaluation test; positive tests round-trip                                                                                                     |
| [`@thomasfosterau/effect-n3`](packages/n3)                     | Notation3 model, parser, serialiser, dataset mapping and a forward-chaining reasoner                                                                                                                                                                                      | [Notation3](https://w3c.github.io/N3/spec/)                                                                                                                                                                                                                                                                 | W3C N3 CG syntax suites (documented skip list); reasoner suite 76 / 89                                                                                                            |
| [`@thomasfosterau/effect-jsonld`](packages/jsonld)             | JSON-LD 1.1 processor: expansion, compaction, flattening, framing, RDF conversion, document loaders                                                                                                                                                                       | [JSON-LD 1.1 API](https://www.w3.org/TR/json-ld11-api/), [Framing](https://www.w3.org/TR/json-ld11-framing/)                                                                                                                                                                                                | W3C expand, compact, flatten, toRdf, fromRdf, remote-doc and framing suites (skips only JSON-LD 1.0-only and generalized-RDF tests)                                               |
| [`@thomasfosterau/effect-rdfxml`](packages/rdfxml)             | RDF/XML parser and serialiser on a small namespace-aware XML parser (with Exclusive XML Canonicalization)                                                                                                                                                                 | [RDF 1.2 XML Syntax](https://www.w3.org/TR/rdf12-xml/)                                                                                                                                                                                                                                                      | Every W3C RDF 1.1 and RDF 1.2 RDF/XML test                                                                                                                                        |
| [`@thomasfosterau/effect-rdfjson`](packages/rdfjson)           | RDF/JSON codec built on Effect `Schema`                                                                                                                                                                                                                                   | [RDF 1.1 JSON Alternate Serialization](https://www.w3.org/TR/rdf-json/)                                                                                                                                                                                                                                     | Unit tests (no W3C suite exists)                                                                                                                                                  |
| [`@thomasfosterau/effect-xmp`](packages/xmp)                   | XMP packets as RDF: packet scanning and padding, the XMP data model, typed accessors for Dublin Core, XMP, PDF, PDF/A, Photoshop, EXIF and TIFF, JPEG and PNG extraction                                                                                                  | [XMP (ISO 16684-1)](https://www.iso.org/standard/75163.html), [PDF/A (ISO 19005)](https://www.pdfa.org/resource/iso-19005-pdfa/)                                                                                                                                                                            | veraPDF corpus metadata sections: 497 / 497 passing files read; unit tests modelled on ISO 16684-1                                                                                |
| [`@thomasfosterau/effect-sparql`](packages/sparql)             | SPARQL parser, generator, algebra, optimiser, streaming query / update engine, results formats, typed builder; a Protocol + Graph Store Protocol server over `effect/http` (with an `HttpApi` definition, OpenAPI and a CLI) and a typed client with `SERVICE` federation | [SPARQL 1.1 Query](https://www.w3.org/TR/sparql11-query/) / [Update](https://www.w3.org/TR/sparql11-update/), [SPARQL 1.2](https://www.w3.org/TR/sparql12-query/), [SPARQL 1.1 Protocol](https://www.w3.org/TR/sparql11-protocol/), [Graph Store Protocol](https://www.w3.org/TR/sparql11-http-rdf-update/) | Syntax 574 / 574; evaluation 707 / 707 runnable, in-process and over HTTP (entailment skipped); `service` 7 / 7; protocol 34 / 34, graph store 14 / 14, service description 3 / 3 |
| [`@thomasfosterau/effect-shacl`](packages/shacl)               | SHACL Core validator: typed shapes graphs, paths, validation reports, `Schema` integration                                                                                                                                                                                | [SHACL](https://www.w3.org/TR/shacl/)                                                                                                                                                                                                                                                                       | 98 / 98 Core tests                                                                                                                                                                |
| [`@thomasfosterau/effect-shacl-sparql`](packages/shacl-sparql) | SHACL-SPARQL: SPARQL-based constraints, constraint components and targets on the SPARQL engine                                                                                                                                                                            | [SHACL-SPARQL](https://www.w3.org/TR/shacl/#sparql-constraints), [SHACL-AF targets](https://www.w3.org/TR/shacl-af/#targets)                                                                                                                                                                                | 22 / 22 SHACL-SPARQL tests (and the 98 Core tests with the evaluator)                                                                                                             |
| [`@thomasfosterau/effect-shex`](packages/shex)                 | ShEx: ShExC / ShExJ / ShExR, validation with shape maps and semantic actions                                                                                                                                                                                              | [ShEx 2.1](https://shex.io/shex-semantics/)                                                                                                                                                                                                                                                                 | shexTest: schemas 484 / 484, validation 1309 / 1309, negative syntax 105 / 105, negative structure 19 / 19                                                                        |
| [`@thomasfosterau/effect-sparql-sql`](packages/sparql-sql)     | SQL storage backend for the SPARQL engine on `effect/sql` (SQLite, PostgreSQL): term dictionary with triple terms, `QuadStore`, SPARQL-to-SQL `QueryCapability`                                                                                                           | [SPARQL 1.1 Query](https://www.w3.org/TR/sparql11-query/)                                                                                                                                                                                                                                                   | evaluation 707 / 707 runnable on SQLite and on PostgreSQL (PGlite)                                                                                                                |
| [`@thomasfosterau/effect-sparql-ai`](packages/sparql-ai)       | Knowledge-graph tools for `effect/ai`: a read-only SPARQL / dataset `Toolkit` for `LanguageModel` and an MCP server registration                                                                                                                                          | [MCP](https://modelcontextprotocol.io/specification)                                                                                                                                                                                                                                                        | —                                                                                                                                                                                 |

Each package has a README with its API and usage examples.

## Install

The packages are published to npm under the `@thomasfosterau` scope and have
`effect` (4.x) as a peer dependency (`effect-turtle`, `effect-sparql`,
`effect-shex`, `effect-n3`, `effect-rdfxml` and `effect-xmp` also have `@thomasfosterau/effect-parse`):

```sh
pnpm add effect @thomasfosterau/effect-parse @thomasfosterau/effect-rdf @thomasfosterau/effect-turtle
pnpm add @thomasfosterau/effect-sparql @thomasfosterau/effect-shacl @thomasfosterau/effect-shacl-sparql
```

## Quick tour

Parse Turtle into a `Dataset`, query it with the typed SPARQL builder,
validate it with SHACL (including a SHACL-SPARQL constraint) and serialise it
as JSON-LD. This example is type-checked and run by the test suite
([`packages/shacl-sparql/test/readme-example.test.ts`](packages/shacl-sparql/test/readme-example.test.ts)).

```ts
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
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

const program = Effect.fn('program')(function* () {
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
    Effect.provideService(Engine.SparqlEngine, Engine.make(yield* Store.makeMemory(dataset))),
  );
  // [{ name: 'Alice', age: 42 }, { name: 'Bob', age: -1 }]

  // 3. Validate it with SHACL; the evaluator layer (provided at the entry point) enables
  //    SHACL-SPARQL.
  const shapesGraph = (yield* Turtle.parse(shapes)).dataset;
  const report = yield* Validator.validate(dataset, shapesGraph);
  // report.conforms === false: "http://example.org/bob has an invalid age: -1"

  // 4. Serialise it as JSON-LD (compacted with the given prefixes).
  const jsonld = yield* JsonLd.serialize(dataset, {
    prefixes: PrefixMap.make({ ex: 'http://example.org/' }),
  });

  return { people, report: ValidationReport.format(report), jsonld };
});

Effect.runPromise(program().pipe(Effect.provide(Evaluator.layer()))).then(console.log);
```

## Tracing

Every public, coarse-grained operation opens a span; nothing is traced per token, quad or binding, and with no tracer installed the spans cost next to nothing. The span names are `<Module>.<operation>`:

- **Syntaxes:** `NTriples.parse`, `NQuads.parseStream`, `Turtle.serialize`, `TriG.serializeStream`, `N3.parse`, `JsonLd.parse`, `RdfXml.parse`, `RdfJson.serialize`, `Xmp.parse`, and so on (`parse`, `parseStream`, `serialize` and `serializeStream` where a syntax has them). Attributes: `rdf.format`, `rdf.media_type`, `rdf.input.length` (characters, never the content), and on completion `rdf.quads` (parse) or `rdf.output.length` (serialise).
- **SPARQL:** `SparqlEngine.query` (`sparql.query.form`) and `SparqlEngine.update` (`sparql.update.operations`). The query text is recorded (`sparql.query.text`) only when `Engine.make(store, { traceQueryText: true })` opts in, since queries may contain user data. `SparqlClient.*`, `Federation.*`, `SparqlServer.*` and `SqlStore.query` trace the HTTP and SQL edges.
- **Validation and reasoning:** `Shacl.validate` (`shacl.shapes`, `shacl.results`, `shacl.conforms`), `ShEx.validate` (`shex.associations`, `shex.nonconformant`, `shex.conformant`), `Reasoner.reason` (`n3.input.statements`, `n3.statements`) and `DocumentLoader.load` (`url.full`).

To see them, provide a tracer: for example Effect's OTLP exporter from `effect/observability`:

```ts
import { Effect, Layer } from 'effect';
import * as Otlp from 'effect/observability/Otlp';
import * as OtlpSerialization from 'effect/observability/OtlpSerialization';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';

const Observability = Otlp.layer({
  baseUrl: 'http://localhost:4318',
  resource: { serviceName: 'my-rdf-app' },
}).pipe(Layer.provide([OtlpSerialization.layerJson, FetchHttpClient.layer]));

program.pipe(Effect.provide(Observability));
```

## Development

The repository is a pnpm 11 workspace driven by [Vite+](https://viteplus.dev)
(`vp`). Node ≥ 22 and pnpm 11 are required.

```sh
pnpm install                              # dependencies, git hooks, the @effect/tsgo patch
./scripts/fetch-test-suites.sh            # clone the conformance suites into .test-suites (git-ignored)
vp check                                  # format + lint
vp run --concurrency-limit 2 check        # type-check every package
vp run --concurrency-limit 2 -r test:unit # all unit and conformance tests
vp run -r build                           # build every package (vp pack → dist/)
```

Conformance tests read the suites from `.test-suites/` or `$RDF_TEST_SUITES`
(`rdf-tests`, `json-ld-api`, `json-ld-framing`, `data-shapes`, `shexTest`,
`N3`) and are skipped when the suites are absent; CI always fetches them.

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, hooks and individual checks.
- [AGENTS.md](AGENTS.md) — repository conventions and the verification gates.
- [PUBLISHING.md](PUBLISHING.md) — the Changesets release pipeline (npm trusted publishing).
- [SECURITY.md](SECURITY.md) — reporting a vulnerability, untrusted-input defences.

## Architecture

```
effect-rdf (core) ── Term · Dataset · Serialization · Formats · PrefixMap · Rdfs · Isomorphism
 ├─ syntaxes: effect-ntriples · effect-turtle · effect-n3 · effect-jsonld · effect-rdfxml · effect-rdfjson
 │   └─ effect-xmp (on effect-rdfxml)
 ├─ effect-sparql ── engine · protocol server and client · QuadStore / QueryCapability ←─ effect-sparql-sql
 │   └─ effect-sparql-ai (effect/ai Toolkit and MCP tools over the engine)
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
