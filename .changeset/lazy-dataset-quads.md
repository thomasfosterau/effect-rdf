---
'@thomasfosterau/effect-rdf': patch
---

`Dataset.fromIterable` (which every format's `parse` uses) keeps the quads it is given. Iterating such a dataset, or reading its `size`, yields its distinct quads in the order first given (found by structural hashes, without building keys or the persistent map); the persistent quad set is built only when a lookup, match or update needs it. Equality and contents are unchanged; the iteration order of these datasets is now document order rather than hash order. Parse spans now record the number of statements parsed as `rdf.quads` (a statement the document repeats is counted each time) rather than the distinct quads, so tracing does not build the set either. `RdfXml.parse` and `JsonLd.parse` now run level with rdfxml-streaming-parser and jsonld.js on the synthetic benchmarks.
