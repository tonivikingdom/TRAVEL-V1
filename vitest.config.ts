import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    exclude: ['**/dist/**', '**/node_modules/**', '**/*.integration.test.ts'],
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
