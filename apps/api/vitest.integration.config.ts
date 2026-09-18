import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../vitest.workspace-aliases.js';

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 1,
  },
});
