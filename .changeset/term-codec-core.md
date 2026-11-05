---
'@thomasfosterau/effect-rdf': minor
'@thomasfosterau/effect-sparql': patch
---

The term ⇄ JS value codecs move from `@thomasfosterau/effect-sparql/TermSchema` into core as `@thomasfosterau/effect-rdf/TermCodec`, so decoding a `Dataset`'s objects, SHACL / ShEx results or XMP values no longer needs the SPARQL engine; `effect-sparql`'s `TermSchema` re-exports it unchanged. New codecs: `dateTime` (to Effect `DateTime.Utc`, or `DateTime.Zoned` when the lexical form has an offset), `double` and `float` (keeping their datatype), `localized` (a string with an optional language tag and direction) and `typedOneOf` (any of several datatypes, restoring the literal on encode).
