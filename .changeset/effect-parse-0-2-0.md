---
'@thomasfosterau/effect-rdf': minor
---

Require `@thomasfosterau/effect-parse` `^0.2.0` (was `^0.1.0`). The peer range moves to the 0.2 line, so a consumer must upgrade its own `@thomasfosterau/effect-parse` with these packages. The grammars now compile with `Compiler.jit` (0.2.0 removed `Parser.compile`), and the SPARQL grammar matches each token kind as a compiled token set instead of an interpreted hook, which speeds up query and update parsing; error messages are unchanged.
