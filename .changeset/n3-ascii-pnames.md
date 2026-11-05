---
'@thomasfosterau/effect-n3': patch
---

Faster N3 parsing: a prefixed name that is plain ASCII (a prefix without dots, and no `%`, `\` or non-ASCII character) is scanned by hand rather than by the general grammar, which reads it as before otherwise. `N3.parse` runs about 10% faster on the synthetic benchmark, level with N3.js. The only observable difference is in some syntax error messages right after such a name: the characters that could have continued the name are no longer listed among what was expected.
