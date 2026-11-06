---
'@thomasfosterau/effect-rdf': patch
---

Faster N-Triples and N-Quads parsing. An IRI with no escapes or disallowed characters is read with one `indexOf` and one regex test instead of a check per character, and a document without carriage returns is split into lines with a plain string split. `NTriples.parseQuads` runs about 40% faster on the synthetic benchmark (50 MB/s, against N3.js's 37 MB/s). Regular expressions in per-term predicates (`Iri.isAbsolute`, `Lexical.isAbsoluteIri`, `Xml.isWhitespace` and two JSON-LD helpers) are hoisted to module constants, so they no longer allocate a `RegExp` per call.
