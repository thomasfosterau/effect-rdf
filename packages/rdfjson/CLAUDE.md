# @thomasfosterau/effect-rdfjson

RDF/JSON (`application/rdf+json`) built on Effect `Schema`: document schemas, `string ⇄ Document ⇄ Dataset` transformations and the `Serialization` parser / serializer / codec.

## Boundary

Peers: `effect`. Imports from this workspace: core — `.fallowrc.json` zone `rdfjson`.

## Invariants

- **Schemas are the implementation:** `parse` / `serialize` are the `DatasetFromString` schema, so a schema change is a behaviour change.
- **Errors name the JSON path** (`at ["s"]["p"][0]`); JSON syntax errors carry `line` / `column`.

## Terms

- **Value object** — an RDF/JSON `{ "type": "uri" | "bnode" | "literal" | "triple", … }` entry.
