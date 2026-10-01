import { describe, expect, it } from 'vitest';
import type { RouteCandidatePayload } from '../src/route-planning-ports.js';
import type { ExternalRouteOriginSnapshot } from '@travel/contracts';
import {
  hashRouteCandidateSnapshot,
  hashExternalRouteCandidateSnapshot,
} from '../src/route-snapshot.js';
const legacy = {
  tripId: 'SYNTHETIC_TRIP',
  basisVersion: 4,
  fromNodeId: 'A',
  toNodeId: 'D',
  provider: 'SYNTHETIC',
  observedAt: '2030-01-01T00:00:00.000Z',
  candidatePayload: {
    candidateId: 'legacy-1',
    provider: 'SYNTHETIC',
    planningAssessment: { requiresUserAdjustment: false },
    fare: null,
  } as unknown as RouteCandidatePayload,
};
const origin: ExternalRouteOriginSnapshot = {
  schema: 'external-route-origin-v1',
  externalOriginId: 'E',
  provider: 'SYNTHETIC',
  providerHubRef: 'E',
  canonicalHubRef: 'synthetic:E',
  name: 'Synthetic E',
  latitude: 35,
  longitude: 139,
  timeZone: 'Asia/Tokyo',
  arrivedAt: '2030-01-01T00:00:00.000Z',
  sourceAdoptedRouteId: 'R1',
  sourceTransportEdgeId: 'BC',
  sourceGroundTransitLegExecutionId: 'LEG',
  sourceGroundTransitObservationId: 'OBS',
  sourceObservationIdentity: 'OBS_ID',
  sourceObservationFetchedAt: '2030-01-01T00:00:00.000Z',
  sourceObservationFactsHash: 'a'.repeat(64),
};
describe('node hash compatibility and external hash separation', () => {
  it('preserves a fixed digest produced by the Batch 5A hash algorithm', () =>
    expect(hashRouteCandidateSnapshot(legacy)).toBe(
      '8973d3715937f73476b549a85eb089c9551331bcc9639250e58af418cfa0493b',
    ));
  it('external hash is deterministic, key-order independent, and binds execution evidence', () => {
    const { fromNodeId: _node, ...basis } = legacy;
    void _node;
    const input = { ...basis, externalOriginSnapshot: origin };
    expect(hashExternalRouteCandidateSnapshot(input)).toBe(
      hashExternalRouteCandidateSnapshot({
        ...input,
        externalOriginSnapshot: Object.fromEntries(
          Object.entries(origin).reverse(),
        ) as unknown as ExternalRouteOriginSnapshot,
      }),
    );
    expect(hashExternalRouteCandidateSnapshot(input)).not.toBe(
      hashExternalRouteCandidateSnapshot({
        ...input,
        externalOriginSnapshot: {
          ...origin,
          sourceObservationFactsHash: 'b'.repeat(64),
        },
      }),
    );
    expect(hashExternalRouteCandidateSnapshot(input)).not.toBe(
      hashRouteCandidateSnapshot(legacy),
    );
  });
});
