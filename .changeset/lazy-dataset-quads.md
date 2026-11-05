---
'@thomasfosterau/effect-rdf': patch
---

`Dataset.fromIterable` (which every format's `parse` uses) keeps the quads it is given and builds the dataset's persistent quad set the first time the dataset is used, with the same contents, order and equality as before; a parse whose dataset is never read, or is only checked for errors, no longer pays for it. Parse spans now record the number of statements parsed as `rdf.quads` (a statement the document repeats is counted each time) rather than the distinct quads, so tracing does not build the set either. `RdfXml.parse` and `JsonLd.parse` now run level with rdfxml-streaming-parser and jsonld.js on the synthetic benchmarks.
