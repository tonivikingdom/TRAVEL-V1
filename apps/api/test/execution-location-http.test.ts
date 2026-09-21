import type {
  AuthService,
  ExecutionLocationService,
} from '@travel/application';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApi } from '../src/app.js';

const userId = '00000000-0000-4000-8000-000000000061';
const tripId = '10000000-0000-4000-8000-000000000061';
const nodeId = '40000000-0000-4000-8000-000000000061';
const eventId = '80000000-0000-4000-8000-000000000061';
const apps: Array<ReturnType<typeof buildApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('P5E1 execution-location HTTP surface', () => {
  it('passes a location sample to the authenticated execution service', async () => {
    const observeLocation = vi.fn(async () => ({
      status: 'NO_CHANGE' as const,
      event: null,
      resultingTripVersion: 3,
      confirmationRecommended: false,
      airportTriggerAttempted: false,
    }));
    const app = api({ observeLocation });
    const payload = {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
      speedMetersPerSecond: 2,
      headingDegrees: 90,
    };
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${tripId}/execution/location`,
      headers: bearer(),
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(observeLocation).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      tripId,
      payload,
    );
  });

  it('passes only the server event path and typed manual request boundary', async () => {
    const createManualEvent = vi.fn(async () => ({
      event: { id: eventId },
      resultingTripVersion: 4,
      idempotentReplay: false,
      airportTriggerAttempted: false,
    }));
    const app = api({ createManualEvent });
    const payload = {
      baseTripVersion: 3,
      idempotencyKey: 'manual-1',
      type: 'MANUAL_ARRIVAL',
      nodeId,
      occurredAt: '2030-01-01T10:00:00.000Z',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/trips/${tripId}/execution/events`,
          headers: bearer(),
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(createManualEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      tripId,
      payload,
    );
  });

  it('uses the path event ID for explicit undo', async () => {
    const undoEvent = vi.fn(async () => ({
      event: { id: eventId },
      resultingTripVersion: 5,
      idempotentReplay: false,
    }));
    const app = api({ undoEvent });
    const payload = { baseTripVersion: 4, idempotencyKey: 'undo-1' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/trips/${tripId}/execution/events/${eventId}/undo`,
          headers: bearer(),
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(undoEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      tripId,
      eventId,
      payload,
    );
  });

  it('returns the owner-scoped execution context', async () => {
    const getExecution = vi.fn(async () => ({
      tripId,
      tripVersion: 3,
      currentNodeId: null,
      targetNodeId: nodeId,
      currentState: 'NOT_STARTED' as const,
      frontierConflict: null,
      latestArrival: null,
      latestDeparture: null,
      possibleSkippedNodeIds: [],
      confirmedSkippedNodeIds: [],
      locationStatus: 'NO_SAMPLE' as const,
      activeRisks: [],
    }));
    const app = api({ getExecution });
    const response = await app.inject({
      method: 'GET',
      url: `/trips/${tripId}/execution`,
      headers: bearer(),
    });
    expect(response.statusCode).toBe(200);
    expect(getExecution).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      tripId,
    );
  });
});

function api(methods: Record<string, ReturnType<typeof vi.fn>>) {
  const app = buildApi({
    readinessProbe: {
      async check() {
        return { name: 'postgresql', status: 'READY' };
      },
    },
    authService: {
      authenticate: vi.fn(async () => ({
        actor: {
          userId,
          email: 'owner@synthetic.example.test',
          role: 'USER',
          status: 'ACTIVE',
        },
        user: {
          id: userId,
          email: 'owner@synthetic.example.test',
          role: 'USER',
          status: 'ACTIVE',
          preferences: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' },
        },
        sessionDigest: 'digest',
      })),
    } as unknown as AuthService,
    executionLocationService: methods as unknown as ExecutionLocationService,
  });
  apps.push(app);
  return app;
}

function bearer() {
  return { authorization: 'Bearer synthetic' };
}
