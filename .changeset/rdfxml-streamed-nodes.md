---
'@thomasfosterau/effect-rdf': patch
---

Faster RDF/XML parsing. `RdfXml.parse` converts each node element of an `rdf:RDF` document as soon as the XML parser closes it and then lets it go, instead of building the whole XML tree first, so the tree never outlives the young generation of the garbage collector. Results, prefixes, blank node labels and errors are unchanged (an XML error anywhere still takes precedence over an RDF/XML one), and a differential test checks this against the whole-document path on every W3C RDF/XML test. The synthetic benchmark runs about 15–25% faster.
