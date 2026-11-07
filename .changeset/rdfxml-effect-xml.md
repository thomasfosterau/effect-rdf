---
'@thomasfosterau/effect-rdf': minor
'@thomasfosterau/effect-sparql-node': minor
---

RDF/XML, XMP and SPARQL XML results now read XML with [`@thomasfosterau/effect-xml`](https://www.npmjs.com/package/@thomasfosterau/effect-xml)'s tokenizer, the family's shared XML layer, instead of a private effect-parse grammar (#13).

- **effect-rdf:** `@thomasfosterau/effect-xml` (`^0.1.0`) is a new **optional** peer, needed by `/rdfxml`, `/xmp` and `/sparql` (with `/sparql/shacl` and `/sparql/ai`). effect-xml requires `@thomasfosterau/effect-parse` `^0.4.1` itself, so those subpaths need both installed.
- **effect-sparql-node:** `@thomasfosterau/effect-xml` is a new **required** peer.
- **API and model unchanged.** `Xml`'s document model, `parse` / `parseResult`, `XmlParseError` (with `line` / `column`), `canonicalize` and the escapes stay the same, and so do `RdfXml` and `Xmp`. So do the limits: entity expansion 1,000,000 characters, entity nesting 64, element nesting 1,024.
- **Error messages** for malformed XML are now effect-xml's wording, for example `Resource limit maxDepth (1024) exceeded at 1:3073`.
- **`Xml.Position`** now counts offsets in the input as written (after any byte order mark), with `\r\n` and `\r` as line ends. Before, offsets counted the line-end-normalised text.
- **`DocumentType.entities`** records the internal general entities as declared, with character references expanded.
- **Conformance:** the W3C RDF 1.1 and RDF 1.2 RDF/XML tests (550 / 550) and the veraPDF XMP corpus (503 / 503) still all pass.
