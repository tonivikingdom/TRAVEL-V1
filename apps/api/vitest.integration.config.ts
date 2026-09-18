import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@travel/application': fileURLToPath(
        new URL('../../packages/application/src/index.ts', import.meta.url),
      ),
      '@travel/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
      '@travel/persistence': fileURLToPath(
        new URL('../../packages/persistence/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 1,
  },
});
