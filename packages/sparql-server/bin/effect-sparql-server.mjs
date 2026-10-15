#!/usr/bin/env -S node --no-warnings
// Serves RDF files over the SPARQL 1.1 Protocol and Graph Store Protocol.
// Uses the built `dist/` when available, otherwise the TypeScript sources
// (run directly with Node's built-in type stripping).
import { existsSync } from 'node:fs';

const dist = new URL('../dist/Cli.mjs', import.meta.url);
const Cli = await import(
  existsSync(dist) ? dist.href : new URL('../src/Cli.ts', import.meta.url).href
);
const { NodeRuntime } = await import('@effect/platform-node');
const { Effect } = await import('effect');

NodeRuntime.runMain(
  Cli.run(process.argv.slice(2)).pipe(
    Effect.catchTag('CliError', (e) =>
      Effect.sync(() => {
        process.stderr.write(`${e.message}\n\n${Cli.usage}`);
        process.exitCode = 2;
      }),
    ),
  ),
);
