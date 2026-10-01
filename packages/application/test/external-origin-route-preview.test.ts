import { describe, expect, it, vi } from 'vitest';
import { buildExternalOriginPreviewPayload } from '../src/external-origin-route-preview.js';
import { RoutePreviewService } from '../src/route-preview-service.js';
import { externalRouteOriginSnapshot } from '../src/external-origin-route-query.js';
import { hashExternalRouteCandidateSnapshot } from '../src/route-snapshot.js';
import type {
  ExternalOriginPlanningContext,
  ExternalOriginRecord,
} from '../src/external-execution-origin-ports.js';
import type {
  RouteCandidatePayload,
  RouteCandidateSnapshotRecord,
  RoutePlanningRepository,
} from '../src/route-planning-ports.js';
import type { TripAggregateRecord, TripRepository } from '../src/trip-ports.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const now = new Date('2030-10-01T15:50:00Z');
function fixture() {
  const [tripId, ownerUserId, routeId, dayId] = [id(1), id(2), id(3), id(4)];
  const nodes = ['A', 'B', 'C', 'D'].map((name, position) => ({
    id: id(10 + position),
    tripId,
    dayOccurrenceId: dayId,
    kind: 'PLACE_VISIT' as const,
    position,
    place: {
      id: id(20 + position),
      ownerUserId,
      name: `SYNTHETIC ${name}`,
      latitude: 35 + position * 0.01,
      longitude: 139,
      address: null,
      createdAt: now,
    },
    source:
      position === 1 || position === 2
        ? ('ROUTE_GENERATED' as const)
        : ('USER_PLANNED' as const),
    adoptedRouteId: position === 1 || position === 2 ? routeId : null,
    autoReplaceable: true,
    userModifiedAt: null,
    note: null,
    createdAt: now,
    updatedAt: now,
    timeValues: [],
    timeIntents: [],
  }));
  const edges = nodes.slice(0, -1).map((node, index) => ({
    id: id(30 + index),
    tripId,
    fromNodeId: node.id,
    toNodeId: nodes[index + 1]!.id,
    mode: 'RAIL' as const,
    fixedService: true,
    serviceLabel: 'SYNTHETIC',
    note: null,
    source: 'ADOPTED_ROUTE' as const,
    adoptedRouteId: routeId,
    createdAt: now,
    updatedAt: now,
    timeValues: [],
  }));
  const route = {
    id: routeId,
    tripId,
    anchorFromNodeId: nodes[0]!.id,
    anchorToNodeId: nodes[3]!.id,
    sourcePreviewId: id(40),
    candidateSnapshotId: id(41),
    candidateHash: 'a'.repeat(64),
    policyVersion: 'route-adoption-preview-v3',
    status: 'ACTIVE' as const,
    createdAt: now,
    replacedAt: null,
    undoneAt: null,
  };
  const trip: TripAggregateRecord = {
    id: tripId,
    ownerUserId,
    name: 'SYNTHETIC',
    planningAnchorDate: new Date('2030-10-01'),
    defaultPeopleCount: 1,
    version: 6,
    effectiveStartDate: new Date('2030-10-01'),
    effectiveEndDate: new Date('2030-10-01'),
    createdAt: now,
    updatedAt: now,
    ownedDates: [new Date('2030-10-01')],
    dayOccurrences: [
      {
        id: dayId,
        tripId,
        localDate: new Date('2030-10-01'),
        sequence: 0,
        createdAt: now,
        updatedAt: now,
        nodes,
      },
    ],
    transportEdges: edges,
    adoptedRoutes: [route],
  };
  const origin: ExternalOriginRecord = {
    id: id(50),
    tripId,
    kind: 'TRANSIT_HUB',
    provider: 'SYNTHETIC',
    providerHubRef: 'synthetic:E',
    canonicalHubRef: 'synthetic:hub:E',
    name: 'SYNTHETIC E',
    latitude: 35.7,
    longitude: 139.7,
    timeZone: 'Asia/Tokyo',
    status: 'ARRIVED',
    arrivedAt: new Date('2030-09-30T10:00:00Z'),
    departedAt: null,
    invalidatedAt: null,
    sourceAdoptedRouteId: routeId,
    sourceTransportEdgeId: edges[1]!.id,
    sourceGroundTransitLegExecutionId: id(51),
    sourceGroundTransitObservationId: id(52),
    sourceObservationIdentity: 'synthetic:observation',
    sourceObservationFetchedAt: new Date('2030-09-30T09:00:00Z'),
    sourceObservationFactsHash: 'b'.repeat(64),
  };
  const context: ExternalOriginPlanningContext = {
    tripId,
    tripVersion: trip.version,
    sourceRoute: route,
    sourceEdge: edges[1]!,
    origin,
    origins: [origin],
    frontierState: 'CONSISTENT',
    executionEvents: [],
    itineraryHubs: [],
    evidence: null,
    leg: {
      id: origin.sourceGroundTransitLegExecutionId,
      tripId,
      transportEdgeId: origin.sourceTransportEdgeId,
      adoptedRouteId: routeId,
      legIndex: 1,
      provider: 'SYNTHETIC',
      mode: 'RAIL',
      serviceClass: 'FIXED_SERVICE',
      serviceIdentityKey: 'synthetic:service',
      baseline: null,
      state: 'NO_LONGER_FEASIBLE',
      latestObservation: null,
      latestFetchedAt: null,
      observationCount: 1,
      deviationCount: 0,
      deviationStartedAt: null,
      current: true,
    },
  };
  const departure = {
    instant: '2030-10-01T16:00:00.000Z',
    timeZone: 'Asia/Tokyo',
  };
  const arrival = { instant: '2030-10-01T17:00:00.000Z', timeZone: 'UTC' };
  const location = {
    name: 'SYNTHETIC E',
    latitude: 35.7,
    longitude: 139.7,
    providerPlaceRef: null,
    providerHubRef: 'synthetic:E',
  };
  const time = {
    hardEarliestDeparture: now.toISOString(),
    hardLatestArrival: null,
    earliestDeparture: now.toISOString(),
    latestArrival: null,
    preference: { type: 'NONE' as const },
    hint: null,
  };
  const candidatePayload: RouteCandidatePayload = {
    candidateId: 'synthetic:route',
    provider: 'SYNTHETIC',
    providerCandidateRef: 'synthetic:route',
    observedAt: now.toISOString(),
    validUntil: null,
    queryBasisVersion: trip.version,
    queryTimeCondition: time,
    overall: { departure, arrival, durationSeconds: 3600 },
    fare: null,
    legs: [
      {
        mode: 'BUS',
        from: location,
        to: {
          ...location,
          name: 'SYNTHETIC D',
          latitude: 35.03,
          longitude: 139,
          providerHubRef: null,
        },
        departure,
        arrival,
        durationSeconds: 3600,
        fixedService: false,
        serviceLabel: null,
        providerRef: null,
      },
    ],
  };
  const evidence = externalRouteOriginSnapshot(origin);
  const snapshot: RouteCandidateSnapshotRecord = {
    id: id(53),
    ownerUserId,
    tripId,
    basisVersion: trip.version,
    origin: {
      type: 'EXTERNAL_EXECUTION_ORIGIN',
      externalOriginId: origin.id,
      snapshot: evidence,
    },
    fromNodeId: null,
    toNodeId: nodes[3]!.id,
    provider: 'SYNTHETIC',
    providerCandidateRef: 'synthetic:route',
    observedAt: now,
    providerValidUntil: null,
    candidatePayload,
    queryTimeCondition: time,
    candidateHash: hashExternalRouteCandidateSnapshot({
      tripId,
      basisVersion: trip.version,
      toNodeId: nodes[3]!.id,
      provider: 'SYNTHETIC',
      observedAt: now.toISOString(),
      candidatePayload,
      externalOriginSnapshot: evidence,
    }),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 900000),
  };
  return { trip, snapshot, context, now };
}

describe('external Preview Application policy', () => {
  it('uses trusted E timezone and candidate departure date instead of arrival history', () => {
    const f = fixture();
    const before = structuredClone(f);
    const payload = buildExternalOriginPreviewPayload(f);
    expect(payload.changeSummary.routeCorridor).toBeUndefined();
    expect(
      payload.changeSummary.externalOriginReplacement?.materializedOrigin,
    ).toMatchObject({
      localDate: '2030-10-02',
      dayOccurrenceId: null,
      temporalValues: [],
      executionEvents: [],
      evidence: 'USER_CONFIRMED',
    });
    expect(payload.changeSummary.requiredUserAdjustments).toEqual([]);
    expect(f).toEqual(before);
  });
  it.each([
    'SUPERSEDED',
    'DEPARTED',
    'INVALIDATED',
    'CONFLICT',
    'REPLACED',
    'missing-edge',
    'leg-id',
    'leg-route',
    'leg-trip',
    'metadata',
    'past-departure',
    'TTL',
    'candidate-hash',
  ] as const)('rejects %s as PREVIEW_STALE', (kind) => {
    const f = fixture();
    if (kind === 'SUPERSEDED')
      f.context = {
        ...f.context,
        executionEvents: [{ occurredAt: now, undoneAt: null }],
      };
    else if (kind === 'DEPARTED' || kind === 'INVALIDATED')
      f.context = {
        ...f.context,
        origin: {
          ...f.context.origin!,
          status: kind,
          ...(kind === 'DEPARTED'
            ? { departedAt: now }
            : { invalidatedAt: now }),
        },
      };
    else if (kind === 'CONFLICT')
      f.context = { ...f.context, frontierState: 'INCONSISTENT' };
    else if (kind === 'REPLACED')
      f.context = {
        ...f.context,
        sourceRoute: { ...f.context.sourceRoute!, status: 'REPLACED' },
      };
    else if (kind === 'missing-edge')
      f.context = { ...f.context, sourceEdge: null };
    else if (kind === 'leg-id')
      f.context = { ...f.context, leg: { ...f.context.leg!, id: id(99) } };
    else if (kind === 'leg-route')
      f.context = {
        ...f.context,
        leg: { ...f.context.leg!, adoptedRouteId: id(99) },
      };
    else if (kind === 'leg-trip')
      f.context = { ...f.context, leg: { ...f.context.leg!, tripId: id(99) } };
    else if (kind === 'metadata')
      f.context = {
        ...f.context,
        origin: { ...f.context.origin!, name: 'SYNTHETIC changed' },
      };
    else if (kind === 'past-departure')
      f.now = new Date('2030-10-01T16:00:01Z');
    else if (kind === 'TTL') f.snapshot = { ...f.snapshot, expiresAt: now };
    else f.snapshot = { ...f.snapshot, candidateHash: 'f'.repeat(64) };
    expect(() => buildExternalOriginPreviewPayload(f)).toThrow(
      expect.objectContaining({ code: 'PREVIEW_STALE' }),
    );
  });
  it.each(['zone', 'fare', 'time', 'continuity'])(
    'rejects a valid-hash but invalid provider candidate %s',
    (kind) => {
      const f = fixture();
      const payload = structuredClone(f.snapshot.candidatePayload);
      const changed =
        kind === 'zone'
          ? {
              ...payload,
              overall: {
                ...payload.overall,
                departure: {
                  ...payload.overall.departure,
                  timeZone: 'Invalid/Zone',
                },
              },
            }
          : kind === 'fare'
            ? { ...payload, fare: { amount: '-1', currency: 'JPY' } }
            : kind === 'time'
              ? {
                  ...payload,
                  overall: {
                    ...payload.overall,
                    departure: {
                      ...payload.overall.departure,
                      instant: 'not-an-instant',
                    },
                  },
                }
              : {
                  ...payload,
                  legs: [
                    payload.legs[0]!,
                    {
                      ...payload.legs[0]!,
                      from: {
                        ...payload.legs[0]!.from,
                        latitude: 0,
                        longitude: 0,
                      },
                    },
                  ],
                };
      if (f.snapshot.origin.type !== 'EXTERNAL_EXECUTION_ORIGIN')
        throw new Error('SYNTHETIC external origin expected');
      f.snapshot = {
        ...f.snapshot,
        candidatePayload: changed,
        candidateHash: hashExternalRouteCandidateSnapshot({
          tripId: f.trip.id,
          basisVersion: f.trip.version,
          toNodeId: f.snapshot.toNodeId,
          provider: f.snapshot.provider,
          observedAt: f.snapshot.observedAt.toISOString(),
          candidatePayload: changed,
          externalOriginSnapshot: f.snapshot.origin.snapshot,
        }),
      };
      expect(() => buildExternalOriginPreviewPayload(f)).toThrow(
        expect.objectContaining({
          code: kind === 'continuity' ? 'PREVIEW_UNSUPPORTED' : 'PREVIEW_STALE',
        }),
      );
    },
  );
  it('keeps materialization date in E timezone even if Provider describes departure using another valid zone', () => {
    const f = fixture();
    if (f.snapshot.origin.type !== 'EXTERNAL_EXECUTION_ORIGIN')
      throw new Error('SYNTHETIC external origin expected');
    const payload = f.snapshot.candidatePayload;
    const departure = { ...payload.overall.departure, timeZone: 'UTC' };
    const changed = {
      ...payload,
      overall: { ...payload.overall, departure },
      legs: [{ ...payload.legs[0]!, departure }],
    };
    f.snapshot = {
      ...f.snapshot,
      candidatePayload: changed,
      candidateHash: hashExternalRouteCandidateSnapshot({
        tripId: f.trip.id,
        basisVersion: f.trip.version,
        toNodeId: f.snapshot.toNodeId,
        provider: f.snapshot.provider,
        observedAt: f.snapshot.observedAt.toISOString(),
        candidatePayload: changed,
        externalOriginSnapshot: f.snapshot.origin.snapshot,
      }),
    };
    expect(
      buildExternalOriginPreviewPayload(f).changeSummary
        .externalOriginReplacement?.materializedOrigin.localDate,
    ).toBe('2030-10-02');
  });

  it('keeps v2 ACTIVE and historical v1 ADOPT_UNSUPPORTED readable through the separate save port', async () => {
    const f = fixture();
    const save = vi.fn(async (input) => ({
      status: 'SUCCESS' as const,
      preview: {
        id: id(60),
        ownerUserId: f.trip.ownerUserId,
        tripId: f.trip.id,
        basisVersion: f.trip.version,
        candidateSnapshotId: f.snapshot.id,
        candidateHash: f.snapshot.candidateHash,
        policyVersion: input.policyVersion,
        previewPayload: input.previewPayload,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      },
    }));
    const planning: RoutePlanningRepository = {
      saveCandidateSnapshots: vi.fn(),
      findSnapshotOwned: vi.fn().mockResolvedValue(f.snapshot),
      createPreview: vi.fn(),
      createExternalOriginPreview: save,
      findPreviewOwned: vi.fn(),
    };
    const trips: TripRepository = {
      create: vi.fn(),
      listOwned: vi.fn(),
      findOwnedById: vi.fn().mockResolvedValue(f.trip),
      updateMetadata: vi.fn(),
      executeCommand: vi.fn(),
      setTemporalValue: vi.fn(),
      listTransportHistoryOwned: vi.fn(),
    };
    const service = new RoutePreviewService(trips, planning, {
      previewTtlSeconds: 600,
      clock: { now: () => now },
      externalOrigins: {
        readPlanning: vi.fn().mockResolvedValue(f.context),
        read: vi.fn(),
        mutate: vi.fn(),
      },
    });
    const actor = {
      userId: f.trip.ownerUserId,
      email: 'synthetic@example.test',
      role: 'USER' as const,
      status: 'ACTIVE' as const,
    };
    const preview = await service.createPreview(actor, f.trip.id, {
      basisVersion: f.trip.version,
      candidateSnapshotId: f.snapshot.id,
    });
    expect(preview).toMatchObject({
      status: 'ACTIVE',
      adoptable: true,
      policyVersion: 'route-external-origin-preview-v2',
    });
    expect(planning.createPreview).not.toHaveBeenCalled();
    const result = await save.mock.results[0]!.value;
    vi.mocked(planning.findPreviewOwned).mockResolvedValue(result.preview);
    expect(
      await service.getPreview(actor, f.trip.id, preview.previewId),
    ).toEqual(preview);
    vi.mocked(planning.findPreviewOwned).mockResolvedValue({
      ...result.preview,
      policyVersion: 'route-external-origin-preview-v1',
      previewPayload: {
        ...result.preview.previewPayload,
        policyVersion: 'route-external-origin-preview-v1',
      },
    });
    expect(
      await service.getPreview(actor, f.trip.id, preview.previewId),
    ).toMatchObject({ status: 'ADOPT_UNSUPPORTED', adoptable: false });
    expect(trips.executeCommand).not.toHaveBeenCalled();
    expect(trips.setTemporalValue).not.toHaveBeenCalled();
  });
});
