---
'@thomasfosterau/effect-n3': patch
---

Faster N3 parsing. The builder makes one `NamedNode` per IRI (cached by namespace and local name for prefixed names), so a repeated name is neither concatenated nor hashed again and its key, which formulas deduplicate by, is computed once. Quantifier scopes exist only for formulas that use `@forAll` / `@forSome`, and a formula of one statement no longer computes its key to deduplicate it. `N3.parse` runs about 10–15% faster on the synthetic benchmark.
