---
'@thomasfosterau/effect-rdf': patch
'@thomasfosterau/effect-sparql-node': patch
---

Widen the `@thomasfosterau/effect-parse` peer to `^0.4.0 || ^0.5.0` (was `^0.4.0`, which on 0.x refuses 0.5). The grammars run unchanged on both lines: every unit and conformance test passes against effect-parse 0.4.1 and 0.5.0. A consumer already on effect-parse 0.5 (effect-bib, effect-document) no longer gets an unmet peer or a second copy with its own `Parser` / `Token` identities. `@thomasfosterau/effect-xml` 0.1.0 still declares effect-parse `^0.4.1` itself; its next release widens the same way.
