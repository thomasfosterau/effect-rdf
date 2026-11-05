---
'@thomasfosterau/effect-n3': patch
---

Faster first read of an N3 formula's statements. Removing duplicate statements now compares terms by identity, then by cached hash, then part by part (only IRIs, literals, blank nodes and variables by key), instead of building the keys of every formula a rule contains; and the parser makes one node per quick variable name, so the copies of a rule compare by identity. Reading a parsed document's statements takes about a third of the time it did.
