# @thomasfosterau/effect-rdf

The RDF 1.2 / RDF-star data model every other package builds on: `Term` (IRIs, blank nodes, literals with base direction, variables, triple terms), `Dataset` (immutable, indexed quads), `Iri`, `PrefixMap`, `Namespace` / `Vocab`, `Xsd`, `Rdfs`, `Reification`, `Isomorphism`, `RdfJs` and the `Serialization` interfaces (format, parser, serializer, codec, `Formats` service) the syntax packages implement. One nested subpath builds on it with no dependency of its own: **`/rdfjson`** (`src/rdfjson/`, formerly the never-published `effect-rdfjson` package) — RDF/JSON (`application/rdf+json`) built on Effect `Schema`: document schemas, `string ⇄ Document ⇄ Dataset` transformations and the `Serialization` parser / serializer / codec.

## Boundary

Peers: `effect`. Imports from this workspace: nothing — `.fallowrc.json` zone `core`.

Entry points: every `src/*.ts` is `./<Module>`; a subpath is `./<subpath>` (its `index.ts` barrel, which re-exports its modules as namespaces) and `./<subpath>/<Module>`, listed in `vite.config.ts` (`subpaths`) and `.fallowrc.json` (`entry`), and kept off the root barrel. A subpath imports the data model through relative paths (`../Term.ts`), never through the package's own name; the data model never imports a subpath.

## Invariants

- **Terms have value equality.** Every term implements Effect `Equal` / `Hash`, so `Dataset` deduplicates and `HashSet` / `HashMap` work by value; a new term kind implements both.
- **`Dataset` is immutable and indexed.** Every operation returns a new dataset; pattern matching uses the indexes, so a change to the index layout is a performance change the syntax and SPARQL suites measure.
- **`Serialization` is the contract between packages.** A parser fails with `RdfParseError` (with `line` / `column` where known), a serializer with `RdfSerializeError`; changing either shape is breaking for every syntax package.
- **`Isomorphism.isomorphic` is the conformance oracle** every package's suite compares graphs with; it must stay correct for blank nodes inside triple terms and must not overflow the stack on large blank-node graphs.

### `/rdfjson`

- **Schemas are the implementation:** `parse` / `serialize` are the `DatasetFromString` schema, so a schema change is a behaviour change.
- **Errors name the JSON path** (`at ["s"]["p"][0]`); JSON syntax errors carry `line` / `column`. `src/rdfjson/internal/json.ts` is the subpath's one `JSON.parse`.

## Terms

- **Triple term** — RDF 1.2 `<<( s p o )>>`, a term whose value is a triple; **reifier** — the term naming a reified triple (`Reification`).
- **Ground term** — a term with no variables or blank nodes.
- **Value object** (`/rdfjson`) — an RDF/JSON `{ "type": "uri" | "bnode" | "literal" | "triple", … }` entry.
