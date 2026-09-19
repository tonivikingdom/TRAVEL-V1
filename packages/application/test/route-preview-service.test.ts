import type { RouteCandidateLegView } from '@travel/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RoutePreviewService } from '../src/route-preview-service.js';
import { hashRouteCandidateSnapshot } from '../src/route-snapshot.js';
import type { Actor } from '../src/authorization.js';
import type {
  RouteCandidatePayload,
  RouteCandidateSnapshotRecord,
  RoutePlanningRepository,
} from '../src/route-planning-ports.js';
import type {
  ItineraryNodeRecord,
  TripAggregateRecord,
  TripRepository,
} from '../src/trip-ports.js';

const ownerUserId = '00000000-0000-4000-8000-000000000001';
const tripId = '00000000-0000-4000-8000-000000000002';
const dayId = '00000000-0000-4000-8000-000000000003';
const fromNodeId = '00000000-0000-4000-8000-000000000004';
const toNodeId = '00000000-0000-4000-8000-000000000005';
const snapshotId = '00000000-0000-4000-8000-000000000006';
const previewId = '00000000-0000-4000-8000-000000000007';
const transportId = '00000000-0000-4000-8000-000000000008';
const intentId = '00000000-0000-4000-8000-000000000009';
const adoptedRouteId = '00000000-0000-4000-8000-000000000010';
const staleRouteId = '00000000-0000-4000-8000-000000000011';
const now = new Date('2030-01-01T00:00:00.000Z');

const actor: Actor = {
  userId: ownerUserId,
  email: 'owner@synthetic.example.test',
  role: 'USER',
  status: 'ACTIVE',
};

describe('RoutePreviewService', () => {
  let trip: TripAggregateRecord;
  let snapshot: RouteCandidateSnapshotRecord;
  let tripRepository: TripRepository;
  let planningRepository: RoutePlanningRepository;

  beforeEach(() => {
    trip = baseTrip();
    snapshot = candidateSnapshot(singleLegPayload());
    tripRepository = {
      create: vi.fn(),
      listOwned: vi.fn(),
      findOwnedById: vi.fn().mockResolvedValue(trip),
      updateMetadata: vi.fn(),
      executeCommand: vi.fn(),
      setTemporalValue: vi.fn(),
      listTransportHistoryOwned: vi.fn(),
    };
    planningRepository = {
      saveCandidateSnapshots: vi.fn(),
      findSnapshotOwned: vi.fn().mockResolvedValue(snapshot),
      createPreview: vi.fn(async (input) => ({
        status: 'SUCCESS' as const,
        preview: {
          id: previewId,
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
          basisVersion: input.basisVersion,
          candidateSnapshotId: input.snapshotId,
          candidateHash: input.expectedCandidateHash,
          policyVersion: input.policyVersion,
          previewPayload: input.previewPayload,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        },
      })),
      findPreviewOwned: vi.fn(),
    };
  });

  it('creates an immutable single-leg CREATE preview without mutating Trip facts', async () => {
    const preview = await service().createPreview(actor, tripId, request());

    expect(preview).toMatchObject({
      previewId,
      candidateSnapshotId: snapshotId,
      candidateHash: snapshot.candidateHash,
      policyVersion: 'route-adoption-preview-v2',
      adoptable: true,
      status: 'ACTIVE',
      currentConnection: { state: 'MISSING', transport: null },
      changeSummary: {
        transportAction: 'CREATE',
        willReplaceTransportEdgeId: null,
        requiresGeneratedNodes: false,
        generatedTransferPoints: [],
        temporalLayer: 'PLANNED',
        temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
      },
    });
    expect(preview.changeSummary.proposedSegments).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain('ACTUAL');
    expect(tripRepository.executeCommand).not.toHaveBeenCalled();
    expect(tripRepository.setTemporalValue).not.toHaveBeenCalled();
    expect(trip.version).toBe(3);
  });

  it('identifies a directly adjacent ACTIVE adopted route from its current edge', async () => {
    trip = singleLegAdoptedTrip();
    vi.mocked(tripRepository.findOwnedById).mockResolvedValue(trip);

    const preview = await service().createPreview(actor, tripId, request());

    expect(preview.changeSummary.routeCorridor).toMatchObject({
      currentAdoptedRouteId: adoptedRouteId,
      currentNodeIds: [fromNodeId, toNodeId],
    });
    expect(preview.changeSummary.willReplaceTransportEdgeIds).toEqual([
      transportId,
    ]);
  });

  it('rejects ambiguous ACTIVE route lifecycle records instead of selecting the first', async () => {
    const current = singleLegAdoptedTrip();
    trip = {
      ...current,
      adoptedRoutes: [
        ...current.adoptedRoutes!,
        {
          ...current.adoptedRoutes![0]!,
          id: staleRouteId,
          sourcePreviewId: staleRouteId,
          candidateSnapshotId: staleRouteId,
        },
      ],
    };
    vi.mocked(tripRepository.findOwnedById).mockResolvedValue(trip);

    await expect(
      service().createPreview(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  });

  it('preserves multi-leg walking and fixed-service facts and proposes located transfers', async () => {
    snapshot = candidateSnapshot(multiLegPayload());
    vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValue(snapshot);

    const preview = await service().createPreview(actor, tripId, request());

    expect(preview.changeSummary).toMatchObject({
      requiresGeneratedNodes: true,
      generatedTransferPoints: [
        {
          ref: 'TRANSFER_0',
          name: 'Station',
          latitude: 35.1,
          longitude: 139.1,
        },
      ],
      proposedSegments: [
        { mode: 'WALKING', fixedService: false },
        {
          mode: 'RAIL',
          fixedService: true,
          serviceLabel: 'SYNTHETIC EXPRESS',
        },
      ],
    });
  });

  it('does not infer fixedService from mode', async () => {
    const payload = singleLegPayload();
    payload.legs[0] = {
      ...payload.legs[0]!,
      mode: 'RAIL',
      fixedService: false,
    };
    snapshot = candidateSnapshot(payload);
    vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValue(snapshot);

    const preview = await service().createPreview(actor, tripId, request());
    expect(preview.changeSummary.proposedSegments[0]).toMatchObject({
      mode: 'RAIL',
      fixedService: false,
    });
  });

  it('describes replacement without archiving the current Transport', async () => {
    trip = baseTrip(true);
    vi.mocked(tripRepository.findOwnedById).mockResolvedValue(trip);

    const preview = await service().createPreview(actor, tripId, request());
    expect(preview.currentConnection.state).toBe('ACTIVE');
    expect(preview.changeSummary).toMatchObject({
      transportAction: 'REPLACE',
      willReplaceTransportEdgeId: transportId,
    });
    expect(tripRepository.executeCommand).not.toHaveBeenCalled();
  });

  it('rejects expired, provider-expired, and hash-tampered snapshots as PREVIEW_STALE', async () => {
    const variants = [
      { ...snapshot, expiresAt: now },
      { ...snapshot, providerValidUntil: now },
      { ...snapshot, candidateHash: '0'.repeat(64) },
    ];
    for (const variant of variants) {
      vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValueOnce(
        variant,
      );
      await expect(
        service().createPreview(actor, tripId, request()),
      ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    }
    expect(planningRepository.createPreview).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for a snapshot outside the owner/Trip scope', async () => {
    vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValue(null);
    await expect(
      service().createPreview(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('preserves VERSION_CONFLICT from the atomic create transaction', async () => {
    vi.mocked(planningRepository.createPreview).mockResolvedValue({
      status: 'VERSION_CONFLICT',
    });
    await expect(
      service().createPreview(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('rejects changed adjacency without creating a Preview', async () => {
    const original = baseTrip();
    trip = {
      ...original,
      dayOccurrences: [
        {
          ...original.dayOccurrences[0]!,
          nodes: [...original.dayOccurrences[0]!.nodes].reverse(),
        },
      ],
    };
    vi.mocked(tripRepository.findOwnedById).mockResolvedValue(trip);
    await expect(
      service().createPreview(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(planningRepository.createPreview).not.toHaveBeenCalled();
  });

  it('rejects a candidate that no longer satisfies the current P3B2 hard window', async () => {
    trip = baseTrip(false, true);
    vi.mocked(tripRepository.findOwnedById).mockResolvedValue(trip);
    await expect(
      service().createPreview(actor, tripId, request()),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(planningRepository.createPreview).not.toHaveBeenCalled();
  });

  it('rejects discontinuous or unlocated transfer points as PREVIEW_UNSUPPORTED', async () => {
    const discontinuous = multiLegPayload();
    discontinuous.legs[1] = {
      ...discontinuous.legs[1]!,
      from: { ...discontinuous.legs[1]!.from, providerPlaceRef: 'different' },
    };
    const unlocated = multiLegPayload();
    unlocated.legs[0] = {
      ...unlocated.legs[0]!,
      to: {
        ...unlocated.legs[0]!.to,
        latitude: null,
        longitude: null,
      },
    };
    unlocated.legs[1] = {
      ...unlocated.legs[1]!,
      from: {
        ...unlocated.legs[1]!.from,
        latitude: null,
        longitude: null,
      },
    };
    for (const payload of [discontinuous, unlocated]) {
      vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValueOnce(
        candidateSnapshot(payload),
      );
      await expect(
        service().createPreview(actor, tripId, request()),
      ).rejects.toMatchObject({ code: 'PREVIEW_UNSUPPORTED' });
    }
  });

  it('returns an expired persisted preview with adoptable=false', async () => {
    const active = await service().createPreview(actor, tripId, request());
    const persisted = await vi.mocked(planningRepository.createPreview).mock
      .results[0]!.value;
    if (persisted.status !== 'SUCCESS') throw new Error('expected preview');
    vi.mocked(planningRepository.findPreviewOwned).mockResolvedValue({
      ...persisted.preview,
      expiresAt: now,
    });

    const fetched = await service().getPreview(actor, tripId, active.previewId);
    expect(fetched).toMatchObject({ status: 'EXPIRED', adoptable: false });
  });

  it('keeps a v1 preview readable but marks it SUPERSEDED_POLICY', async () => {
    const active = await service().createPreview(actor, tripId, request());
    const persisted = await vi.mocked(planningRepository.createPreview).mock
      .results[0]!.value;
    if (persisted.status !== 'SUCCESS') throw new Error('expected preview');
    vi.mocked(planningRepository.findPreviewOwned).mockResolvedValue({
      ...persisted.preview,
      policyVersion: 'route-adoption-preview-v1',
      previewPayload: {
        ...persisted.preview.previewPayload,
        policyVersion: 'route-adoption-preview-v1',
      },
    });

    await expect(
      service().getPreview(actor, tripId, active.previewId),
    ).resolves.toMatchObject({
      status: 'SUPERSEDED_POLICY',
      adoptable: false,
    });
  });

  it('collapses a structured same-hub walking transfer without creating a formal segment', async () => {
    const from = location('From', 35, 139, 'from');
    const railStation = {
      ...location('Rail Station', 35.1, 139.1, 'rail-station'),
      providerHubRef: 'hub-station',
    };
    const busStop = {
      ...location('Bus Stop', 35.11, 139.11, 'bus-stop'),
      providerHubRef: 'hub-station',
    };
    const to = location('To', 36, 140, 'to');
    snapshot = candidateSnapshot(
      payload([
        leg(
          'RAIL',
          from,
          railStation,
          '2030-01-01T01:00:00.000Z',
          '2030-01-01T01:20:00.000Z',
          true,
        ),
        leg(
          'WALKING',
          railStation,
          busStop,
          '2030-01-01T01:20:00.000Z',
          '2030-01-01T01:30:00.000Z',
          false,
        ),
        leg(
          'BUS',
          busStop,
          to,
          '2030-01-01T01:40:00.000Z',
          '2030-01-01T02:00:00.000Z',
          true,
        ),
      ]),
    );
    vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValue(snapshot);

    const preview = await service().createPreview(actor, tripId, request());
    expect(preview.changeSummary.generatedTransferPoints).toHaveLength(1);
    expect(preview.changeSummary.proposedSegments).toHaveLength(2);
    expect(preview.changeSummary.internalTransferDetails).toEqual([
      expect.objectContaining({
        legIndex: 1,
        mode: 'WALKING',
        evidence: 'SYSTEM_STRUCTURED',
      }),
    ]);
  });

  it('accepts typed user same-hub confirmation but never rewrites candidate facts', async () => {
    const from = location('From', 35, 139, 'from');
    const station = location('Station', 35.1, 139.1, 'station');
    const stop = location('Stop', 35.11, 139.11, 'stop');
    const to = location('To', 36, 140, 'to');
    snapshot = candidateSnapshot(
      payload([
        leg(
          'RAIL',
          from,
          station,
          '2030-01-01T01:00:00.000Z',
          '2030-01-01T01:20:00.000Z',
          true,
        ),
        leg(
          'WALKING',
          station,
          stop,
          '2030-01-01T01:20:00.000Z',
          '2030-01-01T01:30:00.000Z',
          false,
        ),
        leg(
          'BUS',
          stop,
          to,
          '2030-01-01T01:40:00.000Z',
          '2030-01-01T02:00:00.000Z',
          true,
        ),
      ]),
    );
    vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValue(snapshot);

    const preview = await service().createPreview(actor, tripId, {
      ...request(),
      sameHubWalkingLegIndexes: [1],
    });
    expect(preview.changeSummary.internalTransferDetails?.[0]).toMatchObject({
      evidence: 'USER_CONFIRMED',
      durationSeconds: 600,
    });
    expect(preview.candidate.legs[1]).toMatchObject({
      mode: 'WALKING',
      providerRef: 'walking-1',
      durationSeconds: 600,
    });
  });

  it('does not infer same-hub grouping from similar names or nearby coordinates', async () => {
    const from = location('From', 35, 139, 'from');
    const station = location('Central Station', 35.1, 139.1, 'station');
    const stop = location(
      'Central Station Bus Stop',
      35.10001,
      139.10001,
      'bus-stop',
    );
    const to = location('To', 36, 140, 'to');
    snapshot = candidateSnapshot(
      payload([
        leg(
          'RAIL',
          from,
          station,
          '2030-01-01T01:00:00.000Z',
          '2030-01-01T01:20:00.000Z',
          true,
        ),
        leg(
          'WALKING',
          station,
          stop,
          '2030-01-01T01:20:00.000Z',
          '2030-01-01T01:30:00.000Z',
          false,
        ),
        leg(
          'BUS',
          stop,
          to,
          '2030-01-01T01:40:00.000Z',
          '2030-01-01T02:00:00.000Z',
          true,
        ),
      ]),
    );
    vi.mocked(planningRepository.findSnapshotOwned).mockResolvedValue(snapshot);

    const preview = await service().createPreview(actor, tripId, request());
    expect(preview.changeSummary.generatedTransferPoints).toHaveLength(2);
    expect(preview.changeSummary.proposedSegments).toHaveLength(3);
    expect(preview.changeSummary.internalTransferDetails).toEqual([]);
  });

  function service(): RoutePreviewService {
    return new RoutePreviewService(tripRepository, planningRepository, {
      previewTtlSeconds: 600,
      clock: { now: () => now },
    });
  }
});

function request() {
  return { basisVersion: 3, candidateSnapshotId: snapshotId };
}

function candidateSnapshot(
  candidatePayload: RouteCandidatePayload,
): RouteCandidateSnapshotRecord {
  const basis = {
    tripId,
    basisVersion: 3,
    fromNodeId,
    toNodeId,
    provider: candidatePayload.provider,
    observedAt: candidatePayload.observedAt,
    candidatePayload,
  };
  return {
    id: snapshotId,
    ownerUserId,
    tripId,
    basisVersion: 3,
    fromNodeId,
    toNodeId,
    provider: candidatePayload.provider,
    providerCandidateRef: candidatePayload.providerCandidateRef,
    observedAt: new Date(candidatePayload.observedAt),
    providerValidUntil:
      candidatePayload.validUntil === null
        ? null
        : new Date(candidatePayload.validUntil),
    candidatePayload,
    candidateHash: hashRouteCandidateSnapshot(basis),
    queryTimeCondition: candidatePayload.queryTimeCondition,
    createdAt: now,
    expiresAt: new Date('2030-01-01T00:15:00.000Z'),
  };
}

function singleLegPayload(): MutableCandidatePayload {
  const from = location('From', 35, 139, 'from');
  const to = location('To', 36, 140, 'to');
  return payload([
    leg(
      'BUS',
      from,
      to,
      '2030-01-01T01:00:00.000Z',
      '2030-01-01T02:00:00.000Z',
      false,
    ),
  ]);
}

function multiLegPayload(): MutableCandidatePayload {
  const from = location('From', 35, 139, 'from');
  const transfer = location('Station', 35.1, 139.1, 'station');
  const to = location('To', 36, 140, 'to');
  return payload([
    leg(
      'WALKING',
      from,
      transfer,
      '2030-01-01T01:00:00.000Z',
      '2030-01-01T01:10:00.000Z',
      false,
    ),
    {
      ...leg(
        'RAIL',
        transfer,
        to,
        '2030-01-01T01:20:00.000Z',
        '2030-01-01T02:00:00.000Z',
        true,
      ),
      serviceLabel: 'SYNTHETIC EXPRESS',
    },
  ]);
}

type MutableCandidatePayload = Omit<RouteCandidatePayload, 'legs'> & {
  legs: RouteCandidateLegView[];
};

function payload(legs: RouteCandidateLegView[]): MutableCandidatePayload {
  return {
    candidateId: 'candidate-1',
    provider: 'SYNTHETIC',
    providerCandidateRef: 'provider-candidate-1',
    observedAt: now.toISOString(),
    validUntil: '2030-01-01T00:30:00.000Z',
    queryBasisVersion: 3,
    queryTimeCondition: {
      hardEarliestDeparture: null,
      hardLatestArrival: null,
      earliestDeparture: '2030-01-01T01:00:00.000Z',
      latestArrival: null,
      preference: { type: 'NONE' },
      hint: null,
    },
    overall: {
      departure: { instant: '2030-01-01T01:00:00.000Z', timeZone: 'UTC' },
      arrival: { instant: '2030-01-01T02:00:00.000Z', timeZone: 'UTC' },
      durationSeconds: 3_600,
    },
    legs,
    fare: null,
  };
}

function leg(
  mode: RouteCandidateLegView['mode'],
  from: RouteCandidateLegView['from'],
  to: RouteCandidateLegView['to'],
  departure: string,
  arrival: string,
  fixedService: boolean,
): RouteCandidateLegView {
  return {
    mode,
    from,
    to,
    departure: { instant: departure, timeZone: 'UTC' },
    arrival: { instant: arrival, timeZone: 'UTC' },
    durationSeconds:
      (new Date(arrival).getTime() - new Date(departure).getTime()) / 1_000,
    fixedService,
    serviceLabel: null,
    providerRef: `${mode.toLowerCase()}-1`,
  };
}

function location(
  name: string,
  latitude: number,
  longitude: number,
  providerPlaceRef: string,
) {
  return { name, latitude, longitude, providerPlaceRef };
}

function baseTrip(
  withTransport = false,
  withArrivalUpperBound = false,
): TripAggregateRecord {
  const from = node(fromNodeId, 0, 'From');
  const to = node(toNodeId, 1, 'To');
  if (withArrivalUpperBound) {
    (to.timeIntents as Array<(typeof to.timeIntents)[number]>).push({
      id: intentId,
      tripId,
      nodeId: toNodeId,
      kind: 'POINT_TIME',
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: new Date('2030-01-01T01:30:00.000Z'),
      timeZone: 'UTC',
      durationSeconds: null,
      locked: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return {
    id: tripId,
    ownerUserId,
    name: 'SYNTHETIC P4B1',
    planningAnchorDate: new Date('2030-01-01T00:00:00.000Z'),
    defaultPeopleCount: 1,
    version: 3,
    effectiveStartDate: new Date('2030-01-01T00:00:00.000Z'),
    effectiveEndDate: new Date('2030-01-01T00:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
    ownedDates: [new Date('2030-01-01T00:00:00.000Z')],
    dayOccurrences: [
      {
        id: dayId,
        tripId,
        localDate: new Date('2030-01-01T00:00:00.000Z'),
        sequence: 0,
        createdAt: now,
        updatedAt: now,
        nodes: [from, to],
      },
    ],
    transportEdges: withTransport
      ? [
          {
            id: transportId,
            tripId,
            fromNodeId,
            toNodeId,
            mode: 'TAXI',
            fixedService: false,
            serviceLabel: null,
            note: null,
            source: 'MANUAL',
            createdAt: now,
            updatedAt: now,
            timeValues: [],
          },
        ]
      : [],
  };
}

function singleLegAdoptedTrip(): TripAggregateRecord {
  const trip = baseTrip();
  return {
    ...trip,
    transportEdges: [
      {
        id: transportId,
        tripId,
        fromNodeId,
        toNodeId,
        mode: 'BUS',
        fixedService: false,
        serviceLabel: null,
        note: null,
        source: 'ADOPTED_ROUTE',
        adoptedRouteId,
        provider: 'SYNTHETIC',
        providerRef: 'synthetic-current-edge',
        createdAt: now,
        updatedAt: now,
        timeValues: [],
      },
    ],
    adoptedRoutes: [
      {
        id: adoptedRouteId,
        tripId,
        anchorFromNodeId: fromNodeId,
        anchorToNodeId: toNodeId,
        sourcePreviewId: previewId,
        candidateSnapshotId: snapshotId,
        candidateHash: 'a'.repeat(64),
        policyVersion: 'route-adoption-preview-v2',
        status: 'ACTIVE',
        createdAt: now,
        replacedAt: null,
      },
    ],
  };
}

function node(id: string, position: number, name: string): ItineraryNodeRecord {
  return {
    id,
    tripId,
    dayOccurrenceId: dayId,
    kind: 'PLACE_VISIT',
    position,
    place: {
      id: `00000000-0000-4000-8000-0000000000${position + 20}`,
      ownerUserId,
      name,
      latitude: 35 + position,
      longitude: 139 + position,
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
