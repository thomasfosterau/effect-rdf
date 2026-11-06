---
'@thomasfosterau/effect-rdf': minor
---

Faster parsing of Turtle-family documents. `Iri.resolve` returns an absolute reference without dot segments after a single character scan, instead of matching it with regular expressions (N-Triples-style Turtle parses about 35% faster). The new `Grammar.dottedRun` (N-Triples) matches the language of `dottedTail` over a character class while scanning each run of the class in one compiled loop; `BLANK_NODE_LABEL`, `PN_PREFIX` and `PN_LOCAL` use it, so the Turtle, TriG, N3, SPARQL and ShExC grammars no longer call a function per character of a name.
