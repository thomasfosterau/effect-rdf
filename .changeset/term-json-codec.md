---
'@thomasfosterau/effect-rdf': minor
'@thomasfosterau/effect-sparql': patch
'@thomasfosterau/effect-n3': patch
---

Term, quad and dataset schemas gain JSON codecs (`toCodecJson`), so RDF values pass through `Schema.toCodecJson` (RPC, `HttpApi`, persistence, `effect/ai`) and `Schema.toJsonSchemaDocument`. The new `TermJson` module holds the JSON shape — the SPARQL 1.2 JSON results term, moved from `effect-sparql`'s `Results` (which re-exports it unchanged), extended with variables and the default graph — and `Term` gains `toJson`, `fromJson`, `quadToJson`, `quadFromJson` and `isWellFormed`. A dataset encodes as its quads in sorted order. `effect-rdf/shacl`'s `ValidationReportSchema` and `effect-n3`'s `Model` schemas (formulas, collections, statements) gain JSON codecs too.
