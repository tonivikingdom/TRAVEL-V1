import { describe, expect, it } from 'vitest';

import { createWorkerHeartbeat } from '../src/heartbeat.js';

describe('createWorkerHeartbeat', () => {
  it('is ready only when PostgreSQL is ready', () => {
    expect(
      createWorkerHeartbeat(
        { name: 'postgresql', status: 'READY' },
        new Date('2026-09-17T00:00:00.000Z'),
      ),
    ).toEqual({
      service: 'worker',
      status: 'READY',
      observedAt: '2026-09-17T00:00:00.000Z',
      dependencies: [{ name: 'postgresql', status: 'READY' }],
    });
  });

  it('does not conceal missing database configuration', () => {
    expect(
      createWorkerHeartbeat(
        { name: 'postgresql', status: 'MISCONFIGURED' },
        new Date('2026-09-17T00:00:00.000Z'),
      ).status,
    ).toBe('NOT_READY');
  });
});
