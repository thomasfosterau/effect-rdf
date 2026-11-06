---
'@thomasfosterau/effect-rdf': patch
---

Fix `Dataset` keeping a stale index on `effect` 4.0.x: after a dataset had been matched, `add` / `remove` / `mutate` could leave its pattern index unchanged, so `match` (and anything built on it, such as `Resource.decode`'s cycle check) missed the new quads. 4.0.x's `HashMap.set` keeps an existing value that is `Equal.equals` to the new one, and the index batch stored each inner map before changing it; it now stores them once the batch is done.
