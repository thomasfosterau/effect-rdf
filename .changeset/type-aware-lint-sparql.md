---
'@thomasfosterau/effect-sparql': patch
---

`QueryBuilder`'s declarations drop type arguments that only restated their defaults (`Term.Variable<string>` is now `Term.Variable`, `Alias<N, false>` is now `Alias<N>`). The types are unchanged.
