/**
 * A full MCP client round trip over `Mcp.layer`. `McpTest` is effect 4.1+,
 * so this file needs the 4.1 line: on 4.0 it neither type-checks nor runs,
 * while `Mcp.layer` itself does (`Tools.test.ts` registers the tools on an
 * `McpServer` on every supported effect).
 */
import { describe, expect, it } from '@effect/vitest';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Order from 'effect/Order';
import { McpProtocol, McpTest } from 'effect/ai';
import { Mcp } from '../../../src/sparql/ai/index.ts';
import { EX, engine } from './support/fixture.ts';

describe('Mcp', () => {
  it.effect('serves the read-only tools to an MCP client', () =>
    Effect.gen(function* () {
      const client = yield* McpTest.makeClient(Mcp.layer().pipe(Layer.provide(engine)), {
        protocols: [McpProtocol.v2025_11_25],
      });
      const tools = yield* client.listTools();
      expect(
        Arr.sort(
          tools.tools.map((t) => t.name),
          Order.String,
        ),
      ).toEqual([
        'describe_resource',
        'list_classes',
        'list_properties',
        'search_labels',
        'sparql_query',
      ]);
      const result = yield* client.callTool({ name: 'search_labels', arguments: { text: 'bob' } });
      expect(result.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining(`${EX}bob`) }),
      ]);
    }).pipe(Effect.scoped),
  );
});
