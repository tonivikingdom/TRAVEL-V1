import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../../vitest.workspace-aliases.js';
export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: { include: ['test/**/*.test.ts'], testTimeout: 10_000 },
});
