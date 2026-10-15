import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
  pack: {
    entry: ['src/*.ts'],
    dts: true,
    format: ['esm'],
    sourcemap: true,
  },
});
