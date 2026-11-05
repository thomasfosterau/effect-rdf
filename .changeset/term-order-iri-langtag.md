---
'@thomasfosterau/effect-rdf': minor
---

`Term` gains Effect typeclass instances: `Order` and `QuadOrder` (the `compare` / `compareQuads` orderings) and `Equivalence` / `QuadEquivalence`. `Iri` gains `isValidReference` and the `IriSchema` / `IriReferenceSchema` string schemas (JSON Schema `format: "iri"` / `"iri-reference"`). The new `LanguageTag` module checks BCP 47 well-formedness (`isWellFormed`), normalises tags (`normalize`) and provides `LanguageTagSchema`.
