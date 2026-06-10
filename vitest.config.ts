import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'shared/test/**/*.test.ts',
      'agents/**/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['shared/src/**/*.ts', 'agents/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/dist/**'],
      thresholds: {
        statements: 40,
        branches: 35,
        functions: 40,
        lines: 40,
      },
    },
  },
});
