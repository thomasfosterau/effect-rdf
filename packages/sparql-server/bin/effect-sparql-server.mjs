#!/usr/bin/env -S node --no-warnings
// Serves RDF files over the SPARQL 1.1 Protocol and Graph Store Protocol.
// Uses the built `dist/` when available, otherwise the TypeScript sources
// (run directly with Node's built-in type stripping).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const dist = new URL('../dist/Cli.mjs', import.meta.url);
const Cli = await import(
  existsSync(dist) ? dist.href : new URL('../src/Cli.ts', import.meta.url).href
);
const { NodeRuntime } = await import('@effect/platform-node');
const { Effect } = await import('effect');
const { version } = createRequire(import.meta.url)('../package.json');

NodeRuntime.runMain(
  Cli.run(process.argv.slice(2), { version }).pipe(
    // Usage errors: `effect/cli` has printed the help; say what was wrong.
    Effect.catchTag('CliError', (e) =>
      Effect.sync(() => {
        if (e.message !== '') process.stderr.write(`${e.message}\n`);
        process.exitCode = 2;
      }),
    ),
  ),
);
