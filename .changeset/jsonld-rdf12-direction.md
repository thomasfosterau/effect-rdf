---
'@thomasfosterau/effect-rdf': minor
---

JSON-LD: a new `rdfDirection: 'rdf-1.2'` mode for `toRdf`, `toQuads` and `parse` maps `@language` + `@direction` to an RDF 1.2 directional language-tagged string (`rdf:dirLangString`), so `parse(serialize(dataset), { rdfDirection: 'rdf-1.2' })` round-trips directional strings. It follows the JSON-LD 1.2 proposal (w3c/json-ld-syntax#488). It is opt-in, and the default is unchanged. `JsonLd.RdfDirection` names the option's values.
