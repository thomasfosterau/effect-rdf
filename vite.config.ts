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
import effect from '@enfect/oxlint';

const packages = ['effect-rdf', 'effect-sparql-node'].map((name) => `@thomasfosterau/${name}`);

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
      '**/CHANGELOG.md',
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
    plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'promise', 'jsdoc'],
    categories: {
      correctness: 'error',
      suspicious: 'error',
      perf: 'error',
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
      // `_tag` is the discriminant of every Effect tagged union (`Data.TaggedEnum`,
      // `Schema.TaggedClass`, the AST and term types).
      'eslint/no-underscore-dangle': ['error', { allow: ['_tag'] }],
      // Every export's doc comment carries `@since` and `@category` (AGENTS.md).
      'jsdoc/check-tag-names': ['error', { definedTags: ['since', 'category'] }],
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
          // Tests are written on `@effect/vitest` (`it.effect`, `layer`),
          // which Effect marks unstable as a whole, and exercise the same
          // unstable modules as the sources below.
          'effecttsgo/unstable-api-usage': 'off',
        },
      },
      // A benchmark's console output is its product: each `bench/*.ts`
      // script prints its timings and nothing else reads them.
      {
        files: ['packages/*/bench/**'],
        rules: { 'no-console': 'off' },
      },
      // Effect 4.1 ships HTTP, SQL, AI, the CLI, `FileSystem` / `Path` and
      // `Graph` only in its "unstable" tier: the marker states their
      // stability, it does not point at a stable alternative. These are the
      // sources built on them, and only these: the SPARQL protocol server,
      // client, SQL store and AI tools; effect-sparql-node (the Node server,
      // CLI and `HttpApi`); the JSON-LD `DocumentLoader` over `HttpClient`;
      // `Serialization`'s file helpers; and `Dataset`'s `Graph` conversion. A
      // new use anywhere else is still reported.
      {
        files: [
          'packages/core/src/sparql/**',
          'packages/core/src/jsonld/DocumentLoader.ts',
          'packages/core/src/Serialization.ts',
          'packages/core/src/Dataset.ts',
          'packages/sparql-node/src/**',
          'packages/sparql-node/bin/**',
        ],
        rules: { 'effecttsgo/unstable-api-usage': 'off' },
      },
      // The one native `JSON.parse` per nested subpath: `Schema.fromJsonString`
      // replaces the engine's SyntaxError with "Expected a valid JSON
      // string", and the parsers' error messages (and the positions in them)
      // are part of their contract.
      {
        files: ['packages/*/src/*/internal/json.ts'],
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
          'packages/core/src/jsonld/JsonLd.ts',
          'packages/core/src/jsonld/DocumentLoader.ts',
          'packages/core/src/jsonld/internal/util.ts',
          'packages/core/src/n3/Model.ts',
          'packages/core/src/shex/ShExJ.ts',
          'packages/core/src/shex/ShapeMap.ts',
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
        files: ['packages/core/src/sparql/sql/SqlStore.ts'],
        rules: { 'effect/no-unknown-parameters': 'off' },
      },
      // The SPARQL server's Node runtime boundary: the `bin/` launcher picks
      // `dist/` or `src/` before any Effect runtime exists, the CLI needs
      // `node:util` `parseArgs` and reads the files it is given, and the
      // listener is a `node:http` server handed to `NodeHttpServer.layer`
      // (a server, not the HTTP client the rule is about).
      {
        files: [
          'packages/sparql-node/bin/**',
          'packages/sparql-node/src/Cli.ts',
          'packages/sparql-node/src/NodeSparqlServer.ts',
        ],
        rules: {
          'effect/avoid-node-imports': 'off',
          'effect/avoid-sync-fs': 'off',
          'effect/use-filesystem-service': 'off',
          'effect/use-path-service': 'off',
          'effect/use-http-client-service': 'off',
          // `Cli.ts` is the server's application entry point, where the
          // rule says layers belong.
          'effecttsgo/strict-effect-provide': 'off',
        },
      },
      // Synchronous public APIs over a pure, in-memory `Stream`:
      // `Results.serializeString` and the client's push-based `Incremental`
      // parser run the Effect-returning serializer / codec to completion.
      {
        files: ['packages/core/src/sparql/Results.ts', 'packages/core/src/sparql/ResultsStream.ts'],
        rules: { 'effect/effect-run-in-body': 'off' },
      },
      // The RDF/XML tree builder handles every SAX event of a document: a
      // `switch` on the tag, as effect-xml's own lexer does (its AGENTS.md:
      // `$match` / `$is` cost a third of the throughput there, since one
      // shared function per program goes megamorphic).
      {
        files: ['packages/core/src/rdfxml/internal/builder.ts'],
        rules: {
          'effect/prefer-match-over-switch': 'off',
          'effect/avoid-direct-tag-checks': 'off',
        },
      },
      // The SPARQL parser's per-token `hook` / `take` combinators catch the
      // parse failure they throw; a `Result` per token is the per-step
      // allocation AGENTS.md keeps out of hot loops.
      {
        files: ['packages/core/src/sparql/internal/parser.ts'],
        rules: { 'effect/avoid-try-catch': 'off' },
      },
      // Three assertions TypeScript cannot check, each on a type whose keys
      // are correlated one by one with a tuple or union the value was built
      // from by iteration: `Namespace.vocabulary` (`{ [K in Terms]:
      // NamedNode<`${Base}${K}`> }`), `QueryBuilder.vars` (`{ [K in
      // N[number]]: Variable<K> }`) and `QueryBuilder.execute`'s rows (the
      // projection lives only in the builder's type parameters; checking a
      // row against it at run time is the per-row validation AGENTS.md keeps
      // out of the evaluator). And `Term.tripleFromJson`: `TermJson.Triple`
      // types its positions as any ground term on purpose, so an ill-formed
      // triple decodes and `isWellFormed` (or the codec) rejects it; the two
      // assertions there are that documented contract. Every other `as` in
      // the workspace is an error.
      {
        files: [
          'packages/core/src/Namespace.ts',
          'packages/core/src/Term.ts',
          'packages/core/src/sparql/QueryBuilder.ts',
        ],
        rules: {
          'typescript/no-unsafe-type-assertion': 'off',
          'effect/casting-awareness': 'off',
        },
      },
      {
        files: ['**/*.test.ts'],
        plugins: ['vitest'],
        rules: {
          // Conformance suites name a `describe` after a manifest path held
          // in a variable; the rule cannot see that it is a string.
          'vitest/valid-title': ['error', { ignoreTypeOfDescribeName: true }],
          'vitest/no-standalone-expect': [
            'error',
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
    // Type-aware linting through oxlint-tsgolint (bundled with Vite+, patched
    // by `effect-tsgo patch --oxlint`), with `typeCheck` so the lint pass also
    // reports type errors. The `check` tasks (native, Effect-patched `tsc`)
    // stay the type gate of record; both read the same tsconfig.json files,
    // so every linted TypeScript file must be in one (hence `bench` in the
    // tsconfigs of the packages that have benchmarks): outside one, tsgolint
    // falls back to default compiler options (no `@types/node`, no
    // `noUncheckedIndexedAccess`) and reports false findings.
    options: {
      typeAware: true,
      typeCheck: true,
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
      // `effect/unstable/*` (removed in rc.118, before the `effect` peer floor).
      // Reads `dist/`, hence the build edges.
      'check:dist': {
        command: 'node scripts/check-dist-imports.mjs',
        dependsOn: packages.map((name) => `${name}#build`),
        cache: false,
      },
      // The whole pipeline, as one task: what `.github/workflows/ci.yml` runs
      // and what to run before pushing. A sequence, not a graph: each gate
      // needs the one before it to have finished (the type gates and the
      // tests are held to two packages at a time, since each is a large
      // native `tsc` program or a suite holding W3C manifests in memory, and
      // the tests need the conformance suites fetched), and the first failure
      // stops it.
      ci: {
        command: [
          'vp check',
          'vp run --concurrency-limit 2 check',
          './scripts/fetch-test-suites.sh',
          'vp run --concurrency-limit 2 -r test:unit',
          'vp run -r build',
          'vp run check:dist',
          'pnpm audit --audit-level high',
        ].join(' && '),
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
