import type { NormalizedRouteCandidate } from '@travel/domain';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { RouteQueryService } from '../src/route-query-service.js';
import type { Actor } from '../src/authorization.js';
import type { RoutePlanningRepository } from '../src/route-planning-ports.js';
import type { RouteProvider } from '../src/route-ports.js';
import type {
  ItineraryNodeRecord,
  TripAggregateRecord,
  TripRepository,
} from '../src/trip-ports.js';

const ownerUserId = '00000000-0000-4000-8000-000000000001';
const tripId = '00000000-0000-4000-8000-000000000002';
const dayAId = '00000000-0000-4000-8000-000000000003';
const dayBId = '00000000-0000-4000-8000-000000000004';
const fromNodeId = '00000000-0000-4000-8000-000000000005';
const toNodeId = '00000000-0000-4000-8000-000000000006';
const thirdNodeId = '00000000-0000-4000-8000-000000000007';
const now = new Date('2030-01-01T00:00:00.000Z');

const actor: Actor = {
  userId: ownerUserId,
  email: 'owner@synthetic.example.test',
  role: 'USER',
  status: 'ACTIVE',
};

describe('RouteQueryService', () => {
  let repository: TripRepository;
  let findOwnedById: Mock<TripRepository['findOwnedById']>;
  let queryRoutes: Mock<RouteProvider['queryRoutes']>;
  let provider: RouteProvider;
  let planningRepository: RoutePlanningRepository;

  beforeEach(() => {
    findOwnedById = vi
      .fn<TripRepository['findOwnedById']>()
      .mockResolvedValue(baseTrip());
    repository = {
      create: vi.fn(),
      listOwned: vi.fn(),
      findOwnedById,
      updateMetadata: vi.fn(),
      executeCommand: vi.fn(),
      setTemporalValue: vi.fn(),
      listTransportHistoryOwned: vi.fn(),
    };
    queryRoutes = vi
      .fn<RouteProvider['queryRoutes']>()
      .mockResolvedValue({ status: 'SUCCESS', candidates: [candidate()] });
    provider = { queryRoutes };
    planningRepository = {
      saveCandidateSnapshots: vi.fn(
        async (
          input: Parameters<
            RoutePlanningRepository['saveCandidateSnapshots']
          >[0],
        ) => ({
          status: 'SUCCESS' as const,
          snapshots: input.snapshots.map((snapshot, index) => ({
            ...snapshot,
            id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
            ownerUserId: input.ownerUserId,
            tripId: input.tripId,
            basisVersion: input.basisVersion,
            fromNodeId: input.fromNodeId,
            toNodeId: input.toNodeId,
          })),
        }),
      ),
      findSnapshotOwned: vi.fn(),
      createPreview: vi.fn(),
      findPreviewOwned: vi.fn(),
    };
  });

  it('queries an adjacent Place pair and preserves provider provenance', async () => {
    const result = await service().queryRoutes(actor, tripId, request());

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      candidateId: 'candidate-1',
      provider: 'SYNTHETIC',
      providerCandidateRef: 'provider-ref-1',
      observedAt: '2030-01-01T00:00:00.000Z',
      queryBasisVersion: 3,
      fare: null,
      candidateSnapshotId: '00000000-0000-4000-8000-000000000010',
      snapshotExpiresAt: '2030-01-01T00:15:00.000Z',
    });
    expect(findOwnedById).toHaveBeenCalledWith({ ownerUserId, tripId });
  });

  it('caps snapshot expiry at provider validity before the internal TTL', async () => {
    queryRoutes.mockResolvedValue({
      status: 'SUCCESS',
      candidates: [
        {
          ...candidate(),
          validUntil: new Date('2030-01-01T00:05:00.000Z'),
        },
      ],
    });

    const result = await service().queryRoutes(actor, tripId, request());
    expect(result.candidates[0]?.snapshotExpiresAt).toBe(
      '2030-01-01T00:05:00.000Z',
    );
    expect(planningRepository.saveCandidateSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshots: [
          expect.objectContaining({
            expiresAt: new Date('2030-01-01T00:05:00.000Z'),
          }),
        ],
      }),
    );
  });

  it('rejects a provider-time race when the short save transaction sees a changed Trip', async () => {
    vi.mocked(planningRepository.saveCandidateSnapshots).mockResolvedValue({
      status: 'VERSION_CONFLICT',
    });

    await expect(
      service().queryRoutes(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(queryRoutes).toHaveBeenCalledOnce();
  });

  it('rejects duplicate provider candidate IDs before saving snapshots', async () => {
    queryRoutes.mockResolvedValue({
      status: 'SUCCESS',
      candidates: [candidate(), candidate()],
    });
    await expect(
      service().queryRoutes(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(planningRepository.saveCandidateSnapshots).not.toHaveBeenCalled();
  });

  it('requires a query time when propagation is unbounded and no hint exists', async () => {
    await expect(
      service().queryRoutes(actor, tripId, {
        basisVersion: 3,
        fromNodeId,
        toNodeId,
      }),
    ).rejects.toMatchObject({ code: 'ROUTE_QUERY_TIME_REQUIRED' });
    expect(queryRoutes).not.toHaveBeenCalled();
  });

  it('passes a DEPART_AT hint as an absolute provider preference', async () => {
    await service().queryRoutes(actor, tripId, request());

    expect(queryRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        earliestDeparture: new Date('2030-10-01T10:00:00.000Z'),
        preference: {
          type: 'DEPART_AT',
          instant: new Date('2030-10-01T10:00:00.000Z'),
          timeZone: 'Asia/Tokyo',
        },
      }),
    );
  });

  it('passes an ARRIVE_BY hint as an absolute provider preference', async () => {
    queryRoutes.mockResolvedValue({
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T09:30:00Z', '2030-10-01T10:30:00Z')],
    });
    await service().queryRoutes(actor, tripId, {
      ...request(),
      hint: {
        type: 'ARRIVE_BY',
        instant: '2030-10-01T19:00:00+08:00',
        timeZone: 'Asia/Shanghai',
      },
    });

    expect(queryRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        latestArrival: new Date('2030-10-01T11:00:00.000Z'),
        preference: {
          type: 'ARRIVE_BY',
          instant: new Date('2030-10-01T11:00:00.000Z'),
          timeZone: 'Asia/Shanghai',
        },
      }),
    );
  });

  it('reuses P3B2 departure and arrival requirement windows', async () => {
    findOwnedById.mockResolvedValue(
      tripWithBounds('2030-10-01T09:00:00Z', '2030-10-01T11:00:00Z'),
    );
    await service().queryRoutes(actor, tripId, {
      ...request(),
      hint: null,
    });

    expect(queryRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        earliestDeparture: new Date('2030-10-01T09:00:00Z'),
        latestArrival: new Date('2030-10-01T11:00:00Z'),
        preference: { type: 'NONE' },
      }),
    );
  });

  it('allows a hint to tighten but never relax a hard requirement', async () => {
    findOwnedById.mockResolvedValue(
      tripWithBounds('2030-10-01T09:00:00Z', '2030-10-01T11:00:00Z'),
    );
    await service().queryRoutes(actor, tripId, {
      ...request(),
      hint: {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:00:00Z',
        timeZone: 'UTC',
      },
    });
    expect(queryRoutes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        earliestDeparture: new Date('2030-10-01T10:00:00Z'),
      }),
    );

    queryRoutes.mockClear();
    await service().queryRoutes(actor, tripId, {
      ...request(),
      hint: {
        type: 'ARRIVE_BY',
        instant: '2030-10-01T12:00:00Z',
        timeZone: 'UTC',
      },
    });
    expect(queryRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        latestArrival: new Date('2030-10-01T11:00:00Z'),
      }),
    );
  });

  it('rejects an incompatible hint before calling the provider', async () => {
    findOwnedById.mockResolvedValue(
      tripWithBounds(null, '2030-10-01T09:30:00Z'),
    );
    await expect(
      service().queryRoutes(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_CONFLICT' });
    expect(queryRoutes).not.toHaveBeenCalled();
  });

  it('does not call the provider when P3B2 already reports a conflict', async () => {
    findOwnedById.mockResolvedValue(
      tripWithBounds('2030-10-01T12:00:00Z', '2030-10-01T11:00:00Z'),
    );
    await expect(
      service().queryRoutes(actor, tripId, { ...request(), hint: null }),
    ).rejects.toMatchObject({ code: 'CONSTRAINT_CONFLICT' });
    expect(queryRoutes).not.toHaveBeenCalled();
  });

  it('filters candidates that depart too early or arrive too late', async () => {
    findOwnedById.mockResolvedValue(
      tripWithBounds('2030-10-01T09:00:00Z', '2030-10-01T11:00:00Z'),
    );
    queryRoutes.mockResolvedValue({
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T08:59:00Z', '2030-10-01T09:59:00Z', 'early'),
        candidate('2030-10-01T09:30:00Z', '2030-10-01T11:01:00Z', 'late'),
        candidate('2030-10-01T09:30:00Z', '2030-10-01T10:30:00Z', 'valid'),
      ],
    });

    const result = await service().queryRoutes(actor, tripId, {
      ...request(),
      hint: null,
    });
    expect(result.candidates.map((value) => value.candidateId)).toEqual([
      'valid',
    ]);
  });

  it('returns NO_MATCHING_CANDIDATE when every successful result is filtered', async () => {
    findOwnedById.mockResolvedValue(
      tripWithBounds(null, '2030-10-01T10:00:00Z'),
    );
    queryRoutes.mockResolvedValue({
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T09:30:00Z', '2030-10-01T10:01:00Z')],
    });
    await expect(
      service().queryRoutes(actor, tripId, { ...request(), hint: null }),
    ).rejects.toMatchObject({ code: 'NO_MATCHING_CANDIDATE' });
  });

  it.each([
    [{ status: 'NO_MATCHING_CANDIDATE' }, 'NO_MATCHING_CANDIDATE'],
    [
      { status: 'PROVIDER_UNAVAILABLE', reason: 'UPSTREAM_UNAVAILABLE' },
      'PROVIDER_UNAVAILABLE',
    ],
    [
      { status: 'PROVIDER_UNAVAILABLE', reason: 'ROUTE_PROVIDER_UNCONFIGURED' },
      'ROUTE_PROVIDER_UNCONFIGURED',
    ],
    [{ status: 'UNSUPPORTED_QUERY' }, 'ROUTE_QUERY_UNSUPPORTED'],
  ] as const)('preserves provider result category %s', async (result, code) => {
    queryRoutes.mockResolvedValue(result);
    await expect(
      service().queryRoutes(actor, tripId, request()),
    ).rejects.toMatchObject({
      code,
    });
  });

  it('keeps multi-leg walking, explicit fixedService, and known fare facts', async () => {
    const value = candidate();
    queryRoutes.mockResolvedValue({
      status: 'SUCCESS',
      candidates: [
        {
          ...value,
          legs: [
            { ...value.legs[0]!, mode: 'BUS', fixedService: false },
            { ...value.legs[0]!, mode: 'WALKING', fixedService: false },
            {
              ...value.legs[0]!,
              mode: 'RAIL',
              fixedService: true,
              serviceLabel: 'SYNTHETIC-EXPRESS',
            },
          ],
          fare: { amount: '42.50', currency: 'CNY' },
        },
      ],
    });
    const result = await service().queryRoutes(actor, tripId, request());
    expect(
      result.candidates[0]?.legs.map((leg) => [leg.mode, leg.fixedService]),
    ).toEqual([
      ['BUS', false],
      ['WALKING', false],
      ['RAIL', true],
    ]);
    expect(result.candidates[0]?.fare).toEqual({
      amount: '42.50',
      currency: 'CNY',
    });
  });

  it('rejects non-adjacent and FreeAction endpoints without provider access', async () => {
    findOwnedById.mockResolvedValue(baseTrip(true));
    await expect(
      service().queryRoutes(actor, tripId, {
        ...request(),
        toNodeId: thirdNodeId,
      }),
    ).rejects.toMatchObject({ code: 'ROUTE_QUERY_UNSUPPORTED' });

    findOwnedById.mockResolvedValue(baseTrip(false, true));
    await expect(
      service().queryRoutes(actor, tripId, request()),
    ).rejects.toMatchObject({
      code: 'ROUTE_QUERY_UNSUPPORTED',
    });
    expect(queryRoutes).not.toHaveBeenCalled();
  });

  it('returns private-resource NOT_FOUND and rejects a stale basis version', async () => {
    findOwnedById.mockResolvedValueOnce(null).mockResolvedValueOnce(baseTrip());
    await expect(
      service().queryRoutes(actor, tripId, request()),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      service().queryRoutes(actor, tripId, { ...request(), basisVersion: 2 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(queryRoutes).not.toHaveBeenCalled();
  });

  it('validates hint absolute time and named IANA zone', async () => {
    await expect(
      service().queryRoutes(actor, tripId, {
        ...request(),
        hint: {
          type: 'DEPART_AT',
          instant: '2030-10-01 10:00',
          timeZone: 'UTC',
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCENARIO' });
    await expect(
      service().queryRoutes(actor, tripId, {
        ...request(),
        hint: {
          type: 'DEPART_AT',
          instant: '2030-10-01T10:00:00Z',
          timeZone: '+08:00',
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('uses DayOccurrence sequence, not localDate, for rollback adjacency', async () => {
    const trip = baseTrip();
    findOwnedById.mockResolvedValue({
      ...trip,
      dayOccurrences: [
        {
          ...trip.dayOccurrences[0]!,
          localDate: new Date('2030-01-10T00:00:00Z'),
        },
        {
          ...trip.dayOccurrences[1]!,
          localDate: new Date('2030-01-09T00:00:00Z'),
        },
      ],
    });
    await service().queryRoutes(actor, tripId, request());
    expect(queryRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: expect.objectContaining({ name: 'Tokyo' }),
        destination: expect.objectContaining({ name: 'Los Angeles' }),
      }),
    );
  });

  it('is read-only and does not invoke any Trip mutation port', async () => {
    await service().queryRoutes(actor, tripId, request());
    expect(repository.updateMetadata).not.toHaveBeenCalled();
    expect(repository.executeCommand).not.toHaveBeenCalled();
    expect(repository.setTemporalValue).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  function service(): RouteQueryService {
    return new RouteQueryService(repository, provider, planningRepository, {
      candidateSnapshotTtlSeconds: 900,
      clock: { now: () => now },
    });
  }
});

function request() {
  return {
    basisVersion: 3,
    fromNodeId,
    toNodeId,
    hint: {
      type: 'DEPART_AT' as const,
      instant: '2030-10-01T19:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    },
  };
}

function baseTrip(
  includeThird = false,
  freeActionDestination = false,
): TripAggregateRecord {
  const from = placeNode(fromNodeId, dayAId, 0, 'Tokyo');
  const to = freeActionDestination
    ? freeAction(toNodeId, dayBId, 0)
    : placeNode(toNodeId, dayBId, 0, 'Los Angeles');
  const days = [
    day(dayAId, '2030-01-10', 0, [from]),
    day(dayBId, '2030-01-09', 1, [to]),
  ];
  if (includeThird) {
    days.push(
      day('00000000-0000-4000-8000-000000000008', '2030-01-11', 2, [
        placeNode(
          thirdNodeId,
          '00000000-0000-4000-8000-000000000008',
          0,
          'Third',
        ),
      ]),
    );
  }
  return {
    id: tripId,
    ownerUserId,
    name: 'SYNTHETIC P4A1',
    planningAnchorDate: new Date('2030-01-10T00:00:00Z'),
    defaultPeopleCount: 1,
    version: 3,
    effectiveStartDate: new Date('2030-01-09T00:00:00Z'),
    effectiveEndDate: new Date('2030-01-10T00:00:00Z'),
    createdAt: now,
    updatedAt: now,
    ownedDates: [],
    dayOccurrences: days,
    transportEdges: [],
  };
}

function tripWithBounds(
  earliestDeparture: string | null,
  latestArrival: string | null,
): TripAggregateRecord {
  const trip = baseTrip();
  const from = trip.dayOccurrences[0]!.nodes[0]!;
  const to = trip.dayOccurrences[1]!.nodes[0]!;
  return {
    ...trip,
    dayOccurrences: [
      day(dayAId, '2030-01-10', 0, [
        {
          ...from,
          timeIntents:
            earliestDeparture === null
              ? []
              : [
                  pointIntent(
                    from.id,
                    'DEPARTURE',
                    'NOT_BEFORE',
                    earliestDeparture,
                  ),
                ],
        },
      ]),
      day(dayBId, '2030-01-09', 1, [
        {
          ...to,
          timeIntents:
            latestArrival === null
              ? []
              : [pointIntent(to.id, 'ARRIVAL', 'NOT_AFTER', latestArrival)],
        },
      ]),
    ],
  };
}

function pointIntent(
  nodeId: string,
  pointKind: 'ARRIVAL' | 'DEPARTURE',
  operator: 'NOT_BEFORE' | 'NOT_AFTER',
  instant: string,
) {
  return {
    id: `00000000-0000-4000-8000-${pointKind === 'ARRIVAL' ? '000000000010' : '000000000011'}`,
    tripId,
    nodeId,
    kind: 'POINT_TIME' as const,
    pointKind,
    operator,
    instant: new Date(instant),
    timeZone: 'UTC',
    durationSeconds: null,
    locked: false,
    createdAt: now,
    updatedAt: now,
  };
}

function day(
  id: string,
  localDate: string,
  sequence: number,
  nodes: readonly ItineraryNodeRecord[],
) {
  return {
    id,
    tripId,
    localDate: new Date(`${localDate}T00:00:00Z`),
    sequence,
    createdAt: now,
    updatedAt: now,
    nodes,
  };
}

function placeNode(
  id: string,
  dayOccurrenceId: string,
  position: number,
  name: string,
): ItineraryNodeRecord {
  return {
    id,
    tripId,
    dayOccurrenceId,
    kind: 'PLACE_VISIT',
    position,
    place: {
      id: `00000000-0000-4000-8000-${name === 'Tokyo' ? '000000000020' : name === 'Los Angeles' ? '000000000021' : '000000000022'}`,
      ownerUserId,
      name,
      latitude: 35.6762,
      longitude: 139.6503,
      address: null,
      createdAt: now,
    },
    note: null,
    source: 'USER_PLANNED',
    createdAt: now,
    updatedAt: now,
    timeValues: [],
    timeIntents: [],
  };
}

function freeAction(
  id: string,
  dayOccurrenceId: string,
  position: number,
): ItineraryNodeRecord {
  return {
    ...placeNode(id, dayOccurrenceId, position, 'Free'),
    kind: 'FREE_ACTION',
    place: null,
  };
}

function candidate(
  departure = '2030-10-01T10:00:00Z',
  arrival = '2030-10-01T11:00:00Z',
  candidateId = 'candidate-1',
): NormalizedRouteCandidate {
  const durationSeconds =
    (new Date(arrival).getTime() - new Date(departure).getTime()) / 1_000;
  const from = {
    name: 'Tokyo',
    latitude: 35.6762,
    longitude: 139.6503,
    providerPlaceRef: 'tokyo',
  };
  const to = {
    name: 'Los Angeles',
    latitude: 34.0522,
    longitude: -118.2437,
    providerPlaceRef: 'los-angeles',
  };
  return {
    candidateId,
    provider: 'SYNTHETIC',
    providerCandidateRef: 'provider-ref-1',
    observedAt: now,
    validUntil: null,
    departure: { instant: new Date(departure), timeZone: 'Asia/Tokyo' },
    arrival: { instant: new Date(arrival), timeZone: 'America/Los_Angeles' },
    durationSeconds,
    legs: [
      {
        mode: 'RAIL',
        from,
        to,
        departure: { instant: new Date(departure), timeZone: 'Asia/Tokyo' },
        arrival: {
          instant: new Date(arrival),
          timeZone: 'America/Los_Angeles',
        },
        durationSeconds,
        fixedService: false,
        serviceLabel: null,
        providerRef: 'leg-1',
      },
    ],
    fare: null,
  };
}
