---
'@thomasfosterau/effect-sparql-ai': minor
---

New package `@thomasfosterau/effect-sparql-ai`: knowledge-graph tools for `effect/ai`. `Tools` defines `sparql_query`, `describe_resource`, `list_classes`, `list_properties`, `search_labels` and an opt-in `sparql_update`, as the read-only `toolkit` and `toolkitWithUpdate`, with handler layers over the `SparqlEngine` (row limits, timeouts, `SERVICE` refused by default, failures returned to the model); `Mcp` registers them with an `McpServer`.
