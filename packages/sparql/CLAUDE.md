# @thomasfosterau/effect-sparql

The SPARQL 1.1 / 1.2 engine: parser (an LL(1) `effect-parse` grammar), AST and generator, algebra translation and optimizer, expression and function library, a streaming query / update `Engine` over the pluggable `QuadStore` service (and its `QueryCapability` extension point), the results formats and a typed `QueryBuilder`.

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Imports from this workspace: core, rdfxml, turtle (tests also use ntriples) — `.fallowrc.json` zone `sparql`.

## Invariants

- **Parse → generate → parse is stable,** and every static check of the specification (blank-node scoping, grouping, `BIND` scoping, `VALUES` arity, …) is a `SparqlParseError` with `line` / `column`.
- **The algebra is §18 exactly;** the optimizer is semantics-preserving (filter pushdown, join ordering by store estimates). The W3C evaluation suite (707 / 707 runnable) is the oracle; entailment and `SERVICE` tests are skipped with reasons.
- **Storage is a service:** the engine talks to `QuadStore` only; a backend may claim whole subtrees through `QueryCapability` (`effect-sparql-sql` does), and must return the same solutions.
- **Per-query semantics** for `NOW`, `RAND`, `UUID`, `STRUUID` and `BNODE` (one `NOW` per query).

## Terms

- **Pre-binding** — SHACL-SPARQL's values insertion (`Algebra.prebind`); **solution** — a `Bindings` row.
