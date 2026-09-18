import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createPostgresReadiness } from '../src/index.js';

const connectionString = process.env.TEST_DATABASE_URL;

if (connectionString === undefined || connectionString.trim() === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for the PostgreSQL integration test',
  );
}

const applicationName = 'travel-v1-r1-readiness-test';
const backgroundErrors: Array<{ readonly name: string }> = [];
const managedProbe = createPostgresReadiness(connectionString, {
  applicationName,
  onBackgroundError: (error) => {
    backgroundErrors.push(error);
  },
});
const adminPool = new Pool({
  connectionString,
  application_name: 'travel-v1-r1-admin-test',
});

afterAll(async () => {
  await managedProbe.close();
  await adminPool.end();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('PostgreSQL readiness integration', () => {
  it('executes a real SELECT against PostgreSQL', async () => {
    await expect(managedProbe.probe.check()).resolves.toEqual({
      name: 'postgresql',
      status: 'READY',
    });
  });

  it('handles a terminated idle connection and reconnects without an uncaught error', async () => {
    await expect(managedProbe.probe.check()).resolves.toEqual({
      name: 'postgresql',
      status: 'READY',
    });

    const terminated = await adminPool.query<{ readonly terminated: boolean }>(
      `
        SELECT pg_terminate_backend(pid) AS terminated
        FROM pg_stat_activity
        WHERE application_name = $1
          AND pid <> pg_backend_pid()
      `,
      [applicationName],
    );

    expect(terminated.rows.some((row) => row.terminated)).toBe(true);
    await waitFor(() => backgroundErrors.length > 0);
    expect(backgroundErrors[0]?.name).toEqual(expect.any(String));

    await expect(managedProbe.probe.check()).resolves.toEqual({
      name: 'postgresql',
      status: 'READY',
    });
  });
});
