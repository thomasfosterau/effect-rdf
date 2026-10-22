# @thomasfosterau/effect-ntriples

RDF 1.2 N-Triples and N-Quads: strict and streaming parsers, canonical serializers, and the shared `Lexical` / `Grammar` modules (character classes, escapes, language tags, canonical term formatting) the Turtle family reuses.

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Imports from this workspace: core — `.fallowrc.json` zone `ntriples`.

## Invariants

- **Strict by default:** absolute IRIs only, validated escapes (no surrogates), language tags with base direction; the W3C negative syntax tests pin each rejection.
- **`parseStream` buffers one line at most:** chunk boundaries may fall anywhere, and large files are never held whole.
- **Serialization is canonical** (RDF 1.2 canonical escapes, lower-case language tags), so `serialize(parse(x))` matches the W3C canonicalisation tests byte for byte.

## Terms

- **Canonical form** — the RDF 1.2 N-Triples canonical serialization the c14n tests check.
