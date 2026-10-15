import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    // Make @effect/vitest use the Vitest bundled with vite-plus.
    server: { deps: { inline: ['@effect/vitest'] } },
  },
  resolve: { alias: { vitest: 'vite-plus/test' } },
  pack: {
    entry: ['src/*.ts'],
    dts: true,
    format: ['esm'],
    sourcemap: true,
  },
});
