# @thomasfosterau/effect-shex

ShEx 2.1 (with 2.2 extensions): ShExJ values and schemas, the ShExC parser (an `effect-parse` lexer and grammar) and printer, ShExR ⇄ RDF, structural checks, ShapeMaps, semantic actions and the `Validator`.

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Imports from this workspace: core, turtle — `.fallowrc.json` zone `shex`.

## Invariants

- **Structural checks precede validation:** unresolved references, self-reference outside a triple constraint, negation cycles and extension cycles are `ShExError`s.
- **shexTest is the oracle:** schemas 484 / 484, validation 1309 / 1309, negative syntax 105 / 105, negative structure 19 / 19.
- **Imports load only through `SchemaLoader`;** semantic actions run through the `SemActHandler` reference, which ignores (succeeds on) any action it does not recognise.

## Terms

- **Shape expression / triple expression** — the ShEx specification's terms (hence `no-shape-in-symbol-names` is off); **shape map** — the node@shape associations to validate.
