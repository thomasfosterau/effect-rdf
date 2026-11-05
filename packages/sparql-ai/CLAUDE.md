# @thomasfosterau/effect-sparql-ai

Knowledge-graph tools for `effect/ai`: `Tools` (the `sparql_query`, `describe_resource`, `list_classes`, `list_properties`, `search_labels` and opt-in `sparql_update` tools, the read-only `toolkit` / `toolkitWithUpdate`, and handler layers over `SparqlEngine`) and `Mcp` (their `McpServer.toolkit` registration).

## Boundary

Peers: `effect`. Imports from this workspace: core, sparql, turtle — `.fallowrc.json` zone `sparql-ai`.

## Invariants

- **Tool input is untrusted (model-generated).** `sparql_query` is read-only (it only parses queries), updates need the separate `toolkitWithUpdate`, every result is capped at `maxRows` and reports `isTruncated`, every call has a `timeout`, and `SERVICE` is refused unless `federation: true`. `SECURITY.md` states these; a change to any of them updates it.
- **Failures are returned to the model** (`failureMode: 'return'`, `SparqlToolError`), never thrown into the conversation.
- **Tool I/O is plain JSON:** SPARQL JSON results, Turtle text, IRIs as strings — the same shapes over `LanguageModel` and MCP.
- **The floor:** only `Tool`, `Toolkit` and `McpServer.toolkit` are used from `effect/ai`; transports (`McpServer.layerStdio` / `layerHttp`) are the caller's, since their options changed after rc.118. `McpTest` (4.1+) is test-only.

## Terms

- **Tool** / **toolkit** — `effect/ai`'s `Tool.make` definitions and their `Toolkit`; **MCP** — the Model Context Protocol.
