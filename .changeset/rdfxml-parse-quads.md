---
'@thomasfosterau/effect-rdf': minor
---

`RdfXml.parseQuads` parses a document into its statements in document order, with its prefixes and base, without building a dataset (as `Turtle.parseQuads` and `NTriples.parseQuads` do). RDF/XML parsing is faster too: the XML parser checks and splits each distinct qualified name once per document, and the RDF/XML conversion builds each name's IRI once. `RdfXml.parseQuads` reads the synthetic benchmark document about 10% faster than rdfxml-streaming-parser.
