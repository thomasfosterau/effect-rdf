---
'@thomasfosterau/effect-rdf': patch
---

Five positional parameters were renamed so they no longer shadow another export of their module (`Ast.negated`, `Ast.exists`, `QueryBuilder.bound`, n3 `Model.document` and `Model.hasStatement`); no call site changes.
