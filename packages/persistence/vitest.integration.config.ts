import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../vitest.workspace-aliases.js';

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
  },
});
