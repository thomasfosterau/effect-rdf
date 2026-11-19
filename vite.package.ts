/**
 * The Vite+ config every package shares (tasks, `vp pack`, vitest); each
 * `packages/<name>/vite.config.ts` instantiates it. Development `exports`
 * point at `src/`, so siblings are consumed from source and no task needs a
 * build first.
 */
import { defineConfig } from 'vite-plus';

export interface PackageConfigOptions {
  /** Per-test timeout in ms: a conformance suite runs a whole manifest in one test. */
  readonly testTimeout?: number;
  /** Nested subpaths (`src/<name>/*.ts`) built beside the flat `src/*.ts` entries. */
  readonly subpaths?: ReadonlyArray<string>;
  /** Extra uncached tasks (benchmarks). */
  readonly tasks?: Readonly<Record<string, { readonly command: string }>>;
}

// Auto tracking minus pnpm's node_modules bookkeeping, with the lockfile back
// so a dependency upgrade still invalidates the cache.
const cacheInputs = [
  { auto: true },
  '!node_modules/**',
  '!coverage/**',
  { pattern: '!node_modules/**', base: 'workspace' as const },
  { pattern: 'pnpm-lock.yaml', base: 'workspace' as const },
];

export const packageConfig = ({
  testTimeout = 60_000,
  subpaths = [],
  tasks = {},
}: PackageConfigOptions = {}) => {
  const maxWorkers = process.env.VITEST_MAX_WORKERS;
  return defineConfig({
    run: {
      tasks: {
        check: {
          command: 'tsc -p tsconfig.json',
          cache: { input: cacheInputs, output: [] },
        },
        build: {
          command: 'vp pack',
          cache: { input: cacheInputs, output: ['dist/**'] },
        },
        // Never cached: the conformance suites read `RDF_TEST_SUITES` (default
        // `<repo>/.test-suites`), which is outside every task fingerprint.
        'test:unit': {
          command: 'vp test run',
          cache: false,
        },
        'test:coverage': {
          command: 'vp test run --coverage',
          cache: false,
        },
        ...Object.fromEntries(
          Object.entries(tasks).map(([name, { command }]) => [name, { command, cache: false }]),
        ),
      },
    },
    pack: {
      entry: ['src/*.ts', ...subpaths.map((name) => `src/${name}/*.ts`)],
      dts: true,
      format: ['esm'],
      sourcemap: true,
    },
    test: {
      include: ['test/**/*.test.ts'],
      testTimeout,
      ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
      coverage: {
        provider: 'istanbul',
        reporter: ['text-summary', 'json-summary', 'json'],
        reportsDirectory: './coverage',
        include: ['src/**/*.ts'],
        exclude: ['**/*.d.ts'],
      },
    },
  });
};
