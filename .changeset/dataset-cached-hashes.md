---
'@thomasfosterau/effect-rdf': patch
---

Iterating a dataset made by `Dataset.fromIterable` (every format's `parse` result) for the first time is faster: its duplicates are found using the terms' own cached hashes, so a node shared between statements, such as an RDF/XML description's subject, is hashed once rather than once per statement.
