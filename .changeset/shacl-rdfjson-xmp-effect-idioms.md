---
'@thomasfosterau/effect-shacl': patch
'@thomasfosterau/effect-shacl-sparql': patch
'@thomasfosterau/effect-rdfjson': patch
'@thomasfosterau/effect-xmp': patch
---

Internals rewritten on Effect's `Array`, `Option`, `Result`, `MutableHashMap` and `MutableHashSet` helpers instead of loops, native `Map` / `Set`, casts and non-null assertions; validation reports, RDF/JSON and XMP output are unchanged. A SHACL-SPARQL prefix declaration whose name is an `Object.prototype` member (such as `constructor`) is now read like any other prefix.
