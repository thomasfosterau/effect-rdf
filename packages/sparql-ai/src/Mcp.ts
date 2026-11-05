/**
 * The knowledge-graph tools as an MCP (Model Context Protocol) server
 * registration: provide `Mcp.layer()` together with one of `effect/ai`'s
 * `McpServer` transports (`McpServer.layerStdio`, `McpServer.layerHttp`, …)
 * and a `SparqlEngine`, and any MCP client can call the tools.
 *
 * ```ts
 * import { Layer } from 'effect'
 * import { McpServer } from 'effect/ai'
 * import { Engine } from '@thomasfosterau/effect-sparql'
 * import { Mcp } from '@thomasfosterau/effect-sparql-ai'
 *
 * const Server = Mcp.layer({ maxRows: 50 }).pipe(
 *   Layer.provide(McpServer.layerStdio({ name: 'knowledge-graph', version: '1.0.0', protocols })),
 *   Layer.provide(Engine.layerMemory()),
 * )
 * ```
 *
 * @since 0.1.0
 */
import * as Layer from 'effect/Layer';
import { McpServer } from 'effect/ai';
import * as Tools from './Tools.ts';

/**
 * Registers the read-only `Tools.toolkit` with the `McpServer` in context,
 * with its handlers over the `SparqlEngine` in context.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options?: Tools.ToolOptions) =>
  McpServer.toolkit(Tools.toolkit).pipe(Layer.provide(Tools.layer(options)));

/**
 * Registers `Tools.toolkitWithUpdate` (the read-only tools plus
 * `sparql_update`) with the `McpServer` in context.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWithUpdate = (options?: Tools.ToolOptions) =>
  McpServer.toolkit(Tools.toolkitWithUpdate).pipe(Layer.provide(Tools.layerWithUpdate(options)));
