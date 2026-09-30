import { describe, expect, it } from 'vitest';
import {
  assessGroundTransitOperational,
  type GroundTransitBaseline,
  type GroundTransitObservation,
} from '../src/ground-transit-execution.js';
import {
  isValidResolvedTransitHub,
  resolveExternalTransitHubIdentity,
  resolveExternalExecutionOriginCurrentness,
  type ExternalOriginFact,
} from '../src/external-execution-origin.js';
const now = new Date('2030-10-01T10:00:00Z');
const baseline: GroundTransitBaseline = {
  provider: 'SYNTHETIC',
  mode: 'RAIL',
  serviceClass: 'FIXED_SERVICE',
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
const observation: GroundTransitObservation = {
  provider: 'SYNTHETIC',
  observationIdentity: 'SYNTHETIC_SHORT_TURN',
  fetchedAt: now,
  serviceClass: 'FIXED_SERVICE',
  mode: 'RAIL',
  lineRef: 'line',
  lineName: 'Synthetic line',
  directionRef: 'east',
  directionLabel: 'east',
  boardingHubRef: 'A',
  alightingHubRef: 'D',
  serviceIdentityKey: 'SYNTHETIC_SERVICE',
  scheduledDeparture: baseline.plannedDeparture,
  scheduledArrival: baseline.plannedArrival,
  estimatedDeparture: null,
  estimatedArrival: null,
  actualDeparture: null,
  actualArrival: null,
  departurePlatform: null,
  arrivalPlatform: null,
  serviceStatus: 'ON_TIME',
  alightingTargetServiceability: 'NOT_SERVED',
  currentTerminusRef: 'E',
  operatingToHubRef: 'E',
  currentTerminusLabel: 'Synthetic E',
  headwayMinSeconds: null,
  headwayMaxSeconds: null,
  nextDepartureInSeconds: null,
  minimumTransferSeconds: 0,
};
function resolve(
  obs = observation,
  itineraryHubs: readonly {
    provider: string | null;
    providerHubRef: string | null;
  }[] = [],
) {
  return resolveExternalTransitHubIdentity({
    current: true,
    baseline,
    observation: obs,
    assessment: assessGroundTransitOperational({
      baseline,
      previousObservation: null,
      latestObservation: obs,
      now,
      state: 'PENDING',
      current: true,
      availableAtBoarding: null,
      actualServiceDeparture: null,
      downstreamProtectedDeparture: null,
    }),
    itineraryHubs,
  });
}
const hub = {
  provider: 'SYNTHETIC',
  providerHubRef: 'E',
  canonicalHubRef: 'synthetic:hub:E',
  name: 'Synthetic E',
  latitude: 35,
  longitude: 139,
  timeZone: 'Asia/Tokyo',
};
const origin: ExternalOriginFact = {
  id: 'E',
  status: 'ARRIVED',
  arrivedAt: now,
  departedAt: null,
  invalidatedAt: null,
};
function current(
  overrides: Partial<
    Parameters<typeof resolveExternalExecutionOriginCurrentness>[0]
  > = {},
) {
  return resolveExternalExecutionOriginCurrentness({
    origin,
    origins: [origin],
    executionEvents: [],
    frontierState: 'AT_NODE',
    ...overrides,
  });
}
describe('external transit execution origin policy', () => {
  it.each([
    { currentTerminusRef: 'E', operatingToHubRef: 'E' },
    { currentTerminusRef: 'E', operatingToHubRef: null },
    { currentTerminusRef: null, operatingToHubRef: 'E' },
  ])('resolves only unambiguous structured external terminus %j', (fields) => {
    expect(resolve({ ...observation, ...fields })).toMatchObject({
      status: 'ELIGIBLE',
      providerHubRef: 'E',
    });
  });
  it('refuses conflicting terminus identities', () => {
    expect(resolve({ ...observation, operatingToHubRef: 'F' })).toEqual({
      status: 'UNRESOLVED',
      reason: 'EXTERNAL_HUB_IDENTITY_CONFLICT',
    });
  });
  it('rejects the planned alighting hub', () => {
    expect(
      resolve({
        ...observation,
        currentTerminusRef: 'D',
        operatingToHubRef: 'D',
      }),
    ).toMatchObject({ status: 'NOT_AVAILABLE' });
  });
  it('rejects an exact existing itinerary hub without fuzzy name/coordinate mapping', () => {
    expect(
      resolve(observation, [{ provider: 'SYNTHETIC', providerHubRef: 'E' }]),
    ).toMatchObject({ reason: 'HUB_ALREADY_REPRESENTED_IN_ITINERARY' });
    expect(
      resolve(observation, [{ provider: 'OTHER', providerHubRef: 'E' }]),
    ).toMatchObject({ status: 'ELIGIBLE' });
  });
  it.each(['delay', 'cancellation', 'vehicle-actual'] as const)(
    'does not infer an external user origin from %s',
    (kind) => {
      const obs = {
        ...observation,
        currentTerminusRef: null,
        operatingToHubRef: null,
        alightingTargetServiceability: 'SERVED' as const,
        ...(kind === 'cancellation'
          ? { serviceStatus: 'CANCELLED' as const }
          : kind === 'delay'
            ? { estimatedArrival: new Date(now.getTime() + 7200000) }
            : { actualArrival: now, actualDeparture: now }),
      };
      expect(resolve(obs).status).not.toBe('ELIGIBLE');
      expect(current()).toBe('CURRENT');
    },
  );
  it.each([
    { latitude: 91 },
    { longitude: -181 },
    { latitude: NaN },
    { timeZone: 'Invalid/Zone' },
    { name: '' },
    { providerHubRef: 'F' },
    { provider: 'OTHER' },
    { canonicalHubRef: '' },
  ])('rejects invalid resolver metadata %j', (fields) => {
    expect(
      isValidResolvedTransitHub({ ...hub, ...fields }, 'SYNTHETIC', 'E'),
    ).toBe(false);
  });
  it('accepts complete resolver metadata', () => {
    expect(isValidResolvedTransitHub(hub, 'SYNTHETIC', 'E')).toBe(true);
  });
  it('keeps a confirmed origin current without later user execution', () => {
    expect(current()).toBe('CURRENT');
  });
  it('departed external origin is never current', () => {
    expect(
      current({
        origin: {
          ...origin,
          status: 'DEPARTED',
          departedAt: new Date(now.getTime() + 1000),
        },
      }),
    ).toBe('DEPARTED');
  });
  it('later active durable execution supersedes, undone facts do not', () => {
    const event = {
      occurredAt: new Date(now.getTime() + 1000),
      undoneAt: null,
    };
    expect(current({ executionEvents: [event] })).toBe('SUPERSEDED');
    expect(current({ executionEvents: [{ ...event, undoneAt: now }] })).toBe(
      'CURRENT',
    );
  });
  it('newer external origin supersedes historical departed evidence', () => {
    expect(
      current({
        origin: { ...origin, status: 'INVALIDATED', invalidatedAt: now },
        origins: [
          origin,
          { ...origin, id: 'F', arrivedAt: new Date(now.getTime() + 1000) },
        ],
      }),
    ).toBe('SUPERSEDED');
  });
  it('two ARRIVED origins or inconsistent frontier are CONFLICT', () => {
    expect(current({ origins: [origin, { ...origin, id: 'F' }] })).toBe(
      'CONFLICT',
    );
    expect(current({ frontierState: 'INCONSISTENT' })).toBe('CONFLICT');
  });
  it('a newer completed external visit supersedes the earlier origin', () => {
    const later = new Date(now.getTime() + 1000);
    expect(
      current({
        origins: [
          origin,
          {
            ...origin,
            id: 'F',
            status: 'DEPARTED',
            arrivedAt: later,
            departedAt: later,
          },
        ],
      }),
    ).toBe('SUPERSEDED');
  });
});
