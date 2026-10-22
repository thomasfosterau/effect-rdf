# @thomasfosterau/effect-jsonld

A self-contained JSON-LD 1.1 processor: context processing, expansion, compaction, flattening, framing, RDF conversion, the `DocumentLoader` service and a `Serialization.Codec` for `application/ld+json`.

## Boundary

Peers: `@thomasfosterau/effect-parse`, `effect`. Imports from this workspace: core — `.fallowrc.json` zone `jsonld`.

## Invariants

- **Every algorithm fails with a `JsonLdError` whose `code` is the specification's error code** (`invalid @id value`, `loading remote context failed`, …); the W3C suites compare those codes.
- **Network access only through `DocumentLoader`:** without one in the environment, any remote reference fails; the package never fetches on its own initiative (SECURITY.md).
- **Skips are JSON-LD 1.0-only and generalized-RDF tests only;** anything else failing is a defect.

## Terms

- **Active context** — the processed context the algorithms thread through; **document loader** — the service that resolves a remote context or document.
