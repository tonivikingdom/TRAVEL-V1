import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@travel/application': fileURLToPath(
        new URL('./packages/application/src/index.ts', import.meta.url),
      ),
      '@travel/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@travel/persistence': fileURLToPath(
        new URL('./packages/persistence/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      enabled: false,
    },
    exclude: ['**/dist/**', '**/node_modules/**', '**/*.integration.test.ts'],
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
