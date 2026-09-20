import type { FlightBindingView, FlightSnapshotView } from '@travel/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Actor } from '../src/authorization.js';
import type { ExecutionRiskService } from '../src/execution-risk-service.js';
import {
  computeFlightChanges,
  FlightService,
  selectRefreshCandidate,
} from '../src/flight-service.js';
import type {
  FlightRepository,
  FlightSnapshotProvider,
} from '../src/flight-ports.js';

const userId = '00000000-0000-4000-8000-000000000001';
const tripId = '00000000-0000-4000-8000-000000000002';
const edgeId = '00000000-0000-4000-8000-000000000003';
const bindingId = '00000000-0000-4000-8000-000000000004';
const actor: Actor = {
  userId,
  email: 'owner@synthetic.example.test',
  role: 'USER',
  status: 'ACTIVE',
};
let provider: FlightSnapshotProvider;
let repository: FlightRepository;
let risk: { evaluateTripRisks: ReturnType<typeof vi.fn> };

describe('FlightService', () => {
  beforeEach(() => {
    provider = {
      search: vi.fn(async () => [snapshot()]),
      refresh: vi.fn(async () => [snapshot()]),
    };
    repository = {
      adopt: vi.fn(async () => ({
        status: 'SUCCESS' as const,
        binding: binding(),
        resultingTripVersion: 4,
        idempotentReplay: false,
      })),
      findOwnedBinding: vi.fn(async () => binding()),
      refresh: vi.fn(async () => ({
        status: 'SUCCESS' as const,
        binding: binding(),
        previousSnapshot: snapshot(),
        resultingTripVersion: 4,
        factsChanged: false,
        actualConflicts: [],
        observationDisposition: 'APPLIED' as const,
      })),
    };
    risk = {
      evaluateTripRisks: vi.fn(async () => ({
        tripId,
        evaluationBasisTripVersion: 4,
        risks: [],
        resolvedRisks: [],
        notificationsCreated: [],
      })),
    };
  });

  it('searches normalized flights without writing the repository', async () => {
    const result = await service().search(actor, {
      flightNumber: ' nh 53 ',
      date: '2026-09-22',
    });
    expect(result.flights).toHaveLength(1);
    expect(provider.search).toHaveBeenCalledWith({
      flightNumber: 'NH53',
      date: '2026-09-22',
    });
    expect(repository.adopt).not.toHaveBeenCalled();
  });

  it('returns FLIGHT_NOT_FOUND for an empty search', async () => {
    vi.mocked(provider.search).mockResolvedValue([]);
    await expect(
      service().search(actor, { flightNumber: 'NH53', date: '2026-09-22' }),
    ).rejects.toMatchObject({ code: 'FLIGHT_NOT_FOUND' });
  });

  it.each([
    [{ flightNumber: 'bad', date: '2026-09-22' }],
    [{ flightNumber: 'NH53', date: 'bad-date' }],
    [{ date: '2026-09-22' }],
  ])('rejects malformed search input %#', async (input) => {
    await expect(service().search(actor, input)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('adopts onto an owned FLIGHT edge through the repository', async () => {
    await expect(
      service().adopt(actor, tripId, {
        baseTripVersion: 3,
        transportEdgeId: edgeId,
        flight: snapshot(),
      }),
    ).resolves.toMatchObject({ resultingTripVersion: 4 });
    expect(repository.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: userId,
        tripId,
        transportEdgeId: edgeId,
      }),
    );
  });

  it.each([
    { ...snapshot(), departure: undefined },
    {
      ...snapshot(),
      arrival: {
        ...snapshot().arrival,
        scheduledUtc: '2026-02-30T01:30:00Z',
      },
    },
    {
      ...snapshot(),
      departure: { ...snapshot().departure, timeZone: '+09:00' },
    },
  ])('rejects malformed client-provided flight snapshots', async (flight) => {
    await expect(
      service().adopt(actor, tripId, {
        baseTripVersion: 3,
        transportEdgeId: edgeId,
        flight: flight as FlightSnapshotView,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.adopt).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['VERSION_CONFLICT', 'VERSION_CONFLICT'],
    ['FACT_PROTECTED', 'FACT_PROTECTED'],
    ['INVALID_TRANSPORT', 'FLIGHT_MISMATCH'],
  ] as const)('maps adopt status %s to %s', async (status, code) => {
    vi.mocked(repository.adopt).mockResolvedValue({ status });
    await expect(
      service().adopt(actor, tripId, {
        baseTripVersion: 3,
        transportEdgeId: edgeId,
        flight: snapshot(),
      }),
    ).rejects.toMatchObject({ code });
  });

  it('refreshes outside persistence and evaluates risks after persistence', async () => {
    const order: string[] = [];
    vi.mocked(provider.refresh).mockImplementation(async () => {
      order.push('provider');
      return [snapshot({ status: 'DELAYED' })];
    });
    vi.mocked(repository.refresh).mockImplementation(async () => {
      order.push('repository');
      return {
        status: 'SUCCESS',
        binding: binding(),
        previousSnapshot: snapshot(),
        resultingTripVersion: 4,
        factsChanged: true,
        actualConflicts: [],
        observationDisposition: 'APPLIED',
      };
    });
    risk.evaluateTripRisks.mockImplementation(async () => {
      order.push('risk');
      return {
        tripId,
        evaluationBasisTripVersion: 4,
        risks: [],
        resolvedRisks: [],
        notificationsCreated: [],
      };
    });
    await service().refresh(actor, tripId, bindingId);
    expect(order).toEqual(['provider', 'repository', 'risk']);
  });

  it.each(['CANCELLED', 'DIVERTED'] as const)(
    'marks %s as requiring attention without replanning',
    async (status) => {
      const accepted = snapshot({ status });
      vi.mocked(provider.refresh).mockResolvedValue([accepted]);
      vi.mocked(repository.refresh).mockResolvedValue({
        status: 'SUCCESS',
        binding: binding(accepted),
        previousSnapshot: snapshot(),
        resultingTripVersion: 4,
        factsChanged: false,
        actualConflicts: [],
        observationDisposition: 'APPLIED',
      });
      const result = await service().refresh(actor, tripId, bindingId);
      expect(result).toMatchObject({
        requiresAttention: true,
        requiresRouteReevaluation: true,
      });
    },
  );

  it('returns no changes for a stale observation and evaluates the accepted database state', async () => {
    const accepted = snapshot({
      fetchedAt: '2026-09-22T00:02:00.000Z',
      status: 'ARRIVED',
    });
    vi.mocked(provider.refresh).mockResolvedValue([
      snapshot({
        fetchedAt: '2026-09-22T00:01:00.000Z',
        status: 'CANCELLED',
      }),
    ]);
    vi.mocked(repository.refresh).mockResolvedValue({
      status: 'SUCCESS',
      binding: binding(accepted),
      previousSnapshot: accepted,
      resultingTripVersion: 4,
      factsChanged: false,
      actualConflicts: [],
      observationDisposition: 'STALE_IGNORED',
    });

    const result = await service().refresh(actor, tripId, bindingId);

    expect(result).toMatchObject({
      observationDisposition: 'STALE_IGNORED',
      factsChanged: false,
      actualConflict: false,
      changes: { changeTypes: [] },
      requiresAttention: false,
    });
    expect(risk.evaluateTripRisks).toHaveBeenCalledOnce();
  });

  it('rejects a provider observation without a valid absolute fetchedAt', async () => {
    vi.mocked(provider.refresh).mockResolvedValue([
      snapshot({ fetchedAt: '2026-09-22T00:01:00' }),
    ]);

    await expect(
      service().refresh(actor, tripId, bindingId),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCENARIO' });
    expect(repository.refresh).not.toHaveBeenCalled();
  });

  it('does not treat predicted-only changes as operational time changes', () => {
    const base = snapshot();
    const next = {
      ...base,
      departure: {
        ...base.departure,
        predictedUtc: '2026-09-22T00:45:00.000Z',
      },
    };
    expect(computeFlightChanges(snapshot(), next).changeTypes).not.toContain(
      'DEPARTURE_TIME_CHANGED',
    );
  });

  it('summarizes operational and display changes structurally', () => {
    const base = snapshot();
    const next: FlightSnapshotView = {
      ...base,
      status: 'DELAYED',
      departure: {
        ...base.departure,
        revisedUtc: '2026-09-22T00:10:00.000Z',
        gate: '63',
      },
      arrival: { ...base.arrival, terminal: 'D', baggageBelt: '5' },
      aircraft: { ...base.aircraft!, registration: 'JA002A' },
    };
    expect(computeFlightChanges(snapshot(), next).changeTypes).toEqual([
      'STATUS_CHANGED',
      'DEPARTURE_TIME_CHANGED',
      'GATE_CHANGED',
      'TERMINAL_CHANGED',
      'BAGGAGE_CHANGED',
      'AIRCRAFT_CHANGED',
    ]);
  });
});

describe('refresh candidate safety', () => {
  it('selects the exact candidate ID first', () => {
    const selected = snapshot();
    const fallback = snapshot({ candidateId: 'other' });
    expect(selectRefreshCandidate(selected, [fallback, selected])).toBe(
      selected,
    );
  });

  it('permits only a unique full-identity fallback', () => {
    const selected = snapshot();
    const renamed = snapshot({ candidateId: 'new-provider-id' });
    expect(selectRefreshCandidate(selected, [renamed])).toBe(renamed);
  });

  it('rejects ambiguous fallback candidates', () => {
    const selected = snapshot();
    expect(() =>
      selectRefreshCandidate(selected, [
        snapshot({ candidateId: 'new-1' }),
        snapshot({ candidateId: 'new-2' }),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'FLIGHT_AMBIGUOUS' }));
  });

  it('rejects a candidate with a changed airport or schedule identity', () => {
    const base = snapshot({ candidateId: 'new' });
    const changed = {
      ...base,
      departure: { ...base.departure, airportIata: 'NRT' },
    };
    expect(() => selectRefreshCandidate(snapshot(), [changed])).toThrowError(
      expect.objectContaining({ code: 'FLIGHT_NOT_FOUND' }),
    );
  });
});

function service() {
  return new FlightService(
    provider,
    repository,
    risk as unknown as ExecutionRiskService,
  );
}

function snapshot(
  overrides: Partial<FlightSnapshotView> = {},
): FlightSnapshotView {
  return {
    provider: 'aerodatabox',
    candidateId: 'aerodatabox:nh53',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2026-09-22',
    status: 'SCHEDULED',
    rawStatus: 'Scheduled',
    airline: { name: 'ANA', iata: 'NH', icao: 'ANA' },
    departure: movement('HND', '2026-09-22T00:00:00.000Z'),
    arrival: movement('CTS', '2026-09-22T01:30:00.000Z'),
    aircraft: {
      model: 'Boeing 787',
      registration: 'JA001A',
      icao24: 'ABC123',
      callSign: 'ANA53',
    },
    departureDelayMinutes: null,
    arrivalDelayMinutes: null,
    departureDelayBasis: null,
    arrivalDelayBasis: null,
    fetchedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function movement(iata: string, scheduledUtc: string) {
  return {
    airportName: iata,
    airportIata: iata,
    airportIcao: null,
    timeZone: 'Asia/Tokyo',
    scheduledLocal: scheduledUtc,
    scheduledUtc,
    revisedLocal: null,
    revisedUtc: null,
    predictedLocal: null,
    predictedUtc: null,
    runwayLocal: null,
    runwayUtc: null,
    terminal: '1',
    gate: '62',
    checkInDesk: null,
    baggageBelt: '4',
  };
}

function binding(latestSnapshot = snapshot()): FlightBindingView {
  return {
    id: bindingId,
    tripId,
    transportEdgeId: edgeId,
    provider: 'aerodatabox',
    providerFlightRef: snapshot().candidateId,
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2026-09-22',
    selectedSnapshot: snapshot(),
    latestSnapshot,
    status: latestSnapshot.status,
    lastRefreshedAt: latestSnapshot.fetchedAt,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}
