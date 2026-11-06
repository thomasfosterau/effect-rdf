---
'@thomasfosterau/effect-rdf': patch
---

`Term.mapTerms` now checks what its function returns: a result that cannot stand in its position (a literal for a subject, say) leaves the original term there, where it used to build an ill-formed statement. `PrefixMap.make`'s record form is now spelled `Record.ReadonlyRecord<string, string>` in the declarations (same type). Internals of both packages are rewritten onto Effect collections, `Option` and refinements instead of loops, casts, non-null assertions and direct tag checks; results are unchanged.
