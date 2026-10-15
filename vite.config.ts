import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    cache: true,
  },
  fmt: {
    singleQuote: true,
    semi: true,
    printWidth: 100,
    ignorePatterns: ['**/dist/**', '**/test/fixtures/**', 'pnpm-lock.yaml'],
  },
  lint: {
    ignorePatterns: ['**/dist/**', '**/test/fixtures/**'],
    plugins: ['typescript'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'no-console': 'error',
    },
    overrides: [
      {
        files: ['**/*.test.ts'],
        plugins: ['vitest'],
        rules: {
          'typescript/no-explicit-any': 'off',
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
  },
  test: {
    projects: ['packages/*'],
  },
});
