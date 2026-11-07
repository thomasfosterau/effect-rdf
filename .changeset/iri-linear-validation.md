---
'@thomasfosterau/effect-rdf': patch
---

`Iri.isValid` and `Iri.isValidReference` run in linear time. A nested quantifier made a failing match exponential, so an IRI such as `http://example.com/vocabulary/./rel2##fragment-works` took seconds (ReDoS). They also follow RFC 3987 more closely: after an authority, the path must be empty or start with `/`, so `http://h:80x` is no longer accepted. `RdfXml.splitIri` is linear too, where it was quadratic in the IRI's length.
