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
          // `...(x === undefined ? {} : { x })` is how a vitest option is left
          // unset under `exactOptionalPropertyTypes`.
          'effect/no-conditional-empty-object-spread': 'off',
        },
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
