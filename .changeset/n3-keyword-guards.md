---
'@thomasfosterau/effect-n3': patch
---

Faster N3 parsing: a verb is no longer tried as each of the keywords `a`, `has` and `is` (each read as a bare word) and as `<=` / `<-` (each attempting an IRI reference) before it is read as a path; the parser first checks the character those alternatives start with. `N3.parse` runs about 20% faster on the synthetic benchmark.
