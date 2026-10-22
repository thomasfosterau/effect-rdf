# @thomasfosterau/effect-n3

Notation3: the N3 `Model` (collections, formulas, terms in any position), a parser and pretty-printer, the documented N3 ⇄ RDF dataset `Mapping`, formula `Isomorphism` and a forward-chaining `Reasoner` with a subset of the `math:` / `string:` / `list:` / `log:` builtins.

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Imports from this workspace: core, turtle — `.fallowrc.json` zone `n3`.

## Invariants

- **The N3 model is wider than RDF:** literals and formulas may be subjects, variables are terms. Only RDF-compatible documents map to a core `Dataset`; formulas become named graphs identified by blank nodes (`Mapping`).
- **Skips are listed with reasons:** the syntax suites carry a documented skip list and the reasoner suite's pass rate (76 / 89) is stated in the README; a change that moves either updates both.

## Terms

- **Formula** — a quoted graph `{ … }` as a term; **rule** — `{ premise } => { conclusion }`.
