# @thomasfosterau/effect-sparql-ai

Knowledge-graph tools for [Effect AI](https://effect.website) (`effect/ai`): a
`Toolkit` that lets a language model explore and query an RDF dataset through
the [`effect-sparql`](../sparql) engine, and the same tools as an
[MCP](https://modelcontextprotocol.io/specification) server registration for
any MCP client.

```sh
pnpm add effect @thomasfosterau/effect-rdf @thomasfosterau/effect-sparql @thomasfosterau/effect-sparql-ai
```

## Tools

| Tool                | Parameters        | Result                                                                                  |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `sparql_query`      | `query`, `limit?` | SELECT: SPARQL JSON results; ASK: `isTrue`; CONSTRUCT / DESCRIBE: Turtle; `isTruncated` |
| `describe_resource` | `iri`, `limit?`   | the triples whose subject is `iri`, as Turtle; `isTruncated`                            |
| `list_classes`      | `limit?`          | `[{ iri, count }]`: types in use and declared `rdfs:Class` / `owl:Class`                |
| `list_properties`   | `limit?`          | `[{ iri, count }]`: predicates in use and declared properties                           |
| `search_labels`     | `text`, `limit?`  | `[{ iri, label }]`: `rdfs:label` / `skos:prefLabel` containing `text` (any case)        |
| `sparql_update`     | `update`          | `{ isApplied }` — only in `Tools.toolkitWithUpdate`                                     |

`Tools.toolkit` holds the five read-only tools; `Tools.toolkitWithUpdate` adds
`sparql_update`. `Tools.layer(options)` / `Tools.layerWithUpdate(options)`
provide their handlers over the `SparqlEngine` service.

## With a language model

```ts
import { Effect, Layer } from 'effect';
import { LanguageModel } from 'effect/ai';
import { Engine } from '@thomasfosterau/effect-sparql';
import { Tools } from '@thomasfosterau/effect-sparql-ai';

const answer = (question: string) =>
  Effect.gen(function* () {
    const toolkit = yield* Tools.toolkit;
    const response = yield* LanguageModel.generateText({ prompt: question, toolkit });
    return response.text;
  });

// Provide a `LanguageModel` (e.g. from @effect/ai-openai), the tool handlers and an engine.
const ToolsLive = Tools.layer({ maxRows: 50 }).pipe(Layer.provide(Engine.layerMemory()));
```

## As an MCP server

`Mcp.layer(options)` registers the read-only tools with the `McpServer` in
context; add a transport and an engine:

```ts
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { McpProtocol, McpServer } from 'effect/ai';
import { Engine } from '@thomasfosterau/effect-sparql';
import { Mcp } from '@thomasfosterau/effect-sparql-ai';

Mcp.layer().pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: 'knowledge-graph',
      version: '1.0.0',
      protocols: [McpProtocol.v2025_11_25],
    }),
  ),
  Layer.provide(Engine.layerMemory()),
  Layer.provide(NodeServices.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
```

## Safety

Tool input is written by a model, so treat it as untrusted:

- **Read-only by default.** `sparql_query` only accepts queries; updates need
  the separate `toolkitWithUpdate` (or `Mcp.layerWithUpdate`).
- **Bounded.** Every result is capped at `maxRows` (default 100) rows or
  triples and says whether it was truncated; every call times out after
  `timeout` (default 10 seconds).
- **No federation.** Queries with `SERVICE` are refused unless
  `federation: true` (and the engine has a federation handler).
- **Errors go back to the model** as a `SparqlToolError` (or a parameter
  validation error), so it can correct its query.

## Conformance

There is no conformance suite for tools; the tests drive every handler
against an in-memory engine and round-trip the tools through `McpTest`.
