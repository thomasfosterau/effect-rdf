# @thomasfosterau/effect-shacl

SHACL Core: the `sh:` vocabulary, a typed shapes-graph model (`Shapes`), property paths, the `Validator` (function, service, pre-compiling layer and conforming-dataset `Schema`), the `ValidationReport` model ⇄ RDF, and the `Sparql.SparqlConstraintEvaluator` extension point.

## Boundary

Peers: `effect`. Imports from this workspace: core (tests also use turtle) — `.fallowrc.json` zone `shacl`.

## Invariants

- **No SPARQL dependency:** SHACL-SPARQL features go through the `SparqlConstraintEvaluator` service, implemented in `effect-shacl-sparql`; without it they fail as unsupported.
- **Ill-formed shapes graphs fail with `ShapesGraphError`,** never a partial validation.
- **98 / 98 Core tests pass;** the report graph is compared with `Isomorphism.isomorphic`.

## Terms

- **Shape** — a SHACL node or property shape (the specification's term, hence `no-shape-in-symbol-names` is off); **focus node** — the node a shape validates; **value node** — what a path reaches from it.
