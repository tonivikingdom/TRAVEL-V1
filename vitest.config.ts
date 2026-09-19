import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from './vitest.workspace-aliases.js';

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    coverage: {
      enabled: false,
    },
    exclude: ['**/dist/**', '**/node_modules/**', '**/*.integration.test.ts'],
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
  },
});
