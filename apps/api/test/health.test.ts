import type { DependencyHealth } from '@travel/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const apps: Array<ReturnType<typeof buildApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function apiWithDatabase(status: DependencyHealth['status']) {
  const app = buildApi({
    readinessProbe: {
      async check() {
        return {
          name: 'postgresql',
          status,
        };
      },
    },
  });
  apps.push(app);
  return app;
}

describe('health endpoints', () => {
  it('keeps liveness independent from PostgreSQL availability', async () => {
    const response = await apiWithDatabase('UNAVAILABLE').inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'api',
      status: 'UP',
    });
  });

  it('reports ready only after a successful PostgreSQL probe', async () => {
    const response = await apiWithDatabase('READY').inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'api',
      status: 'READY',
      dependencies: [{ name: 'postgresql', status: 'READY' }],
    });
  });

  it('returns 503 rather than a false positive when PostgreSQL is down', async () => {
    const response = await apiWithDatabase('UNAVAILABLE').inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      service: 'api',
      status: 'NOT_READY',
      dependencies: [{ name: 'postgresql', status: 'UNAVAILABLE' }],
    });
  });
});
