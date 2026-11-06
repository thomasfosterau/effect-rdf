---
'@thomasfosterau/effect-rdf': patch
---

Faster JSON-LD expansion: the matcher that expands keyword keys (13.4 of the expansion algorithm) is built once instead of once per JSON object, with what it reads from the object passed in. `JsonLd.parse` runs about 30% faster on the synthetic benchmark, level with jsonld.js `toRDF`.
