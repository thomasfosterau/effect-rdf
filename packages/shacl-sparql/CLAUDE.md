# @thomasfosterau/effect-shacl-sparql

SHACL-SPARQL on the `effect-sparql` engine: implements `effect-shacl`'s `Sparql.SparqlConstraintEvaluator` (`Evaluator.layer` / `make`) for `sh:sparql` constraints, SPARQL-based constraint components and SHACL-AF SPARQL targets; `Query` reads `sh:select` / `sh:ask` with prefixes, pre-binding and `$PATH` substitution.

## Boundary

Peers: `effect`. Imports from this workspace: core, shacl, sparql (tests also use jsonld, turtle) — `.fallowrc.json` zone `shacl-sparql`.

## Invariants

- **Pre-binding follows the specification exactly** (values insertion, `Algebra.prebind`), and its restrictions — `MINUS`, `VALUES`, `SERVICE`, `AS ?prebound`, sub-queries dropping pre-bound variables — are failures.
- **22 / 22 SHACL-SPARQL tests pass, and the 98 Core tests with the evaluator installed.**
- **`test/readme-example.test.ts` is the root README's quick tour:** change both together.

## Terms

- **Constraint component** — a SPARQL-defined, parameterised constraint (`sh:ConstraintComponent`).
