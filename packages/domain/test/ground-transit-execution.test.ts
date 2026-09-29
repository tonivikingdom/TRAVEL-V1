import { describe, expect, it } from 'vitest';

import {
  assessGroundTransitSafety,
  decideGroundTransitObservationOrdering,
  matchGroundTransitIdentity,
  isSustainedGroundTransitDeviation,
  validGroundTransitObservation,
  resolveGroundTransitLegState,
  type GroundTransitBaseline,
  type GroundTransitObservation,
} from '../src/ground-transit-execution.js';

const at = (time: string) => new Date(`2030-01-10T${time}:00Z`);
const highFrequency: GroundTransitBaseline = {
  provider: 'SYNTHETIC',
  mode: 'RAIL',
  serviceClass: 'HIGH_FREQUENCY',
  serviceIdentityKey: null,
  lineRef: 'line-1',
  directionRef: 'north',
  boardingHubRef: 'A',
  alightingHubRef: 'B',
  headwayMinSeconds: 180,
  headwayMaxSeconds: 300,
  minimumTransferSeconds: null,
  boardingAccessMinimumSeconds: 0,
  plannedDeparture: at('10:20'),
  plannedArrival: at('10:45'),
};
const observation: GroundTransitObservation = {
  provider: 'SYNTHETIC',
  observationIdentity: 'obs-1',
  fetchedAt: at('10:00'),
  serviceClass: 'HIGH_FREQUENCY',
  mode: 'RAIL',
  lineRef: 'line-1',
  lineName: 'Line 1',
  directionRef: 'north',
  directionLabel: 'North',
  boardingHubRef: 'A',
  alightingHubRef: 'B',
  serviceIdentityKey: null,
  scheduledDeparture: null,
  scheduledArrival: null,
  estimatedDeparture: null,
  estimatedArrival: null,
  actualDeparture: null,
  actualArrival: null,
  departurePlatform: null,
  arrivalPlatform: null,
  serviceStatus: 'UNKNOWN',
  headwayMinSeconds: 180,
  headwayMaxSeconds: 300,
  nextDepartureInSeconds: null,
  minimumTransferSeconds: null,
};

describe('ground transit execution policy', () => {
  it('uses headway without inventing or double-counting transfer, without making it the ETA', () => {
    const result = assessGroundTransitSafety({
      baseline: highFrequency,
      observation: null,
      now: at('10:00'),
      availableAt: at('10:00'),
      downstreamLatestAt: at('11:00'),
      boundary: 'BOARDING',
    });
    expect(result.headwayWaitReserveSeconds).toBe(300);
    expect(result.transferMinimumSeconds).toBeNull();
    expect(result.totalSystemMinimumSeconds).toBe(300);
    expect(result.etaRangeSeconds).toEqual([180, 300]);
  });

  it('fresh next departure replaces rather than adds to the headway upper bound', () => {
    const result = assessGroundTransitSafety({
      baseline: highFrequency,
      observation: { ...observation, nextDepartureInSeconds: 120 },
      now: at('10:01'),
      availableAt: at('10:00'),
      downstreamLatestAt: at('11:00'),
      boundary: 'BOARDING',
    });
    expect(result.headwayWaitReserveSeconds).toBe(120);
    expect(result.totalSystemMinimumSeconds).toBe(120);
    expect(result.etaRangeSeconds).toEqual([120, 120]);
  });

  it('marks missing transfer-to-next unknown without a five-minute guess', () => {
    const result = assessGroundTransitSafety({
      baseline: highFrequency,
      observation: null,
      now: at('10:00'),
      availableAt: at('10:45'),
      downstreamLatestAt: at('10:50'),
      boundary: 'TRANSFER_TO_NEXT',
    });
    expect(result).toMatchObject({
      headwayWaitReserveSeconds: null,
      transferMinimumSeconds: null,
      transferBasis: 'UNKNOWN',
      totalSystemMinimumSeconds: null,
      feasibility: 'UNKNOWN',
    });
    expect(result.reasonCodes).toContain('TRANSFER_MINIMUM_UNKNOWN');
  });

  it('uses known adopted or fresh provider transfer only at the onward boundary', () => {
    const basis = { ...highFrequency, minimumTransferSeconds: 240 };
    const input = {
      baseline: basis,
      now: at('10:01'),
      availableAt: at('10:45'),
      downstreamLatestAt: at('10:50'),
      boundary: 'TRANSFER_TO_NEXT' as const,
    };
    expect(
      assessGroundTransitSafety({ ...input, observation: null }),
    ).toMatchObject({
      transferMinimumSeconds: 240,
      transferBasis: 'ADOPTED',
      totalSystemMinimumSeconds: 240,
    });
    expect(
      assessGroundTransitSafety({
        ...input,
        observation: { ...observation, minimumTransferSeconds: 180 },
      }),
    ).toMatchObject({
      transferMinimumSeconds: 180,
      transferBasis: 'PROVIDER',
      totalSystemMinimumSeconds: 180,
    });
    expect(
      assessGroundTransitSafety({
        ...input,
        observation: null,
        boundary: 'BOARDING',
      }),
    ).toMatchObject({
      headwayWaitReserveSeconds: 300,
      transferMinimumSeconds: null,
      transferBasis: 'NOT_APPLICABLE',
      totalSystemMinimumSeconds: 300,
    });
    expect(
      assessGroundTransitSafety({
        ...input,
        observation: null,
        downstreamLatestAt: at('10:48'),
      }).feasibility,
    ).toBe('INFEASIBLE');
  });

  it('keeps boarding access unknown distinct from headway when a protected connection needs it', () => {
    const result = assessGroundTransitSafety({
      baseline: { ...highFrequency, boardingAccessMinimumSeconds: null },
      observation: { ...observation, nextDepartureInSeconds: 120 },
      now: at('10:01'),
      availableAt: at('10:00'),
      downstreamLatestAt: null,
      boundary: 'BOARDING',
      boardingAccessRequired: true,
    });
    expect(result.headwayWaitReserveSeconds).toBe(120);
    expect(result.totalSystemMinimumSeconds).toBeNull();
    expect(result.feasibility).toBe('UNKNOWN');
    expect(result.reasonCodes).toContain('BOARDING_ACCESS_UNKNOWN');
  });

  it('stale realtime falls back to adopted metadata without erasing evidence', () => {
    const result = assessGroundTransitSafety({
      baseline: highFrequency,
      observation: { ...observation, nextDepartureInSeconds: 120 },
      now: at('10:06'),
      availableAt: at('10:00'),
      downstreamLatestAt: at('11:00'),
      boundary: 'BOARDING',
    });
    expect(result.realtimeFreshness).toBe('STALE');
    expect(result.headwayWaitReserveSeconds).toBe(300);
    expect(result.reasonCodes).toContain('REALTIME_STALE');
  });

  it('fixed-service identity never uses a fuzzy line or time match', () => {
    const fixed = {
      ...highFrequency,
      serviceClass: 'FIXED_SERVICE' as const,
      serviceIdentityKey: 'trip:123',
    };
    expect(
      matchGroundTransitIdentity(fixed, {
        ...observation,
        serviceClass: 'FIXED_SERVICE',
        serviceIdentityKey: null,
      }),
    ).toBe('IDENTITY_UNKNOWN');
    expect(
      matchGroundTransitIdentity(fixed, {
        ...observation,
        serviceClass: 'FIXED_SERVICE',
        serviceIdentityKey: 'trip:456',
      }),
    ).toBe('DIFFERENT_SERVICE');
  });

  it('matches high-frequency service only within the adopted line, direction, hubs and execution window', () => {
    expect(matchGroundTransitIdentity(highFrequency, observation)).toBe(
      'MATCHED',
    );
    expect(
      matchGroundTransitIdentity(highFrequency, {
        ...observation,
        directionRef: 'south',
      }),
    ).toBe('DIFFERENT_SERVICE');
    expect(
      matchGroundTransitIdentity(highFrequency, {
        ...observation,
        fetchedAt: at('07:00'),
      }),
    ).toBe('IDENTITY_UNKNOWN');
    expect(
      matchGroundTransitIdentity(
        { ...highFrequency, plannedArrival: null },
        observation,
      ),
    ).toBe('IDENTITY_UNKNOWN');
  });

  it('orders provider observations by fetchedAt and stable identity', () => {
    const basis = {
      previousFetchedAt: at('10:00'),
      previousObservationIdentity: 'one',
      previousFactsHash: 'hash-1',
      incomingObservationIdentity: 'one',
      incomingFactsHash: 'hash-1',
    };
    expect(
      decideGroundTransitObservationOrdering({
        ...basis,
        incomingFetchedAt: at('09:59'),
      }),
    ).toBe('STALE_IGNORED');
    expect(
      decideGroundTransitObservationOrdering({
        ...basis,
        incomingFetchedAt: at('10:00'),
      }),
    ).toBe('IDEMPOTENT');
    expect(
      decideGroundTransitObservationOrdering({
        ...basis,
        incomingFetchedAt: at('10:00'),
        incomingFactsHash: 'hash-2',
      }),
    ).toBe('OBSERVATION_CONFLICT');
    expect(
      decideGroundTransitObservationOrdering({
        ...basis,
        incomingFetchedAt: at('10:01'),
      }),
    ).toBe('APPLIED');
  });

  it('does not call a provider arrival user completion without execution handoff', () => {
    expect(
      resolveGroundTransitLegState({
        previous: 'IN_PROGRESS',
        destinationArrived: true,
        executionHandoffComplete: false,
        reliableMovementOnCorridor: true,
        fixedServiceNoLongerFeasible: false,
      }),
    ).toBe('ARRIVED_PENDING_HANDOFF');
  });

  it('requires matching execution context for progress and preserves completed history', () => {
    const base = {
      previous: 'PENDING' as const,
      destinationArrived: false,
      executionHandoffComplete: false,
      reliableMovementOnCorridor: false,
      fixedServiceNoLongerFeasible: false,
    };
    expect(resolveGroundTransitLegState(base)).toBe('PENDING');
    expect(
      resolveGroundTransitLegState({
        ...base,
        reliableMovementOnCorridor: true,
      }),
    ).toBe('IN_PROGRESS');
    expect(
      resolveGroundTransitLegState({ ...base, destinationArrived: true }),
    ).toBe('ARRIVED_PENDING_HANDOFF');
    expect(
      resolveGroundTransitLegState({
        ...base,
        destinationArrived: true,
        executionHandoffComplete: true,
      }),
    ).toBe('COMPLETED');
    expect(
      resolveGroundTransitLegState({
        ...base,
        previous: 'COMPLETED',
        fixedServiceNoLongerFeasible: true,
      }),
    ).toBe('COMPLETED');
  });

  it('treats a missed fixed service as infeasible without marking a high-frequency missed vehicle', () => {
    const fixed = {
      ...highFrequency,
      serviceClass: 'FIXED_SERVICE' as const,
      serviceIdentityKey: 'service-1',
    };
    expect(
      resolveGroundTransitLegState({
        previous: 'PENDING',
        destinationArrived: false,
        executionHandoffComplete: false,
        reliableMovementOnCorridor: false,
        fixedServiceNoLongerFeasible: true,
      }),
    ).toBe('NO_LONGER_FEASIBLE');
    expect(
      assessGroundTransitSafety({
        baseline: fixed,
        observation: null,
        now: at('10:00'),
        availableAt: at('10:30'),
        downstreamLatestAt: null,
        boundary: 'BOARDING',
      }).feasibility,
    ).toBe('INFEASIBLE');
    expect(
      assessGroundTransitSafety({
        baseline: highFrequency,
        observation: null,
        now: at('10:00'),
        availableAt: at('10:05'),
        downstreamLatestAt: null,
        boundary: 'BOARDING',
      }).feasibility,
    ).toBe('FEASIBLE');
  });

  it('requires repeated consequential deviation over the versioned time window', () => {
    expect(
      isSustainedGroundTransitDeviation({
        consecutiveObservations: 1,
        startedAt: at('10:00'),
        now: at('10:10'),
      }),
    ).toBe(false);
    expect(
      isSustainedGroundTransitDeviation({
        consecutiveObservations: 2,
        startedAt: at('10:00'),
        now: at('10:01'),
      }),
    ).toBe(false);
    expect(
      isSustainedGroundTransitDeviation({
        consecutiveObservations: 2,
        startedAt: at('10:00'),
        now: at('10:02'),
      }),
    ).toBe(true);
  });

  it('rejects malformed provider facts without guessing missing fields', () => {
    expect(validGroundTransitObservation(observation)).toBe(true);
    expect(
      validGroundTransitObservation({
        ...observation,
        fetchedAt: new Date(Number.NaN),
      }),
    ).toBe(false);
    expect(
      validGroundTransitObservation({
        ...observation,
        headwayMinSeconds: 600,
        headwayMaxSeconds: 300,
      }),
    ).toBe(false);
  });
});
