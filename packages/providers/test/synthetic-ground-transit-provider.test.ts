import { describe, expect, it } from 'vitest';

import type { GroundTransitLegRecord } from '@travel/application';

import {
  createGroundTransitProvider,
  SyntheticGroundTransitProvider,
} from '../src/synthetic-ground-transit-provider.js';

const now = new Date('2030-01-10T10:00:00Z');
const leg: GroundTransitLegRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  tripId: '00000000-0000-4000-8000-000000000002',
  transportEdgeId: '00000000-0000-4000-8000-000000000003',
  adoptedRouteId: '00000000-0000-4000-8000-000000000004',
  legIndex: 0,
  provider: 'SYNTHETIC',
  mode: 'RAIL',
  serviceClass: 'FIXED_SERVICE',
  serviceIdentityKey: 'synthetic:service-1',
  state: 'PENDING',
  baseline: {
    provider: 'SYNTHETIC',
    mode: 'RAIL',
    serviceClass: 'FIXED_SERVICE',
    serviceIdentityKey: 'synthetic:service-1',
    lineRef: 'line',
    directionRef: 'east',
    boardingHubRef: 'a',
    alightingHubRef: 'b',
    headwayMinSeconds: null,
    headwayMaxSeconds: null,
    minimumTransferSeconds: 300,
    plannedDeparture: new Date('2030-01-10T10:20:00Z'),
    plannedArrival: new Date('2030-01-10T11:00:00Z'),
  },
  latestObservation: null,
  latestFetchedAt: null,
  observationCount: 0,
  current: true,
  deviationCount: 0,
  deviationStartedAt: null,
};

describe('synthetic ground transit provider safety', () => {
  it('rejects synthetic provider outside Dev/Test even with CI flag', () => {
    expect(() =>
      createGroundTransitProvider({
        APP_ENV: 'production',
        SYNTHETIC_CI_ONLY: 'true',
        GROUND_TRANSIT_SYNTHETIC_SCENARIO: 'ON_TIME',
      }),
    ).toThrow(/Dev\/Test/u);
    expect(() =>
      createGroundTransitProvider({
        APP_ENV: 'test',
        GROUND_TRANSIT_SYNTHETIC_SCENARIO: 'ON_TIME',
      }),
    ).toThrow(/SYNTHETIC_CI_ONLY/u);
  });

  it('fails the first call and lets a durable retry fetch the same adopted service', async () => {
    const provider = new SyntheticGroundTransitProvider(
      'FAIL_FIRST',
      () => now,
    );
    expect(await provider.fetchObservation({ leg })).toEqual({
      status: 'UNAVAILABLE',
    });
    const retry = await provider.fetchObservation({ leg });
    expect(retry).toMatchObject({
      status: 'SUCCESS',
      observation: {
        provider: 'SYNTHETIC',
        serviceIdentityKey: 'synthetic:service-1',
        serviceClass: 'FIXED_SERVICE',
      },
    });
  });

  it('keeps identity mismatch explicit and never writes a guessed service', async () => {
    const provider = new SyntheticGroundTransitProvider(
      'IDENTITY_MISMATCH',
      () => now,
    );
    const result = await provider.fetchObservation({ leg });
    expect(result).toMatchObject({
      status: 'SUCCESS',
      observation: {
        serviceIdentityKey: 'synthetic:other-service',
      },
    });
  });

  it('returns the same normalized observation for deterministic replay', async () => {
    const provider = new SyntheticGroundTransitProvider(
      'REPLAY_SAME',
      () => now,
    );
    const first = await provider.fetchObservation({ leg });
    const replay = await provider.fetchObservation({ leg });
    expect(first).toMatchObject({ status: 'SUCCESS' });
    expect(replay).toEqual(first);
  });

  it('replays the same two-minute next-departure fact without advancing its identity', async () => {
    const provider = new SyntheticGroundTransitProvider(
      'NEXT_DEPARTURE_2',
      () => now,
    );
    const first = await provider.fetchObservation({ leg });
    const replay = await provider.fetchObservation({ leg });
    expect(first).toMatchObject({
      status: 'SUCCESS',
      observation: { nextDepartureInSeconds: 120 },
    });
    expect(replay).toEqual(first);
  });

  it('does not expose a synthetic provider when unconfigured', async () => {
    const provider = createGroundTransitProvider({ APP_ENV: 'production' });
    expect(await provider.fetchObservation({ leg })).toEqual({
      status: 'UNAVAILABLE',
    });
  });

  it('provides normalized cancellation, short-turn and correction fixtures without a paid provider', async () => {
    const outcomes = await Promise.all(
      (['CANCEL_FIXED', 'SHORT_TURN', 'RECOVERY'] as const).map(
        async (scenario) =>
          new SyntheticGroundTransitProvider(
            scenario,
            () => now,
          ).fetchObservation({ leg }),
      ),
    );
    expect(outcomes[0]).toMatchObject({
      status: 'SUCCESS',
      observation: {
        serviceStatus: 'CANCELLED',
        serviceIdentityKey: 'synthetic:service-1',
      },
    });
    expect(outcomes[1]).toMatchObject({
      status: 'SUCCESS',
      observation: {
        alightingTargetServiceability: 'NOT_SERVED',
        currentTerminusRef: 'synthetic:short-terminus',
      },
    });
    expect(outcomes[2]).toMatchObject({
      status: 'SUCCESS',
      observation: {
        serviceStatus: 'ON_TIME',
        alightingTargetServiceability: 'SERVED',
      },
    });
  });
});
