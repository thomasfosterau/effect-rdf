---
'@thomasfosterau/effect-rdf': patch
---

The protocol client and server modules (`ResultsStream`, `SparqlClient`, `SparqlServer`, `GraphStore`, `Protocol`, `Federation`, `ServiceDescription`, `Options`, `ServerFormats`, `ClientFormats`, `ClientErrors`) are rewritten onto Effect collections, `Option` and tag guards, without loops, casts or non-null assertions. The incremental JSON results parser now scans whole tokens (and whole strings) at a time instead of one character at a time. No public API or behaviour changes; the emitted declarations differ only in the order of union members.
