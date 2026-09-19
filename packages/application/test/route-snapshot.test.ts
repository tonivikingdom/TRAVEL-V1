import { describe, expect, it } from 'vitest';

import type { RouteCandidatePayload } from '../src/route-planning-ports.js';
import {
  hashRouteAdoptionRequest,
  hashRouteCandidateSnapshot,
} from '../src/route-snapshot.js';

const basis = {
  tripId: '00000000-0000-4000-8000-000000000001',
  previewId: '00000000-0000-4000-8000-000000000002',
  baseTripVersion: 7,
} as const;

describe('route adoption request hashing', () => {
  it('keeps an empty P5C adjustment list compatible with legacy adoption retries', () => {
    expect(
      hashRouteAdoptionRequest({ ...basis, acceptedUserAdjustments: [] }),
    ).toBe(hashRouteAdoptionRequest(basis));
  });

  it('binds an accepted user dwell adjustment into the idempotency hash', () => {
    expect(
      hashRouteAdoptionRequest({
        ...basis,
        acceptedUserAdjustments: [
          {
            intentId: '00000000-0000-4000-8000-000000000003',
            nodeId: '00000000-0000-4000-8000-000000000004',
            fromDurationSeconds: 3_000,
            toDurationSeconds: 2_700,
          },
        ],
      }),
    ).not.toBe(hashRouteAdoptionRequest(basis));
  });
});

describe('route candidate canonical hashing', () => {
  it('excludes internal recommendation metadata from provider candidate identity', () => {
    const candidatePayload = routeCandidatePayload();
    const hash = hashRouteCandidateSnapshot({
      tripId: basis.tripId,
      basisVersion: basis.baseTripVersion,
      fromNodeId: basis.previewId,
      toNodeId: '00000000-0000-4000-8000-000000000005',
      provider: 'SYNTHETIC',
      observedAt: '2030-01-01T00:00:00.000Z',
      candidatePayload,
    });
    expect(
      hashRouteCandidateSnapshot({
        tripId: basis.tripId,
        basisVersion: basis.baseTripVersion,
        fromNodeId: basis.previewId,
        toNodeId: '00000000-0000-4000-8000-000000000005',
        provider: 'SYNTHETIC',
        observedAt: '2030-01-01T00:00:00.000Z',
        candidatePayload: {
          ...candidatePayload,
          planningAssessment: {
            effectiveTotalTimeSeconds: 99_999,
            requiresUserAdjustment: true,
            requiredUserAdjustments: [],
            softDeviations: ['SYSTEM_SUGGESTED_DWELL'],
          },
        },
      }),
    ).toBe(hash);
    expect(
      hashRouteCandidateSnapshot({
        tripId: basis.tripId,
        basisVersion: basis.baseTripVersion,
        fromNodeId: basis.previewId,
        toNodeId: '00000000-0000-4000-8000-000000000005',
        provider: 'SYNTHETIC',
        observedAt: '2030-01-01T00:00:00.000Z',
        candidatePayload: {
          ...candidatePayload,
          overall: {
            ...candidatePayload.overall,
            durationSeconds: candidatePayload.overall.durationSeconds + 1,
          },
        },
      }),
    ).not.toBe(hash);
  });
});

function routeCandidatePayload(): RouteCandidatePayload {
  const departure = { instant: '2030-01-01T10:00:00.000Z', timeZone: 'UTC' };
  const arrival = { instant: '2030-01-01T11:00:00.000Z', timeZone: 'UTC' };
  const from = {
    name: 'A',
    latitude: 1,
    longitude: 1,
    providerPlaceRef: 'a',
    providerHubRef: null,
  };
  const to = {
    name: 'B',
    latitude: 2,
    longitude: 2,
    providerPlaceRef: 'b',
    providerHubRef: null,
  };
  return {
    candidateId: 'candidate',
    provider: 'SYNTHETIC',
    providerCandidateRef: 'provider-candidate',
    observedAt: '2030-01-01T00:00:00.000Z',
    validUntil: null,
    queryBasisVersion: 7,
    queryTimeCondition: {
      hardEarliestDeparture: null,
      hardLatestArrival: null,
      planningEarliestDeparture: null,
      earliestDeparture: departure.instant,
      latestArrival: null,
      lookbackSeconds: 900,
      preference: { type: 'NONE' },
      hint: null,
    },
    overall: { departure, arrival, durationSeconds: 3_600 },
    legs: [
      {
        mode: 'RAIL',
        from,
        to,
        departure,
        arrival,
        durationSeconds: 3_600,
        fixedService: false,
        serviceLabel: null,
        providerRef: 'leg',
      },
    ],
    fare: null,
    planningAssessment: {
      effectiveTotalTimeSeconds: 3_600,
      requiresUserAdjustment: false,
      requiredUserAdjustments: [],
      softDeviations: [],
    },
  };
}
