# @thomasfosterau/effect-rdf

The whole RDF toolkit in one package. The root entry is the RDF 1.2 / RDF-star data model: `Term` (IRIs, blank nodes, literals with base direction, variables, triple terms), `Dataset` (immutable, indexed quads), `Iri`, `PrefixMap`, `Namespace` / `Vocab`, `Xsd`, `Rdfs`, `Reification`, `Isomorphism`, `RdfJs` and the `Serialization` interfaces (format, parser, serializer, codec, `Formats` service) the syntaxes implement. Everything else is a nested subpath. They were separate packages before any was first published (`effect-rdfjson`, `effect-csvw`, `effect-shacl` first; then the syntaxes, SPARQL and ShEx):

- **`/ntriples`** (`src/ntriples/`) — N-Triples and N-Quads: strict and streaming parsers, canonical serializers, and the shared `Lexical` / `Grammar` modules the Turtle family reuses.
- **`/turtle`** (`src/turtle/`) — Turtle and TriG parsers and pretty-printers, the Turtle `Grammar` terminals that `/n3`, `/sparql` and `/shex` reuse, and the W3C test-`Manifest` reader every conformance suite uses.
- **`/n3`** (`src/n3/`) — Notation3: the N3 `Model`, parser and pretty-printer, the N3 ⇄ RDF `Mapping`, formula `Isomorphism` and a forward-chaining `Reasoner`.
- **`/jsonld`** (`src/jsonld/`) — a self-contained JSON-LD 1.1 processor with the `DocumentLoader` service and a `Serialization.Codec`.
- **`/rdfxml`** (`src/rdfxml/`) — RDF/XML on `Xml`, a namespace-aware XML 1.0 document tree built from `@thomasfosterau/effect-xml`'s SAX events, with Exclusive XML Canonicalization.
- **`/rdfjson`** (`src/rdfjson/`) — RDF/JSON (`application/rdf+json`) built on Effect `Schema`: document schemas, `string ⇄ Document ⇄ Dataset` transformations and the `Serialization` parser / serializer / codec.
- **`/xmp`** (`src/xmp/`) — XMP packets as RDF: `Packet`, the XMP data model (`Metadata`), the syntax (`Xmp`), typed schema accessors and JPEG / PNG extraction (`Extract`).
- **`/csvw`** (`src/csvw/`) — CSV on the Web over already-parsed tables: metadata documents (`Metadata`), datatypes and cell parsing (`Datatype`), the annotated tabular data model with embedded metadata and keys (`Table`), the validation report (`Report`), processing from a metadata or tabular data file through a `Loader` (`Processor`), and the CSV2RDF (`Csv2Rdf`) and CSV2JSON (`Csv2Json`) conversions.
- **`/shacl`** (`src/shacl/`) — SHACL Core: the `sh:` vocabulary, a typed shapes-graph model (`Shapes`), property paths, the `Validator` (function, service, pre-compiling layer and conforming-dataset `Schema`), the `ValidationReport` model ⇄ RDF, and the `Sparql.SparqlConstraintEvaluator` extension point.
- **`/shex`** (`src/shex/`) — ShEx 2.1 (with 2.2 extensions): ShExJ, the ShExC parser and printer, ShExR ⇄ RDF, structural checks, ShapeMaps, semantic actions and the `Validator`.
- **`/sparql`** (`src/sparql/`) — the SPARQL 1.1 / 1.2 engine: parser (an LL(1) `effect-parse` grammar), AST and generator, algebra and optimizer, expressions and functions, a streaming `Engine` over the `QuadStore` service (and its `QueryCapability` extension point), results formats, a typed `QueryBuilder`, the platform-neutral Protocol / Graph Store server (`SparqlServer`, `Protocol`, `GraphStore`, `ServiceDescription`, `Options`, `ServerFormats`, `ProtocolErrors`, `Testing`) and the typed client (`SparqlClient`, `ClientErrors`, `ClientFormats`, `ResultsStream`, `Federation`). Three nested subpaths build on it:
  - **`/sparql/shacl`** (`src/sparql/shacl/`) — SHACL-SPARQL: `Evaluator`, the `/shacl` `Sparql.SparqlConstraintEvaluator` implementation, and `Query` (`sh:select` / `sh:ask` with prefixes, pre-binding and `$PATH`).
  - **`/sparql/ai`** (`src/sparql/ai/`) — knowledge-graph tools for `effect/ai` (`Tools`) and their MCP registration (`Mcp`).
  - **`/sparql/sql`** (`src/sparql/sql/`) — the driver-agnostic SQL store: a term dictionary (with triple terms), `SqlStore` implementing `QuadStore`, and `Translation` / `Dialect` (SQLite and PostgreSQL) turning algebra subtrees into one SQL statement through `QueryCapability`, on `effect/sql` only.

## Boundary

Peers: `effect`; `@thomasfosterau/effect-parse`, **optional**, imported only by the syntax and SPARQL-parser subpaths (`/ntriples`, `/turtle`, `/n3`, `/jsonld`, `/shex`, `/sparql`, `/sparql/shacl`, `/sparql/ai`); `@thomasfosterau/effect-xml`, **optional**, imported only by the subpaths that read XML (`/rdfxml`, `/xmp` through it, `/sparql` for SPARQL XML results and the RDF/XML codec, so `/sparql/shacl` and `/sparql/ai` too). effect-xml requires effect-parse itself, so `/rdfxml` and `/xmp` need both installed though neither imports effect-parse. The root entry, every flat module, `/rdfjson`, `/csvw`, `/shacl` and `/sparql/sql` import neither, not even for a type, and `/ntriples`, `/turtle`, `/n3`, `/jsonld` and `/shex` never import effect-xml: `test/ModuleGraph.test.ts` walks each entry's static imports and pins which subpaths reach each peer, and on a root barrel that reaches a nested subpath. No runtime dependency; no Node platform package and no SQL driver in `src/` (the same test). DevDependencies only, for the tests: `@effect/sql-sqlite-node`, `@effect/sql-pg` and `@electric-sql/pglite` (`/sparql/sql`'s suites). Imports from this workspace: nothing — `.fallowrc.json` zone `core`.

Entry points: every `src/*.ts` is `./<Module>`; each subpath is `./<subpath>` (its `index.ts` barrel, which re-exports its modules as namespaces) and `./<subpath>/<Module>`, nested ones included (`./sparql/sql`, `./sparql/sql/<Module>`). The subpaths are nested so the root barrel loads none of them and so their module names (`Metadata`, `Table`, `Path`, `Grammar`, `Model`, `Validator`) stay out of the flat namespace. A subpath imports the data model and other subpaths through relative paths (`../index.ts`, `../Term.ts`, `../turtle/Grammar.ts`), never through the package's own name (doc-comment `@example`s and tests use the package name, as a consumer does); the data model never imports a subpath, and no subpath imports a subpath that depends on it. Each subpath's tests live in `test/<subpath>/`, its benchmarks in `bench/<subpath>/` (`vp run --filter ./packages/core bench:<subpath>`).

## Invariants

- **Terms have value equality.** Every term implements Effect `Equal` / `Hash`, so `Dataset` deduplicates and `HashSet` / `HashMap` work by value; a new term kind implements both.
- **`Dataset` is immutable and indexed.** Every operation returns a new dataset; pattern matching uses the indexes, so a change to the index layout is a performance change the syntax and SPARQL suites measure.
- **`Serialization` is the contract between the data model and the syntaxes.** A parser fails with `RdfParseError` (with `line` / `column` where known), a serializer with `RdfSerializeError`; changing either shape is breaking for every syntax subpath.
- **A pattern from the data never reaches `new RegExp` whole.** SPARQL `REGEX` / `REPLACE`, `sh:pattern`, ShEx `pattern`, CSVW `format` and the N3 string built-ins compile through `src/internal/regex.ts` (XPath or ECMAScript dialect): a Pike VM, linear in the input, with a step-budgeted backtracking matcher only for back-references and lookahead, and a cap on the program size. Only a single character class is handed to the JavaScript engine. A new call site that takes a pattern from input uses it too (SECURITY.md).
- **`Isomorphism.isomorphic` is the conformance oracle** every subpath's suite compares graphs with; it must stay correct for blank nodes inside triple terms and must not overflow the stack on large blank-node graphs.

### `/rdfjson`

- **Schemas are the implementation:** `parse` / `serialize` are the `DatasetFromString` schema, so a schema change is a behaviour change.
- **Errors name the JSON path** (`at ["s"]["p"][0]`); JSON syntax errors carry `line` / `column`.

### `/csvw`

- **No CSV scanner here.** A `Table.Source` is records of cell strings in file order; the `Loader` (`table(url, dialect)`) splits text. The dialect's scanner fields (`delimiter`, `quoteChar`, `doubleQuote`, `lineTerminators`, `encoding`) are the `Loader`'s; its row fields (`skipRows`, `headerRowCount`, `commentPrefix`, `skipBlankRows`, `skipColumns`, `trim`) are `Table.read`'s. `test/csvw/support/csv.ts` is a test-only stand-in for `@thomasfosterau/effect-csv`; nothing in `src/` may import it.
- **Validating changes severities, not behaviour.** `validate: true` makes incompatible metadata and cell errors `error`s and checks primary and foreign keys; otherwise they are `warning`s and keys are unchecked. Specification _errors_ in metadata fail with `MetadataError`; invalid property values are dropped with a warning (§Annotating Tables).
- **Lexical forms are the source's** unless a `format` changed them: a native `0.0e0` stays `0.0e0` (the suite compares RDF literally); formatted numbers lose group characters and apply `%` / `‰`; formatted dates become XSD lexical forms.
- **No HTTP.** Metadata discovery stops at the default locations through the `Loader`; `Link` headers and `/.well-known/csvm` are future work (README).
- **`src/csvw/internal/json.ts` and `src/rdfjson/internal/json.ts` are each subpath's one `JSON.parse`**, so metadata and document syntax errors keep the engine's message.

### `/shacl`

- **No SPARQL dependency:** SHACL-SPARQL features go through the `SparqlConstraintEvaluator` service, implemented by `/sparql/shacl`; without it they fail as unsupported.
- **Ill-formed shapes graphs fail with `ShapesGraphError`,** never a partial validation.
- **98 / 98 Core tests pass**; the report graph is compared with `Isomorphism.isomorphic`.

### `/ntriples`

- **Strict by default:** absolute IRIs only, validated escapes (no surrogates), language tags with base direction; the W3C negative syntax tests pin each rejection.
- **`parseStream` buffers one line at most:** chunk boundaries may fall anywhere, and large files are never held whole.
- **Serialization is canonical** (RDF 1.2 canonical escapes, lower-case language tags), so `serialize(parse(x))` matches the W3C canonicalisation tests byte for byte.

### `/turtle`

- **The parser is a compiled `effect-parse` grammar emitting quads as it reads;** `parseStream` emits each statement as soon as it is complete, whatever the chunk boundaries, with the same errors and positions as `parse`.
- **Every positive W3C test round-trips** through the serializers; `serializeStream` writes in constant memory.
- **Nesting is bounded** (about 900 levels of `[ … ]`); deeper input fails with a parse error, never a stack overflow.
- **`Grammar` is shared API:** `/n3`, `/sparql` and `/shex` build on its terminals, so a change there runs their suites too.

### `/n3`

- **The N3 model is wider than RDF:** literals and formulas may be subjects, variables are terms. Only RDF-compatible documents map to a core `Dataset`; formulas become named graphs identified by blank nodes (`Mapping`).
- **Skips are listed with reasons:** the syntax suites carry a documented skip list and the reasoner suite's pass rate (76 / 89) is stated in the README; a change that moves either updates both.

### `/jsonld`

- **Every algorithm fails with a `JsonLdError` whose `code` is the specification's error code** (`invalid @id value`, `loading remote context failed`, …); the W3C suites compare those codes.
- **Network access only through `DocumentLoader`:** without one in the environment, any remote reference fails; the package never fetches on its own initiative (SECURITY.md).
- **Skips are JSON-LD 1.0-only and generalized-RDF tests only;** anything else failing is a defect.

### `/rdfxml`

- **effect-xml reads the characters, `src/rdfxml/internal/builder.ts` the structure.** The tokenizer (`Sax.forEach`) checks names, references, the internal subset, forbidden characters and the limits; the builder adds matched tags, one root, unique attributes, Namespaces in XML 1.0, merged text nodes and every node's position (computed from offsets with its own line index, not effect-xml's lazy positions). It dispatches on the event tag with a `switch` (a scoped lint override, as in effect-xml's lexer).
- **`dtd: "internal"` only with a DOCTYPE:** it turns effect-xml's scanner off (about 3× slower), so the builder passes it only when the prolog has a `<!DOCTYPE`; without one both modes read a document identically.
- **Hostile input fails, it never exhausts resources:** no external entity or DTD is loaded, entity expansion is capped at 1,000,000 characters, entity nesting at 64 and element nesting at 1,024 (effect-xml's `limits`; its other limits are off, as this parser never had them), each reported as an `XmlParseError` (SECURITY.md).
- **Every W3C RDF 1.1 and 1.2 RDF/XML test passes,** including `rdf:version`, `its:dir`, `rdf:parseType="Triple"` and annotations.

### `/xmp`

- **One parser seam:** only `src/xmp/internal/xml.ts` imports `/rdfxml` (`Xml`, `RdfXml.parseDocument`, `splitIri`, the escapes). `/rdfxml`'s `Xml` is itself built on effect-xml, so XMP shares its parser; a move to effect-xml's own DOM would replace that file and nothing else. Keep every other module free of XML-parser types.
- **The serializer writes the canonical XMP form** — `<x:xmpmeta>`, one `rdf:Description` per schema namespace, property elements only, `rdf:parseType="Resource"` structures and the `rdf:value` qualifier form — never the RDF/XML abbreviations a non-RDF XMP reader may reject.
- **Readers are lenient where ISO 16684-1 says so:** `<x:xapmeta>`, a missing wrapper, `rdf:RDF` anywhere in the document, differing or absent `rdf:about` values (merged), property attributes. RDF outside the data model (cycles, triple terms, a property twice, non-member properties on an array) fails with `XmpModelError`.
- **Entry order carries no meaning:** `fromDataset` sorts entries by IRI (the dataset is unordered), so output is deterministic.

### `/shex`

- **Structural checks precede validation:** unresolved references, self-reference outside a triple constraint, negation cycles and extension cycles are `ShExError`s.
- **shexTest is the oracle:** schemas 484 / 484, validation 1309 / 1309, negative syntax 105 / 105, negative structure 19 / 19.
- **Imports load only through `SchemaLoader`;** semantic actions run through the `SemActHandler` reference, which ignores (succeeds on) any action it does not recognise.

### `/sparql`

- **Parse → generate → parse is stable,** and every static check of the specification (blank-node scoping, grouping, `BIND` scoping, `VALUES` arity, …) is a `SparqlParseError` with `line` / `column`.
- **The algebra is §18 exactly;** the optimizer is semantics-preserving (filter pushdown, join ordering by store estimates). The W3C evaluation suite (707 / 707 runnable) is the oracle; entailment tests are skipped with reasons, and `SERVICE` tests run over HTTP (`test/sparql/Federation.test.ts`).
- **Storage is a service:** the engine talks to `QuadStore` only; a backend may claim whole subtrees through `QueryCapability` (`/sparql/sql` does), and must return the same solutions.
- **Per-query semantics** for `NOW`, `RAND`, `UUID`, `STRUUID` and `BNODE` (one `NOW` per query).
- **Status codes are the protocol's:** `400` / `403` / `405` (with `Allow`) / `406` / `415` / `500` / `503` as the README lists; the protocol (34 / 34), graph store (14 / 14) and service description (3 / 3) suites in effect-sparql-node pin them.
- **Responses stream,** but the status waits for the first solution, so errors and timeouts before it get a proper status code.
- **Platform-neutral:** the server (`SparqlServer`: `handler`, `layerRoutes`, `layerServe`) is `effect/http` and runs under any `HttpServer`; nothing here imports `@effect/platform-node` or `node:*`. The Node listener, the CLI and the `HttpApi` definition are `@thomasfosterau/effect-sparql-node`'s (its CLAUDE.md).
- **Results stream on the client:** JSON, XML, TSV and CSV `SELECT` results and N-Triples graphs are parsed incrementally.
- **Every failure of `SparqlClient` is a `SparqlClientError` member** (`HttpStatusError` with the body, `MalformedResponseError`, `UnsupportedMediaTypeError`, `TransportError`, `TimeoutError`, `ConfigurationError`); retries apply to transient failures only by default.
- **707 / 707 evaluation tests also pass over HTTP** (client against an in-process server); `service` 7 / 7.

#### `/sparql/shacl`

- **Pre-binding follows the specification exactly** (values insertion, `Algebra.prebind`), and its restrictions — `MINUS`, `VALUES`, `SERVICE`, `AS ?prebound`, sub-queries dropping pre-bound variables — are failures.
- **22 / 22 SHACL-SPARQL tests pass, and the 98 Core tests with the evaluator installed.**
- **`test/sparql/readme-example.test.ts` is the root README's quick tour:** change both together.

#### `/sparql/ai`

- **Tool input is untrusted (model-generated).** `sparql_query` is read-only (it only parses queries), updates need the separate `toolkitWithUpdate`, every result is capped at `maxRows` and reports `isTruncated`, every call has a `timeout`, and `SERVICE` is refused unless `federation: true`. `SECURITY.md` states these; a change to any of them updates it.
- **Failures are returned to the model** (`failureMode: 'return'`, `SparqlToolError`), never thrown into the conversation.
- **Tool I/O is plain JSON:** SPARQL JSON results, Turtle text, IRIs as strings — the same shapes over `LanguageModel` and MCP.
- **The floor:** only `Tool`, `Toolkit` and `McpServer.toolkit` are used from `effect/ai`; transports (`McpServer.layerStdio` / `layerHttp`) are the caller's, since their options changed after rc.118. `McpTest` (4.1+) is test-only, confined to `test/sparql/ai/McpClient.test.ts`, the one core test that cannot run on the 4.0 floor; `Tools.test.ts` registers the tools on an `McpServer` on every supported effect.

#### `/sparql/sql`

- **`effect/sql` only:** no driver is a dependency or a peer; the store runs over the `SqlClient` in the context, in the SQLite or PostgreSQL dialect. Tests use `@effect/sql-sqlite-node` and PGlite (with `@effect/sql-pg`'s compiler) as devDependencies only (`test/sparql/sql/support/`). A ready store layer for one driver is a package of its own, `@thomasfosterau/effect-sparql-<driver>` (AGENTS.md).
- **Same solutions as the in-memory engine:** the W3C evaluation suite runs on SQLite and on PostgreSQL (PGlite), and the differential tests compare translated against generic evaluation; untranslatable subtrees fall back to the engine.
- **Exact comparisons:** floats and constants compare as SPARQL does, not as the database would by default.
- **Schema changes are migrations** (`effect/sql` `Migrator`).

## Terms

- **Triple term** — RDF 1.2 `<<( s p o )>>`, a term whose value is a triple; **reifier** — the term naming a reified triple (`Reification`).
- **Ground term** — a term with no variables or blank nodes.
- **Value object** (`/rdfjson`) — an RDF/JSON `{ "type": "uri" | "bnode" | "literal" | "triple", … }` entry.
- **Embedded metadata** (`/csvw`) — the column titles read from a table's header rows (and its comment rows), checked against the table's schema for compatibility.
- **Normalized metadata** (`/csvw`) — a decoded metadata document: absolute URLs, language maps for natural-language properties, value objects for common properties, referenced schemas and dialects inlined.
- **Standard / minimal mode** (`/csvw`) — CSV2RDF and CSV2JSON either frame the cells' output with the group, tables and rows (standard) or emit only what the cells describe (minimal).
- **Shape** (`/shacl`) — a SHACL node or property shape (the specification's term, hence `no-shape-in-symbol-names` is off); **focus node** — the node a shape validates; **value node** — what a path reaches from it.

- **Canonical form** (`/ntriples`) — the RDF 1.2 N-Triples canonical serialization the c14n tests check.

- **Manifest** (`/turtle`) — a W3C test-suite manifest (`mf:` vocabulary) read into typed entries; every subpath's conformance tests iterate it.

- **Formula** (`/n3`) — a quoted graph `{ … }` as a term; **rule** — `{ premise } => { conclusion }`.

- **Active context** (`/jsonld`) — the processed context the algorithms thread through; **document loader** — the service that resolves a remote context or document.

- **XML literal** (`/rdfxml`) — `rdf:XMLLiteral`, serialized with Exclusive XML Canonicalization.

- **Packet** (`/xmp`) — `<?xpacket begin=… id="W5M0MpCehiHzreSzNTczkc9d"?>` … `<?xpacket end="w"?>`, with whitespace padding for in-place updates.
- **Language alternative** (`/xmp`) — an `rdf:Alt` of text items qualified by `xml:lang`, `x-default` first.
- **Extended XMP** (`/xmp`) — a JPEG's packet continued across further APP1 segments, named by `xmpNote:HasExtendedXMP`.

- **Shape expression / triple expression** (`/shex`) — the ShEx specification's terms (hence `no-shape-in-symbol-names` is off); **shape map** — the node@shape associations to validate.

- **Pre-binding** (`/sparql/shacl`) — SHACL-SPARQL's values insertion (`Algebra.prebind`); **solution** — a `Bindings` row.
- **Constraint component** (`/sparql/shacl`) — a SPARQL-defined, parameterised constraint (`sh:ConstraintComponent`).
- **Tool** / **toolkit** (`/sparql/ai`) — `effect/ai`'s `Tool.make` definitions and their `Toolkit`; **MCP** — the Model Context Protocol.
- **Federation** (`/sparql`) — evaluating `SERVICE <url> { … }` by sending the group to that endpoint.
- **Direct / indirect identification** (`/sparql`) — Graph Store addressing by URL path vs `?graph=<iri>`.
- **`Errors` / `ProtocolErrors` / `ClientErrors`** (`/sparql`) — the engine's evaluation and update errors, the server's HTTP-status `ProtocolError`, and the client's `SparqlClientError` members. **`ServerFormats` / `ClientFormats`** — the server's default codecs (Turtle first, for negotiation) and the client's (N-Triples first, parsed incrementally).

- **Term dictionary** (`/sparql/sql`) — the interned id ↔ term table every quad column references.
