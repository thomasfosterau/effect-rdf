---
'@thomasfosterau/effect-n3': patch
---

Internals rewritten on Effect's `Array`, `Iterable`, `Option`, `MutableHashMap` and `MutableHashSet` helpers and plain refinements instead of loops, native `Map` / `Set`, casts, non-null assertions, direct tag checks and per-term `Match` dispatch. Parsing (results, error messages and positions), serialising, the dataset `Mapping`, `Isomorphism` and the `Reasoner` give the same results; the model walks (`isGround`, `variables`, `mapTerms`), `Mapping.toDataset` and `Isomorphism.isomorphic` are faster. The published declarations are unchanged.
