/**
 * The one Vite+ configuration every package in this workspace shares: the
 * task graph (`check`, `build`, `test:unit`, `test:coverage`), the `vp pack`
 * (tsdown) settings and the vitest / coverage settings. Each
 * `packages/<name>/vite.config.ts` is a one-call instantiation of it.
 *
 * Shaped after the effect-web library's `vite.package.ts`, with one
 * deliberate difference: here a package's development `exports` point at
 * `src/*.ts` (its `publishConfig.exports` at `dist/`), so a sibling package
 * is consumed from source and no task needs a build edge first.
 */
import { defineConfig } from 'vite-plus';

/** What differs per package. */
export interface PackageConfigOptions {
  /**
   * Per-test timeout in milliseconds. The conformance suites run thousands
   * of manifest entries inside one test, hence the long default.
   */
  readonly testTimeout?: number | undefined;
  /**
   * The tsconfig `vp pack` declares types with, when `tsconfig.json` (which
   * also covers `test/`) pulls in more than the published sources should.
   */
  readonly packTsconfig?: string | undefined;
}

/**
 * Input fingerprint for a package's cached tasks: auto tracking minus
 * node_modules bookkeeping churn (pnpm rewrites `.modules.yaml` on every
 * install), with the lockfile back explicitly so a dependency upgrade still
 * invalidates a type-check or a test run.
 */
const cacheInputs = [
  { auto: true },
  '!node_modules/**',
  '!coverage/**',
  { pattern: '!node_modules/**', base: 'workspace' as const },
  { pattern: 'pnpm-lock.yaml', base: 'workspace' as const },
];

export const packageConfig = ({
  testTimeout = 60_000,
  packTsconfig,
}: PackageConfigOptions = {}) => {
  const maxWorkers = process.env.VITEST_MAX_WORKERS;
  return defineConfig({
    run: {
      tasks: {
        // `src`, `test` and this config under the native, Effect-patched `tsc`.
        check: {
          command: 'tsc -p tsconfig.json',
          cache: { input: cacheInputs, output: [] },
        },
        // The published artifact: one ESM module + declaration file per
        // `src/*.ts` (the `./*` export), via `vp pack` → tsdown.
        build: {
          command: 'vp pack',
          cache: { input: cacheInputs, output: ['dist/**'] },
        },
        // Never cached: the conformance suites read `RDF_TEST_SUITES`
        // (default `<repo>/.test-suites`, fetched by
        // `scripts/fetch-test-suites.sh`) and skip when it is absent, and a
        // directory outside the package is not part of any task fingerprint,
        // so a cached pass without the suites would mask a run with them.
        'test:unit': {
          command: 'vp test run',
          cache: false,
        },
        'test:coverage': {
          command: 'vp test run --coverage',
          cache: false,
        },
      },
    },
    pack: {
      entry: ['src/*.ts'],
      dts: true,
      format: ['esm'],
      sourcemap: true,
      ...(packTsconfig === undefined ? {} : { tsconfig: packTsconfig }),
    },
    test: {
      include: ['test/**/*.test.ts'],
      testTimeout,
      ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
      coverage: {
        provider: 'istanbul',
        // `json` writes coverage-final.json, the Istanbul map `fallow audit`
        // reads for exact per-function CRAP scores.
        reporter: ['text-summary', 'json-summary', 'json'],
        reportsDirectory: './coverage',
        include: ['src/**/*.ts'],
        exclude: ['**/*.d.ts'],
      },
    },
  });
};
