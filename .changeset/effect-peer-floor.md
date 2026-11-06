---
'@thomasfosterau/effect-rdf': patch
---

Declare the `effect` peer as `^4.0.0` (was `>=4.1.0`), per the peer-range policy: none of these packages has a dependency that requires a newer Effect, and the type gate and unit suites (conformance included) pass with `effect` 4.0.0.
