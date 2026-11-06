---
'@thomasfosterau/effect-rdf': patch
---

The query engine's internals (lexer, parser, generator, translation, optimizer, evaluator, expression and function library, results formats, store and query builder) are rewritten on Effect's `Array`, `Iterable`, `Option`, `Predicate`, `Record` and `MutableHashMap` helpers instead of loops, native `Map` / `Set`, direct `_tag` checks, casts and non-null assertions, and the per-solution paths (expression evaluation, pattern matching, joins, results serialization) dispatch with plain branches instead of `Match`. Parsing and its error positions, the generated text, the algebra, query and update results and the results formats are unchanged (a differential run over every W3C query, update and evaluation test matches the code before this change). An XML results binding with no term now fails with `Missing term in binding` rather than a JavaScript `TypeError` message.
