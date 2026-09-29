import { describe, expect, it } from 'vitest';

import {
  assessGroundTransitOperational,
  type GroundTransitBaseline,
  type GroundTransitObservation,
} from '../src/ground-transit-execution.js';

const at = (minute: number) => new Date(Date.UTC(2030, 0, 10, 10, minute));
const baseline: GroundTransitBaseline = {
  provider: 'SYNTHETIC',
  mode: 'RAIL',
  serviceClass: 'FIXED_SERVICE',
  serviceIdentityKey: 'service-1',
  lineRef: 'line-1',
  directionRef: 'east',
  boardingHubRef: 'A',
  alightingHubRef: 'D',
  headwayMinSeconds: null,
  headwayMaxSeconds: null,
  minimumTransferSeconds: 300,
  boardingAccessMinimumSeconds: 0,
  plannedDeparture: at(25),
  plannedArrival: at(55),
};
const normal: GroundTransitObservation = {
  provider: 'SYNTHETIC',
  observationIdentity: 'one',
  fetchedAt: at(10),
  serviceClass: 'FIXED_SERVICE',
  mode: 'RAIL',
  lineRef: 'line-1',
  lineName: null,
  directionRef: 'east',
  directionLabel: null,
  boardingHubRef: 'A',
  alightingHubRef: 'D',
  serviceIdentityKey: 'service-1',
  scheduledDeparture: at(25),
  scheduledArrival: at(55),
  estimatedDeparture: null,
  estimatedArrival: null,
  actualDeparture: null,
  actualArrival: null,
  departurePlatform: null,
  arrivalPlatform: null,
  serviceStatus: 'ON_TIME',
  boardingTargetServiceability: 'SERVED',
  alightingTargetServiceability: 'SERVED',
  currentTerminusRef: 'D',
  headwayMinSeconds: null,
  headwayMaxSeconds: null,
  nextDepartureInSeconds: null,
  minimumTransferSeconds: null,
};

function assess(
  latest: GroundTransitObservation | null,
  overrides: Partial<Parameters<typeof assessGroundTransitOperational>[0]> = {},
) {
  return assessGroundTransitOperational({
    baseline,
    previousObservation: null,
    latestObservation: latest,
    now: at(11),
    state: 'PENDING',
    current: true,
    availableAtBoarding: at(10),
    actualServiceDeparture: null,
    downstreamProtectedDeparture: null,
    ...overrides,
  });
}

describe('ground transit operational facts', () => {
  it('applies one identity-matched cancellation without GPS hysteresis', () => {
    const result = assess({ ...normal, serviceStatus: 'CANCELLED' });
    expect(result).toMatchObject({
      disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
      requiredAction: 'ROUTE_REEVALUATION_REQUIRED',
      requiresUserAttention: true,
      notificationPriority: 'STRONG',
    });
    expect(result.changeKinds).toContain('SERVICE_CANCELLED');
  });

  it('distinguishes feasible and missed early departure without replacing the service', () => {
    const early = { ...normal, estimatedDeparture: at(18) };
    expect(assess(early).disposition).toBe('CURRENT_PLAN_AT_RISK');
    expect(assess(early).changeKinds).toContain('EARLY_DEPARTURE');
    expect(assess(early, { availableAtBoarding: at(20) })).toMatchObject({
      disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
      requiredAction: 'ROUTE_REEVALUATION_REQUIRED',
    });
  });

  it('keeps a minor delay silent and uses service/context-dependent materiality', () => {
    const minor = assess({ ...normal, estimatedArrival: at(58) });
    expect(minor.changeKinds).not.toContain('MATERIAL_DELAY');
    expect(minor.requiresUserAttention).toBe(false);
    const delayed = { ...normal, estimatedArrival: at(64) };
    expect(assess(delayed).changeKinds).toContain('MATERIAL_DELAY');
    const farBaseline = {
      ...baseline,
      plannedDeparture: new Date('2030-01-10T14:25:00Z'),
      plannedArrival: new Date('2030-01-10T14:55:00Z'),
    };
    const farObservation = {
      ...delayed,
      estimatedArrival: new Date('2030-01-10T15:04:00Z'),
    };
    expect(
      assess(farObservation, { baseline: farBaseline }).requiresUserAttention,
    ).toBe(false);
    expect(
      assess(delayed, { downstreamProtectedDeparture: at(65) })
        .requiresUserAttention,
    ).toBe(true);
  });

  it('makes a platform change silent far away but visible in the execution window', () => {
    const changed = { ...normal, departurePlatform: '5' };
    const previousObservation = { ...normal, departurePlatform: '2' };
    expect(assess(changed, { previousObservation }).changeKinds).toContain(
      'DEPARTURE_PLATFORM_CHANGED',
    );
    expect(assess(changed, { previousObservation }).requiresUserAttention).toBe(
      true,
    );
    expect(
      assess(changed, {
        previousObservation,
        baseline: {
          ...baseline,
          plannedDeparture: new Date('2030-01-10T14:25:00Z'),
        },
      }).requiresUserAttention,
    ).toBe(false);
  });

  it('treats a skipped adopted destination and short turn as goal failure', () => {
    const result = assess({
      ...normal,
      alightingTargetServiceability: 'NOT_SERVED',
      currentTerminusRef: 'C',
    });
    expect(result.changeKinds).toEqual(
      expect.arrayContaining([
        'ALIGHTING_TARGET_NO_LONGER_SERVED',
        'SERVICE_SHORT_TURNED',
      ]),
    );
    expect(result.targetServiceability.alighting).toBe('NOT_SERVED');
    expect(result.disposition).toBe('CURRENT_PLAN_NO_LONGER_FEASIBLE');
  });

  it('retains delay, platform and target-loss facts in one classification', () => {
    const result = assess(
      {
        ...normal,
        serviceStatus: 'DELAYED',
        estimatedArrival: at(72),
        departurePlatform: '5',
        alightingTargetServiceability: 'NOT_SERVED',
        currentTerminusRef: 'C',
      },
      {
        previousObservation: { ...normal, departurePlatform: '2' },
        downstreamProtectedDeparture: at(75),
      },
    );
    expect(result.changeKinds).toEqual(
      expect.arrayContaining([
        'MATERIAL_DELAY',
        'DEPARTURE_PLATFORM_CHANGED',
        'ALIGHTING_TARGET_NO_LONGER_SERVED',
        'SERVICE_SHORT_TURNED',
        'TERMINUS_CHANGED',
      ]),
    );
    expect(result.notificationPriority).toBe('STRONG');
    expect(result.requiredAction).toBe('ROUTE_REEVALUATION_REQUIRED');
  });

  it('allows trusted correction but not reversal of a persisted actual miss', () => {
    const cancelled = { ...normal, serviceStatus: 'CANCELLED' as const };
    expect(
      assess(normal, {
        previousObservation: cancelled,
        state: 'NO_LONGER_FEASIBLE',
      }),
    ).toMatchObject({
      disposition: 'CONTINUE_CURRENT_PLAN',
      changeKinds: ['SERVICE_RESTORED'],
    });
    const missed = assess(normal, {
      previousObservation: cancelled,
      state: 'NO_LONGER_FEASIBLE',
      actualServiceDeparture: at(15),
      availableAtBoarding: at(20),
    });
    expect(missed).toMatchObject({
      disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
      irreversibleActualMiss: true,
    });
    expect(missed.changeKinds).not.toContain('SERVICE_RESTORED');
  });

  it('does not let a replaced route or completed leg create a current decision', () => {
    expect(
      assess({ ...normal, serviceStatus: 'CANCELLED' }, { current: false })
        .requiresUserAttention,
    ).toBe(false);
    expect(
      assess({ ...normal, serviceStatus: 'CANCELLED' }, { state: 'COMPLETED' })
        .disposition,
    ).toBe('CONTINUE_CURRENT_PLAN');
  });

  it('does not treat stale or mismatched observations as authoritative', () => {
    expect(
      assess({ ...normal, serviceStatus: 'CANCELLED' }, { now: at(17) })
        .disposition,
    ).toBe('CONTINUE_CURRENT_PLAN');
    expect(
      assess({
        ...normal,
        serviceStatus: 'CANCELLED',
        serviceIdentityKey: 'another',
      }).disposition,
    ).toBe('CONTINUE_CURRENT_PLAN');
  });

  it('keeps legacy missing target facts UNKNOWN', () => {
    const legacy = Object.fromEntries(
      Object.entries(normal).filter(
        ([key]) =>
          key !== 'boardingTargetServiceability' &&
          key !== 'alightingTargetServiceability',
      ),
    ) as unknown as GroundTransitObservation;
    expect(assess(legacy).targetServiceability).toEqual({
      boarding: 'UNKNOWN',
      alighting: 'UNKNOWN',
    });
  });

  it('does not turn missing transfer evidence into a fabricated downstream failure', () => {
    const result = assess(normal, {
      baseline: { ...baseline, minimumTransferSeconds: null },
      downstreamProtectedDeparture: new Date('2030-01-10T12:00:00Z'),
    });
    expect(result.disposition).toBe('CONTINUE_CURRENT_PLAN');
    expect(result.requiredAction).toBe('NONE');
    expect(result.requiresUserAttention).toBe(false);
  });
});
