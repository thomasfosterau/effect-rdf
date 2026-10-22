# @thomasfosterau/effect-turtle

Turtle and TriG parsers and pretty-printers (RDF 1.2: triple terms, reified triples, annotations, `VERSION`), the Turtle `Grammar` terminals on `effect-parse` that N3 and SPARQL reuse, and the W3C test-`Manifest` reader every package's conformance suite uses.

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Imports from this workspace: core, ntriples — `.fallowrc.json` zone `turtle`.

## Invariants

- **The parser is a compiled `effect-parse` grammar emitting quads as it reads;** `parseStream` emits each statement as soon as it is complete, whatever the chunk boundaries, with the same errors and positions as `parse`.
- **Every positive W3C test round-trips** through the serializers; `serializeStream` writes in constant memory.
- **Nesting is bounded** (about 900 levels of `[ … ]`); deeper input fails with a parse error, never a stack overflow.
- **`Grammar` is shared API:** n3, sparql and shex build on its terminals, so a change there runs their suites too.

## Terms

- **Manifest** — a W3C test-suite manifest (`mf:` vocabulary) read into typed entries; the conformance tests of every package iterate it.
