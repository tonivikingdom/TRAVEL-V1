import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresReadiness } from '../src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;

if (connectionString === undefined || connectionString.trim() === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for the PostgreSQL integration test',
  );
}

const managedProbe = createPostgresReadiness(connectionString);

afterAll(async () => {
  await managedProbe.close();
});

describe('PostgreSQL readiness integration', () => {
  it('executes a real SELECT against PostgreSQL', async () => {
    await expect(managedProbe.probe.check()).resolves.toEqual({
      name: 'postgresql',
      status: 'READY',
    });
  });
});
