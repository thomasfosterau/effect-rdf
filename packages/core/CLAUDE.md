# @thomasfosterau/effect-rdf

The RDF 1.2 / RDF-star data model every other package builds on: `Term` (IRIs, blank nodes, literals with base direction, variables, triple terms), `Dataset` (immutable, indexed quads), `Iri`, `PrefixMap`, `Namespace` / `Vocab`, `Xsd`, `Rdfs`, `Reification`, `Isomorphism`, `RdfJs` and the `Serialization` interfaces (format, parser, serializer, codec, `Formats` service) the syntax packages implement.

## Boundary

Peers: `effect`. Imports from this workspace: nothing — `.fallowrc.json` zone `core`.

## Invariants

- **Terms have value equality.** Every term implements Effect `Equal` / `Hash`, so `Dataset` deduplicates and `HashSet` / `HashMap` work by value; a new term kind implements both.
- **`Dataset` is immutable and indexed.** Every operation returns a new dataset; pattern matching uses the indexes, so a change to the index layout is a performance change the syntax and SPARQL suites measure.
- **`Serialization` is the contract between packages.** A parser fails with `RdfParseError` (with `line` / `column` where known), a serializer with `RdfSerializeError`; changing either shape is breaking for every syntax package.
- **`Isomorphism.isomorphic` is the conformance oracle** every package's suite compares graphs with; it must stay correct for blank nodes inside triple terms and must not overflow the stack on large blank-node graphs.

## Terms

- **Triple term** — RDF 1.2 `<<( s p o )>>`, a term whose value is a triple; **reifier** — the term naming a reified triple (`Reification`).
- **Ground term** — a term with no variables or blank nodes.
