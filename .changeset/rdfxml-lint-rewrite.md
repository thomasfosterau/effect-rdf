---
'@thomasfosterau/effect-rdf': patch
---

`RdfXml.serialize` no longer overflows the call stack on large graphs (more than about 100,000 output lines): the document's lines were passed to `push` as arguments. The XML and RDF/XML parsers and the serializer are rewritten onto Effect collections, `Option` and refinements instead of loops, casts, non-null assertions and direct tag checks; their results and errors are unchanged, and an element's position is now found when its start tag is read. Parsing a large document is about 20% faster as XML and 10% faster as RDF/XML; serialising is unchanged.
