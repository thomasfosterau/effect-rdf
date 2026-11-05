---
'@thomasfosterau/effect-n3': patch
---

Faster N3 parsing, with unchanged results and errors. The parser builds the model as its grammar reads, instead of building a syntax tree and walking it afterwards, and makes one `NamedNode` per IRI (prefixed names cached by namespace and local name), so a repeated name is neither concatenated nor hashed again. Quantifier scopes exist only for formulas that use `@forAll` / `@forSome`. `Model.Formula` deduplicates its statements by their terms' cached hashes, comparing keys only within a bucket, rather than by building every statement's key, and skips the check for a formula of one statement. `N3.parse` runs about 1.4× faster on the synthetic benchmark.
