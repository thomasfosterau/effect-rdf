---
'@thomasfosterau/effect-rdf': patch
---

Internals rewritten on Effect's `Array`, `Record`, `Option`, `MutableHashMap` and `MutableHashSet` helpers instead of loops, native `Map` / `Set`, casts and non-null assertions; expansion, compaction, flattening, framing and RDF conversion output is unchanged. The second parameter of `JsonLd.frame` is now named `frameInput` (it shadowed the function's own name).
