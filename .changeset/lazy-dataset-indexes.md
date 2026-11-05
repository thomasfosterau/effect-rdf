---
'@thomasfosterau/effect-rdf': patch
'@thomasfosterau/effect-rdfxml': patch
---

Faster dataset construction and RDF/XML parsing. A `Dataset` builds its subject, predicate, object and graph indexes the first time it is matched rather than on every insert, and keeps them up to date from then on, updating inner index maps in place within a batch. Building a dataset from parsed quads is about 7× faster, which speeds up every format's `parse` (JSON-LD 2.2×, RDF/XML 2.7× on the synthetic benchmarks). `Dataset.mutate` looks each quad up once instead of twice. The XML parser finds line numbers incrementally, scans for line starts with `indexOf`, and checks short start tags for duplicate attributes without allocating sets. RDF/XML reuses one `NamedNode` per element name, attribute name and datatype.
