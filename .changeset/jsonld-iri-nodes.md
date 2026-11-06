---
'@thomasfosterau/effect-rdf': patch
---

Faster JSON-LD to RDF. The conversion validates each distinct IRI (property, type, datatype or node) once per document and reuses its `NamedNode`, instead of running the IRI regular expression for every occurrence, and `Term.mapTerms` returns a quad or triple unchanged (the same object, with any key already computed) when every term maps to itself, so relabelling blank nodes no longer copies the quads that have none. `JsonLd.parse` runs about 15% faster on the synthetic benchmark, within 10% of jsonld.js `toRDF` (which builds no dataset).
