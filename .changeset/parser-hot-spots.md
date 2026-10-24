---
'@thomasfosterau/effect-rdf': patch
'@thomasfosterau/effect-sparql': patch
'@thomasfosterau/effect-shex': patch
---

Faster parsing, with unchanged results and errors. `Iri.resolve` returns an absolute reference without dot segments as it is and reuses the last base's parsed parts, and `Iri.removeDotSegments` returns a path without dot segments unchanged (the N-Triples-like Turtle benchmark runs about twice as fast). `Term.escapeIri` no longer builds its regexes per call. The SPARQL grammar's token peeks are compiled token sets, and ShEx `ShapeMap.parse` / `parseTerm` compile their grammars once instead of wrapping them per call.
