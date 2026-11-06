# @effect-rdf/conformance

Private and never published (`"private": true`). The test suites of core's subpaths that need a sibling syntax package to read their inputs: the W3C CSVW suite (`test/csvw/`, for `@thomasfosterau/effect-rdf/csvw`) and the W3C SHACL Core suite plus the SHACL unit, tracing and `Schema` tests that parse shapes from Turtle (`test/shacl/`, for `@thomasfosterau/effect-rdf/shacl`).

## Boundary

Dev dependencies only: `@thomasfosterau/effect-rdf` and `@thomasfosterau/effect-turtle` (manifests, expected RDF, shapes graphs) — `.fallowrc.json` zone `conformance`. It imports core by its package name, as a consumer does. Nothing imports it.

## Invariants

- **It exists to break a cycle.** Core may not take turtle as a devDependency (turtle depends on core, and `vp run -r` refuses the cycle), so a core test that needs a syntax package lives here; a core test that needs none stays in `packages/core/test/`.
- **Suites read `RDF_TEST_SUITES ?? <repo>/.test-suites`** and skip when absent, like every other package's.
- **Coverage counts toward core.** The root `vp run test:coverage` map measures `packages/*/src/**` across every project, this one included; its own `test:coverage` measures `packages/core/src/csvw` and `packages/core/src/shacl`.
- `test/csvw/support/csv.ts` is a test-only stand-in for `@thomasfosterau/effect-csv`.
