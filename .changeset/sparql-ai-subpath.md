---
'@thomasfosterau/effect-rdf': minor
---

New nested subpath `@thomasfosterau/effect-rdf/sparql/ai` (and `…/ai/Tools`, `…/ai/Mcp`), kept off the root barrel: knowledge-graph tools for `effect/ai`. `Tools` defines `sparql_query`, `describe_resource`, `list_classes`, `list_properties`, `search_labels` and an opt-in `sparql_update`, as the read-only `toolkit` and `toolkitWithUpdate`, with handler layers over the `SparqlEngine` (row limits, timeouts, `SERVICE` refused by default, failures returned to the model); `Mcp` registers them with an `McpServer`. It replaces the separate `effect-sparql-ai` package, which was never published, and adds no dependency to this package. RDF/JSON now comes from `@thomasfosterau/effect-rdf/rdfjson`, so this package no longer depends on `effect-rdfjson`.
