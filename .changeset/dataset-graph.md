---
'@thomasfosterau/effect-rdf': minor
---

`Dataset.toGraph` converts a dataset to an `effect/Graph` directed graph (subjects and objects as nodes, quads as predicate-labelled edges; optionally restricted to some predicates or one named graph, with or without literal nodes) together with the term → node-index map, for topological order, cycle detection, shortest paths and the other `Graph` algorithms; `Dataset.fromGraph` converts back.
