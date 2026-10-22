# @thomasfosterau/effect-rdf

The [RDF 1.2](https://www.w3.org/TR/rdf12-concepts/) / RDF-star data model for [Effect](https://effect.website) 4, and the core of the [effect-rdf](https://github.com/thomasfosterau/effect-rdf) family: terms with value equality, an immutable indexed `Dataset`, IRIs, prefix maps, typed vocabularies, XSD datatypes, RDF Schema entailment, RDF 1.2 reification, graph isomorphism and the serialisation interfaces every syntax package implements.

```sh
pnpm add effect @thomasfosterau/effect-rdf
```

`effect` (`>=4.0.0-rc.118`) is a peer dependency.

## Modules

| Module               | What it holds                                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Term`               | `NamedNode`, `BlankNode`, `Literal` (language tags with base direction), `Variable`, `DefaultGraph`, `Triple` (triple terms) and `Quad`; constructors (`namedNode`, `blankNode`, `literal`, `triple`, `quad`), guards, `compare` and schemas. Every term implements `Equal` / `Hash`.    |
| `Dataset`            | An immutable, indexed set of quads: `make`, `fromIterable`, `add`, `remove`, `match`, `objectsOf`, `subjects`, `graphs`, `list` (RDF collections), set operations, `filter` / `map` / `reduce`, `toNQuads` and `DatasetSchema`.                                                          |
| `Iri`                | RFC 3987 resolution (`resolve`, `removeDotSegments`), `relativize`, `isAbsolute`, `isValid`.                                                                                                                                                                                             |
| `PrefixMap`          | Prefix ⇄ namespace maps: `make`, `set`, `merge`, `expand` (CURIE → IRI), `compact` (IRI → prefix and local name).                                                                                                                                                                        |
| `Namespace`, `Vocab` | `Namespace.make(base)` builds IRIs; `Namespace.vocabulary(base, terms)` a typed vocabulary. `Vocab` ships `rdf`, `rdfs`, `xsd`, `owl` and `commonPrefixes`.                                                                                                                              |
| `Xsd`                | Lexical validation, canonicalisation and value mapping for the XSD datatypes, literal constructors (`integer`, `decimal`, `dateTime`, …) and `fromJs` / `toJs`.                                                                                                                          |
| `Rdfs`               | Class and property hierarchies (`superClasses`, `instancesOf`, …) and the RDFS `closure`.                                                                                                                                                                                                |
| `Reification`        | RDF 1.2 reifiers and annotations: `annotate`, `reifiers`, `annotations`, `toStandardReification`.                                                                                                                                                                                        |
| `Isomorphism`        | Blank-node-aware graph comparison: `isomorphic`, `bijection`, deterministic `relabel`.                                                                                                                                                                                                   |
| `RdfJs`              | Conversion to and from the [RDF/JS data model](https://rdf.js.org/data-model-spec/).                                                                                                                                                                                                     |
| `Serialization`      | The `Format`, `Parser`, `Serializer` and `Codec` interfaces the syntax packages implement, their typed errors (`RdfParseError` with `line` / `column`, `RdfSerializeError`), `toSchema`, and the `Formats` service with content negotiation (`negotiate`, `parserFor`, `serializerFor`). |

Every module is also its own entry point (`@thomasfosterau/effect-rdf/Term`, …).

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
