# effect-rdf

An [Effect](https://effect.website)-native toolkit for RDF 1.2 / RDF-star:
an immutable data model, parsers and serialisers for every common syntax,
a SPARQL 1.1 / 1.2 engine, and SHACL and ShEx validation. It is one package,
`@thomasfosterau/effect-rdf`, with a subpath per syntax and engine, plus
`@thomasfosterau/effect-sparql-node` for the Node server. Everything is
self-contained TypeScript built on Effect 4 — typed errors, `Stream`s,
services and layers, `Schema` integration — and is checked against the W3C
and community conformance suites.

## Packages

| Package                                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Conformance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@thomasfosterau/effect-rdf`](packages/core)                | The whole toolkit, one subpath per area: the data model at the root (terms, quads, immutable indexed `Dataset`, IRIs, prefix maps, vocabularies, XSD, RDFS, isomorphism, serialisation interfaces); N-Triples and N-Quads (`/ntriples`), Turtle and TriG (`/turtle`), Notation3 with a reasoner (`/n3`), JSON-LD 1.1 (`/jsonld`), RDF/XML (`/rdfxml`), RDF/JSON (`/rdfjson`) and XMP (`/xmp`); CSV on the Web (`/csvw`); SHACL Core (`/shacl`) and ShEx (`/shex`); SPARQL 1.1 / 1.2 (`/sparql`: parser, algebra, engine, results formats, typed builder, platform-neutral Protocol / Graph Store handler and client), SHACL-SPARQL (`/sparql/shacl`), `effect/ai` tools (`/sparql/ai`) and the driver-agnostic SQL store with SPARQL-to-SQL translation (`/sparql/sql`) | W3C suites: N-Triples / N-Quads, Turtle / TriG and RDF/XML in full; N3 syntax (documented skip list), reasoner 76 / 89; JSON-LD (skips only 1.0-only and generalized-RDF tests); CSVW validation 276 / 276, csv2rdf 264 / 264, csv2json 264 / 264 run; SHACL Core 98 / 98, SHACL-SPARQL 22 / 22; SPARQL syntax 574 / 574, evaluation 707 / 707 runnable (in-process, over HTTP, on SQLite and on PostgreSQL), `service` 7 / 7; shexTest schemas 484 / 484, validation 1309 / 1309; veraPDF XMP 497 / 497 |
| [`@thomasfosterau/effect-sparql-node`](packages/sparql-node) | The Node side of `/sparql`: the Protocol / Graph Store server on `node:http` (`NodeSparqlServer`), the `effect-sparql-server` CLI, and the typed `SparqlApi` `HttpApi` definition with OpenAPI, its server and derived client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Protocol 34 / 34, Graph Store 14 / 14, Service Description 3 / 3, against both servers                                                                                                                                                                                                                                                                                                                                                                                                                   |

The package READMEs hold the API and usage examples (one section per subpath in effect-rdf's), and the specifications each subpath implements.

A SPARQL backend for a specific SQL driver is its own package, `@thomasfosterau/effect-sparql-<driver>`: a store layer over `/sparql/sql` with the driver as its dependency or peer. None exists yet.

## Install

The packages are published to npm under the `@thomasfosterau` scope.
`effect` is a peer dependency: `^4.0.0` for `effect-rdf`, `^4.1.2` for
`effect-sparql-node` (its `@effect/platform-node` dependency needs it).
`@thomasfosterau/effect-parse` is an optional peer of `effect-rdf`, needed by
the syntax and SPARQL-parser subpaths, and a peer of `effect-sparql-node`;
`@thomasfosterau/effect-xml` likewise, needed by the subpaths that read XML
(`/rdfxml`, `/xmp`, `/sparql`):

```sh
pnpm add effect @thomasfosterau/effect-parse @thomasfosterau/effect-xml @thomasfosterau/effect-rdf
pnpm add @thomasfosterau/effect-sparql-node # the Node server, CLI and SparqlApi
```

## Quick tour

Parse Turtle into a `Dataset`, query it with the typed SPARQL builder,
validate it with SHACL (including a SHACL-SPARQL constraint) and serialise it
as JSON-LD. This example is type-checked and run by the test suite
([`packages/core/test/sparql/readme-example.test.ts`](packages/core/test/sparql/readme-example.test.ts)).

```ts
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';
import { Namespace, PrefixMap } from '@thomasfosterau/effect-rdf';
import { JsonLd } from '@thomasfosterau/effect-rdf/jsonld';
import { ValidationReport, Validator } from '@thomasfosterau/effect-rdf/shacl';
import { Evaluator } from '@thomasfosterau/effect-rdf/sparql/shacl';
import { Engine, QueryBuilder as Q, Store, TermSchema } from '@thomasfosterau/effect-rdf/sparql';
import { Turtle } from '@thomasfosterau/effect-rdf/turtle';

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
effect-rdf ── Term · Dataset · Serialization · Formats · PrefixMap · Rdfs · Isomorphism (root entry)
 ├─ syntaxes: /ntriples · /turtle · /n3 · /jsonld · /rdfxml · /rdfjson
 │   └─ /xmp (on /rdfxml)
 ├─ /csvw (CSV on the Web)
 ├─ /shacl ── SparqlConstraintEvaluator ←─ /sparql/shacl
 ├─ /sparql ── engine · protocol handler and client · QuadStore / QueryCapability ←─ /sparql/sql
 │   ├─ /shacl (SHACL-SPARQL: the evaluator for /shacl)
 │   ├─ /ai (effect/ai Toolkit and MCP tools over the engine)
 │   └─ /sql (driver-agnostic SQL store ←─ effect-sparql-<driver> backends, none yet)
 └─ /shex

effect-sparql-node ── NodeSparqlServer · Cli · SparqlApi (HttpApi) ── on effect-rdf/sparql
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

Every syntax subpath implements `Serialization.Parser`,
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

- **`Store.QuadStore`** (`effect-rdf/sparql`): the storage service the SPARQL engine
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
- **`Sparql.SparqlConstraintEvaluator`** (`effect-rdf/shacl`): how the SHACL
  validator evaluates SHACL-SPARQL, implemented by `effect-rdf/sparql/shacl`, so
  `/shacl` imports no SPARQL.
- **`DocumentLoader`** (`effect-rdf/jsonld`): remote context and document loading.

## License

[MIT](LICENSE)
