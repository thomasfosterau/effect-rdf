/**
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`) and the root aggregates
 * (`check`, `test:coverage`). Every package's own tasks are defined once in
 * `vite.package.ts` and instantiated by each package's `vite.config.ts`; this
 * file compiles nothing, but a new package adds itself to the `check` list
 * below.
 *
 * Shaped after the effect-web library's root config: every comment that
 * explains a load-bearing decision is part of the standard and travels with
 * the config.
 */

import { defineConfig } from 'vite-plus';
import { recommended } from '@effect/tsgo/oxlint-presets';
import effect from '@mpsuesser/oxlint-plugin-effect';

const packages = [
  'effect-rdf',
  'effect-ntriples',
  'effect-turtle',
  'effect-n3',
  'effect-jsonld',
  'effect-rdfxml',
  'effect-rdfjson',
  'effect-xmp',
  'effect-sparql',
  'effect-shacl',
  'effect-shacl-sparql',
  'effect-shex',
  'effect-sparql-sql',
  'effect-sparql-server',
  'effect-sparql-client',
].map((name) => `@thomasfosterau/${name}`);

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    '*.{js,ts,json,md}': 'vp check --fix',
  },
  fmt: {
    singleQuote: true,
    semi: true,
    printWidth: 100,
    ignorePatterns: [
      '**/dist/**',
      '**/coverage/**',
      '**/test/fixtures/**',
      '.test-suites/**',
      'pnpm-lock.yaml',
    ],
  },
  lint: {
    ignorePatterns: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/test/fixtures/**',
      '.test-suites/**',
    ],
    extends: [recommended, effect.configs.recommended],
    categories: {
      correctness: 'error',
    },
    rules: {
      'no-console': 'error',
      'eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'eslint/prefer-const': 'warn',
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`. Stays visible as a warning.
      'effect/casting-awareness': 'warn',
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this family shares with its consumers.
      'effect/prefer-namespace-imports': 'off',
      // `Shape` is this workspace's (and Effect 4's) name for a service's
      // interface — `Context.Service<X, XShape>()` (AGENTS.md) — and in the
      // SHACL and ShEx packages "shape" is the specifications' own domain
      // term (`sh:NodeShape`, ShEx shape expressions). Neither is a
      // structural description the rule could rename away.
      'effect/no-shape-in-symbol-names': 'off',
      // The `…Schema` constants sit beside the domain type of the same name
      // (`Term.NamedNode` is the interface, `Term.NamedNodeSchema` its
      // schema; `ValidationReport` the class, `ValidationReportSchema` its
      // JSON encoding), so the domain name the rule asks for is already taken
      // by the type it describes.
      'effect/avoid-schema-suffix': 'off',

      // ---- Effect preset: allowances (effect-rdf#18) --------------------
      // The packages predate the Effect oxlint preset, and AGENTS.md makes
      // hot loops (parsers, evaluators, the dataset index) plain code rather
      // than an Effect per step. The rules below sit at `warn` with their
      // count at adoption, too many sites to rewrite safely in one change;
      // the issue lists them. A new site is a defect, not headroom. Once a
      // rule's count reaches zero its line is deleted, so it is back at the
      // preset's `error`.
      'effect/imperative-loops': 'warn', // 834
      'effect/avoid-direct-tag-checks': 'warn', // 631
      'effect/avoid-non-null-assertion': 'warn', // 639
      'effect/avoid-native-object-helpers': 'warn', // 539
      'effect/prefer-match-over-switch': 'warn', // 56
      // ---- Effect preset: rules this workspace's conventions cut across ----
      // `prefer-option-over-null` also fires on `?: T | undefined`, which is
      // the ONLY spelling of an optional member `exactOptionalPropertyTypes`
      // lets a caller forward an optional of its own into. A bare `null` /
      // `undefined` in a return type is still a finding to read (692 at
      // adoption, listed in the issue above).
      'effect/prefer-option-over-null': 'warn',
      'typescript/no-explicit-any': 'off',
      'typescript/no-empty-object-type': 'off',
      'typescript/ban-ts-comment': 'off',
      'unicorn/no-empty-file': 'off',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    overrides: [
      // Build/test configs are evaluated by Vite and Vitest in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The Effect preset's
      // service rules have no satisfiable fix in these files.
      {
        files: ['**/vite.config.ts', 'vite.package.ts', 'scripts/**'],
        rules: {
          'effect/avoid-node-imports': 'off',
          'effect/avoid-sync-fs': 'off',
          'effect/avoid-process-env': 'off',
          'effect/imperative-loops': 'off',
          'effect/no-length-comparison': 'off',
          'effect/prefer-arr-match': 'off',
          'effect/avoid-native-object-helpers': 'off',
          'effect/use-console-service': 'off',
          'effect/use-filesystem-service': 'off',
          'effect/use-path-service': 'off',
          // A build script's console output is its report.
          'no-console': 'off',
          // `...(x === undefined ? {} : { x })` is how a vitest option is left
          // unset under `exactOptionalPropertyTypes`.
          'effect/no-conditional-empty-object-spread': 'off',
        },
      },
      // Test harnesses and benchmarks run outside any Effect runtime: the
      // conformance suites are discovered from disk while vitest collects
      // (`describe.skipIf(!exists)`, reading `RDF_TEST_SUITES`), synchronously
      // and before any layer exists, and a test body or a `bench/*.ts` script
      // IS the runtime boundary that `effect-run-in-body` asks for. A
      // benchmark's console output is its product.
      {
        files: ['packages/*/test/**', 'packages/*/bench/**'],
        rules: {
          'effect/avoid-node-imports': 'off',
          'effect/avoid-sync-fs': 'off',
          'effect/avoid-process-env': 'off',
          'effect/use-filesystem-service': 'off',
          'effect/use-path-service': 'off',
          'effect/use-console-service': 'off',
          'effect/effect-run-in-body': 'off',
        },
      },
      // The one native `JSON.parse` per package: `Schema.fromJsonString`
      // replaces the engine's SyntaxError with "Expected a valid JSON
      // string", and the parsers' error messages (and the positions in them)
      // are part of their contract.
      {
        files: ['packages/*/src/internal/json.ts'],
        rules: { 'effect/avoid-direct-json': 'off' },
      },
      // Public signatures over arbitrary JSON-LD / ShExJ / N3 JSON: a JSON-LD
      // `input`, `context` or `frame` is any JSON value (and `Input` admits
      // `object` so caller interfaces without an index signature are
      // assignable), the static document loader maps URLs to parsed JSON, and
      // the processor is written over `JsonObject`. `decode` / `fromJson` are
      // the parse-at-the-boundary entry points, `equals` takes anything by
      // contract, and `toJSON` / `toJson` return JSON. Narrowing any of them
      // is a breaking API change.
      {
        files: [
          'packages/jsonld/src/JsonLd.ts',
          'packages/jsonld/src/DocumentLoader.ts',
          'packages/jsonld/src/internal/util.ts',
          'packages/n3/src/Model.ts',
          'packages/shex/src/ShExJ.ts',
          'packages/shex/src/ShapeMap.ts',
        ],
        rules: {
          'effect/no-object-parameters': 'off',
          'effect/no-unknown-parameters': 'off',
          'effect/no-unknown-returns': 'off',
          'effect/no-known-value-widening': 'off',
          'effect/no-unsafe-dictionary-type': 'off',
        },
      },
      // `Term.Object` is the RDF object-position type this module exports
      // (it shadows the global name, which is all the rule sees), and
      // `equals(that: unknown)` is the RDF/JS term-equality contract.
      {
        files: ['packages/core/src/Term.ts'],
        rules: { 'effect/avoid-object-type': 'off', 'effect/no-unknown-parameters': 'off' },
      },
      // `Xsd` maps literal values, it never reads the clock: epoch millis come
      // from `setUTCFullYear` (correct for years 0–99, where `Date.UTC` is
      // not), and the public `toJs` returns a JS `Date` that may be invalid
      // where `DateTime` would refuse it.
      {
        files: ['packages/core/src/Xsd.ts'],
        rules: { 'effect/use-clock-service': 'off' },
      },
      // `num` / `str` coerce the driver's result cells at the I/O boundary:
      // `effect/sql` types rows as `unknown`, and pg returns strings where
      // SQLite returns numbers.
      {
        files: ['packages/sparql-sql/src/SqlStore.ts'],
        rules: { 'effect/no-unknown-parameters': 'off' },
      },
      // The SPARQL server's Node runtime boundary: the `bin/` launcher picks
      // `dist/` or `src/` before any Effect runtime exists, the CLI needs
      // `node:util` `parseArgs` and reads the files it is given, and the
      // listener is a `node:http` server handed to `NodeHttpServer.layer`
      // (a server, not the HTTP client the rule is about).
      {
        files: [
          'packages/sparql-server/bin/**',
          'packages/sparql-server/src/Cli.ts',
          'packages/sparql-server/src/SparqlServer.ts',
        ],
        rules: {
          'effect/avoid-node-imports': 'off',
          'effect/avoid-sync-fs': 'off',
          'effect/use-filesystem-service': 'off',
          'effect/use-path-service': 'off',
          'effect/use-http-client-service': 'off',
        },
      },
      // Synchronous public APIs over a pure, in-memory `Stream`:
      // `Results.serializeString` and the client's push-based `Incremental`
      // parser run the Effect-returning serializer / codec to completion.
      {
        files: ['packages/sparql/src/Results.ts', 'packages/sparql-client/src/ResultsStream.ts'],
        rules: { 'effect/effect-run-in-body': 'off' },
      },
      // The SPARQL parser's per-token `hook` / `take` combinators catch the
      // parse failure they throw; a `Result` per token is the per-step
      // allocation AGENTS.md keeps out of hot loops.
      {
        files: ['packages/sparql/src/internal/parser.ts'],
        rules: { 'effect/avoid-try-catch': 'off' },
      },
      // The evaluator hands a built-in its evaluated arguments as the public
      // `Functions.BuiltInArgs` (a tuple-like array whose first three slots
      // are typed present); each built-in checks its own arity, so the cast
      // from the plain array cannot be a single assertion without changing
      // that public type.
      {
        files: ['packages/sparql/src/Expression.ts'],
        rules: { 'effect/avoid-any': 'off', 'effect/no-chained-type-assertions': 'off' },
      },
      {
        files: ['**/*.test.ts'],
        plugins: ['vitest'],
        rules: {
          'vitest/no-standalone-expect': [
            'warn',
            {
              additionalTestBlockFunctions: [
                'it.effect',
                'it.scoped',
                'it.live',
                'it.scopedLive',
                'it.layer',
                'it.effect.each',
                'it.effect.prop',
                'layer',
              ],
            },
          ],
        },
      },
    ],
    // Type-aware linting is intentionally disabled: type checking is the
    // `check` tasks' job (native tsc, Effect-patched).
    options: {
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
  },
  run: {
    cache: true,
    tasks: {
      // The CI typecheck gate, as one task: every package's `check` (`src`,
      // `test` and its config under its tsconfig.json). A pure graph node; a
      // new package adds itself to `packages` above.
      check: {
        command: "echo 'check: every type gate green'",
        dependsOn: packages.map((name) => `${name}#check`),
        cache: false,
      },
      // Import guard: the built dist of every published package imports no
      // `effect/unstable/*` (removed in rc.118, the `effect` peer floor).
      // Reads `dist/`, hence the build edges.
      'check:dist': {
        command: 'node scripts/check-dist-imports.mjs',
        dependsOn: packages.map((name) => `${name}#build`),
        cache: false,
      },
      // Every package's suite under one Istanbul coverage map
      // (`coverage/coverage-final.json`), which `fallow audit` reads for exact
      // per-function CRAP scores (`health.coverage` in .fallowrc.json).
      // Without it fallow estimates every function as uncovered. Run this
      // before `fallow audit` (the Claude Code PreToolUse fallow gate runs the
      // audit on `git commit` / `git push` but never refreshes this map).
      'test:coverage': {
        command: 'vp test run --coverage',
        cache: false,
      },
    },
  },
  test: {
    // One entry per package: each package's own vite.config.ts is a vitest
    // project, so the root run and the root coverage map cover them all.
    projects: ['packages/*/vite.config.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
});
