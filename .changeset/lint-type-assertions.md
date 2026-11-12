---
'@thomasfosterau/effect-rdf': minor
---

Remove type assertions by making the types true.

- `Sparql.Functions.BuiltInArgs`: `ReadonlyArray<GroundTerm> & { 0; 1; 2: GroundTerm }` becomes `ReadonlyArray<GroundTerm>`. Slots beyond a call's arity were never present; a custom `BuiltIn` now reads `GroundTerm | undefined` for each position.
- `RdfJs`: `RdfJsQuad` positions are now the ones RDF allows (`subject: RdfJsSubject`, `predicate: RdfJsNamedNode`, `object: RdfJsObject`, `graph: RdfJsGraph`, were `RdfJsTerm`), so `fromQuad` no longer asserts them; a variable can no longer be typed into a quad. New exported types `RdfJsNamedNode`, `RdfJsBlankNode`, `RdfJsLiteral`, `RdfJsVariable`, `RdfJsDefaultGraph`, `RdfJsSubject`, `RdfJsObject`, `RdfJsGraph`.
- `Term.toQuad`: a pair of overloads (no graph gives `Quad<S, P, O, DefaultGraph>`, a graph `G` gives `Quad<S, P, O, G>`) replaces the single generic signature `(self, graph?: G) => Quad<S, P, O, G>`.
