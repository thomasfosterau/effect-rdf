---
'@thomasfosterau/effect-rdf': patch
---

Internals rewritten onto Effect collections and `Option` (absent values become SQL `NULL` only when parameters are bound); the generated SQL is byte-identical. Two defect paths fail more clearly: an operator missing an argument is declined as unsupported (the engine evaluates it) instead of raising a `TypeError`, and a stored id that decodes to the wrong kind of term raises `StoreError` instead of being mis-typed.
