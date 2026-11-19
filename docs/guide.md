# Guide

A tour of the toolkit, its tracing and its architecture. Each subpath's own guide is in [`packages/core/docs/`](../packages/core/docs/).

## Quick tour

Parse Turtle into a `Dataset`, query it with the typed SPARQL builder,
validate it with SHACL (including a SHACL-SPARQL constraint) and serialise it
as JSON-LD. This example is type-checked and run by the test suite
([`packages/core/test/sparql/guide-example.test.ts`](../packages/core/test/sparql/guide-example.test.ts)).

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
