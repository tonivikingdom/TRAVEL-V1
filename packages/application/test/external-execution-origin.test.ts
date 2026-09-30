import { describe, expect, it } from 'vitest';
import { ExternalExecutionOriginService } from '../src/external-execution-origin-service.js';
import type {
  ExternalOriginContext,
  ExternalOriginRecord,
  GroundTransitHubResolver,
} from '../src/external-execution-origin-ports.js';
const now = new Date('2030-10-01T10:00:00Z');
const hub = {
  provider: 'SYNTHETIC',
  providerHubRef: 'E',
  canonicalHubRef: 'synthetic:hub:E',
  name: 'Synthetic E',
  latitude: 35,
  longitude: 139,
  timeZone: 'Asia/Tokyo',
};
const baseline = {
  provider: 'SYNTHETIC',
  mode: 'RAIL' as const,
  serviceClass: 'FIXED_SERVICE' as const,
  serviceIdentityKey: 'SYNTHETIC_SERVICE',
  lineRef: 'line',
  directionRef: 'east',
  boardingHubRef: 'A',
  alightingHubRef: 'D',
  headwayMinSeconds: null,
  headwayMaxSeconds: null,
  minimumTransferSeconds: 0,
  plannedDeparture: now,
  plannedArrival: new Date(now.getTime() + 3600000),
};
const context: ExternalOriginContext = {
  tripId: 'trip',
  tripVersion: 1,
  itineraryHubs: [],
  origins: [],
  executionEvents: [],
  frontierState: 'NOT_STARTED',
  evidence: {
    id: 'accepted-id',
    identity: 'SYNTHETIC-observation',
    fetchedAt: now,
    factsHash: 'a'.repeat(64),
  },
  leg: {
    id: 'leg',
    tripId: 'trip',
    transportEdgeId: 'edge',
    adoptedRouteId: 'route',
    legIndex: 0,
    provider: 'SYNTHETIC',
    mode: 'RAIL',
    serviceClass: 'FIXED_SERVICE',
    serviceIdentityKey: 'SYNTHETIC_SERVICE',
    baseline,
    state: 'NO_LONGER_FEASIBLE',
    latestFetchedAt: now,
    observationCount: 1,
    deviationCount: 0,
    deviationStartedAt: null,
    current: true,
    latestObservation: {
      ...baseline,
      observationIdentity: 'SYNTHETIC-observation',
      fetchedAt: now,
      lineName: 'Synthetic line',
      directionLabel: 'east',
      scheduledDeparture: baseline.plannedDeparture,
      scheduledArrival: baseline.plannedArrival,
      estimatedDeparture: null,
      estimatedArrival: null,
      actualDeparture: null,
      actualArrival: null,
      nextDepartureInSeconds: null,
      departurePlatform: null,
      arrivalPlatform: null,
      serviceStatus: 'ON_TIME',
      alightingTargetServiceability: 'NOT_SERVED',
      currentTerminusRef: 'E',
      operatingToHubRef: 'E',
    },
  },
};
function service(resolver: GroundTransitHubResolver) {
  return new ExternalExecutionOriginService(
    {
      read: async () => null,
      mutate: async () => {
        throw new Error('Candidate must never write');
      },
    },
    resolver,
    () => now,
  );
}
describe('external origin ephemeral candidate', () => {
  it('does not hide an open origin behind departed history with the same arrival timestamp', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const origin: ExternalOriginRecord = {
      ...hub,
      id: 'current',
      tripId: id,
      kind: 'TRANSIT_HUB',
      status: 'ARRIVED',
      arrivedAt: now,
      departedAt: null,
      invalidatedAt: null,
      sourceAdoptedRouteId: 'route',
      sourceTransportEdgeId: 'edge',
      sourceGroundTransitLegExecutionId: 'leg',
      sourceGroundTransitObservationId: 'accepted-id',
      sourceObservationIdentity: 'SYNTHETIC-observation',
      sourceObservationFetchedAt: now,
      sourceObservationFactsHash: 'a'.repeat(64),
    };
    const subject = new ExternalExecutionOriginService(
      {
        read: async () => ({
          ...context,
          tripId: id,
          origins: [
            { ...origin, id: 'departed', status: 'DEPARTED', departedAt: now },
            origin,
          ],
        }),
        mutate: async () => {
          throw new Error('Read must never write');
        },
      },
      { resolveHub: async () => ({ status: 'UNAVAILABLE' }) },
      () => now,
    );
    expect(
      await subject.get(
        {
          userId: id,
          email: 'synthetic@example.test',
          role: 'USER',
          status: 'ACTIVE',
        },
        id,
        id,
      ),
    ).toMatchObject({
      availability: 'CONFIRMED',
      currentOrigin: { id: 'current', currentness: 'CURRENT' },
    });
  });
  it('canonical hash is deterministic and binds evidence, Trip version and resolved metadata', async () => {
    const subject = service({
      resolveHub: async () => ({ status: 'RESOLVED', hub }),
    });
    const initial = await subject.candidate(context);
    expect(initial.availability).toBe('CONFIRMATION_REQUIRED');
    expect(initial.candidate?.candidateRef).toMatch(/^[a-f0-9]{64}$/u);
    expect(await subject.candidate(context)).toEqual(initial);
    expect(
      (await subject.candidate({ ...context, tripVersion: 2 })).candidate
        ?.candidateRef,
    ).not.toBe(initial.candidate!.candidateRef);
    expect(
      (
        await subject.candidate({
          ...context,
          evidence: { ...context.evidence!, factsHash: 'b'.repeat(64) },
        })
      ).candidate?.candidateRef,
    ).not.toBe(initial.candidate!.candidateRef);
    expect(
      (
        await service({
          resolveHub: async () => ({
            status: 'RESOLVED',
            hub: { ...hub, timeZone: 'Europe/London' },
          }),
        }).candidate(context)
      ).candidate?.candidateRef,
    ).not.toBe(initial.candidate!.candidateRef);
  });
  it.each(['UNAVAILABLE', 'NOT_FOUND', 'AMBIGUOUS'] as const)(
    'keeps %s distinct from recovery',
    async (status) => {
      expect(
        await service({ resolveHub: async () => ({ status }) }).candidate(
          context,
        ),
      ).toEqual({
        availability: 'UNRESOLVED',
        reason: `HUB_RESOLVER_${status}`,
        candidate: null,
      });
    },
  );
  it('does not resolve labels without accepted observation evidence', async () => {
    let calls = 0;
    expect(
      await service({
        resolveHub: async () => {
          calls++;
          return { status: 'RESOLVED', hub };
        },
      }).candidate({ ...context, evidence: null }),
    ).toMatchObject({ availability: 'UNRESOLVED', candidate: null });
    expect(calls).toBe(0);
  });
});
