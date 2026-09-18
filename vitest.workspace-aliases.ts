import { fileURLToPath } from 'node:url';

/**
 * Keep Vitest pointed at workspace source so tests can run before any package
 * has been built. Runtime package exports intentionally remain dist-based.
 */
export const workspaceSourceAliases = {
  '@travel/application': fileURLToPath(
    new URL('./packages/application/src/index.ts', import.meta.url),
  ),
  '@travel/contracts': fileURLToPath(
    new URL('./packages/contracts/src/index.ts', import.meta.url),
  ),
  '@travel/persistence': fileURLToPath(
    new URL('./packages/persistence/src/index.ts', import.meta.url),
  ),
};
