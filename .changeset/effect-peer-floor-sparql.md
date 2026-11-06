---
'@thomasfosterau/effect-sparql': patch
'@thomasfosterau/effect-sparql-sql': patch
'@thomasfosterau/effect-shacl-sparql': patch
'@thomasfosterau/effect-sparql-ai': patch
---

Declare the `effect` peer as `^4.1.2` (was `>=4.1.0`), from a catalog of their own: `effect-sparql`'s runtime dependency `@effect/platform-node` 4.1.2 (and, for `effect-sparql-sql`, `@effect/sql-sqlite-node` 4.1.2) declares `effect: ^4.1.2`, which these packages reach at runtime, so the range now says what an install needs. The other packages stay at `^4.0.0`.
