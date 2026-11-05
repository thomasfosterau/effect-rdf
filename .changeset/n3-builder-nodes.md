---
'@thomasfosterau/effect-n3': patch
---

Faster N3 parsing, with unchanged results and errors. The parser builds the model as its grammar reads, instead of building a syntax tree and walking it afterwards, and makes one `NamedNode` per IRI (prefixed names cached by namespace and local name). Quantifier scopes exist only for formulas that use `@forAll` / `@forSome`. `Model.Formula` removes duplicate statements the first time its statements are read rather than when it is made, finding them by structural hashes in an open-addressing table and comparing keys only when two hashes are equal; statements, collections and formulas now hash their parts (a formula, the sum of its statements' hashes) instead of their keys. `N3.parse` runs about 1.9× faster on the synthetic benchmark (about 1.5× including the first read of the statements).
