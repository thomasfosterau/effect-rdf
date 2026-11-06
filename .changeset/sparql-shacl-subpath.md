---
'@thomasfosterau/effect-rdf': minor
---

New nested subpath `@thomasfosterau/effect-rdf/sparql/shacl` (and `…/shacl/Evaluator`, `…/shacl/Query`), kept off the root barrel: SHACL-SPARQL on this engine, the `Sparql.SparqlConstraintEvaluator` for `@thomasfosterau/effect-rdf/shacl` (`sh:sparql` constraints, SPARQL-based constraint components and SHACL-AF SPARQL targets). It replaces the separate `effect-shacl-sparql` package, which was never published, and adds no dependency to this package.
