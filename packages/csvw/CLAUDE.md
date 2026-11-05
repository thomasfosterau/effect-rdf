# @thomasfosterau/effect-csvw

CSV on the Web over already-parsed tables: metadata documents (`Metadata`), datatypes and cell parsing (`Datatype`), the annotated tabular data model with embedded metadata and keys (`Table`), the validation report (`Report`), processing from a metadata or tabular data file through a `Loader` (`Processor`), and the CSV2RDF (`Csv2Rdf`) and CSV2JSON (`Csv2Json`) conversions.

## Boundary

Peers: `effect`. Imports from this workspace: core — `.fallowrc.json` zone `csvw` (turtle in tests only, for the conformance manifests and expected RDF).

## Invariants

- **No CSV scanner here.** A `Table.Source` is records of cell strings in file order; the `Loader` (`table(url, dialect)`) splits text. The dialect's scanner fields (`delimiter`, `quoteChar`, `doubleQuote`, `lineTerminators`, `encoding`) are the `Loader`'s; its row fields (`skipRows`, `headerRowCount`, `commentPrefix`, `skipBlankRows`, `skipColumns`, `trim`) are `Table.read`'s. `test/support/csv.ts` is a test-only stand-in for `@thomasfosterau/effect-csv`; nothing in `src/` may import it.
- **Validating changes severities, not behaviour.** `validate: true` makes incompatible metadata and cell errors `error`s and checks primary and foreign keys; otherwise they are `warning`s and keys are unchecked. Specification _errors_ in metadata fail with `MetadataError`; invalid property values are dropped with a warning (§Annotating Tables).
- **Lexical forms are the source's** unless a `format` changed them: a native `0.0e0` stays `0.0e0` (the suite compares RDF literally); formatted numbers lose group characters and apply `%` / `‰`; formatted dates become XSD lexical forms.
- **No HTTP.** Metadata discovery stops at the default locations through the `Loader`; `Link` headers and `/.well-known/csvm` are future work (README).
- **`src/internal/json.ts` is the one `JSON.parse`**, so metadata syntax errors keep the engine's message.

## Terms

- **Embedded metadata** — the column titles read from a table's header rows (and its comment rows), checked against the table's schema for compatibility.
- **Normalized metadata** — a decoded metadata document: absolute URLs, language maps for natural-language properties, value objects for common properties, referenced schemas and dialects inlined.
- **Standard / minimal mode** — CSV2RDF and CSV2JSON either frame the cells' output with the group, tables and rows (standard) or emit only what the cells describe (minimal).
