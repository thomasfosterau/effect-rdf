# @thomasfosterau/effect-rdf

The RDF 1.2 / RDF-star data model every other package builds on: `Term` (IRIs, blank nodes, literals with base direction, variables, triple terms), `Dataset` (immutable, indexed quads), `Iri`, `PrefixMap`, `Namespace` / `Vocab`, `Xsd`, `Rdfs`, `Reification`, `Isomorphism`, `RdfJs` and the `Serialization` interfaces (format, parser, serializer, codec, `Formats` service) the syntax packages implement. Three nested subpaths build on it with no dependency of their own (they were the separate `effect-rdfjson`, `effect-csvw` and `effect-shacl` packages before they were first published):

- **`/rdfjson`** (`src/rdfjson/`) — RDF/JSON (`application/rdf+json`) built on Effect `Schema`: document schemas, `string ⇄ Document ⇄ Dataset` transformations and the `Serialization` parser / serializer / codec.
- **`/csvw`** (`src/csvw/`) — CSV on the Web over already-parsed tables: metadata documents (`Metadata`), datatypes and cell parsing (`Datatype`), the annotated tabular data model with embedded metadata and keys (`Table`), the validation report (`Report`), processing from a metadata or tabular data file through a `Loader` (`Processor`), and the CSV2RDF (`Csv2Rdf`) and CSV2JSON (`Csv2Json`) conversions.
- **`/shacl`** (`src/shacl/`) — SHACL Core: the `sh:` vocabulary, a typed shapes-graph model (`Shapes`), property paths, the `Validator` (function, service, pre-compiling layer and conforming-dataset `Schema`), the `ValidationReport` model ⇄ RDF, and the `Sparql.SparqlConstraintEvaluator` extension point.

## Boundary

Peers: `effect`. Imports from this workspace: nothing, tests included — `.fallowrc.json` zone `core`. A test that needs a syntax package (the CSVW and SHACL conformance suites read their manifests, expected RDF and shapes graphs with turtle, which depends on core) lives in the private `tests/conformance` package, never here: a core devDependency on turtle is a cycle `vp run -r` refuses.

Entry points: every `src/*.ts` is `./<Module>`; each subpath is `./<subpath>` (its `index.ts` barrel, which re-exports its modules as namespaces) and `./<subpath>/<Module>`. The subpaths are nested because their module names (`Metadata`, `Table`, `Report`, `Path`, `Message`) are too generic for the flat namespace, and they are not on the root barrel. A subpath imports the data model through relative paths (`../index.ts`, `../Term.ts`), never through the package's own name; the data model never imports a subpath.

## Invariants

- **Terms have value equality.** Every term implements Effect `Equal` / `Hash`, so `Dataset` deduplicates and `HashSet` / `HashMap` work by value; a new term kind implements both.
- **`Dataset` is immutable and indexed.** Every operation returns a new dataset; pattern matching uses the indexes, so a change to the index layout is a performance change the syntax and SPARQL suites measure.
- **`Serialization` is the contract between packages.** A parser fails with `RdfParseError` (with `line` / `column` where known), a serializer with `RdfSerializeError`; changing either shape is breaking for every syntax package.
- **`Isomorphism.isomorphic` is the conformance oracle** every package's suite compares graphs with; it must stay correct for blank nodes inside triple terms and must not overflow the stack on large blank-node graphs.

### `/rdfjson`

- **Schemas are the implementation:** `parse` / `serialize` are the `DatasetFromString` schema, so a schema change is a behaviour change.
- **Errors name the JSON path** (`at ["s"]["p"][0]`); JSON syntax errors carry `line` / `column`.

### `/csvw`

- **No CSV scanner here.** A `Table.Source` is records of cell strings in file order; the `Loader` (`table(url, dialect)`) splits text. The dialect's scanner fields (`delimiter`, `quoteChar`, `doubleQuote`, `lineTerminators`, `encoding`) are the `Loader`'s; its row fields (`skipRows`, `headerRowCount`, `commentPrefix`, `skipBlankRows`, `skipColumns`, `trim`) are `Table.read`'s. `tests/conformance/test/csvw/support/csv.ts` is a test-only stand-in for `@thomasfosterau/effect-csv`; nothing in `src/` may import it.
- **Validating changes severities, not behaviour.** `validate: true` makes incompatible metadata and cell errors `error`s and checks primary and foreign keys; otherwise they are `warning`s and keys are unchecked. Specification _errors_ in metadata fail with `MetadataError`; invalid property values are dropped with a warning (§Annotating Tables).
- **Lexical forms are the source's** unless a `format` changed them: a native `0.0e0` stays `0.0e0` (the suite compares RDF literally); formatted numbers lose group characters and apply `%` / `‰`; formatted dates become XSD lexical forms.
- **No HTTP.** Metadata discovery stops at the default locations through the `Loader`; `Link` headers and `/.well-known/csvm` are future work (README).
- **`src/csvw/internal/json.ts` and `src/rdfjson/internal/json.ts` are each subpath's one `JSON.parse`**, so metadata and document syntax errors keep the engine's message.

### `/shacl`

- **No SPARQL dependency:** SHACL-SPARQL features go through the `SparqlConstraintEvaluator` service, implemented by `@thomasfosterau/effect-sparql/shacl`; without it they fail as unsupported.
- **Ill-formed shapes graphs fail with `ShapesGraphError`,** never a partial validation.
- **98 / 98 Core tests pass** (in `tests/conformance`); the report graph is compared with `Isomorphism.isomorphic`.

## Terms

- **Triple term** — RDF 1.2 `<<( s p o )>>`, a term whose value is a triple; **reifier** — the term naming a reified triple (`Reification`).
- **Ground term** — a term with no variables or blank nodes.
- **Value object** (`/rdfjson`) — an RDF/JSON `{ "type": "uri" | "bnode" | "literal" | "triple", … }` entry.
- **Embedded metadata** (`/csvw`) — the column titles read from a table's header rows (and its comment rows), checked against the table's schema for compatibility.
- **Normalized metadata** (`/csvw`) — a decoded metadata document: absolute URLs, language maps for natural-language properties, value objects for common properties, referenced schemas and dialects inlined.
- **Standard / minimal mode** (`/csvw`) — CSV2RDF and CSV2JSON either frame the cells' output with the group, tables and rows (standard) or emit only what the cells describe (minimal).
- **Shape** (`/shacl`) — a SHACL node or property shape (the specification's term, hence `no-shape-in-symbol-names` is off); **focus node** — the node a shape validates; **value node** — what a path reaches from it.
