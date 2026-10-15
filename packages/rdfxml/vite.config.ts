import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  pack: {
    entry: ['src/*.ts'],
    dts: true,
    format: ['esm'],
    sourcemap: true,
  },
});
