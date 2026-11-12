# @thomasfosterau/effect-rdf

The [RDF 1.2](https://www.w3.org/TR/rdf12-concepts/) / RDF-star toolkit for [Effect](https://effect.website) 4, in one package. The root entry is the data model: terms with value equality, an immutable indexed `Dataset`, IRIs, prefix maps, typed vocabularies, XSD datatypes, RDF Schema entailment, RDF 1.2 reification, graph isomorphism and the serialisation interfaces every syntax implements. Everything else is a nested subpath, none of it on the root barrel, so a bundle carries only what it imports:

| Subpath                                                                 | What it holds                                                                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`/ntriples`](#n-triples-and-n-quads-thomasfosteraueffect-rdfntriples)  | N-Triples and N-Quads: strict and streaming parsers, canonical serialisers                                                         |
| [`/turtle`](#turtle-and-trig-thomasfosteraueffect-rdfturtle)            | Turtle and TriG parsers and pretty-printers; the W3C test-manifest reader                                                          |
| [`/n3`](#notation3-thomasfosteraueffect-rdfn3)                          | Notation3: model, parser, serialiser, dataset mapping and a forward-chaining reasoner                                              |
| [`/jsonld`](#json-ld-thomasfosteraueffect-rdfjsonld)                    | JSON-LD 1.1: expansion, compaction, flattening, framing, RDF conversion, document loaders                                          |
| [`/rdfxml`](#rdfxml-thomasfosteraueffect-rdfrdfxml)                     | RDF/XML on a small namespace-aware XML parser, with Exclusive XML Canonicalization                                                 |
| [`/rdfjson`](#rdfjson-thomasfosteraueffect-rdfrdfjson)                  | RDF/JSON on Effect `Schema`                                                                                                        |
| [`/xmp`](#xmp-thomasfosteraueffect-rdfxmp)                              | XMP packets as RDF, typed accessors for the common schemas, JPEG and PNG extraction                                                |
| [`/csvw`](#csv-on-the-web-thomasfosteraueffect-rdfcsvw)                 | CSV on the Web over already-parsed tables: metadata, the annotated tabular model, CSV2RDF and CSV2JSON                             |
| [`/shacl`](#shacl-thomasfosteraueffect-rdfshacl)                        | The SHACL Core validator                                                                                                           |
| [`/sparql`](#sparql-thomasfosteraueffect-rdfsparql)                     | SPARQL 1.1 / 1.2: parser, algebra, engine, results formats, typed builder, platform-neutral Protocol / Graph Store handler, client |
| [`/sparql/shacl`](#shacl-sparql-thomasfosteraueffect-rdfsparqlshacl)    | SHACL-SPARQL for `/shacl`                                                                                                          |
| [`/sparql/ai`](#knowledge-graph-tools-thomasfosteraueffect-rdfsparqlai) | Knowledge-graph tools for `effect/ai` and an MCP server registration                                                               |
| [`/sparql/sql`](#sparql-over-sql-thomasfosteraueffect-rdfsparqlsql)     | The driver-agnostic SQL store and SPARQL-to-SQL translation (SQLite and PostgreSQL dialects, `effect/sql` only)                    |
| [`/shex`](#shex-thomasfosteraueffect-rdfshex)                           | ShEx: ShExC, ShExJ, ShExR, validation with shape maps and semantic actions                                                         |

Each subpath is `@thomasfosterau/effect-rdf/<subpath>` (its barrel, re-exporting its modules as namespaces) and `@thomasfosterau/effect-rdf/<subpath>/<Module>`. The Node server, its CLI and the typed `SparqlApi` live in [`@thomasfosterau/effect-sparql-node`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/sparql-node).

```sh
pnpm add effect @thomasfosterau/effect-rdf
```

`effect` (`^4.0.0`) is a peer dependency. [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse) (`^0.4.0 || ^0.5.0`) is an optional peer, needed by the syntax and SPARQL-parser subpaths (`/ntriples`, `/turtle`, `/n3`, `/jsonld`, `/rdfxml`, `/xmp`, `/shex`, `/sparql`, `/sparql/shacl`, `/sparql/ai`); the root entry, `/rdfjson`, `/csvw`, `/shacl` and `/sparql/sql` never import it. [`@thomasfosterau/effect-xml`](https://www.npmjs.com/package/@thomasfosterau/effect-xml) (`^0.1.0`) is a second optional peer, needed by the subpaths that read XML: `/rdfxml`, `/xmp` and `/sparql` (SPARQL XML results and the RDF/XML codec), with `/sparql/shacl` and `/sparql/ai`. effect-xml 0.1.0 itself requires effect-parse `^0.4.1` (its widening to 0.5 is merged but not yet released, so a package manager reports that peer as unmet beside effect-parse 0.5; the suites pass on that pairing), so those subpaths need both:

```sh
pnpm add @thomasfosterau/effect-parse
pnpm add @thomasfosterau/effect-xml # for /rdfxml, /xmp and /sparql
```

## Modules

| Module               | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Term`               | `NamedNode`, `BlankNode`, `Literal` (language tags with base direction), `Variable`, `DefaultGraph`, `Triple` (triple terms) and `Quad`; constructors (`namedNode`, `blankNode`, `literal`, `triple`, `quad`), guards, `compare` / `compareQuads` and their Effect instances (`Order`, `QuadOrder`, `Equivalence`, `QuadEquivalence`), JSON conversion (`toJson`, `fromJson`, `quadToJson`, `quadFromJson`, `isWellFormed`) and schemas with JSON codecs. Every term implements `Equal` / `Hash`.                        |
| `TermJson`           | The JSON shape of terms and quads: the SPARQL 1.2 JSON results term (`{ "type": "uri", "value": … }`, triple terms, `xml:lang`, `its:dir`) extended with `{ "type": "variable", "value" }` and `{ "type": "default-graph" }`, and `{ subject, predicate, object, graph? }` quads.                                                                                                                                                                                                                                        |
| `TermCodec`          | `Schema`s between ground terms and JS values: `string`, `localized`, `langString`, `iri`, `namedNode`, `resource`, `literal`, `lexical`, `number`, `integer`, `bigint`, `decimal`, `double`, `float`, `boolean`, `date`, `dateTime` (Effect `DateTime.Utc` / `Zoned`), `value`, `typed`, `typedOneOf`, and `make` for your own. Decode a `Dataset`'s objects or SPARQL solutions into typed structs.                                                                                                                     |
| `Resource`           | Typed records over a dataset's resources: `property(predicate, codec, { inverse?, languages? })` maps a `Schema.Struct` field to a predicate, `describe({ type?, id? })` gives the struct an `rdf:type` and an id field, `list(codec)` reads an RDF collection; `decode`, `decodeAll` (every resource of the described type) and `encode` (to quads), and `schema(struct)`, the same mapping as a `Schema` from `{ dataset, subject }`.                                                                                  |
| `Dataset`            | An immutable, indexed set of quads: `make`, `fromIterable`, `add`, `remove`, `match`, `objectsOf`, `subjects`, `graphs`, `list` (RDF collections), set operations, `filter` / `map` / `reduce`, `toNQuads`, `toGraph` / `fromGraph` (`effect/Graph`) and `DatasetSchema` (JSON: sorted array of quads).                                                                                                                                                                                                                  |
| `Iri`                | RFC 3987 resolution (`resolve`, `removeDotSegments`), `relativize`, `isAbsolute`, `isValid`, `isValidReference`, and `IriSchema` / `IriReferenceSchema` (JSON Schema `format: "iri"` / `"iri-reference"`) for validating IRIs from `Config`, CLI flags or HTTP parameters.                                                                                                                                                                                                                                               |
| `LanguageTag`        | BCP 47 language tags as RDF 1.2 requires them: `isWellFormed` (the §2.1 ABNF), `normalize` (lower case) and `LanguageTagSchema`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `PrefixMap`          | Prefix ⇄ namespace maps: `make`, `set`, `merge`, `expand` (CURIE → IRI), `compact` (IRI → prefix and local name).                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Namespace`, `Vocab` | `Namespace.make(base)` builds IRIs; `Namespace.vocabulary(base, terms)` a typed vocabulary. `Vocab` ships `rdf`, `rdfs`, `xsd`, `owl` and `commonPrefixes`.                                                                                                                                                                                                                                                                                                                                                              |
| `Xsd`                | Lexical validation, canonicalisation and value mapping for the XSD datatypes, literal constructors (`integer`, `decimal`, `dateTime`, …) and `fromJs` / `toJs`.                                                                                                                                                                                                                                                                                                                                                          |
| `Rdfs`               | Class and property hierarchies (`superClasses`, `instancesOf`, …) and the RDFS `closure`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Reification`        | RDF 1.2 reifiers and annotations: `annotate`, `reifiers`, `annotations`, `toStandardReification`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Isomorphism`        | Blank-node-aware graph comparison: `isomorphic`, `bijection`, deterministic `relabel`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RdfJs`              | Conversion to and from the [RDF/JS data model](https://rdf.js.org/data-model-spec/).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Serialization`      | The `Format`, `Parser`, `Serializer` and `Codec` interfaces the syntax subpaths implement, their typed errors (`RdfParseError` with `line` / `column`, `RdfSerializeError`), `toSchema`, the `Formats` service with content negotiation (`negotiate`, `parserFor`, `serializerFor`, `parserForExtension`, `serializerForExtension`), byte entry points (`parseBytes`, `parseBytesDocument`, `serializeBytes`: strict UTF-8 or a `charset`, BOM stripped) and files over Effect's `FileSystem` (`readFile`, `writeFile`). |

Every module is also its own entry point (`@thomasfosterau/effect-rdf/Term`, …). The RDF/JSON, CSVW and SHACL modules are nested under their own subpath (`@thomasfosterau/effect-rdf/shacl`, `@thomasfosterau/effect-rdf/shacl/Validator`, …) and are not on the root barrel; their sections below list them.

### Resources

`Resource` maps the resources of a dataset to typed records. Each field of a `Schema.Struct` names its predicate with `Resource.property` (an annotation only: the field's type is unchanged), and its schema sets the cardinality:

| Field schema                                          | Values read                                             |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `property(p, codec)`                                  | exactly one (fails on none or several)                  |
| `Schema.optional(property(p, codec))` / `optionalKey` | at most one                                             |
| `property(p, Schema.Array(codec))`                    | any number, in `Term.Order`                             |
| `property(p, Resource.list(codec))`                   | one RDF collection (`rdf:first` / `rdf:rest`)           |
| `property(p, Struct)`                                 | a nested resource (IRI or blank node), read recursively |

Values decode through the field's own codec (the `TermCodec` schemas, or any `Schema.Codec<A, Term.GroundTerm>`), and a failure is an ordinary `SchemaError` at the field's path. `{ inverse: true }` reads `?x p resource` instead; `{ languages: ['en', 'fr', ''] }` takes the first value whose language tag matches, in that order (`''` is untagged). `Resource.describe` adds the `rdf:type` decoding requires and encoding writes, and an `id` field holding the resource itself:

```ts
import { Effect, Schema } from 'effect';
import { Dataset, Namespace, Resource, TermCodec } from '@thomasfosterau/effect-rdf';

const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const ex = Namespace.make('http://example.org/');

const Address = Schema.Struct({
  city: Resource.property(ex('city'), TermCodec.string),
});

const Person = Schema.Struct({
  id: TermCodec.iri,
  name: Resource.property(foaf('name'), TermCodec.string, { languages: ['en', ''] }),
  age: Schema.optional(Resource.property(foaf('age'), TermCodec.integer)),
  knows: Resource.property(foaf('knows'), Schema.Array(TermCodec.namedNode)),
  address: Schema.optional(Resource.property(ex('address'), Address)),
}).pipe(Resource.describe({ type: foaf('Person'), id: 'id' }));

const program = Effect.gen(function* () {
  const alice = yield* Resource.decode(Person)(data, ex('alice')); // { id, name, age?, knows, address? }
  const people = yield* Resource.decodeAll(Person)(data, { graph: ex('people') }); // [{ subject, value }]
  // A nested value without an id is written as a fresh blank node.
  const quads = yield* Resource.encode(Person)(ex('alice'), alice);
  return Dataset.fromIterable(quads);
});
```

`decode` and `decodeAll` read every graph unless given `{ graph }`; `encode` writes into `{ graph }` (the default graph otherwise). A cycle through a recursive schema (`Schema.suspend`) fails rather than looping. `Resource.schema(Person)` is the same mapping as a `Schema` whose encoded side is `{ dataset, subject }` (`Resource.InputSchema`), so it composes with `Schema.decodeTo` and the rest of the `Schema` API; encoding gives the dataset of the value's quads.

### Bytes and files

The `Parser` interface reads text; `Serialization.parseBytes` reads the `Stream<Uint8Array>` that files, HTTP bodies, sockets and child processes produce. It decodes UTF-8 across chunk boundaries (or `options.charset`), drops a byte order mark, and fails on ill-formed bytes with an `RdfParseError` at the line and column of the bad byte. `readFile` / `writeFile` go through Effect's platform-agnostic `FileSystem` and `Path` services (provide `NodeFileSystem.layer` / `NodePath.layer` from `@effect/platform-node`, or Bun's), choosing the syntax by file extension from the `Formats` service unless given a parser or media type:

```ts
import { Effect } from 'effect';
import { Serialization } from '@thomasfosterau/effect-rdf';
import { NQuads } from '@thomasfosterau/effect-rdf/ntriples';

const program = Effect.gen(function* () {
  // Relative IRIs resolve against the file's `file:` URL.
  const { dataset } = yield* Serialization.readFile('data.ttl');
  yield* Serialization.writeFile('data.nq', dataset, { serializer: NQuads.serializer });
});
```

### Graph algorithms

`Dataset.toGraph` turns a dataset into an `effect/Graph` directed graph — subjects and objects are nodes, each quad an edge labelled with its predicate — with the term → node-index map algorithms start from. Restrict it to some predicates, one named graph, or include literal objects:

```ts
import { Graph, HashMap, Option } from 'effect';
import { Dataset, Vocab } from '@thomasfosterau/effect-rdf';

const classes = Dataset.toGraph(data, { predicates: [Vocab.rdfs.subClassOf] });
Graph.isAcyclic(classes.graph); // false if the hierarchy has a cycle
const order = Array.from(Graph.indices(Graph.topo()(classes.graph))); // subclasses first

const people = Dataset.toGraph(data, { predicates: [foaf('knows')] });
const index = (t: Term.NamedNode) => Option.getOrElse(HashMap.get(people.nodes, t), () => -1);
Graph.dijkstra({ source: index(alice), target: index(dave), cost: () => 1 })(people.graph);
```

`Dataset.fromGraph(graph, graphName?)` turns such a graph back into quads.

### JSON

Every term, quad and dataset schema carries a `toCodecJson` link, so RDF values pass through anything that serialises with `Schema.toCodecJson` (RPC, `HttpApi` payloads, `KeyValueStore`, `effect/ai` tools) and `Schema.toJsonSchemaDocument` describes them:

```ts
import { Schema } from 'effect';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';

const codec = Schema.toCodecJson(Term.TermSchema);
Schema.encodeSync(codec)(Term.literal('hi', 'en')); // { type: 'literal', value: 'hi', 'xml:lang': 'en' }

// A dataset encodes as its quads in `Dataset.toSortedArray` order.
Schema.encodeSync(Schema.toCodecJson(Dataset.DatasetSchema))(Dataset.make()); // []
```

Decoding rejects triple terms whose positions don't fit RDF (a literal subject, a non-IRI predicate).

### Property testing

The same schemas derive arbitraries for Effect's native property testing (`effect/Arbitrary`, `@effect/vitest`'s `it.prop`): `Term.TermSchema`, `GroundTermSchema`, each term kind, `QuadSchema` and `Dataset.DatasetSchema` generate realistic RDF 1.2 values — IRIs from a small pool (so quads share subjects, objects and graphs), BCP 47 language tags, both base directions, valid lexical forms for common XSD datatypes, triple terms (as objects) nested up to two deep, and datasets of up to a dozen quads with named graphs:

```ts
import { it } from '@effect/vitest';
import { Dataset, Isomorphism } from '@thomasfosterau/effect-rdf';

it.prop('my transform keeps the graph', { ds: Dataset.DatasetSchema }, ({ ds }) =>
  Isomorphism.isomorphic(myTransform(ds), ds),
);
```

## Example

```ts
import { Option } from 'effect';
import { Dataset, Isomorphism, Namespace, PrefixMap, Term, Xsd } from '@thomasfosterau/effect-rdf';

const ex = Namespace.make('http://example.org/');

const alice = ex('alice');
const data = Dataset.make(
  Term.quad(alice, ex('name'), Term.literal('Alice', 'en')),
  Term.quad(alice, ex('age'), Xsd.integer(42)),
  Term.quad(alice, ex('knows'), Term.blankNode()),
);

Dataset.objectsOf(data, alice, ex('name')); // [Literal "Alice"@en]
Dataset.match(data, { predicate: ex('age') }).length; // 1

// Blank-node labels don't matter to isomorphism.
const same = Dataset.make(
  Term.quad(alice, ex('knows'), Term.blankNode('someone')),
  Term.quad(alice, ex('age'), Xsd.integer(42)),
  Term.quad(alice, ex('name'), Term.literal('Alice', 'en')),
);
Isomorphism.isomorphic(data, same); // true

const prefixes = PrefixMap.make({ ex: 'http://example.org/' });
Option.getOrUndefined(PrefixMap.compact(prefixes, alice)); // ['ex', 'alice']
```

To read and write documents, import a syntax subpath: [`/ntriples`](#n-triples-and-n-quads-thomasfosteraueffect-rdfntriples), [`/turtle`](#turtle-and-trig-thomasfosteraueffect-rdfturtle), [`/jsonld`](#json-ld-thomasfosteraueffect-rdfjsonld), [`/rdfxml`](#rdfxml-thomasfosteraueffect-rdfrdfxml), [`/n3`](#notation3-thomasfosteraueffect-rdfn3) or [`/rdfjson`](#rdfjson-thomasfosteraueffect-rdfrdfjson).

## RDF/JSON (`@thomasfosterau/effect-rdf/rdfjson`)

`@thomasfosterau/effect-rdf/rdfjson` is [RDF/JSON](https://www.w3.org/TR/rdf-json/)
(`application/rdf+json`), built on Effect `Schema`. Its one module is also
`@thomasfosterau/effect-rdf/rdfjson/RdfJson`.

### Schemas

| Schema                                   | Type                                     |
| ---------------------------------------- | ---------------------------------------- |
| `RdfJson.Document` / `StrictDocument`    | `Document` (validates the JSON shape)    |
| `RdfJson.ObjectValue`, `LiteralValue`, … | individual value objects                 |
| `RdfJson.RdfJsonFromString`              | `string ⇄ Document`                      |
| `RdfJson.DatasetFromRdfJson`             | `Document ⇄ Dataset`                     |
| `RdfJson.DatasetFromString`              | `string ⇄ Dataset` (also `codec.schema`) |
| `RdfJson.makeDatasetSchema(options)`     | `Document ⇄ Dataset` with options        |

```ts
import { Effect, Schema } from 'effect';
import { RdfJson } from '@thomasfosterau/effect-rdf/rdfjson';

const program = Effect.gen(function* () {
  const dataset = yield* Schema.decodeEffect(RdfJson.DatasetFromString)(`{
    "http://example.org/about": {
      "http://purl.org/dc/terms/title": [
        { "type": "literal", "value": "Anna's Homepage", "lang": "en" }
      ]
    }
  }`);
  const text = yield* Schema.encodeEffect(RdfJson.DatasetFromString)(dataset);
});
```

Invalid documents fail with precise messages, e.g.
`Expected an RDF/JSON value ("type" must be "uri", "bnode", "literal" or "triple") at ["s"]["p"][0]`.

### Parser and serializer

`RdfJson.parse(text, options?)` / `RdfJson.serialize(quads, options?)` implement the core
`Serialization` interfaces (`parser`, `serializer`, `codec`, `format`). Parse errors are
`RdfParseError`s (JSON syntax errors carry `line`/`column`); serialisation errors are
`RdfSerializeError`s.

- `parse` options: `blankNodePrefix`, `graph`, `strict` (reject the RDF 1.2 extensions).
- `serialize` options: `extensions` (default `false`), `mergeGraphs` (default `false`),
  `space` (JSON indentation, default 2).

RDF/JSON describes a single graph, so quads in named graphs are rejected unless
`mergeGraphs: true`.

### RDF 1.2 extensions

Output is strict RDF/JSON by default; data that needs the extensions fails unless
`extensions: true`. Parsing accepts them unless `strict: true`.

- **Base direction**: a literal with `"lang"` may carry `"direction": "ltr" | "rtl"`.
- **Triple terms**: `{ "type": "triple", "value": { "subject": …, "predicate": …, "object": … } }`,
  where `subject` is a `uri` or `bnode` value, `predicate` a `uri` value and `object` any value
  (including another triple term). Triple terms cannot be subjects.

```json
{
  "http://example.org/s": {
    "http://example.org/claims": [
      {
        "type": "triple",
        "value": {
          "subject": { "type": "uri", "value": "http://example.org/a" },
          "predicate": { "type": "uri", "value": "http://example.org/b" },
          "object": { "type": "literal", "value": "مرحبا", "lang": "ar", "direction": "rtl" }
        }
      }
    ]
  }
}
```

## N-Triples and N-Quads (`@thomasfosterau/effect-rdf/ntriples`)

RDF 1.2 [N-Triples](https://www.w3.org/TR/rdf12-n-triples/) and
[N-Quads](https://www.w3.org/TR/rdf12-n-quads/) for
[`@thomasfosterau/effect-rdf`](#modules).

- Strict parsers: absolute IRIs only, validated escapes (no surrogates),
  language tags with base direction (`"x"@en--ltr`), triple terms
  `<<( s p o )>>`, `VERSION` directives, and the RDF 1.1 subset.
- Streaming: `parseStream` consumes a `Stream<string>` line by line (chunk
  boundaries may fall anywhere), so large files are never buffered.
- Canonical serializers (RDF 1.2 canonical escapes, lower-case language tags)
  with a true `serializeStream`.
- Passes the full W3C rdf11/rdf12 N-Triples and N-Quads suites (syntax and
  canonicalisation).

```ts
import { Effect, Stream } from 'effect';
import { NQuads, NTriples } from '@thomasfosterau/effect-rdf/ntriples';

const program = Effect.gen(function* () {
  const { dataset } = yield* NTriples.parse(
    '<http://example.org/s> <http://example.org/p> "chat"@en--ltr .\n',
  );
  const text = yield* NQuads.serialize(dataset, { sort: true });

  // Incremental parsing of a text stream
  const quads = yield* Stream.runCollect(
    NQuads.parseStream(Stream.make(text.slice(0, 10), text.slice(10))),
  );
  return quads;
});
```

Each module exports `format`, `parser`, `serializer`, `codec` (with a
`Schema` from `string` to `Dataset`), `parse`, `parseQuads` (document order),
`parseStream`, `serialize` and `serializeStream`. The `Lexical` module holds
the character classes, escape decoding, language-tag validation and canonical
term formatting shared with the Turtle package.

`Grammar` holds the N-Triples terminals (`iriRef`, `blankNodeLabel`, `langTag`,
`langDir`, `stringLiteralQuote`, `uchar`, `echar`) and character classes
(`pnCharsBase`, `pnCharsU`, `pnChars`, `hex`, …) as
[`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
parsers and token sets (an optional peer dependency of effect-rdf, needed by this subpath). The token sets
accept exactly the code points of the `Lexical` predicates. Turtle's `Grammar`
re-exports them and adds its own terminals. The N-Triples and N-Quads parsers
themselves stay hand-written line parsers, which are simpler and faster for a
one-statement-per-line format.

## Turtle and TriG (`@thomasfosterau/effect-rdf/turtle`)

RDF 1.2 [Turtle](https://www.w3.org/TR/rdf12-turtle/) and
[TriG](https://www.w3.org/TR/rdf12-trig/) for
[`@thomasfosterau/effect-rdf`](#modules).

- Full RDF 1.2 grammar: triple terms `<<( s p o )>>`, reified triples
  `<< s p o ~ r >>`, annotations `{| ... |}`, `VERSION`, base direction, plus
  RDF 1.1 documents.
- `parse` returns the dataset, the declared prefixes and the final base IRI;
  `parseQuads` returns statements in document order.
- `parseStream` is incremental: statements are emitted as soon as they are
  complete, whatever the chunk boundaries.
- The parsers are a compiled
  [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
  grammar built on the `Grammar` terminals below, emitting quads as it reads.
  `vp run --filter ./packages/core bench:turtle` times them on the W3C suites (7.6 MB) and on synthetic Turtle,
  TriG and N-Triples-like documents (10–29 MB), whole and in 64 kB chunks:
  15–32 MB/s on Node 22, 1.1–1.25× the time of the hand-written parser they
  replaced, with the same quads, errors and error positions on every suite
  file, on 6,000 mutated copies of them, and when streamed in chunks of 1 to
  1,000 characters. Nesting is limited to about 900 levels of `[ … ]`.
- Pretty serializers: prefixed names (from `prefixes`, optionally
  `autoPrefixes`), `@base` relativisation, `;`/`,` grouping, `a`, inline `[]`
  blank nodes, `( ... )` collections, numeric/boolean shorthand, annotation
  syntax for reified asserted triples, deterministic order.
  `serializeStream` writes in constant memory (grouping consecutive
  statements only).
- Passes every W3C rdf11/rdf12 Turtle and TriG syntax and evaluation test, and
  every positive test round-trips through the serializers.

```ts
import { Effect } from 'effect';
import { Turtle, TriG } from '@thomasfosterau/effect-rdf/turtle';

const program = Effect.gen(function* () {
  const { dataset, prefixes, baseIri } = yield* Turtle.parse(`
    PREFIX ex: <http://example.org/>
    ex:alice a ex:Person ;
      ex:knows [ ex:name "Bob" ] ;
      ex:age 42 {| ex:source ex:census |} .
  `);
  return yield* Turtle.serialize(dataset, { prefixes, autoPrefixes: true });
});
```

### Grammar

`Grammar` exposes the Turtle grammar's terminals as
[`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
parsers (an optional peer dependency of effect-rdf, needed by this subpath), for the grammars that include
them: N3 (`/n3`) and ShExC (`/shex`) are built on them. The
terminals Turtle shares with N-Triples (`iriRef`, `blankNodeLabel`, `langTag`,
`langDir`, `stringLiteralQuote`, `uchar`, `echar` and the character classes)
come from `/ntriples`' `Grammar` and are re-exported here.

| Parser                                           | Terminal                           | Value                                        |
| ------------------------------------------------ | ---------------------------------- | -------------------------------------------- |
| `iriRef`                                         | `IRIREF`                           | the IRI, `UCHAR`s decoded (not resolved)     |
| `prefixedName`                                   | `PNAME_LN`, `PNAME_NS`             | `{ prefix, local }`, `PN_LOCAL_ESC`s decoded |
| `pnPrefix`, `pnLocal`, `plx`                     | `PN_PREFIX`, `PN_LOCAL`, `PLX`     | the text                                     |
| `blankNodeLabel`                                 | `BLANK_NODE_LABEL`                 | the label after `_:`                         |
| `langTag`, `langDir`                             | `LANGTAG`, `LANG_DIR`              | the tag, or `{ language, direction }`        |
| `stringLiteral` (and the four forms)             | `STRING_LITERAL_QUOTE`, …          | the value, escapes decoded                   |
| `integer`, `decimal`, `double`, `numericLiteral` | `INTEGER`, `DECIMAL`, `DOUBLE`     | the lexical form (and datatype)              |
| `uchar`, `echar`, `booleanLiteral`               | `UCHAR`, `ECHAR`, `true` / `false` | the character or keyword                     |
| `ws`, `comment`, `skip`                          | `WS`, comments                     | —                                            |

The character classes (`pnCharsBase`, `pnCharsU`, `pnChars`, `hex`, …) are
token sets for `Token.oneOf` / `Token.takeWhile`. The parsers neither skip
whitespace (except `skip`) nor resolve IRIs: a grammar adds its own
whitespace and resolves names, typically after parsing so that it can be
compiled.

```ts
import * as Parser from '@thomasfosterau/effect-parse/Parser';
import { Grammar } from '@thomasfosterau/effect-rdf/turtle';

const iri = Parser.preceded(Grammar.skip, Parser.alt(Grammar.iriRef, Grammar.prefixedName));
Parser.parse(iri, '  ex:alice'); // Result.succeed({ prefix: 'ex', local: 'alice' })
```

### Test manifests

`Manifest` reads W3C test manifests (following `mf:include`) and is meant for
other packages' conformance tests:

```ts
import * as fs from 'node:fs';
import { Effect } from 'effect';
import { Manifest } from '@thomasfosterau/effect-rdf/turtle';

const read = Manifest.fileReader('https://w3c.github.io/rdf-tests/', '/path/to/rdf-tests/', (p) =>
  Effect.sync(() => fs.readFileSync(p, 'utf8')),
);
const entries = Effect.runSync(
  Manifest.load('https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-turtle/manifest.ttl', read),
);
// entries: { id, kind: 'TestTurtleEval', name, action: Option<iri>, result: Option<iri>, dataset, ... }
```

## Notation3 (`@thomasfosterau/effect-rdf/n3`)

Effect-idiomatic [Notation3](https://w3c.github.io/N3/spec/) for
[`@thomasfosterau/effect-rdf`](#modules):

- **`Model`** — the N3 data model: core IRIs, blank nodes, literals and
  variables plus N3 `Collection`s (lists) and `Formula`s (graph terms), with
  statements allowing any term in any position. Its schemas carry JSON codecs
  (`Schema.toCodecJson`): core's JSON terms plus `{ "type": "collection", "items" }`
  and `{ "type": "formula", "statements" }`.
- **`N3`** — a conformant parser (`parse` → `Model.Document`), a
  pretty-printing serializer (`serializeDocument`), and the core
  `Serialization` `parser` / `serializer` / `codec` over RDF `Dataset`s.
- **`Mapping`** — the documented mapping between N3 and RDF datasets
  (formulas ⇄ named graphs identified by blank nodes, collections ⇄
  `rdf:first`/`rdf:rest` lists).
- **`Isomorphism`** — blank-node- and variable-aware comparison of formulas.
- **`Reasoner`** — a forward-chaining reasoner for `{ … } => { … }` rules
  with a few `math:`, `string:`, `list:` and `log:` builtins.

### Usage

```ts
import { Effect } from 'effect';
import { N3, Model } from '@thomasfosterau/effect-rdf/n3';

const program = Effect.gen(function* () {
  const doc = yield* N3.parse(`
    @prefix : <http://example.org/> .
    :socrates a :Man .
    { ?x a :Man } => { ?x a :Mortal } .
  `);
  doc.formula.statements.length; // 2
  Model.variables(doc.formula); // [?x]

  // Pretty-print with the document's prefixes
  const text = N3.serializeDocument(doc);

  // RDF-compatible documents can be read as core datasets; formulas become
  // named graphs identified by blank nodes.
  const { dataset } = yield* N3.parser.parse(
    '@prefix : <http://example.org/> . :alice :believes { :bob :knows :carol } .',
  );
  // …and datasets serialise back to N3 with nested formulas.
  const n3 = yield* N3.serialize(dataset);
});
```

#### Reasoning

```ts
import { Effect } from 'effect';
import { N3, Reasoner } from '@thomasfosterau/effect-rdf/n3';

const program = Effect.gen(function* () {
  const doc = yield* N3.parse(`
    @prefix : <http://example.org/> .
    @prefix math: <http://www.w3.org/2000/10/swap/math#> .
    :socrates a :Man ; :age 70 .
    { ?x a :Man } => { ?x a :Mortal } .
    { ?x :age ?a . (?a 1) math:sum ?b } => { ?x :nextAge ?b } .
  `);
  const { closure, inferred } = yield* Reasoner.reason(doc);
  return N3.serializeDocument(inferred, { prefixes: doc.prefixes });
  // :socrates a :Mortal ; :nextAge 71 .
});
```

Builtins: a pragmatic subset of `math:`, `string:`, `list:` and `log:`
(`includes`, `notIncludes`, `conclusion`, `collectAllIn`, `forAllIn`, …).
`Reasoner.query(formula, pattern)` answers conjunctive queries. On the CG
reasoner suite 76 of 89 tests pass; the rest need document dereferencing
(`log:semantics`), `time:` builtins or have broken expected results (listed
in `test/n3/reasoner-conformance.test.ts`).

### Mapping to RDF datasets

| N3                                                | RDF dataset                                           |
| ------------------------------------------------- | ----------------------------------------------------- |
| top-level statement                               | quad in the default graph                             |
| formula `{ … }` (each occurrence)                 | fresh blank node `_:g`; contents in named graph `_:g` |
| collection `( a b )` / `()`                       | `rdf:first`/`rdf:rest` chain / `rdf:nil`              |
| variable `?x`, literal subject, non-IRI predicate | `RdfParseError` (not representable)                   |

Serialising a dataset writes graphs named by blank nodes that are used as
terms as nested formulas and folds well-formed lists into collections; graphs
named by IRIs, or unreferenced blank-node graphs, fail with
`RdfSerializeError`.

### Syntax notes

Following the current CG specification and its test suite:

- `<=` is `log:isImpliedBy`, `=` is `owl:sameAs`, `=>` is `log:implies`.
- `{}` (an empty formula) is the literal `true`.
- An undeclared empty prefix `:` means `<#>`.
- Blank node labels are scoped to the whole document.
- Legacy `@forAll` / `@forSome` are accepted (mapped to variables / fresh
  blank nodes); `@keywords` is rejected.
- `"…"^^i18n:ar-eg_rtl` is read (and written) as a directional
  language-tagged string.

The parser is a compiled
[`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
grammar (an optional peer dependency of effect-rdf, needed by this subpath) that includes the Turtle
grammar's terminals from `@thomasfosterau/effect-rdf/turtle` (`Grammar`), as the
N3 grammar is defined on Turtle's. `vp run --filter ./packages/core bench:n3` times it on every `.n3` and `.ttl` file of the N3
suites and on a large synthetic document.

## JSON-LD (`@thomasfosterau/effect-rdf/jsonld`)

A self-contained, Effect-idiomatic [JSON-LD 1.1](https://www.w3.org/TR/json-ld11-api/) processor
for [`@thomasfosterau/effect-rdf`](#modules): context processing, expansion, compaction,
flattening, [framing](https://www.w3.org/TR/json-ld11-framing/), conversion to and from RDF, and a
`Serialization.Codec` for `application/ld+json`.

It passes the W3C JSON-LD 1.1 test suites for expand, compact, flatten, toRdf, fromRdf,
remote-doc and framing. The only tests it skips are JSON-LD 1.0-only tests and the ones that need
generalized RDF.

**Nesting is bounded.** Framing embeds at most 256 levels: a deeper chain fails with the
`JsonLdError` code `maximum nesting exceeded` (frame it with `@embed: '@never'`
instead). Input in any algorithm that is nested deeper than the stack allows fails with the same
code, never a `RangeError`. That code is this processor's own; every other code is the
specification's.

### Usage

```ts
import { Effect } from 'effect';
import { DocumentLoader, JsonLd } from '@thomasfosterau/effect-rdf/jsonld';

const doc = {
  '@context': { '@vocab': 'http://schema.org/', knows: { '@type': '@id' } },
  '@id': 'http://example.org/alice',
  name: 'Alice',
  knows: 'http://example.org/bob',
};

const program = Effect.gen(function* () {
  const expanded = yield* JsonLd.expand(doc);
  const compacted = yield* JsonLd.compact(doc, { schema: 'http://schema.org/' });
  const flattened = yield* JsonLd.flatten(doc);
  const framed = yield* JsonLd.frame(doc, { '@context': doc['@context'], name: {} });
  const dataset = yield* JsonLd.toRdf(doc, { rdfDirection: 'i18n-datatype' });
  const json = yield* JsonLd.fromRdf(dataset, { useNativeTypes: true });
});
```

Every algorithm returns an `Effect` that fails with a `JsonLdError`. The error's `code` is one of
the JSON-LD error codes, such as `"invalid @id value"` or `"loading remote context failed"`.

### Remote documents and contexts

Remote contexts and documents (a string input is treated as a URL) are loaded through the
`DocumentLoader` service:

```ts
import { FetchHttpClient } from 'effect/http';

// Over HTTP. This follows the JSON-LD content-type and Link-header rules, extracts JSON-LD from
// HTML, and caches documents.
const live = DocumentLoader.layerHttp.pipe(Layer.provide(FetchHttpClient.layer));

// From memory, useful for tests and for pinning well-known contexts.
const pinned = DocumentLoader.layerStatic({
  'https://schema.org/': { '@context': { '@vocab': 'https://schema.org/' } },
});

JsonLd.expand('https://example.org/data.jsonld').pipe(Effect.provide(live));
```

Without a `DocumentLoader` in the environment, any remote reference fails with
`loading document failed` or `loading remote context failed`. You can also pass a loader for a
single call with `options.documentLoader`. `DocumentLoader.fromFetch` builds a loader from any
function that returns raw responses.

### Codec

`JsonLd.codec` implements `Serialization.Codec` for the `application/ld+json` media type and the
`.jsonld` extension.

- **Parsing** runs toRdf.
- **Serialising** runs fromRdf. When you pass a `context` option, or `prefixes` (which become term
  definitions), the result is then compacted.

```ts
const roundTrip = (text: string) =>
  Effect.gen(function* () {
    const { dataset } = yield* JsonLd.parse(text, { baseIri: 'http://example.org/' });
    return yield* JsonLd.serialize(dataset, {
      prefixes: PrefixMap.make({ ex: 'http://example.org/' }),
    });
  });
```

### Notes

- Generalized RDF, where a blank node is used as a predicate, cannot be represented by the core
  term model, so `produceGeneralizedRdf` has no effect.
- When `rdfDirection` is not set, `@direction` is dropped and the value becomes a plain
  language-tagged literal. `fromRdf` turns RDF 1.2 directional language-tagged literals into
  `@direction`, in every mode.
- `rdfDirection: 'rdf-1.2'` maps `@language` + `@direction` to an RDF 1.2 directional
  language-tagged literal (`"…"@ar--rtl`, `rdf:dirLangString`), so
  `parse(serialize(dataset), { rdfDirection: 'rdf-1.2' })` round-trips directional strings. It
  follows the JSON-LD 1.2 proposal ([w3c/json-ld-syntax#488](https://github.com/w3c/json-ld-syntax/issues/488)),
  which is not yet a Recommendation, so it is opt-in and the default is unchanged. A
  `@direction` without `@language` is dropped, as RDF 1.2 has no directional string without a
  language.

## RDF/XML (`@thomasfosterau/effect-rdf/rdfxml`)

[RDF 1.2 XML Syntax](https://www.w3.org/TR/rdf12-xml/) (RDF/XML, `application/rdf+xml`)
for [`@thomasfosterau/effect-rdf`](#modules).

- `RdfXml` — parser and serializer implementing the core `Serialization` interfaces.
- `Xml` — the namespace-aware, non-validating XML 1.0 document tree it is built on
  (internal DTD entities and attribute defaults, CDATA, comments, PIs, with a position on
  every node) plus Exclusive XML Canonicalization, usable on its own.

`Xml` builds its tree from the SAX events of
[`@thomasfosterau/effect-xml`](https://www.npmjs.com/package/@thomasfosterau/effect-xml)'s tokenizer (an optional peer dependency of effect-rdf, needed by this subpath),
adding well-formed structure, unique attributes and Namespaces in XML 1.0 on top. The internal
subset is read only when the document has a DOCTYPE. It never loads external entities, caps entity
expansion at 1,000,000 characters (defeating "billion laughs"), and limits entity references to
64 levels of nesting and elements to 1,024, reporting an `XmlParseError` rather than exhausting
the stack. Positions count UTF-16 code units of the input after any byte order mark. `vp run --filter ./packages/core bench:rdfxml` times it on every RDF/XML and SPARQL XML results file of the W3C suites
(about 20 MB/s: effect-xml's per-document setup dominates on files this small) and on a 10.8 MB synthetic RDF/XML document (about 18 MB/s).

The parser passes every test of the W3C RDF 1.1 and RDF 1.2 RDF/XML test suites, including
`rdf:version`, base direction via `its:dir`, triple terms via `rdf:parseType="Triple"` and
annotations via `rdf:annotation` / `rdf:annotationNodeID`.

### Parsing

```ts
import { Effect } from 'effect';
import { Dataset } from '@thomasfosterau/effect-rdf';
import { RdfXml } from '@thomasfosterau/effect-rdf/rdfxml';

const program = Effect.gen(function* () {
  const { dataset, prefixes } = yield* RdfXml.parse(
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
              xmlns:foaf="http://xmlns.com/foaf/0.1/">
       <foaf:Person rdf:about="#me" foaf:name="Alice"/>
     </rdf:RDF>`,
    { baseIri: 'http://example.org/profile' },
  );
  console.log(Dataset.toNQuads(dataset));
});
```

Errors are `Serialization.RdfParseError`s with `line` and `column`.

`RdfXml.parseQuads(input, options?)` returns the statements in document order (duplicates kept)
with the prefixes and base, without building a dataset: the fastest way to stream a document into
another store.

`RdfXml.parseDocument(doc, options?)` reads an already-parsed `Xml.Document` instead, for formats
that embed RDF/XML in a larger XML document (XMP, SVG metadata): pass a document whose root is
the embedded `rdf:RDF` element.

### Serializing

```ts
import { PrefixMap } from '@thomasfosterau/effect-rdf';

const xml = RdfXml.serialize(dataset, {
  prefixes: PrefixMap.make({ foaf: 'http://xmlns.com/foaf/0.1/' }),
  baseIri: 'http://example.org/profile', // written as xml:base; IRIs are relativised
});
```

The output uses typed node elements, nests blank nodes that are referenced exactly once
(`rdf:parseType="Resource"` when untyped), declares only the namespaces it uses and generates
`ns1`, `ns2`, … for predicates outside the configured prefixes. Directional literals and triple
terms are written with `its:dir` / `rdf:parseType="Triple"` and an `rdf:version="1.2"`
announcement. Serialisation fails with `RdfSerializeError` for quads in named graphs, triple
terms in the subject position and predicates that cannot be written as XML QNames.

Options: `prefixes`, `baseIri`, `indent`, `nestBlankNodes`, `typedNodes`, `xmlDeclaration`.

### Schema

`RdfXml.codec.schema` is a `Schema.Codec<Dataset, string>`.

## XMP (`@thomasfosterau/effect-rdf/xmp`)

[XMP](https://www.iso.org/standard/75163.html) (Extensible Metadata Platform, ISO 16684-1) for
[`@thomasfosterau/effect-rdf`](#modules): the metadata format of PDF (the catalog's `/Metadata`
stream, required by PDF/A and PDF/UA), JPEG, PNG, TIFF, WebP, SVG and MP4. XMP is a constrained
profile of RDF/XML, so the parser is
[`@thomasfosterau/effect-rdf/rdfxml`](#rdfxml-thomasfosteraueffect-rdfrdfxml); this package adds the packet wrapper, the XMP data
model, typed accessors for the core schemas and a serializer that writes the canonical form XMP
consumers expect.

| Module                                                        | Contents                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Xmp`                                                         | `parse` / `serialize` (the core `Serialization` interfaces), `parseMetadata`, `serializeMetadata` |
| `Metadata`                                                    | the data model: `Simple`, `Struct`, `ArrayValue`, qualifiers; `fromDataset` / `toDataset`         |
| `Packet`                                                      | `find` / `findAll` packets in bytes (UTF-8, UTF-16, UTF-32), `unwrap`, `wrap`, `wrapToSize`       |
| `Extract`                                                     | `jpeg` (APP1, with Extended XMP) and `png` (`iTXt`, stored or compressed)                         |
| `DublinCore`, `XmpBasic`, `XmpRights`, `XmpMM`, `Pdf`, `PdfA` | typed getters and setters                                                                         |
| `Photoshop`, `Exif`, `Tiff`                                   | typed getters and setters for the image schemas' common properties                                |
| `Namespaces`                                                  | the schema namespace IRIs and their conventional prefixes                                         |

It needs the optional peers `@thomasfosterau/effect-xml` (the XML tokenizer behind `/rdfxml`) and `@thomasfosterau/effect-parse` (effect-xml's own peer).

### Reading

```ts
import { Effect, Option } from 'effect';
import { DublinCore, PdfA, Xmp, XmpBasic } from '@thomasfosterau/effect-rdf/xmp';

const program = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    // The first packet in any file, or the whole input when it has none.
    const meta = yield* Xmp.parseMetadata(bytes);
    const title = DublinCore.title(meta); // Option<string>, the x-default alternative
    const german = DublinCore.title(meta, 'de');
    const authors = DublinCore.creator(meta); // Option<ReadonlyArray<string>>
    const created = XmpBasic.createDate(meta); // the ISO 8601 string XMP stores
    const pdfa = PdfA.identification(meta); // Option<{ part, conformance, amendment, revision }>
  });
```

`Xmp.parse(text)` returns the RDF itself (a `Serialization.ParseResult`). It accepts a packet,
a bare `<x:xmpmeta>` (or the older `<x:xapmeta>`), a bare `rdf:RDF`, or any XML document with
an `rdf:RDF` inside (an SVG's `<metadata>`), and the forms ISO 16684-1 still requires readers to
accept: descriptions with differing or no `rdf:about` (merged into one resource) and property
attributes. Errors are `RdfParseError`s with `line` / `column`; RDF that does not fit the XMP
data model (a cycle, a triple term, a property given twice) fails too.

`Metadata.fromDataset` reads the data model from RDF: literals and `rdf:resource` URIs are
`Simple` values (`xml:lang` is `Simple.language`), `rdf:parseType="Resource"` nodes are
`Struct`s, `rdf:Bag` / `rdf:Seq` / `rdf:Alt` are `ArrayValue`s, and an `rdf:value` node carries
its other properties as qualifiers. Entry order carries no meaning in XMP; `fromDataset` sorts
entries by IRI so serialization is deterministic.

### Writing

```ts
import { DateTime, Effect, Option, pipe } from 'effect';
import { DublinCore, Metadata, PdfA, Xmp, XmpBasic } from '@thomasfosterau/effect-rdf/xmp';

const meta = pipe(
  Metadata.empty,
  DublinCore.setTitle('Annual report'),
  DublinCore.setTitle('Jahresbericht', 'de'),
  DublinCore.setCreator(['Ada Lovelace']),
  XmpBasic.setCreateDate(DateTime.makeUnsafe('2026-10-01T09:30:00Z')),
  PdfA.setIdentification({
    part: 2,
    conformance: Option.some('B'),
    amendment: Option.none(),
    revision: Option.none(),
  }),
);

const packet = Xmp.serializeMetadata(meta, { toolkit: 'my-app 1.0' });
```

The serializer writes the canonical XMP form: an `<x:xmpmeta>` wrapper, one `rdf:Description`
per schema namespace with that namespace declared on it, property elements only (never
attributes or typed nodes), structures as `rdf:parseType="Resource"` and qualifiers in the
`rdf:value` form, wrapped in an `<?xpacket?>` packet. Options:

- `packet` (default `true`) — wrap in a packet.
- `writable` (default `true`) — `end="w"` or `end="r"`.
- `padding` (default 2048 bytes for a writable packet) — whitespace for in-place edits.
- `size` — the exact byte length of the packet, for rewriting a packet in place; fails when the
  XMP does not fit.
- `toolkit` — the `x:xmptk` attribute; `prefixes` — prefixes to prefer over the conventional
  ones (`Namespaces.prefixes`); `indent` (default one space).

`PdfA.setExtensionSchemas` writes the `pdfaExtension:schemas` descriptions PDF/A-1 to PDF/A-3
require for properties outside the predefined schemas; `PdfA.extensionSchemas` reads them.

### Packets and image files

```ts
import { Extract, Packet } from '@thomasfosterau/effect-rdf/xmp';

Packet.find(bytes); // Option<Packet>: offset, length, encoding, writable, text
Packet.findAll(bytes);
Extract.jpeg(bytes); // Effect<Option<{ standard, extended }>, XmpExtractError>
Extract.png(bytes); // Effect<Option<string>, XmpExtractError>
```

`Packet.find` scans any file (TIFF, WebP, GIF, MP4, PDF, …) for a UTF-8, UTF-16 or UTF-32
packet (either byte order) without parsing it. `Extract.jpeg` reads the APP1 packet and
reassembles Extended XMP; `Extract.png` reads the `iTXt` chunk with the keyword
`XML:com.adobe.xmp`, inflating a compressed one with the platform's `DecompressionStream` up to `maxXmpBytes` (4 MiB by default). Each
has a synchronous `…Result` variant; `Extract.pngResult` fails on a compressed chunk, since
inflating is asynchronous.

## CSV on the Web (`@thomasfosterau/effect-rdf/csvw`)

[CSV on the Web](https://www.w3.org/TR/tabular-data-primer/) (CSVW), on `@thomasfosterau/effect-rdf/csvw`
(one subpath per module: `…/csvw/Processor`, `…/csvw/Metadata`, …): the
[metadata vocabulary](https://www.w3.org/TR/tabular-metadata/), the
[annotated tabular data model](https://www.w3.org/TR/tabular-data-model/) with
validation, and the [CSV2RDF](https://www.w3.org/TR/csv2rdf/) and
[CSV2JSON](https://www.w3.org/TR/csv2json/) conversions.

The subpath works on **already-parsed tables**: a `Table.Source` is a URL and
its records as cell strings, in file order. Splitting CSV text into records is
the job of a CSV scanner (`@thomasfosterau/effect-csv`, which will plug in
here); everything after that — the dialect's skipped rows, header rows, comment
rows, blank rows, skipped columns and trimming, embedded metadata, datatypes,
keys and the conversions — is done here.

### Usage

```ts
import * as Effect from 'effect/Effect';
import { Csv2Json, Csv2Rdf, Processor, Report } from '@thomasfosterau/effect-rdf/csvw';

const metadata = `{
  "@context": "http://www.w3.org/ns/csvw",
  "url": "tree-ops.csv",
  "tableSchema": {
    "columns": [
      {"name": "GID", "titles": "GID", "datatype": "integer"},
      {"name": "on_street", "titles": "On Street"},
      {"name": "inventory_date", "titles": "Inventory Date",
       "datatype": {"base": "date", "format": "M/d/yyyy"}}
    ],
    "aboutUrl": "#gid-{GID}"
  }
}`;

const program = Effect.gen(function* () {
  const { group, report } = yield* Processor.fromMetadata(
    'http://example.org/tree-ops.csv-metadata.json',
    metadata,
    { validate: true },
  );
  return {
    valid: Report.isValid(report),
    dataset: Csv2Rdf.toDataset(group), // standard mode
    json: Csv2Json.toJson(group, { mode: 'minimal' }),
  };
}).pipe(
  Effect.provideService(
    Processor.Loader,
    Processor.makeLoader([
      {
        url: 'http://example.org/tree-ops.csv',
        rows: [
          ['GID', 'On Street', 'Inventory Date'],
          ['1', 'ADDISON AV', '10/18/2010'],
          ['2', 'EMERSON ST', '6/2/2010'],
        ],
      },
    ]),
  ),
);
// json: [{ "@id": "http://example.org/tree-ops.csv#gid-1", "GID": 1,
//          "on_street": "ADDISON AV", "inventory_date": "2010-10-18" }, …]
```

This example is run by [`test/csvw/readme-example.test.ts`](test/csvw/readme-example.test.ts).

### Modules

| Module      | Contents                                                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Processor` | `fromMetadata(url, text, options)` and `fromTabular(url, options)` → `Processed` (`group`, `metadata`, `report`); the `Loader` service (`table(url, dialect)`, `document(url)`) with `makeLoader(sources, documents)` and `layerSources`; `defaultLocations(url)`; `LoadError`                            |
| `Metadata`  | The normalized description model as `Schema`s (`TableGroup`, `Table`, `TableSchema`, `Column`, `Dialect`, `ForeignKey`, `Reference`, `Transformation`, `Inherited`, `LanguageMap`, `CommonProperties`); `decode` / `decodeJson`; `defaultDialect`; inheritance and compatibility helpers; `MetadataError` |
| `Table`     | `Source` (the parsed input); the annotated model (`TableGroup`, `Table`, `Column`, `Row`, `Cell`, `CellValue`); `read` (dialect row flags and embedded metadata), `annotate`, `parseCell`, `validateKeys`                                                                                                 |
| `Datatype`  | The built-in datatypes (`builtIn`, `iri`, `isNumeric`, …), the `Datatype` description schema, `parse` (formats, length and value constraints) and `checkFormat`                                                                                                                                           |
| `Report`    | `Issue` (`level`, `message`, `table`, `row`, `column`) and `Report` schemas; `errors`, `warnings`, `isValid`                                                                                                                                                                                              |
| `Csv2Rdf`   | `toDataset(group, { mode })` → core `Dataset` (`standard` or `minimal`); `convert` (an Effect with a span)                                                                                                                                                                                                |
| `Csv2Json`  | `toJson(group, { mode })` → JSON (`standard` or `minimal`, with nested objects); `convert`                                                                                                                                                                                                                |

#### Processing

`fromMetadata` starts from a metadata document: it is decoded (schemas and
dialects referenced by URL are fetched through the `Loader`), and each table
it describes is read through the `Loader` with the table's dialect. Every
table's embedded metadata (the titles in its header rows) is checked for
compatibility with its schema.

`fromTabular` starts from a tabular data file and takes its metadata from the
`metadata` option (user-supplied, overriding metadata), else the first
document at a default location (`{+url}-metadata.json`, `csv-metadata.json`)
that describes the file, else the file's embedded metadata (column titles from
the header row).

With `validate: true` the processor is a validator: metadata incompatible with
the data and invalid cells are **errors**, and primary keys and foreign keys
(across the group's tables) are checked. Without it, those are **warnings**
and keys are not checked. Metadata problems the specification calls errors
(invalid JSON, a bad `@context`, a blank-node `@id`, conflicting datatype
constraints, a foreign key to a missing table, …) fail with `MetadataError`;
properties with invalid values are dropped with a warning. Every issue carries
the table URL and, for cells and rows, the source row and column numbers.

#### Metadata and datatypes

Decoding implements the metadata vocabulary's property checks and
normalization: link properties are resolved against `@base` (or the document
URL), natural-language properties become language maps (`und` when no
`@language`), common properties are checked against the JSON-LD restrictions
and normalized (`@id` expanded and resolved, strings to value objects), and
inherited properties are resolved column → schema → table → group.

Cells are parsed per the tabular data model: whitespace normalization,
`default`, `null`, `separator` lists, `required`, `lang`, `textDirection` and
virtual columns. Datatypes cover every built-in XSD type and the CSVW
aliases; `format` patterns for numbers (the UAX 35 subset: `0`, `#`, grouping,
`E`, `+`, `-`, `%`, `‰`, and `decimalChar` / `groupChar`), dates and times
(`yyyy`, `MM`, `M`, `dd`, `d`, `HH`, `mm`, `ss`, `S…`, `X…`, `x…`), booleans
(`true|false`) and regular expressions for other types, with `length`,
`minLength`, `maxLength` and `minimum` / `maximum` / `min|maxInclusive` /
`min|maxExclusive` constraints. URI templates (`aboutUrl`, `propertyUrl`,
`valueUrl`) are expanded with RFC 6570 level 4.

### Not yet supported

- **Locating metadata over HTTP**: `Link: rel="describedby"` headers on a
  tabular data file and a site-wide `/.well-known/csvm` configuration are not
  consulted (the default locations are, through the `Loader`). A caller that
  has fetched such metadata can pass it as `metadata`.
- **Parsing CSV text**: the `Loader` hands back parsed records; a CSV scanner
  (`@thomasfosterau/effect-csv`) will provide them.
- **Provenance**: the optional PROV triples of CSV2RDF are not generated.
- **Transformations** are decoded and annotated but not run.

## SHACL (`@thomasfosterau/effect-rdf/shacl`)

An Effect-native [SHACL Core](https://www.w3.org/TR/shacl/) validator, on `@thomasfosterau/effect-rdf/shacl` (one subpath per module:
`…/shacl/Validator`, `…/shacl/Shapes`, …).

- **`Vocabulary`**: the `sh:` namespace as a typed vocabulary (`sh.NodeShape`, `sh.minCount`, …).
- **`Shapes`**: parses a shapes graph (`Dataset`) into a typed model of node and
  property shapes, targets and constraints. Ill-formed shapes graphs fail with a
  `ShapesGraphError`.
- **`Path`**: SHACL property paths (predicate, sequence, alternative, inverse,
  zero-or-more, one-or-more, zero-or-one): model, evaluation, RDF encoding.
- **`Validator`**: `validate(data, shapes, options)`, a `Validator` service and
  layer that pre-compiles a shapes graph, and a `Schema` that only accepts
  conforming datasets.
- **`ValidationReport`**: the typed report model, convertible to and from the
  standard RDF validation report graph; `ValidationReportSchema` has a JSON
  codec (`Schema.toCodecJson`) that mirrors the model.
- **`Sparql`**: the `SparqlConstraintEvaluator` service interface, the extension
  point for SHACL-SPARQL (`sh:sparql`, SPARQL-based constraint components,
  `sh:target`), implemented by `@thomasfosterau/effect-rdf/sparql/shacl`.
- **`Message`**: `{?var}` / `{$var}` message template substitution.

All 98 SHACL Core tests of the W3C test suite pass (see [Conformance](#conformance)).
The 22 `sparql/` tests need a SPARQL evaluator and are run (and pass) by
[`@thomasfosterau/effect-rdf/sparql/shacl`](#shacl-sparql-thomasfosteraueffect-rdfsparqlshacl), which implements
`Sparql.SparqlConstraintEvaluator` on `@thomasfosterau/effect-rdf/sparql`.

### Validating a data graph

```ts
import { Effect } from 'effect';
import { Validator, ValidationReport } from '@thomasfosterau/effect-rdf/shacl';

const program = Effect.gen(function* () {
  // shapesGraph and dataGraph are core `Dataset`s, e.g. parsed from Turtle.
  const report = yield* Validator.validate(dataGraph, shapesGraph);
  if (!report.conforms) {
    console.log(ValidationReport.format(report));
    for (const result of report.results) {
      result.focusNode; // Term
      result.resultPath; // Option<Path>
      result.value; // Option<Term>
      result.sourceShape; // NamedNode | BlankNode
      result.sourceConstraintComponent; // e.g. sh:MinCountConstraintComponent
      result.severity; // sh:Violation | sh:Warning | sh:Info | custom
      result.messages; // sh:message values, or a default English message
    }
  }
  // The standard RDF validation report:
  const reportGraph = ValidationReport.toDataset(report);
});
```

`validate` fails with a typed error when validation cannot produce a report:
`ShapesGraphError` (ill-formed shapes graph), `RecursiveShapeError`,
`UnsupportedFeatureError` (SHACL-SPARQL without an evaluator) or
`SparqlEvaluationError`.

#### Options

```ts
Validator.validate(dataGraph, shapesGraph, {
  // Validate data ∪ shapes graph (e.g. when the data graph declares sh:shapesGraph,
  // or shapes and data live in the same document).
  includeShapesGraph: true,
  // SHACL-SPARQL constructs without a SparqlConstraintEvaluator: 'fail' (default) | 'ignore'.
  sparql: 'ignore',
  // A shape reached again for the same focus node while validating it:
  // 'fail' (default, RecursiveShapeError) | 'ignore' (treat as conforming).
  recursion: 'fail',
  // Attach nested results of sh:node / sh:not / sh:and / sh:or / sh:xone as sh:detail.
  details: true,
});
```

Class-based targets (`sh:targetClass`, implicit class targets) and `sh:class`
use `rdfs:subClassOf` from the data graph, as the specification requires.

### A pre-compiled validator service

```ts
import { Effect } from 'effect';
import { Validator } from '@thomasfosterau/effect-rdf/shacl';

const program = Effect.gen(function* () {
  const validator = yield* Validator.Validator;
  const report = yield* validator.validate(dataGraph);
  const ok = yield* validator.conforms(otherGraph);
  // Fails with ConformanceError (carrying the report) unless the graph conforms.
  const checked = yield* validator.check(dataGraph);
}).pipe(Effect.provide(Validator.layer(shapesGraph)));
```

`Validator.layer` parses the shapes graph once (failing the layer with a
`ShapesGraphError` if it is ill-formed).

### As a Schema

```ts
import { Effect, Schema } from 'effect';
import { Shapes, Validator } from '@thomasfosterau/effect-rdf/shacl';

const program = Effect.gen(function* () {
  const shapes = yield* Shapes.parse(shapesGraph);
  const PersonData = Validator.schema(shapes); // Schema<Dataset, Dataset>
  const valid = yield* Schema.decodeEffect(PersonData)(dataGraph);
});
```

By default only `sh:Violation` results fail decoding; `{ failOn: 'warning' }` also fails on
`sh:Warning`, and `{ failOn: 'info' }` on any result (the report's own `conforms`, which is false
whenever there is any result at all). A failure is a `SchemaIssue.Composite` with one
`InvalidValue` per failing result: its `message` annotation is the one-line
`ValidationReport.formatResult(result)` and its `result` annotation the `ValidationResult` (focus
node, path, constraint component, severity, messages).

To parse and validate in one decode, compose it with a syntax codec:

```ts
import { Turtle } from '@thomasfosterau/effect-rdf/turtle';

const PersonDocument = Turtle.codec.schema.pipe(Schema.decodeTo(Validator.schema(shapes)));
const data = yield * Schema.decodeEffect(PersonDocument)(turtleText); // Dataset, parsed and valid
```

### Inspecting a shapes graph

```ts
const shapes = yield * Shapes.parse(shapesGraph);
for (const shape of shapes.shapes) {
  shape._tag; // 'NodeShape' | 'PropertyShape'
  shape.targets; // TargetNode | TargetClass | TargetSubjectsOf | TargetObjectsOf | SparqlTarget
  shape.constraints; // tagged union: MinCount, Datatype, Pattern, Node, Or, QualifiedMinCount, …
}
```

### SHACL-SPARQL

The core validator does not execute SPARQL. Provide a
`Sparql.SparqlConstraintEvaluator` to evaluate `sh:sparql` constraints,
SPARQL-based constraint components and `sh:target` — normally the one from
`@thomasfosterau/effect-rdf/sparql/shacl`:

```ts
import { Evaluator } from '@thomasfosterau/effect-rdf/sparql/shacl';

Validator.validate(dataGraph, shapesGraph).pipe(Effect.provide(Evaluator.layer()));
```

or a custom implementation:

```ts
import { Effect, Layer } from 'effect';
import { Sparql, Validator } from '@thomasfosterau/effect-rdf/shacl';

const EvaluatorLive = Layer.succeed(Sparql.SparqlConstraintEvaluator, {
  // One call per (shape, constraint, focus node); return the solutions as violations.
  evaluateConstraint: ({ dataGraph, shapesGraph, shape, constraint, focusNode, valueNodes }) =>
    Effect.succeed([{ value: focusNode }]),
  selectTargets: ({ dataGraph, target }) => Effect.succeed([]),
});

Validator.validate(dataGraph, shapesGraph).pipe(Effect.provide(EvaluatorLive));
```

Without an evaluator, shapes graphs using these features fail with
`UnsupportedFeatureError`, or the constructs are skipped with `{ sparql: 'ignore' }`.

### Notes

- Validating recursive shapes is undefined in SHACL; this validator detects it.
- `sh:message` templates are substituted: `{?var}` / `{$var}` refer to
  `this`, `value`, `path` and the constraint's parameters by local name
  (`{$minCount}`, `{$datatype}`, …); for SPARQL-based constraints also to
  the solution variables (`Violation.bindings`). Unknown placeholders are
  left as they are.
- Literal comparisons (`sh:minInclusive`, `sh:lessThan`, …) follow SPARQL `<`:
  numerics across types, strings, booleans, date/time values (with the 14-hour
  timezone rule) and durations; incomparable values are violations.

## SPARQL (`@thomasfosterau/effect-rdf/sparql`)

SPARQL 1.1 (and SPARQL 1.2) for [Effect](https://effect.website), built on
[`@thomasfosterau/effect-rdf`](#modules): a complete parser and generator, the
SPARQL algebra with an optimizer, a streaming query and update engine over a
pluggable storage service, the standard results formats, a strongly-typed
query builder, and — on `effect/http` — a [SPARQL 1.1
Protocol](https://www.w3.org/TR/sparql11-protocol/) and [Graph Store HTTP
Protocol](https://www.w3.org/TR/sparql11-http-rdf-update/)
[server](#protocol-server) and [client](#protocol-client). Three subpaths build on the engine:
[SHACL-SPARQL](#shacl-sparql-thomasfosteraueffect-rdfsparqlshacl) for the SHACL validator
(`/sparql/shacl`), [knowledge-graph tools for `effect/ai`](#knowledge-graph-tools-thomasfosteraueffect-rdfsparqlai)
(`/sparql/ai`) and the [SQL store](#sparql-over-sql-thomasfosteraueffect-rdfsparqlsql) (`/sparql/sql`).
Everything here is platform-neutral; the Node server, the `effect-sparql-server`
command and the typed `SparqlApi` `HttpApi` definition are
[`@thomasfosterau/effect-sparql-node`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/sparql-node).

- **`Parser`** — a compiled LL(1) grammar (on
  [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse),
  reusing the Turtle terminals of `@thomasfosterau/effect-rdf/turtle/Grammar`) for
  SPARQL 1.1 Query and Update plus SPARQL 1.2 (triple terms `<<( s p o )>>`, reified triples
  `<< s p o ~ r >>`, annotations `{| … |}`, `VERSION`, `@lang--dir`), with all
  static checks (blank node scoping, grouping, `BIND`/`AS` scoping, `VALUES`
  arity, `DELETE` blank nodes, …) and `SparqlParseError`s carrying
  line/column.
- **`Ast`** — typed AST (`Select`/`Construct`/`Ask`/`Describe`, all update
  operations) over core `Term`s, with constructors.
- **`Generator`** — prints any AST back to SPARQL; parse → print → parse is
  stable.
- **`Algebra`**, **`Translate`** — translation to the SPARQL algebra exactly
  per §18 (BGP, Path, Join, LeftJoin, Filter, Union, Graph, Extend, Minus,
  Group/aggregation, OrderBy, Project, Distinct, Reduced, Slice, Values,
  Service), S-expression formatting and tree utilities.
- **`Optimizer`** — semantics-preserving filter pushdown and BGP join
  ordering by selectivity (using store estimates when available).
- **`Expression`**, **`Functions`** — every SPARQL 1.1 operator and function
  (string, numeric, date/time, hashes, `RAND`/`NOW`/`UUID`/`STRUUID`/`BNODE`
  with per-query semantics), effective boolean value, XSD casts, the
  `ORDER BY` ordering, SPARQL 1.2 `TRIPLE`/`SUBJECT`/`PREDICATE`/`OBJECT`/
  `isTRIPLE`/`LANGDIR`/`hasLANG`/`hasLANGDIR`/`STRLANGDIR`, and extension
  functions registered by IRI.
- **`Store`** — the `QuadStore` service implemented by backends, and an
  in-memory `QuadStore` (`Store.layerMemory`) on the core `Dataset`.
- **`Engine`** — the `SparqlEngine` service: streaming `SELECT`, `ASK`,
  `CONSTRUCT`, `DESCRIBE` and atomic updates.
- **`Results`** — SPARQL results in JSON (via Effect `Schema`), XML, CSV and
  TSV: streaming serialisers and parsers, including triple terms and base
  directions; media-type lookup and `Accept` negotiation.
- **`QueryBuilder`**, **`TermSchema`** — an immutable, typed builder whose
  `SELECT` rows are typed from the projection, and schemas decoding terms to
  JS values (`TermSchema` re-exports core's `TermCodec`, so code that only
  decodes terms can depend on `@thomasfosterau/effect-rdf` alone).

### Querying

```ts
import { Effect, Layer, Stream } from 'effect';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { Bindings, Engine, Store } from '@thomasfosterau/effect-rdf/sparql';

const data = Dataset.make(/* … quads … */);
const SparqlLive = Engine.layer({ baseIri: 'http://example.org/' }).pipe(
  Layer.provideMerge(Store.layerMemory(data)),
);

const program = Effect.gen(function* () {
  const engine = yield* Engine.SparqlEngine;

  // SELECT: a lazy Stream of solutions (LIMIT stops evaluation early).
  const result = yield* engine.select(`
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT ?name WHERE { ?p foaf:name ?name } ORDER BY ?name LIMIT 10`);
  yield* Stream.runForEach(result.bindings, (b) => Effect.log(Bindings.get(b, 'name')));

  const known = yield* engine.ask('ASK { ?s ?p ?o }');
  const triples = yield* engine.construct('CONSTRUCT WHERE { ?s ?p ?o }');

  yield* engine.update(`
    PREFIX ex: <http://example.org/>
    INSERT { ?s ex:seen true } WHERE { ?s ?p ?o }`);
});

Effect.runPromise(program.pipe(Effect.provide(SparqlLive)));
```

`EngineOptions`: `unionDefaultGraph` (the default graph is the union of all
graphs when there is no `FROM`), `baseIri`, `functions` (extension functions
by IRI), `service` (federation), `load` (`LOAD` support) and `optimize`.
`RequestOptions.dataset` overrides the dataset per request (the protocol's
`default-graph-uri` / `named-graph-uri`); `FROM`/`FROM NAMED` in the query
take precedence.

#### Pre-bound variables

`RequestOptions.bindings` pre-binds variables (initial bindings) with the
"values insertion" semantics of SHACL-SPARQL and SPARQL `EXISTS`
(`Algebra.prebind`): the solution is joined into every BGP, property path and
`GRAPH ?g` pattern, so it is visible to every `FILTER` and `BIND` — unlike a
trailing `VALUES` clause.

```ts
const rows =
  yield *
  engine.select('SELECT $this WHERE { FILTER (isIRI($this)) }', {
    bindings: Bindings.make({ this: Term.namedNode('http://example.org/a') }),
  });
```

### Typed query builder

```ts
import { Schema, Stream } from 'effect';
import { Namespace } from '@thomasfosterau/effect-rdf';
import { QueryBuilder as Q, TermSchema } from '@thomasfosterau/effect-rdf/sparql';

const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const v = Q.vars('person', 'name', 'email'); // or the untyped proxy Q.v

const query = Q.select('person', 'name', Q.maybe('email'), Q.as(Q.strlen(v.name), 'length'))
  .where(Q.triple(v.person, foaf('name'), v.name))
  .optional(Q.triple(v.person, foaf('mbox'), v.email))
  .filter(Q.gt(Q.strlen(v.name), 3))
  .orderBy(Q.desc(v.name))
  .limit(10);

query.build(); // Ast.SelectQuery
query.toString(); // SPARQL text

// Stream<{ readonly person: GroundTerm; readonly name: GroundTerm;
//          readonly length: GroundTerm; readonly email?: GroundTerm }>
const rows = Q.execute(query);

// Decoding rows to JS values with schemas.
const people = Q.decode(
  query,
  Schema.Struct({ name: TermSchema.string, email: Schema.optional(TermSchema.iri) }),
);
```

### Results formats

```ts
import { Results } from '@thomasfosterau/effect-rdf/sparql';

const codec = Results.negotiate(request.headers.accept); // Option<ResultsCodec>
const body = Results.Json.serialize(selectResult); // Stream<string>
const parsed = yield * Results.Xml.parse(text); // ResultSet | BooleanResult
```

The TSV term syntax and CSV rows are parsed with
[`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
(an optional peer dependency of effect-rdf, needed by this subpath), using compiled grammars. A
`ResultsParseError` from the TSV or CSV parsers carries the 1-based `line`
and `column` of the error. `vp run --filter ./packages/core bench:sparql` times both parsers on every
SRX/SRJ result in the conformance suites, re-serialised as TSV and CSV,
plus a synthetic 20,000-row document.

`vp run --filter ./packages/core bench:sparql` also times the query and update parser on every `.rq` and `.ru`
file of the conformance suites (188 kB) and on two synthetic documents (a
222 kB query and a 117 kB update). On Node 22 it reads 4–6 MB/s (the suite in
about 40–50 ms, the query in about 55 ms and the update in about 20 ms),
1.4–1.8× slower than the hand-written parser it replaced, with identical
ASTs, errors and error positions on every suite file and on 8,000 mutated
copies of them.

### Extension points

These are the seams for the packages built on top of this one.

#### Storage backends (`Store.QuadStore`)

A backend provides the `QuadStore` service:

| member                              | purpose                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `match(pattern)`                    | stream the quads matching a quad pattern (`undefined` = wildcard; `graph` may be the default graph) |
| `estimate?(pattern)`                | cheap cardinality estimate used by the optimizer to order joins                                     |
| `graphs`, `hasGraph`                | named graph listing (including empty graphs the backend tracks)                                     |
| `insert`, `delete`                  | quad updates                                                                                        |
| `createGraph`, `dropGraph`, `clear` | graph management for `CREATE`, `DROP`, `CLEAR`, `ADD`, `MOVE`, `COPY`                               |
| `transaction(effect)`               | run an effect atomically (each update request runs in one transaction)                              |
| `query?`                            | optional native algebra evaluation (`QueryCapability`)                                              |

#### Native algebra evaluation (SPARQL-to-SQL)

`QueryCapability.evaluate(op, context)` is offered **every algebra node,
top-down**, before the generic evaluator handles it. Returning
`Option.some(stream)` takes over the whole subtree; `Option.none()` lets the
engine evaluate the node itself, offering its children again. A SQL backend
can therefore translate the largest subtrees it supports (BGPs, joins,
filters, …) to SQL and leave the rest (e.g. property paths, exotic functions)
to the engine. The `context` carries the `DatasetSpec` (default and named
graphs), the active graph, and `evaluate(op, graph?)` to delegate children
back to the engine. The algebra types live in `Algebra` (with `format`,
`transform`, `variables`, `certainVariables` helpers); internal variables
(blank nodes, path steps, aggregates) start with `@`.

#### Federation (`SERVICE`) and `LOAD`

`EngineOptions.service` receives the endpoint IRI and the `Algebra.Service`
node (whose `pattern` holds the original syntax, printable with
`Generator.printPattern`) and returns the remote solutions — the hook for an
HTTP client (implemented by [`Federation`](#federation)).
`SERVICE ?endpoint { … }` is evaluated once per solution after `?endpoint`
has been bound by an earlier pattern. `EngineOptions.load` fetches documents
for `LOAD`.

#### Protocol servers and clients

The [server](#protocol-server) and [client](#protocol-client) below are built
on these:

- `Parser.parse` accepts a query or an update; errors carry positions.
- `Results.codecs`, `Results.codecFor`, `Results.negotiate` and the streaming
  `serialize` functions implement the results side of the protocol; the
  parsers (`Results.Json.parse`, …) are what a client needs.
- `Engine.RequestOptions.dataset` maps the protocol's dataset parameters.
- `Generator.print` turns builder or parsed ASTs into query text for remote
  endpoints.

### Protocol server

A SPARQL 1.1 Protocol and Graph Store HTTP Protocol server built with
`effect/http` on top of the engine (`SparqlServer`, with `Protocol`,
`GraphStore`, `ServiceDescription`, `Options`, `ServerFormats` and
`ProtocolErrors`):

- **Queries** with `GET` (`?query=`), `POST` form-encoded and `POST`
  `application/sparql-query`; **updates** with `POST` form-encoded and `POST`
  `application/sparql-update`.
- The protocol's dataset parameters: `default-graph-uri` / `named-graph-uri`
  (overriding `FROM` / `FROM NAMED`) and `using-graph-uri` /
  `using-named-graph-uri` (rejected with `400` when the update has `USING` or
  `WITH`).
- Errors as specified: `400` for syntax errors, repeated or conflicting
  parameters; `405` (with `Allow`) for other methods; `415` for missing or
  unsupported content types and non-UTF-8 charsets; `406` when no acceptable
  result format exists; `403` for updates in read-only mode; `503` when a
  query exceeds its time limit; `500` for evaluation failures.
- **Content negotiation**: SPARQL results as JSON, XML, CSV or TSV;
  `CONSTRUCT` / `DESCRIBE` results and graphs in every syntax of the core
  `Serialization.Formats` service — by default Turtle, N-Triples, RDF/XML,
  JSON-LD, N3, TriG, N-Quads and RDF/JSON (`ServerFormats.layer`). Responses are
  **streamed** as the engine produces solutions; the server waits for the
  first solution before sending the status, so errors (and timeouts) raised
  before it get a proper status code.
- **Graph Store Protocol**: `GET`, `HEAD`, `PUT`, `POST` and `DELETE` on
  `?default`, `?graph=<iri>` (indirect identification) and on any URL below
  the graph store (direct identification); `POST` to the graph store creates
  a graph (`201 Created` with `Location`); bodies are parsed by
  `Content-Type`, including `multipart/form-data`.
- **Service description** (SPARQL 1.1 Service Description) on `GET` without
  a query, in any RDF syntax.
- **Configurable**: endpoint paths, read-only mode, query and update
  timeouts, maximum result size, CORS, request logging and tracing spans
  (`SparqlServer.query`, `SparqlServer.update`, `SparqlServer.graphStore`).
- Usable as a plain HTTP app (`handler`), as `HttpRouter` routes to mount in
  your own server (`layerRoutes`), or served on whichever `HttpServer` the
  context provides (`layerServe`). The complete Node server
  (`NodeSparqlServer`), its CLI and an `effect/http-api` definition of both
  protocols (`SparqlApi`, with an OpenAPI document and a derived client) are
  in `@thomasfosterau/effect-sparql-node`.

#### Mounting into an existing server

`SparqlServer.layerRoutes(options)` registers the routes on the
`HttpRouter`, and `SparqlServer.handler(options)` is the whole server as one
HTTP app (`Effect<HttpServerResponse, never, HttpServerRequest | …>`) that
dispatches on the configured paths:

```ts
import { Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { NodeHttpServer } from '@effect/platform-node';
import { createServer } from 'node:http';
import { SparqlServer } from '@thomasfosterau/effect-rdf/sparql';

const Routes = Layer.mergeAll(
  HttpRouter.add('GET', '/health', HttpServerResponse.text('ok')),
  SparqlServer.layerRoutes({ path: '/api/sparql', graphStorePath: '/api/graphs' }),
);

const Main = HttpRouter.serve(Routes).pipe(
  Layer.provide(SparqlServer.layerMemoryServices()),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8080 })),
);
```

`HttpRouter.toWebHandler` turns the same routes into a `fetch`-style handler
for serverless runtimes.

#### Options

| option               | default            | meaning                                                                        |
| -------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `path`               | `/sparql`          | query endpoint (also the update endpoint unless `updatePath` is set)           |
| `updatePath`         | `path`             | separate update endpoint                                                       |
| `graphStorePath`     | `/rdf-graph-store` | Graph Store Protocol root, or `false`                                          |
| `baseUrl`            | from `Host`        | public origin, for request URLs, base IRIs and directly identified graphs      |
| `baseIri`            | endpoint URL       | base IRI of queries and updates                                                |
| `readOnly`           | `false`            | reject updates (`403`) and graph store writes (`405`)                          |
| `queryTimeout`       | none               | `Duration` limit for queries (`503`; a streaming response is aborted)          |
| `updateTimeout`      | none               | `Duration` limit for updates (`503`)                                           |
| `maxResults`         | none               | truncate results to this many solutions / triples                              |
| `cors`               | off                | `true` or `{ allowedOrigins, allowedHeaders, exposedHeaders, maxAge, … }`      |
| `logging`            | `false`            | log requests in `handler` / `layerRoutes` (`layerServe` logs via `HttpRouter`) |
| `serviceDescription` | `true`             | serve the service description on `GET` without a query                         |
| `unionDefaultGraph`  | `false`            | advertise `sd:UnionDefaultGraph`                                               |
| `federation`         | `false`            | advertise `sd:BasicFederatedQuery`                                             |
| `prefixes`           | `{}`               | prefixes used when serialising graphs                                          |

#### Testing

`Testing.makeClient(options)` / `Testing.layerClient(options)` give an
`HttpClient` answered in-process by the server, and `Testing.fromApps`
routes requests to several in-process servers by origin — handy for testing
clients and federated queries without sockets.

```ts
import { Effect, Layer } from 'effect';
import { HttpClient } from 'effect/http';
import { SparqlServer, Testing } from '@thomasfosterau/effect-rdf/sparql';

const program = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get('http://localhost/sparql?query=ASK%20%7B%7D');
  return yield* response.text;
}).pipe(
  Effect.provide(Testing.layerClient().pipe(Layer.provide(SparqlServer.layerMemoryServices()))),
);
```

### Protocol client

A strongly-typed SPARQL 1.1 Protocol and Graph Store HTTP Protocol client
built on the `effect/http` `HttpClient` (`SparqlClient`, with `ResultsStream`,
`ClientFormats`, `ClientErrors` and `Federation`):

- **Queries** as strings, parsed `Ast` values or `QueryBuilder` builders —
  the typed rows of `QueryBuilder.select(…)` flow through to `select`, and
  rows can be decoded with an Effect `Schema`.
- **Streaming**: `SELECT` results are parsed incrementally (JSON, XML,
  TSV and CSV) and emitted as a `Stream`; `CONSTRUCT` / `DESCRIBE`
  results are parsed with the `Serialization.Formats` parser for the response
  media type (N-Triples is preferred and parsed incrementally).
- **Updates** with `using-graph-uri` / `using-named-graph-uri`, and the
  **Graph Store Protocol**: `getGraph`, `hasGraph`, `putGraph`, `postGraph`,
  `createGraph`, `deleteGraph`.
- **Typed errors** (`SparqlClientError`): `HttpStatusError` (with the
  response body), `MalformedResponseError`, `UnsupportedMediaTypeError`,
  `TransportError`, `TimeoutError`, `ConfigurationError`.
- **Timeouts and retries** configured with a `Duration` and an Effect
  `Schedule` (transient failures only, by default).
- **Federation**: a `SERVICE` handler and a `LOAD` loader for the in-memory
  engine, so that it evaluates `SERVICE <url> { … }` remotely.
- **A derived client** (`SparqlApiClient`, in `@thomasfosterau/effect-sparql-node`)
  generated with `HttpApiClient` from the `SparqlApi` definition.

#### Querying an endpoint

```ts
import { Effect, Layer, Schedule, Schema, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Namespace } from '@thomasfosterau/effect-rdf';
import { QueryBuilder as Q, SparqlClient, TermSchema } from '@thomasfosterau/effect-rdf/sparql';

const ClientLive = SparqlClient.layer({
  endpoint: 'https://query.wikidata.org/sparql',
  headers: { 'user-agent': 'my-app/1.0' },
  method: 'auto', // GET for short queries, POST otherwise
  timeout: '30 seconds',
  retry: Schedule.max([Schedule.exponential('200 millis'), Schedule.recurs(3)]),
}).pipe(Layer.provide(FetchHttpClient.layer));

const foaf = Namespace.make('http://xmlns.com/foaf/0.1/');
const v = Q.vars('person', 'name', 'mbox');
const query = Q.select('person', 'name', Q.maybe('mbox'))
  .where(Q.triple(v.person, foaf('name'), v.name))
  .optional(Q.triple(v.person, foaf('mbox'), v.mbox))
  .limit(10);

const program = Effect.gen(function* () {
  const client = yield* SparqlClient.SparqlClient;

  // Stream<{ person: GroundTerm; name: GroundTerm; mbox?: GroundTerm }>
  yield* Stream.runForEach(client.select(query), (row) => Effect.log(row.name));

  // Untyped rows from a string (or an Ast.Query).
  const rows = yield* Stream.runCollect(client.select('SELECT * { ?s ?p ?o } LIMIT 3'));

  // Rows decoded with a schema.
  const people = yield* Stream.runCollect(
    SparqlClient.decode(query, Schema.Struct({ name: TermSchema.string })),
  );

  const exists = yield* client.ask('ASK { ?s ?p ?o }');
  const graph = yield* client.constructDataset('CONSTRUCT WHERE { ?s ?p ?o } LIMIT 10');
  const triples = client.describe(Q.describe(foaf('Person'))); // Stream<Quad>

  // Protocol dataset parameters.
  yield* Stream.runDrain(
    client.select('SELECT * { ?s ?p ?o }', { defaultGraphs: ['http://example.org/g'] }),
  );
});

Effect.runPromise(program.pipe(Effect.provide(ClientLive)));
```

`selectAll` collects a result set with its variables, `results` exposes the
raw stream of events (`Variables`, `Solution`, `Boolean`), and `query`
evaluates any query form and dispatches on the response media type.

#### Updates and the Graph Store

```ts
import { Effect } from 'effect';
import { Term } from '@thomasfosterau/effect-rdf';
import { SparqlClient } from '@thomasfosterau/effect-rdf/sparql';

const ClientLive = SparqlClient.layer({
  endpoint: 'http://localhost:3030/sparql',
  updateEndpoint: 'http://localhost:3030/sparql',
  graphStoreEndpoint: 'http://localhost:3030/rdf-graph-store',
});

const program = Effect.gen(function* () {
  const client = yield* SparqlClient.SparqlClient;
  yield* client.update('INSERT DATA { <urn:a> <urn:b> "c" }');
  yield* client.update('DELETE WHERE { ?s ?p ?o }', { usingGraphs: ['urn:g'] });

  const g = Term.namedNode('http://example.org/people');
  yield* client.putGraph(g, [
    Term.quad(Term.namedNode('urn:x'), Term.namedNode('urn:p'), Term.literal('v')),
  ]);
  yield* client.postGraph(g, [], { mediaType: 'text/turtle' });
  const dataset = yield* client.getGraphDataset(g);
  const exists = yield* client.hasGraph(g);
  const created = yield* client.createGraph([]); // POST to the store: the new graph's IRI
  yield* client.deleteGraph(g);
  yield* client.getGraphDataset('default');
});
```

#### Client errors

```ts
const result = client.ask('ASK {').pipe(
  Effect.catchTag('HttpStatusError', (e) => Effect.logError(e.status, e.body)),
  Effect.catchTag('TimeoutError', () => Effect.succeed(false)),
);
```

`ClientErrors.isTransient` decides what `retry` retries (transport errors,
timeouts, `408`, `429`, `502`, `503`, `504`); override it with `retryWhile`.

#### Federation

```ts
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Federation, Store } from '@thomasfosterau/effect-rdf/sparql';

// SERVICE <url> { … } is sent to the remote endpoint; LOAD <url> fetches
// documents over HTTP.
const EngineLive = Federation.layerEngine({ baseIri: 'http://example.org/' }).pipe(
  Layer.provide(Store.layerMemory()),
  Layer.provide(FetchHttpClient.layer),
);
```

`Federation.serviceHandler(config)` and `Federation.loader(config)` give the
`Engine.EngineOptions.service` / `load` functions on their own. Each remote
pattern is sent as `SELECT * WHERE { … }` with the prefixes of the original
query; `SERVICE SILENT` swallows failures, and `SERVICE ?endpoint` works once
`?endpoint` is bound by an earlier pattern.

#### Client formats

The client uses the `Serialization.Formats` service when one is provided and
falls back to `ClientFormats.defaults` (N-Triples, Turtle, N-Quads, TriG, RDF/XML,
JSON-LD, N3, RDF/JSON). `ResultsStream` exposes the incremental results
parsers.

### SHACL-SPARQL (`@thomasfosterau/effect-rdf/sparql/shacl`)

[SHACL-SPARQL](https://www.w3.org/TR/shacl/#sparql-constraints) for
[`@thomasfosterau/effect-rdf/shacl`](#shacl-thomasfosteraueffect-rdfshacl), on
`@thomasfosterau/effect-rdf/sparql/shacl` (and `…/shacl/Evaluator`, `…/shacl/Query`),
evaluated with this package's engine. It implements the
`Sparql.SparqlConstraintEvaluator` service that the SHACL validator delegates
SPARQL features to, so the core's SHACL validator itself stays free of a
SPARQL dependency.

- **`Evaluator`**: `Evaluator.layer(options?)` / `Evaluator.make(options?)`
  providing the evaluator.
- **`Query`**: reading `sh:select` / `sh:ask` queries with their prefix
  declarations, the pre-binding restrictions and `$PATH` substitution.

Supported:

- SPARQL-based constraints (`sh:sparql` with `sh:select`, `sh:message`,
  `sh:deactivated`) on node and property shapes;
- SPARQL-based constraint components: parameters (mandatory and
  `sh:optional`), `sh:nodeValidator` / `sh:propertyValidator` (SELECT) and
  `sh:validator` (ASK), validator and component messages;
- SPARQL-based targets (`sh:SPARQLTarget`) and target types
  (`sh:SPARQLTargetType` with parameters) from SHACL Advanced Features;
- pre-bound `$this`, `$value` (ASK validators), `$currentShape`,
  `$shapesGraph` and parameters, with the exact pre-binding semantics of the
  specification (values insertion, see `Algebra.prebind` in
  `/sparql`) and its restrictions: `MINUS`, `VALUES`, `SERVICE`,
  `AS ?prebound` and sub-queries that drop pre-bound variables are failures;
- `$PATH` substitution with the property shape's path (any other use of
  `$PATH` is a failure);
- prefixes via `sh:prefixes` / `owl:imports` / `sh:declare` (conflicting
  declarations are failures);
- the result variables `?this`, `?value`, `?path`, `?message` and `?failure`;
- `{?var}` / `{$param}` placeholders in messages (substituted by the
  validator from the solution and parameters).

#### Usage

```ts
import { Effect } from 'effect';
import { ValidationReport, Validator } from '@thomasfosterau/effect-rdf/shacl';
import { Evaluator } from '@thomasfosterau/effect-rdf/sparql/shacl';
import { Turtle } from '@thomasfosterau/effect-rdf/turtle';

const program = Effect.gen(function* () {
  const { dataset: shapes } = yield* Turtle.parse(`
    @prefix sh: <http://www.w3.org/ns/shacl#> .
    @prefix ex: <http://example.org/> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    ex: sh:declare [ sh:prefix "ex" ; sh:namespace "http://example.org/"^^xsd:anyURI ] .

    ex:PersonShape a sh:NodeShape ;
      sh:targetClass ex:Person ;
      sh:sparql [
        sh:prefixes ex: ;
        sh:message "{$this} is their own parent" ;
        sh:select """
          SELECT $this WHERE { $this ex:parent $this }
        """ ;
      ] .
  `);
  const { dataset: data } = yield* Turtle.parse(`
    @prefix ex: <http://example.org/> .
    ex:alice a ex:Person ; ex:parent ex:alice .
  `);
  const report = yield* Validator.validate(data, shapes);
  console.log(ValidationReport.format(report));
}).pipe(Effect.provide(Evaluator.layer()));
```

##### Constraint components

```turtle
ex:MaxWordsComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path ex:maxWords ] ;
  sh:message "Value has more than {$maxWords} words" ;
  sh:validator [
    a sh:SPARQLAskValidator ;
    sh:ask """ASK { FILTER (strlen(replace(str($value), "[^ ]", "")) < $maxWords) }""" ;
  ] .

ex:BookShape a sh:NodeShape ;
  sh:targetClass ex:Book ;
  sh:property [ sh:path ex:title ; ex:maxWords 8 ] .
```

##### Options

```ts
Evaluator.layer({
  // The IRI of the named graph holding the shapes graph ($shapesGraph).
  shapesGraphIri: 'urn:x-shacl:shapesGraph',
  // Options of the SPARQL engine, e.g. extension functions.
  engine: { functions },
});
```

The data graph is the default graph of the queried dataset (named graphs of
the data are merged into it, as the core validator sees them). Per data graph
the evaluator builds one in-memory store and caches compiled queries.

### Knowledge-graph tools (`@thomasfosterau/effect-rdf/sparql/ai`)

On `@thomasfosterau/effect-rdf/sparql/ai` (and `…/ai/Tools`, `…/ai/Mcp`):
knowledge-graph tools for [Effect AI](https://effect.website) (`effect/ai`): a
`Toolkit` that lets a language model explore and query an RDF dataset through
this package's engine, and the same tools as an
[MCP](https://modelcontextprotocol.io/specification) server registration for
any MCP client.

```sh
pnpm add effect @thomasfosterau/effect-rdf @thomasfosterau/effect-rdf/sparql
```

#### Tools

| Tool                | Parameters        | Result                                                                                  |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `sparql_query`      | `query`, `limit?` | SELECT: SPARQL JSON results; ASK: `isTrue`; CONSTRUCT / DESCRIBE: Turtle; `isTruncated` |
| `describe_resource` | `iri`, `limit?`   | the triples whose subject is `iri`, as Turtle; `isTruncated`                            |
| `list_classes`      | `limit?`          | `[{ iri, count }]`: types in use and declared `rdfs:Class` / `owl:Class`                |
| `list_properties`   | `limit?`          | `[{ iri, count }]`: predicates in use and declared properties                           |
| `search_labels`     | `text`, `limit?`  | `[{ iri, label }]`: `rdfs:label` / `skos:prefLabel` containing `text` (any case)        |
| `sparql_update`     | `update`          | `{ isApplied }` — only in `Tools.toolkitWithUpdate`                                     |

`Tools.toolkit` holds the five read-only tools; `Tools.toolkitWithUpdate` adds
`sparql_update`. `Tools.layer(options)` / `Tools.layerWithUpdate(options)`
provide their handlers over the `SparqlEngine` service.

#### With a language model

```ts
import { Effect, Layer } from 'effect';
import { LanguageModel } from 'effect/ai';
import { Engine } from '@thomasfosterau/effect-rdf/sparql';
import { Tools } from '@thomasfosterau/effect-rdf/sparql/ai';

const answer = (question: string) =>
  Effect.gen(function* () {
    const toolkit = yield* Tools.toolkit;
    const response = yield* LanguageModel.generateText({ prompt: question, toolkit });
    return response.text;
  });

// Provide a `LanguageModel` (e.g. from @effect/ai-openai), the tool handlers and an engine.
const ToolsLive = Tools.layer({ maxRows: 50 }).pipe(Layer.provide(Engine.layerMemory()));
```

#### As an MCP server

`Mcp.layer(options)` registers the read-only tools with the `McpServer` in
context; add a transport and an engine:

```ts
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { McpProtocol, McpServer } from 'effect/ai';
import { Engine } from '@thomasfosterau/effect-rdf/sparql';
import { Mcp } from '@thomasfosterau/effect-rdf/sparql/ai';

Mcp.layer().pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: 'knowledge-graph',
      version: '1.0.0',
      protocols: [McpProtocol.v2025_11_25],
    }),
  ),
  Layer.provide(Engine.layerMemory()),
  Layer.provide(NodeServices.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
```

#### Safety

Tool input is written by a model, so treat it as untrusted:

- **Read-only by default.** `sparql_query` only accepts queries; updates need
  the separate `toolkitWithUpdate` (or `Mcp.layerWithUpdate`).
- **Bounded.** Every result is capped at `maxRows` (default 100) rows or
  triples and says whether it was truncated; every call times out after
  `timeout` (default 10 seconds).
- **No federation.** Queries with `SERVICE` are refused unless
  `federation: true` (and the engine has a federation handler).
- **Errors go back to the model** as a `SparqlToolError` (or a parameter
  validation error), so it can correct its query.

## SPARQL over SQL (`@thomasfosterau/effect-rdf/sparql/sql`)

The driver-agnostic SQL storage layer for
[`@thomasfosterau/effect-rdf/sparql`](#sparql-thomasfosteraueffect-rdfsparql), built on Effect's SQL
abstraction alone (`effect/sql`: `SqlClient`, `Statement`, `Migrator`). It
implements the engine's `QuadStore` service **and** its `QueryCapability`
extension point: SPARQL algebra is translated to SQL, so whole queries (or the
largest translatable subtrees) run as a single SQL statement, and everything
else falls back to the generic engine.

It runs over the `SqlClient` in the context, in one of two dialects
(`Dialect.sqlite`, `Dialect.postgres`, detected by `Dialect.fromClient`):

- **SQLite** (3.35 or later), e.g. through `@effect/sql-sqlite-node`.
- **PostgreSQL**, e.g. through `@effect/sql-pg`.

No driver is a dependency or a peer of effect-rdf: the application provides
the `SqlClient`. A ready backend for one driver (a store layer that also
provides that driver's `SqlClient`) is a package of its own,
`@thomasfosterau/effect-sparql-<driver>`, with the driver as its dependency or
peer; none is published yet.

### Usage

```ts
import { Effect, Layer, Stream } from 'effect';
import { Engine } from '@thomasfosterau/effect-rdf/sparql';
import { SqlStore } from '@thomasfosterau/effect-rdf/sparql/sql';
import { SqliteClient } from '@effect/sql-sqlite-node';

// The store over a SQLite file (or ':memory:'); provides SqlStore and QuadStore.
const SparqlLive = Engine.layer().pipe(
  Layer.provideMerge(SqlStore.layer()),
  Layer.provideMerge(SqliteClient.layer({ filename: 'data.db' })),
);

const program = Effect.gen(function* () {
  const store = yield* SqlStore.SqlStore;
  yield* store.insert(quads); // batched, interned, one transaction

  const engine = yield* Engine.SparqlEngine;
  const result = yield* engine.select(`
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT ?name (COUNT(?friend) AS ?friends) WHERE {
      ?p foaf:name ?name OPTIONAL { ?p foaf:knows ?friend }
    } GROUP BY ?name`);
  yield* Stream.runForEach(result.bindings, (b) => Effect.log(b.toString()));
});
```

With PostgreSQL, provide any `SqlClient` to `SqlStore.layer`:

```ts
import { PgClient } from '@effect/sql-pg';

const StoreLive = SqlStore.layer().pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) })),
);
```

`SqlStoreOptions`: `dialect` (detected from the client), `tablePrefix`
(default `rdf_`), `migrate` (create/migrate the schema with the Effect
`Migrator`, default `true`), `translate` (SPARQL-to-SQL, default `true`),
`batchSize`, `pageSize` (streaming `match`) and `onQuery`, a debug hook that
receives an event for every algebra node offered to the store (`Executed`
with the SQL text, or `Declined` with the reason). `store.compile(op)` returns
the SQL for an algebra tree without running it; queries are also traced with
an `SqlStore.query` span carrying the SQL text.

### Schema

| table              | columns                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `rdf_terms`        | `id`, `kind`, `value`, `datatype`, `lang`, `dir`, `sub`, `pre`, `obj`, `cls`, `num` |
| `rdf_quads`        | `s`, `p`, `o`, `g` (term ids; `g = 0` is the default graph)                         |
| `rdf_graphs`       | `id` — explicitly created (possibly empty) named graphs                             |
| `rdf_term_classes` | `cls` — the comparison classes present in the dictionary                            |
| `rdf_migrations`   | the store's `Migrator` table                                                        |

- **Terms are interned** in an append-only dictionary. `kind` is 1 IRI, 2
  blank node, 3 literal, 4 triple term. RDF 1.2 **triple terms are
  first-class**: `sub`, `pre`, `obj` hold the ids of their components (and
  `value` is `"s p o"`, so `(value, kind, datatype, lang, dir)` is the unique
  key of every term — indexed on `md5(value)` in PostgreSQL). Triple terms are
  indexed by component.
- `cls` is a **comparison class** (numeric, double, float, string,
  language-tagged string, boolean, temporal, unknown datatype, ill-formed, …)
  and `num` the numeric value of numeric and boolean literals; they let SQL
  evaluate SPARQL comparisons and effective boolean values per row.
- Quads are indexed `spog` (primary key), `posg`, `ospg` and `gspo`.
- Inserts are batched (terms with `INSERT … ON CONFLICT DO NOTHING
  RETURNING`, then quads), in one transaction; ids are cached in memory
  outside transactions. Loading 100,000 triples into SQLite takes about 1.5 s.

### QuadStore

`match` streams by keyset pagination over the index matching the bound
positions; `estimate` (bounded count) and `count` are SQL counts; `insert`,
`delete`, `createGraph`, `dropGraph`, `clear`, `graphs`, `hasGraph`; and
`transaction` maps to `SqlClient.withTransaction` (nested transactions use
savepoints).

### SPARQL to SQL

The engine offers every algebra node top-down; the store returns a stream
when the whole subtree is **exactly** translatable, otherwise the engine
evaluates the node itself and offers its children again. Solutions are rows of
term ids (`NULL` = unbound); the final `SELECT` joins the dictionary to decode
them.

| algebra                          | SQL                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| BGP                              | self-joins of `rdf_quads` (triple term patterns join `rdf_terms` on `kind = 4`)      |
| `Join`                           | merged `FROM`/`WHERE` with compatibility conditions (`NULL`-aware)                   |
| `LeftJoin`                       | `LEFT JOIN (…) ON compatible AND filter` (the OPTIONAL filter is in the `ON` clause) |
| `Union`                          | `UNION ALL` with `NULL` padding                                                      |
| `Minus`, `[NOT] EXISTS`          | correlated `NOT EXISTS` / `EXISTS`                                                   |
| `Filter`                         | `WHERE` (see expressions)                                                            |
| `Graph` (IRI or variable)        | graph column constraints; `FROM` / `FROM NAMED` datasets, union default graph        |
| `Extend`                         | term-valued expressions (variables, constants, `IF`, `COALESCE`, boolean results)    |
| `Values`                         | `VALUES` lists (terms not in the store get query-local negative ids)                 |
| `Project`, `Distinct`, `Reduced` | column selection, `SELECT DISTINCT`                                                  |
| `Slice`                          | `LIMIT` / `OFFSET`                                                                   |
| `Group`                          | `GROUP BY` variables with `COUNT(*)`, `COUNT([DISTINCT] ?x)`, `SAMPLE(?x)`; `HAVING` |

Expressions: `&&`, `||`, `!` (SPARQL's error semantics coincide with SQL's
three-valued logic, an error being `NULL`), `=`, `!=`, `<`, `>`, `<=`, `>=`,
`IN`, `NOT IN`, `BOUND`, `sameTerm`, `isIRI`, `isBlank`, `isLiteral`,
`isNumeric`, `isTRIPLE`, `hasLANG`, `hasLANGDIR`, `STR`, `LANG`, `DATATYPE`,
`STRLEN`, `STRSTARTS`, `STRENDS`, `CONTAINS`, `LANGMATCHES`, `IF`,
`COALESCE`, `EXISTS`, and effective boolean values.

**Correctness first.** Comparisons follow the engine exactly: numbers compare
by value (`1 = 1.0`), strings by code point (binary collation), language
strings only with the same tag, booleans by value, IRIs and blank nodes by
identity, incomparable values are errors. Combinations SQL cannot compare
exactly — dates and durations, integers beyond 2^53, decimals with more than
15 digits, `NaN`/`INF`, float/double promotion against non-constants, triple
term value equality — are recorded at compilation; before running, the store
checks which comparison classes the data contains and hands the node back to
the engine when such a combination can occur.

Evaluated by the engine (with their translatable children in SQL): `ORDER BY`
(SPARQL's ordering is not a total order SQL can reproduce), property paths,
`SERVICE`, `REGEX`, arithmetic, casts, string-building and date/time
functions, `SUM`/`AVG`/`MIN`/`MAX`/`GROUP_CONCAT`, group keys that are
expressions, and `LIMIT`/`GROUP BY` inside `GRAPH ?g`. Results are fetched
with one statement per translated subtree (SQLite has no cursors in
`node:sqlite`).

### Adding a dialect

A `Dialect` (see `Dialect.ts`) only produces SQL text; statements run through
the `SqlClient`. Implement:

- `schema(tables)` — idempotent DDL for the tables above (and a unique index
  on the dictionary key);
- `placeholder(i)` and `anonymousParameters` — `?` (positional) or `$1`;
- `valueKey` — the dictionary key expression (e.g. `md5(value)`);
- typed `NULL`s and casts (`nullId`, `castId`, `castText`, `castDouble`,
  `castInt`) for databases that type `NULL` and parameters strictly;
- `binary(text)` — code point collation; `startsWith`, `endsWith`,
  `contains`, `length` (in characters) and `hasNonZeroDigit`;
- `limitOffset`, `maxParameters`.

The database must support `INSERT … ON CONFLICT DO NOTHING RETURNING`, row
value comparisons, `VALUES` lists and correlated subqueries. Pass the dialect
as `SqlStore.layer({ dialect })` (or extend `Dialect.fromClient`).

## ShEx (`@thomasfosterau/effect-rdf/shex`)

[ShEx (Shape Expressions)](https://shex.io/shex-semantics/) for
[`@thomasfosterau/effect-rdf`](#modules), written with Effect.

- **ShExJ** (`ShExJ`): the abstract syntax as plain immutable values, with
  Effect `Schema`s to decode, validate and encode ShExJ JSON. `resolveIris`
  resolves the relative IRIs in a ShExJ document.
- **ShExC** (`ShExC`): a hand-written parser for the compact syntax. It
  handles `BASE`/`PREFIX`/`IMPORT`, `start=`, `EXTERNAL`, node kinds,
  datatypes, every string and numeric facet, regular expressions with flags
  and escapes, value sets with IRI, literal and language stems, ranges and
  exclusions, `$label` and `&include`, inverse `^`, every cardinality form,
  annotations `//`, semantic actions `%iri{ code %}`, and the ShEx 2.2
  `ABSTRACT`, `EXTENDS` and `RESTRICTS`. Errors are `RdfParseError`s with line
  and column. The lexer and the grammar (over the lexer's tokens) are
  compiled `@thomasfosterau/effect-parse` parsers; `vp run --filter ./packages/core bench:shex` times them on
  the shexTest schemas and a large synthetic schema. `ShExC.print` writes a
  schema back as ShExC.
- **ShExR** (`ShExR`): reads a schema from a core `Dataset` that holds its RDF
  representation, and writes one (`toQuads` / `toDataset`).
- **Structural checks** (`Structure`): every reference resolves, inclusions
  name triple expressions, no shape refers to itself except through a triple
  constraint, no reference cycle passes through negation (`NOT` or `EXTRA`),
  and the extension hierarchy has no cycles.
- **ShapeMaps** (`ShapeMap`): the compact syntax for fixed maps
  (`node@shape`, `node@START`), query maps with `{FOCUS p _}` / `{_ p FOCUS}`
  selectors, and the JSON form. The compact syntax is parsed with
  [`@thomasfosterau/effect-parse`](https://www.npmjs.com/package/@thomasfosterau/effect-parse)
  (an optional peer dependency of effect-rdf, needed by this subpath). Errors are `RdfParseError`s with
  line and column.
- **Validation** (`Validator`): the ShEx 2.1 semantics plus ShEx 2.2
  `EXTENDS`/`ABSTRACT`/`RESTRICTS`.
  - Triple expressions are matched by searching for a partition of the
    neighbourhood, then checking the bag of triple-constraint counts against
    `EachOf`/`OneOf`/cardinalities with a bag-derivative algorithm.
  - `CLOSED` and `EXTRA` are supported.
  - Recursion uses the maximal typing: it is evaluated coinductively and
    memoised, and stratified negation is guaranteed by the structural checks.
  - Imports are loaded through the `SchemaLoader` service.
  - Semantic actions go to a pluggable `SemAct.SemActHandler`. Unknown actions
    are ignored, and the ShEx Test extension is included.

### Validating data

```ts
import { Effect } from 'effect';
import { Dataset, Term } from '@thomasfosterau/effect-rdf';
import { ShapeMap, ShExC, Validator } from '@thomasfosterau/effect-rdf/shex';

const ex = (s: string) => Term.namedNode(`http://example.org/${s}`);

const program = Effect.gen(function* () {
  const schema = yield* ShExC.parse(`
    PREFIX ex: <http://example.org/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    start = @ex:Person
    ex:Person CLOSED {
      ex:name xsd:string MINLENGTH 1 ;
      ex:age xsd:integer MININCLUSIVE 0 ? ;
      ex:knows @ex:Person *
    }
  `);

  const data = Dataset.make(
    Term.quad(ex('alice'), ex('name'), Term.literal('Alice')),
    Term.quad(ex('alice'), ex('knows'), ex('bob')),
    Term.quad(ex('bob'), ex('name'), Term.literal('Bob')),
  );

  // A shape map: fixed associations or triple-pattern queries.
  const map = yield* ShapeMap.parse('{FOCUS ex:name _}@START, ex:alice@ex:Person', {
    prefixes: { ex: 'http://example.org/' },
  });

  const report = yield* Validator.validate(data, schema, map);
  for (const r of report.results) {
    console.log(r.node.key, ShapeMap.formatShape(r.shape), r.status, r.reason ?? '');
  }
  return report.conformant;
});
```

`Validator.validate` returns
`Effect<ValidationReport, ShExValidationError | ShExImportError | ShExStructureError>`.
The report has one `ShapeResult` (`conformant` or `nonconformant`, with a
`reason`) for each association. If you validate many shape maps against the
same schema, call `Validator.make(schema)` once and reuse the validator. It
loads the imports and runs the structural checks a single time.

### As a Schema

`Validator.schema(validator, shapeMap)` (or a single `{ node, shape }`) is a `Dataset` → `Dataset`
schema that accepts only data where every association conforms, so ShEx fits `Schema.decode`
pipelines (`HttpApi` payloads, config loading). It takes a prepared validator, so imports are
resolved up front and decoding needs no services. A failure is a `SchemaIssue.Composite` with one
`InvalidValue` per nonconformant association, whose `message` annotation is
`Validator.formatResult(result)` and whose `result` annotation is the `ShapeResult`. Compose it with
a syntax codec to parse and validate in one decode:

```ts
import { Schema } from 'effect';
import { Turtle } from '@thomasfosterau/effect-rdf/turtle';

const validator = yield * Validator.make(schema);
const PersonDocument = Turtle.codec.schema.pipe(
  Schema.decodeTo(Validator.schema(validator, { node: alice, shape: 'http://ex.example/Person' })),
);
const data = yield * Schema.decodeEffect(PersonDocument)(turtleText);
```

### Imports

`IMPORT` is resolved through the `SchemaLoader` reference. By default it fails
on every import, so provide a loader:

```ts
const loader: Validator.Loader = {
  load: (iri) =>
    fetchText(iri).pipe(
      Effect.flatMap((text) => ShExC.parse(text, { baseIri: iri })),
      Effect.mapError((e) => new ShExError.ShExImportError({ iri, message: String(e) })),
    ),
};

Validator.validate(data, schema, map).pipe(Effect.provide(Validator.loaderLayer(loader)));
```

`Validator.loaderFromRecord({ iri: schema })` serves schemas you already have
in memory.

### Semantic actions

```ts
import { Option } from 'effect';
import { SemAct } from '@thomasfosterau/effect-rdf/shex';

// Dispatch on action names (a name ending in / or # covers its namespace).
const handler = SemAct.make({
  'http://example.org/ext/check': (code, ctx) => ctx.triple !== undefined && code !== 'reject',
});

Validator.validate(data, schema, map).pipe(
  Effect.provideService(
    SemAct.SemActHandler,
    SemAct.combine(
      handler,
      SemAct.testExtension((line) => console.log(line)),
    ),
  ),
);
```

Pass `externalSemActs` to supply code for actions written as `%<name>%`. Pass
`externalShapes` to supply definitions for `EXTERNAL` shapes.

### Other representations

```ts
const json = ShExJ.stringify(schema); // ShExJ text
const back = yield * ShExJ.parse(json); // decoded and validated with Effect Schema
const shexc = ShExC.print(schema, { prefixes }); // ShExC text
const rdf = ShExR.toDataset(schema); // ShExR as a Dataset
const fromRdf = yield * ShExR.fromDataset(rdf);
```

## Conformance

The data model has no W3C suite of its own; it is exercised by every syntax subpath's suites (N-Triples, Turtle, TriG, RDF/XML, JSON-LD, N3) and by the SPARQL evaluation suite, which compare graphs with `Isomorphism.isomorphic`. Its unit tests cover terms, datasets, IRIs, XSD, RDFS and isomorphism, and RDF/JSON's (`test/rdfjson/`) its schemas, parser, serialiser and round trips; RDF/JSON has no W3C suite.

Every suite below runs when it is checked out under `.test-suites` (`scripts/fetch-test-suites.sh`, or set `RDF_TEST_SUITES`), and skips otherwise. Each subpath's suites live in `test/<subpath>/`; manifests and expected results are read with `/turtle`, `/ntriples` and `/rdfxml`.

**CSV on the Web**: the [W3C CSVW test suite](https://github.com/w3c/csvw/tree/gh-pages/tests) (`.test-suites/csvw`). The suite's CSV files are split into records by a test-only stand-in for `effect-csv` (`test/csvw/support/csv.ts`).

| Manifest                   | Result                    |
| -------------------------- | ------------------------- |
| `manifest-validation.ttl`  | 276 / 276 run (6 skipped) |
| `manifest-rdf.ttl` (RDF)   | 264 / 264 run (6 skipped) |
| `manifest-json.ttl` (JSON) | 264 / 264 run (6 skipped) |

RDF results are compared with `Isomorphism.isomorphic`, JSON results structurally. The skipped tests need metadata discovery over HTTP, which the CSVW subpath does not do: `test014`, `test016`, `test120` and `test122` (an HTTP `Link` header) and `test259` and `test260` (a site-wide `/.well-known/csvm` file).

**SHACL**: the W3C SHACL test suite (`.test-suites/data-shapes`): all 98 SHACL Core tests pass. The 22 SHACL-SPARQL tests (`sparql/`) need a SPARQL evaluator; they run in `@thomasfosterau/effect-rdf/sparql`'s suite, where all 22 pass, and all 98 Core tests pass with the evaluator installed.

**N-Triples and N-Quads** (`/ntriples`): The full W3C rdf11 / rdf12 N-Triples and N-Quads suites pass (syntax and canonicalisation): `test/ntriples/conformance.test.ts`.

**Turtle and TriG** (`/turtle`): Every W3C rdf11 / rdf12 Turtle and TriG syntax and evaluation test passes, and every positive test round-trips through the serializer: `test/turtle/conformance.test.ts`.

**Notation3** (`/n3`): `test/n3/conformance.test.ts` runs the W3C N3 CG suite (`.test-suites/N3/tests`):
the Turtle, N3 parser and extended N3 parser manifests, positive and
negative syntax and evaluation tests. Every positive test is additionally
round-tripped through the serializer (and, where RDF-compatible, through a
core dataset). See the test file for the documented skip list.

**JSON-LD** (`/jsonld`): The W3C JSON-LD 1.1 expand, compact, flatten, toRdf, fromRdf, remote-doc and framing suites pass (`test/jsonld/`); the only tests skipped are JSON-LD 1.0-only ones and the ones that need generalized RDF.

**RDF/XML** (`/rdfxml`): Every test of the W3C RDF 1.1 and RDF 1.2 RDF/XML suites passes (`test/rdfxml/Conformance.test.ts`), including `rdf:version`, base direction via `its:dir`, triple terms and annotations.

**XMP** (`/xmp`): There is no public XMP conformance suite; the unit tests are modelled on the ISO 16684-1
examples. `scripts/fetch-test-suites.sh` checks out the metadata sections of
[veraPDF's PDF/A and PDF/UA corpus](https://github.com/veraPDF/veraPDF-corpus), and
`test/xmp/Conformance.test.ts` reads the packet of every file in them: all 497 files that should
pass validation parse (and give the PDF/A part their section tests), and none of the 568 that
should fail makes the reader throw. The ISO 16684-1 examples are not freely published, and the
Adobe XMP Toolkit SDK ships no sample XMP files, only the C++ samples that generate them.

**SPARQL** (`/sparql`): The W3C test suites are run from `.test-suites/rdf-tests/sparql` (or
`$RDF_TEST_SUITES`), using `/turtle`, `/ntriples` and `/rdfxml` to read
manifests and data:

- **Syntax**: 574 / 574 (SPARQL 1.0, 1.1 query and update, 1.2) — every
  positive test also round-trips through `Generator.print`.
- **Evaluation**: 707 / 707 runnable query, update and CSV/TSV result tests
  (SPARQL 1.0, 1.1, 1.2). Result sets are compared up to blank node renaming
  (numeric literals by value); ordered results check the `ORDER BY` keys.
  Skipped (77): `sparql11/entailment` (70; entailment regimes are not
  supported) and `sparql11/service` (7; federation needs remote endpoints,
  so these run over HTTP below).
- **Evaluation over HTTP** (`test/sparql/HttpEvalConformance.test.ts`): the same
  707 / 707 runnable tests pass with each test's data loaded into an
  in-process server and every query sent by the client, with results parsed
  from JSON, XML and TSV. Skipped: `sparql11/entailment` and
  `sparql11/service` (below).
- **Federation** (`sparql11/service`): 7 / 7, with one in-process server per
  endpoint (the servers are federated themselves, for nested `SERVICE`).

The protocol suites in `.test-suites/rdf-tests/sparql/sparql11` are run
in-process against the server, reading the HTTP requests and expected
responses from the manifests — once against `SparqlServer.handler` and once
against the `SparqlApi` routes (`SparqlApiBuilder`), with the same results.
They live in `@thomasfosterau/effect-sparql-node`'s tests
(`test/ProtocolConformance.test.ts`), since `SparqlApi` is that package's:

- **SPARQL 1.1 Protocol** (`protocol`): 34 / 34 on both.
- **Graph Store Protocol** (`graph-store-protocol`, direct and indirect
  identification, graph creation by `POST`, `multipart/form-data`): 14 / 14
  on both (13 listed tests plus `head_non_existing_direct`, which the
  manifest defines but does not list).
- **Service Description** (`service-description`): 3 / 3 on both (the
  manifest has no machine-readable requests; the three checks are
  implemented directly).
- **Skipped**: `http-rdf-update` — deprecated (`dawg:Deprecated`, superseded
  by `graph-store-protocol`), its requests are prose-only and depend on state
  it never creates.

**SHACL-SPARQL** (`/sparql/shacl`): the W3C SHACL test suite (`.test-suites/data-shapes`, or
`$RDF_TEST_SUITES`): all **22 / 22** SHACL-SPARQL tests (`sparql/`: node,
property, component and pre-binding tests) pass, and all 98 Core tests pass
with the evaluator installed.

**Knowledge-graph tools** (`/sparql/ai`): there is no conformance suite for tools; the tests
(`test/sparql/ai/`) drive every handler against an in-memory engine and round-trip the tools through `McpTest` (`test/sparql/ai/McpClient.test.ts`, which needs effect 4.1; everything else in the package's suite also runs on the 4.0 floor).

**SPARQL over SQL** (`/sparql/sql`):

- The W3C SPARQL 1.0/1.1/1.2 evaluation tests run against SQLite (a fresh
  database per test) **and against PostgreSQL** (PGlite, PostgreSQL compiled
  to WASM, through a small `SqlClient` adapter in `test/sparql/sql/support/pglite.ts`):
  707/707 runnable query, update and result-format tests pass on both (the
  same 77 entailment and federation tests as the in-memory store are
  skipped). More than half of the queries run entirely as one SQL statement.
- Differential tests compare the SQL store with the in-memory store on
  random queries over random datasets (including data that forces the
  exactness fallbacks).
- Translation tests assert that representative queries are executed entirely
  in SQL and inspect the generated SQL (SQLite and PostgreSQL).
- A bulk-load test loads 100,000 triples and runs a join/filter/count query.

**ShEx** (`/shex`): The tests run the [shexTest](https://github.com/shexSpec/shexTest) suite when
it is checked out under `.test-suites/shexTest` (or set `RDF_TEST_SUITES`):

| Suite                                               | Result                                |
| --------------------------------------------------- | ------------------------------------- |
| `schemas`: ShExC → ShExJ                            | 484 / 484                             |
| `schemas`: ShExJ → ShExC → ShExJ (printer)          | 484 / 484                             |
| `schemas`: ShExR → ShExJ, and ShExJ → ShExR → ShExJ | 482 / 484 each (2 skipped, see below) |
| `negativeSyntax`                                    | 105 / 105                             |
| `negativeStructure`                                 | 19 / 19                               |
| `validation` (status, plus Test-extension output)   | 1309 / 1309                           |

These two ShExR tests are skipped because the RDF is ambiguous. In both, a
labelled triple expression is used in several places, and RDF cannot record
which use defines it: `1Include1` and `ShExR`. The `TwoNegation_pass`
representation test is not checked structurally, because its schema
deliberately breaks the negation requirement.

## License

MIT
