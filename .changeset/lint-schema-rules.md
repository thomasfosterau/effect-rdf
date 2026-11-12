---
'@thomasfosterau/effect-rdf': minor
'@thomasfosterau/effect-sparql-node': minor
---

Tagged error classes are now nominally branded (`Schema.TaggedError<Self, { readonly brand: unique symbol }>`): a structurally identical object is no longer assignable to an error class type such as `RdfParseError`, `ShExError` or `SparqlError`.
