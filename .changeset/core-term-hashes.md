---
'@thomasfosterau/effect-rdf': patch
---

IRIs, blank nodes, variables and literals hash their parts instead of their N-Triples key, so hashing a term (as an Effect `HashSet` or `HashMap` does) no longer builds its key. Equal terms still have equal hashes; the hash values themselves change.
