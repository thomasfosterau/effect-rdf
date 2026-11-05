# @thomasfosterau/effect-rdf

The [RDF 1.2](https://www.w3.org/TR/rdf12-concepts/) / RDF-star data model for [Effect](https://effect.website) 4, and the core of the [effect-rdf](https://github.com/thomasfosterau/effect-rdf) family: terms with value equality, an immutable indexed `Dataset`, IRIs, prefix maps, typed vocabularies, XSD datatypes, RDF Schema entailment, RDF 1.2 reification, graph isomorphism and the serialisation interfaces every syntax package implements.

```sh
pnpm add effect @thomasfosterau/effect-rdf
```

`effect` (`>=4.0.0-rc.118`) is a peer dependency.

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

Every module is also its own entry point (`@thomasfosterau/effect-rdf/Term`, …).

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

To read and write documents, add a syntax package: [`effect-ntriples`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/ntriples), [`effect-turtle`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/turtle), [`effect-jsonld`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/jsonld), [`effect-rdfxml`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/rdfxml), [`effect-rdfjson`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/rdfjson) or [`effect-n3`](https://github.com/thomasfosterau/effect-rdf/tree/main/packages/n3).

## Conformance

The core has no W3C suite of its own; it is exercised by every syntax package's suites (N-Triples, Turtle, TriG, RDF/XML, JSON-LD, N3) and by the SPARQL evaluation suite, which compare graphs with `Isomorphism.isomorphic`. Its unit tests cover terms, datasets, IRIs, XSD, RDFS and isomorphism.

## License

MIT
