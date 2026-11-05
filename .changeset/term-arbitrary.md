---
'@thomasfosterau/effect-rdf': minor
---

Term, quad and dataset schemas derive arbitraries (`toCodecArbitrary`), so `Arbitrary.schema(Term.TermSchema)`, `Dataset.DatasetSchema` and `@effect/vitest`'s `it.prop` generate realistic RDF 1.2 values: pooled IRIs that collide across quads, BCP 47 language tags, both base directions, valid lexical forms for common XSD datatypes, triple terms (as objects) nested up to two deep, and datasets of up to a dozen quads with named graphs.
