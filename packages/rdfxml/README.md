# @thomasfosterau/effect-rdfxml

[RDF 1.2 XML Syntax](https://www.w3.org/TR/rdf12-xml/) (RDF/XML, `application/rdf+xml`)
for [`@thomasfosterau/effect-rdf`](../core).

- `RdfXml` — parser and serializer implementing the core `Serialization` interfaces.
- `Xml` — the small namespace-aware, non-validating XML 1.0 parser it is built on
  (internal DTD entities and attribute defaults, CDATA, comments, PIs) plus Exclusive XML
  Canonicalization, usable on its own.

The parser passes every test of the W3C RDF 1.1 and RDF 1.2 RDF/XML test suites, including
`rdf:version`, base direction via `its:dir`, triple terms via `rdf:parseType="Triple"` and
annotations via `rdf:annotation` / `rdf:annotationNodeID`.

## Parsing

```ts
import { Effect } from 'effect';
import { Dataset } from '@thomasfosterau/effect-rdf';
import { RdfXml } from '@thomasfosterau/effect-rdfxml';

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

## Serializing

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

## Schema

`RdfXml.codec.schema` is a `Schema.Codec<Dataset, string>`.
