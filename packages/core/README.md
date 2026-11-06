# @thomasfosterau/effect-rdf

The [RDF 1.2](https://www.w3.org/TR/rdf12-concepts/) / RDF-star data model for [Effect](https://effect.website) 4, and the core of the [effect-rdf](https://github.com/thomasfosterau/effect-rdf) family: terms with value equality, an immutable indexed `Dataset`, IRIs, prefix maps, typed vocabularies, XSD datatypes, RDF Schema entailment, RDF 1.2 reification, graph isomorphism and the serialisation interfaces every syntax package implements. Three subpaths build on it without a dependency of their own: [RDF/JSON](#rdfjson-thomasfosteraueffect-rdfrdfjson) (`/rdfjson`), [CSV on the Web](#csv-on-the-web-thomasfosteraueffect-rdfcsvw) (`/csvw`) and a [SHACL Core validator](#shacl-thomasfosteraueffect-rdfshacl) (`/shacl`).

```sh
pnpm add effect @thomasfosterau/effect-rdf
```

`effect` (`^4.0.0`) is a peer dependency.

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
| `Serialization`      | The `Format`, `Parser`, `Serializer` and `Codec` interfaces the syntax packages implement, their typed errors (`RdfParseError` with `line` / `column`, `RdfSerializeError`), `toSchema`, the `Formats` service with content negotiation (`negotiate`, `parserFor`, `serializerFor`, `parserForExtension`, `serializerForExtension`), byte entry points (`parseBytes`, `parseBytesDocument`, `serializeBytes`: strict UTF-8 or a `charset`, BOM stripped) and files over Effect's `FileSystem` (`readFile`, `writeFile`). |

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
import { NQuads } from '@thomasfosterau/effect-ntriples';

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

To read and write documents, add a syntax package: [`effect-ntriples`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/ntriples), [`effect-turtle`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/turtle), [`effect-jsonld`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/jsonld), [`effect-rdfxml`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/rdfxml) or [`effect-n3`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/n3); RDF/JSON ships here, on [`/rdfjson`](#rdfjson-thomasfosteraueffect-rdfrdfjson).

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
  `sh:target`), implemented by `@thomasfosterau/effect-sparql/shacl`.
- **`Message`**: `{?var}` / `{$var}` message template substitution.

All 98 SHACL Core tests of the W3C test suite pass (see [Conformance](#conformance)).
The 22 `sparql/` tests need a SPARQL evaluator and are run (and pass) by
[`@thomasfosterau/effect-sparql/shacl`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/sparql#shacl-sparql-thomasfosteraueffect-sparqlshacl), which implements
`Sparql.SparqlConstraintEvaluator` on `@thomasfosterau/effect-sparql`.

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
import { Turtle } from '@thomasfosterau/effect-turtle';

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
`@thomasfosterau/effect-sparql/shacl`:

```ts
import { Evaluator } from '@thomasfosterau/effect-sparql/shacl';

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

## Conformance

The data model has no W3C suite of its own; it is exercised by every syntax package's suites (N-Triples, Turtle, TriG, RDF/XML, JSON-LD, N3) and by the SPARQL evaluation suite, which compare graphs with `Isomorphism.isomorphic`. Its unit tests cover terms, datasets, IRIs, XSD, RDFS and isomorphism, and RDF/JSON's (`test/rdfjson/`) its schemas, parser, serialiser and round trips; RDF/JSON has no W3C suite.

The CSVW and SHACL suites run when they are checked out under `.test-suites` (`scripts/fetch-test-suites.sh`, or set `RDF_TEST_SUITES`). They read their manifests with `effect-turtle`, which depends on this package, so they live in the repository's private [`tests/conformance`](https://github.com/thomasfosterau/effect-rdf/tree/main/tests/conformance) package (`test/csvw/`, `test/shacl/`) together with the SHACL tests that parse shapes from Turtle; the CSVW unit tests (`test/csvw/`) stay here.

**CSV on the Web**: the [W3C CSVW test suite](https://github.com/w3c/csvw/tree/gh-pages/tests) (`.test-suites/csvw`). The suite's CSV files are split into records by a test-only stand-in for `effect-csv` (`tests/conformance/test/csvw/support/csv.ts`).

| Manifest                   | Result                    |
| -------------------------- | ------------------------- |
| `manifest-validation.ttl`  | 276 / 276 run (6 skipped) |
| `manifest-rdf.ttl` (RDF)   | 264 / 264 run (6 skipped) |
| `manifest-json.ttl` (JSON) | 264 / 264 run (6 skipped) |

RDF results are compared with `Isomorphism.isomorphic`, JSON results structurally. The skipped tests need metadata discovery over HTTP, which the CSVW subpath does not do: `test014`, `test016`, `test120` and `test122` (an HTTP `Link` header) and `test259` and `test260` (a site-wide `/.well-known/csvm` file).

**SHACL**: the W3C SHACL test suite (`.test-suites/data-shapes`): all 98 SHACL Core tests pass. The 22 SHACL-SPARQL tests (`sparql/`) need a SPARQL evaluator; they run in `@thomasfosterau/effect-sparql`'s suite, where all 22 pass, and all 98 Core tests pass with the evaluator installed.

## License

MIT
