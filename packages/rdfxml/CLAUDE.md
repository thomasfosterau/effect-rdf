# @thomasfosterau/effect-rdfxml

RDF/XML (RDF 1.2 XML Syntax) parser and serializer, on `Xml`: a small namespace-aware, non-validating XML 1.0 parser (an `effect-parse` grammar) with Exclusive XML Canonicalization.

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Imports from this workspace: core — `.fallowrc.json` zone `rdfxml`.

## Invariants

- **Hostile input fails, it never exhausts resources:** no external entity or DTD is loaded, entity expansion is capped at 1,000,000 characters, entity nesting at 64 and element nesting at 1,024, each reported as an `XmlParseError` (SECURITY.md).
- **Every W3C RDF 1.1 and 1.2 RDF/XML test passes,** including `rdf:version`, `its:dir`, `rdf:parseType="Triple"` and annotations.

## Terms

- **XML literal** — `rdf:XMLLiteral`, serialized with Exclusive XML Canonicalization.
