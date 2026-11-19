# @thomasfosterau/effect-rdf

The data model at the root, one nested subpath per syntax and engine (listed in [README.md](README.md), documented in [docs/](docs/)).

## Boundary

- Peers: `effect`; optional `@thomasfosterau/effect-parse` (the syntax and SPARQL-parser subpaths), `@thomasfosterau/effect-xml` (`/rdfxml`, `/xmp`, `/sparql` and the subpaths on it) and `@thomasfosterau/effect-ext` (`/csvw` only, through its `./UriTemplate` entry). The root entry, the flat modules, `/rdfjson`, `/csvw`, `/shacl` and `/sparql/sql` import neither effect-parse nor effect-xml, not even for a type. `test/ModuleGraph.test.ts` pins which entry reaches which peer.
- No runtime dependency, no Node platform package and no SQL driver in `src/`. The SQL drivers and PGlite are devDependencies for `/sparql/sql`'s suites.
- A subpath imports the data model and other subpaths by relative path, never by the package name (examples and tests use the name). The data model never imports a subpath, and the module graph is acyclic.
- A new subpath: `exports` / `publishConfig.exports`, `subpaths` in `vite.config.ts`, an `entry` glob in `.fallowrc.json`, its place in `test/ModuleGraph.test.ts`, and a page in `docs/`.

## Invariants

- Terms implement `Equal` / `Hash`; `Dataset` is immutable and indexed.
- Parsers fail with `RdfParseError` (with `line` / `column`), serialisers with `RdfSerializeError`; changing either is breaking for every syntax.
- A pattern from the data (SPARQL `REGEX`, `sh:pattern`, ShEx `pattern`, CSVW `format`, N3 string built-ins) never reaches `new RegExp`: it compiles through `src/internal/regex.ts`, which bounds the work ([docs/SECURITY.md](../../docs/SECURITY.md)).
- `Isomorphism.isomorphic` is the oracle every conformance suite compares graphs with.
- Hostile input fails, it never exhausts resources: RDF/XML loads no external entity and caps expansion and nesting; Turtle nesting is bounded; JSON-LD and ShEx reach the network only through a caller-provided loader.
- `/shacl` has no SPARQL dependency: SHACL-SPARQL goes through the `SparqlConstraintEvaluator` service that `/sparql/shacl` implements.
- `/turtle`'s `Grammar` is shared by `/n3`, `/sparql` and `/shex`; a change there runs their suites too.
- `/xmp` reaches XML only through `src/xmp/internal/xml.ts`.
- `/csvw` scans no CSV: tables arrive as records of cell strings, and every byte comes through the `Loader`.
- The SPARQL engine talks only to the `QuadStore` service; a backend claiming subtrees through `QueryCapability` (as `/sparql/sql` does) must return the same solutions. The server is `effect/http` only; Node lives in effect-sparql-node.
- `/sparql/ai` tool input is model-generated: read-only by default, capped, timed out, no `SERVICE` unless enabled. Changing any of these updates docs/SECURITY.md.
- Skipped conformance tests are listed with their reason in the test file; a change that moves a pass rate updates [docs/conformance.md](docs/conformance.md).
