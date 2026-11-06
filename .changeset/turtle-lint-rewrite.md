---
'@thomasfosterau/effect-rdf': patch
---

Internals rewritten on Effect's `Array`, `Iterable`, `Option`, `MutableHashMap` and `MutableHashSet` helpers instead of loops, native `Map` / `Set`, casts and non-null assertions. Parsing, error messages and positions, streaming and the Turtle / TriG output are unchanged, and so are the published declarations (apart from the order of their imports).
