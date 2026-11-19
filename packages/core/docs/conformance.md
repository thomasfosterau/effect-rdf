# Conformance

The data model has no W3C suite of its own; it is exercised by every syntax subpath's suites (N-Triples, Turtle, TriG, RDF/XML, JSON-LD, N3) and by the SPARQL evaluation suite, which compare graphs with `Isomorphism.isomorphic`. Its unit tests cover terms, datasets, IRIs, XSD, RDFS and isomorphism, and RDF/JSON's (`test/rdfjson/`) its schemas, parser, serialiser and round trips; RDF/JSON has no W3C suite.

Every suite below runs when it is checked out under `.test-suites` (`scripts/fetch-test-suites.sh`, or set `RDF_TEST_SUITES`), and skips otherwise. Each subpath's suites live in `test/<subpath>/`; manifests and expected results are read with `/turtle`, `/ntriples` and `/rdfxml`.

**CSV on the Web**: the [W3C CSVW test suite](https://github.com/w3c/csvw/tree/gh-pages/tests) (`.test-suites/csvw`). The suite's CSV files are split into records by a test-only stand-in for `effect-csv` (`test/csvw/support/csv.ts`).

| Manifest                   | Result                       |
| -------------------------- | ---------------------------- |
| `manifest-validation.ttl`  | 282 / 282 run (none skipped) |
| `manifest-rdf.ttl` (RDF)   | 270 / 270 run (none skipped) |
| `manifest-json.ttl` (JSON) | 270 / 270 run (none skipped) |

RDF results are compared with `Isomorphism.isomorphic`, JSON results structurally. The harness feeds the `Loader` what HTTP would: the `Link` header a test declares (`csvt:httpLink`: `test014`, `test016`, `test120`, `test122`) and one site-wide `/.well-known/csvm` file for every test (the suite ships none: the two default locations, then `{+url}.json` and `csvm.json`, where `test260` and `test259` keep their metadata).

**SHACL**: the W3C SHACL test suite (`.test-suites/data-shapes`): all 98 SHACL Core tests pass. The 22 SHACL-SPARQL tests (`sparql/`) need a SPARQL evaluator; they run in `@thomasfosterau/effect-rdf/sparql`'s suite, where all 22 pass, and all 98 Core tests pass with the evaluator installed.

**N-Triples and N-Quads** (`/ntriples`): The full W3C rdf11 / rdf12 N-Triples and N-Quads suites pass (syntax and canonicalisation): `test/ntriples/conformance.test.ts`.

**Turtle and TriG** (`/turtle`): Every W3C rdf11 / rdf12 Turtle and TriG syntax and evaluation test passes, and every positive test round-trips through the serializer: `test/turtle/conformance.test.ts`.

**Notation3** (`/n3`): `test/n3/conformance.test.ts` runs the W3C N3 CG suite (`.test-suites/N3/tests`):
the Turtle, N3 parser and extended N3 parser manifests, positive and
negative syntax and evaluation tests. Every positive test is additionally
round-tripped through the serializer (and, where RDF-compatible, through a
core dataset). See the test file for the documented skip list.

**JSON-LD** (`/jsonld`): The W3C JSON-LD 1.1 expand, compact, flatten, toRdf, fromRdf, remote-doc and framing suites pass (`test/jsonld/`); the only tests skipped are JSON-LD 1.0-only ones and the ones that need generalized RDF.

**RDF/XML** (`/rdfxml`): Every test of the W3C RDF 1.1 and RDF 1.2 RDF/XML suites passes (`test/rdfxml/Conformance.test.ts`), including `rdf:version`, base direction via `its:dir`, triple terms and annotations.

**XMP** (`/xmp`): There is no public XMP conformance suite; the unit tests are modelled on the ISO 16684-1
examples. `scripts/fetch-test-suites.sh` checks out the metadata sections of
[veraPDF's PDF/A and PDF/UA corpus](https://github.com/veraPDF/veraPDF-corpus), and
`test/xmp/Conformance.test.ts` reads the packet of every file in them: all 497 files that should
pass validation parse (and give the PDF/A part their section tests), and none of the 568 that
should fail makes the reader throw. The ISO 16684-1 examples are not freely published, and the
Adobe XMP Toolkit SDK ships no sample XMP files, only the C++ samples that generate them.

**SPARQL** (`/sparql`): The W3C test suites are run from `.test-suites/rdf-tests/sparql` (or
`$RDF_TEST_SUITES`), using `/turtle`, `/ntriples` and `/rdfxml` to read
manifests and data:

- **Syntax**: 574 / 574 (SPARQL 1.0, 1.1 query and update, 1.2) — every
  positive test also round-trips through `Generator.print`.
- **Evaluation**: 707 / 707 runnable query, update and CSV/TSV result tests
  (SPARQL 1.0, 1.1, 1.2). Result sets are compared up to blank node renaming
  (numeric literals by value); ordered results check the `ORDER BY` keys.
  Skipped (77): `sparql11/entailment` (70; entailment regimes are not
  supported) and `sparql11/service` (7; federation needs remote endpoints,
  so these run over HTTP below).
- **Evaluation over HTTP** (`test/sparql/HttpEvalConformance.test.ts`): the same
  707 / 707 runnable tests pass with each test's data loaded into an
  in-process server and every query sent by the client, with results parsed
  from JSON, XML and TSV. Skipped: `sparql11/entailment` and
  `sparql11/service` (below).
- **Federation** (`sparql11/service`): 7 / 7, with one in-process server per
  endpoint (the servers are federated themselves, for nested `SERVICE`).

The protocol suites in `.test-suites/rdf-tests/sparql/sparql11` are run
in-process against the server, reading the HTTP requests and expected
responses from the manifests — once against `SparqlServer.handler` and once
against the `SparqlApi` routes (`SparqlApiBuilder`), with the same results.
They live in `@thomasfosterau/effect-sparql-node`'s tests
(`test/ProtocolConformance.test.ts`), since `SparqlApi` is that package's:

- **SPARQL 1.1 Protocol** (`protocol`): 34 / 34 on both.
- **Graph Store Protocol** (`graph-store-protocol`, direct and indirect
  identification, graph creation by `POST`, `multipart/form-data`): 14 / 14
  on both (13 listed tests plus `head_non_existing_direct`, which the
  manifest defines but does not list).
- **Service Description** (`service-description`): 3 / 3 on both (the
  manifest has no machine-readable requests; the three checks are
  implemented directly).
- **Skipped**: `http-rdf-update` — deprecated (`dawg:Deprecated`, superseded
  by `graph-store-protocol`), its requests are prose-only and depend on state
  it never creates.

**SHACL-SPARQL** (`/sparql/shacl`): the W3C SHACL test suite (`.test-suites/data-shapes`, or
`$RDF_TEST_SUITES`): all **22 / 22** SHACL-SPARQL tests (`sparql/`: node,
property, component and pre-binding tests) pass, and all 98 Core tests pass
with the evaluator installed.

**Knowledge-graph tools** (`/sparql/ai`): there is no conformance suite for tools; the tests
(`test/sparql/ai/`) drive every handler against an in-memory engine and round-trip the tools through `McpTest` (`test/sparql/ai/McpClient.test.ts`, which needs effect 4.1; everything else in the package's suite also runs on the 4.0 floor).

**SPARQL over SQL** (`/sparql/sql`):

- The W3C SPARQL 1.0/1.1/1.2 evaluation tests run against SQLite (a fresh
  database per test) **and against PostgreSQL** (PGlite, PostgreSQL compiled
  to WASM, through a small `SqlClient` adapter in `test/sparql/sql/support/pglite.ts`):
  707/707 runnable query, update and result-format tests pass on both (the
  same 77 entailment and federation tests as the in-memory store are
  skipped). More than half of the queries run entirely as one SQL statement.
- Differential tests compare the SQL store with the in-memory store on
  random queries over random datasets (including data that forces the
  exactness fallbacks).
- Translation tests assert that representative queries are executed entirely
  in SQL and inspect the generated SQL (SQLite and PostgreSQL).
- A bulk-load test loads 100,000 triples and runs a join/filter/count query.

**ShEx** (`/shex`): The tests run the [shexTest](https://github.com/shexSpec/shexTest) suite when
it is checked out under `.test-suites/shexTest` (or set `RDF_TEST_SUITES`):

| Suite                                               | Result                                |
| --------------------------------------------------- | ------------------------------------- |
| `schemas`: ShExC → ShExJ                            | 484 / 484                             |
| `schemas`: ShExJ → ShExC → ShExJ (printer)          | 484 / 484                             |
| `schemas`: ShExR → ShExJ, and ShExJ → ShExR → ShExJ | 482 / 484 each (2 skipped, see below) |
| `negativeSyntax`                                    | 105 / 105                             |
| `negativeStructure`                                 | 19 / 19                               |
| `validation` (status, plus Test-extension output)   | 1309 / 1309                           |

These two ShExR tests are skipped because the RDF is ambiguous. In both, a
labelled triple expression is used in several places, and RDF cannot record
which use defines it: `1Include1` and `ShExR`. The `TwoNegation_pass`
representation test is not checked structurally, because its schema
deliberately breaks the negation requirement.
