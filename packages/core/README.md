# @thomasfosterau/effect-rdf

An [RDF 1.2](https://www.w3.org/TR/rdf12-concepts/) / RDF-star toolkit for [Effect](https://effect.website) 4: the data model, parsers and serialisers for the common syntaxes, a SPARQL 1.1 / 1.2 engine, and SHACL and ShEx validation, checked against the W3C conformance suites.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add effect @thomasfosterau/effect-rdf
pnpm add @thomasfosterau/effect-parse # the syntax and SPARQL subpaths
pnpm add @thomasfosterau/effect-xml   # /rdfxml, /xmp and /sparql
pnpm add @thomasfosterau/effect-ext   # /csvw
```

`effect` (`^4.0.0`) is a peer; the other three are optional peers, needed only by the subpaths named.

## Example

```ts
import { Dataset, Isomorphism, Namespace, Term, Xsd } from '@thomasfosterau/effect-rdf';

const ex = Namespace.make('http://example.org/');
const data = Dataset.make(
  Term.quad(ex('alice'), ex('name'), Term.literal('Alice', 'en')),
  Term.quad(ex('alice'), ex('age'), Xsd.integer(42)),
);

Dataset.objectsOf(data, ex('alice'), ex('name')); // [Literal "Alice"@en]
Isomorphism.isomorphic(data, data); // true
```

## Entry points

The root entry is the data model; each module is also its own subpath (`@thomasfosterau/effect-rdf/Term`, …). Everything else is a nested subpath, off the root barrel, with each module at `<subpath>/<Module>`.

| Entry                                    | What it holds                                                                                                     | Guide                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.`                                      | Terms, `Dataset`, IRIs, prefixes, vocabularies, XSD, RDFS, isomorphism, typed resources, serialisation interfaces | [data model](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/data-model.md) |
| `/ntriples`                              | N-Triples and N-Quads                                                                                             | [ntriples](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/ntriples.md)     |
| `/turtle`                                | Turtle and TriG; the W3C manifest reader                                                                          | [turtle](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/turtle.md)         |
| `/n3`                                    | Notation3 and a forward-chaining reasoner                                                                         | [n3](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/n3.md)                 |
| `/jsonld`                                | JSON-LD 1.1                                                                                                       | [jsonld](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/jsonld.md)         |
| `/rdfxml`                                | RDF/XML and Exclusive XML Canonicalization                                                                        | [rdfxml](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/rdfxml.md)         |
| `/rdfjson`                               | RDF/JSON                                                                                                          | [rdfjson](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/rdfjson.md)       |
| `/xmp`                                   | XMP packets; JPEG and PNG extraction                                                                              | [xmp](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/xmp.md)               |
| `/csvw`                                  | CSV on the Web                                                                                                    | [csvw](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/csvw.md)             |
| `/shacl`                                 | SHACL Core                                                                                                        | [shacl](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/shacl.md)           |
| `/sparql`, `/sparql/shacl`, `/sparql/ai` | SPARQL engine, results, builder, protocol handler and client; SHACL-SPARQL; `effect/ai` tools                     | [sparql](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/sparql.md)         |
| `/sparql/sql`                            | The SQL store and SPARQL-to-SQL translation                                                                       | [sparql-sql](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/sparql-sql.md) |
| `/shex`                                  | ShEx: ShExC, ShExJ, ShExR, validation                                                                             | [shex](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/shex.md)             |

Conformance results: [conformance](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/docs/conformance.md). The Node server and CLI are [`@thomasfosterau/effect-sparql-node`](https://github.com/thomasfosterau/effect-rdf/tree/trunk/packages/sparql-node).

## License

[MIT](https://github.com/thomasfosterau/effect-rdf/blob/trunk/packages/core/LICENSE.md)
