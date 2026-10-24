# @thomasfosterau/effect-rdf

## 0.1.0

### Minor Changes

- [#19](https://github.com/thomasfosterau/effect-rdf/pull/19) [`7fc6de8`](https://github.com/thomasfosterau/effect-rdf/commit/7fc6de832606e5765c196f1495e0607f23af0f7e) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Initial release of the effect-rdf family on Effect 4 (peer `effect` `>=4.0.0-rc.118`): the RDF 1.2 data model (`@thomasfosterau/effect-rdf`); N-Triples / N-Quads, Turtle / TriG, Notation3, JSON-LD 1.1, RDF/XML and RDF/JSON syntaxes; the SPARQL 1.1 / 1.2 engine with its SQL storage backend, Protocol server and client; and SHACL Core, SHACL-SPARQL and ShEx 2.1 validation. Each package README states its W3C conformance results.

### Patch Changes

- [#26](https://github.com/thomasfosterau/effect-rdf/pull/26) [`ea22360`](https://github.com/thomasfosterau/effect-rdf/commit/ea2236084cc473130a73ecf9bbcea34e207be0d3) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Faster parsing, with unchanged results and errors. `Iri.resolve` returns an absolute reference without dot segments as it is and reuses the last base's parsed parts, and `Iri.removeDotSegments` returns a path without dot segments unchanged (the N-Triples-like Turtle benchmark runs about twice as fast). `Term.escapeIri` no longer builds its regexes per call. The SPARQL grammar's token peeks are compiled token sets, and ShEx `ShapeMap.parse` / `parseTerm` compile their grammars once instead of wrapping them per call.
