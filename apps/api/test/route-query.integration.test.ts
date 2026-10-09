import { randomUUID } from 'node:crypto';

import {
  TripImpactService,
  AuthService,
  StaticBackupService,
  InTripReadService,
  digestOpaqueToken,
  ExecutionRiskService,
  ExecutionLocationService,
  type FlightMonitoringService,
  GroundTransitService,
  ExternalExecutionOriginService,
  externalOriginView,
  type GroundTransitHubResolver,
  GroundTransitRouteReevaluationService,
  type GroundTransitProvider,
  hashRoutePreviewPayload,
  hashRouteCandidateSnapshot,
  hashExternalRouteCandidateSnapshot,
  buildExternalOriginPreviewPayload,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  RouteUndoService,
  TripService,
  type Actor,
  type RouteProvider,
  type RouteProviderQueryInput,
  type RouteProviderResult,
  type StoredRoutePreviewPayload,
} from '@travel/application';
import type {
  AdoptRoutePreviewResponse,
  RouteAdoptDeltaV5,
  GroundTransitExecutionResponse,
  ExternalOriginResponse,
  ExternalOriginMutationResponse,
  GroundTransitRouteReevaluationHandoffView,
  RoutePreviewView,
  RouteQueryResponse,
  TripView,
} from '@travel/contracts';
import {
  createPrismaClient,
  hashPreservedRoutePrefix,
  PrismaAuthRepository,
  PrismaStaticBackupRepository,
  PrismaInTripReadRepository,
  PrismaExecutionRiskRepository,
  PrismaExecutionLocationRepository,
  PrismaGroundTransitRepository,
  PrismaExternalExecutionOriginRepository,
  PrismaGroundTransitRouteProgressRepository,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import {
  GoogleOrdinaryRouteProvider,
  baiduToWgs84,
  BaiduOrdinaryRouteProvider,
  RegionalRouteProvider,
  GoogleConsumerExperimentalRouteProvider,
  SyntheticRouteProvider,
  SyntheticGroundTransitProvider,
  SyntheticGroundTransitHubResolver,
  createDevelopmentSyntheticGroundTransitRouteProvider,
  UnconfiguredGroundTransitProvider,
} from '@travel/providers';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { buildApi } from '../src/app.js';
import {
  footprint,
  onlyWrites,
  gate,
  waitForOwnerLock,
} from './helpers/replanning-acceptance.js';
import {
  adoptionFootprint,
  setSyntheticSnapshotExpiry,
  ttlAdoptionApi,
  ttlEvidence,
  waitForAdoptionLock,
} from './helpers/adoption-evidence-ttl.js';
import {
  draftEvidence,
  draftPlanningApi,
  withHeldDraftLock,
} from './helpers/draft-evidence-ttl.js';

type JsonInput = Parameters<
  ManagedPrismaClient['client']['routePreview']['create']
>[0]['data']['previewPayload'];

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P4A1 integration tests');
}

const NOW = new Date('2030-09-01T00:00:00.000Z');

describe('P4A1 provider-neutral route query with PostgreSQL 17', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let userA: SyntheticIdentity;
  let userB: SyntheticIdentity;
  let admin: SyntheticIdentity;
  let providerInputs: RouteProviderQueryInput[];
  let providerResult: RouteProviderResult;
  let currentNow: Date;
  let externalEndpointFault:
    'origin' | 'destination' | 'hub' | 'name' | undefined;
  let providerHook: (() => Promise<void>) | undefined;
  let tripRepository: PrismaTripRepository;
  let hubResolver: GroundTransitHubResolver;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    [userA, userB, admin] = await Promise.all([
      createIdentity(managed, 'p4a1-a@synthetic.example.test', 'USER'),
      createIdentity(managed, 'p4a1-b@synthetic.example.test', 'USER'),
      createIdentity(managed, 'p4a1-admin@synthetic.example.test', 'ADMIN'),
    ]);
    hubResolver = new SyntheticGroundTransitHubResolver();
    providerInputs = [];
    currentNow = NOW;
    providerHook = undefined;
    externalEndpointFault = undefined;
    providerResult = {
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T10:00:00Z', '2030-10-01T11:00:00Z')],
    };
    const repository = new PrismaTripRepository(managed.client);
    tripRepository = repository;
    const provider = new SyntheticRouteProvider(async (input) => {
      providerInputs.push(input);
      await providerHook?.();
      return providerResult;
    });
    app = buildTestApi(provider);
  });

  function buildTestApi(
    provider: RouteProvider,
    groundProvider: GroundTransitProvider = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    ),
  ): FastifyInstance {
    const routePlanningRepository = new PrismaRoutePlanningRepository(
      managed.client,
      { now: () => currentNow },
    );
    const groundTransitRepository = new PrismaGroundTransitRepository(
      managed.client,
    );
    const executionRiskService = new ExecutionRiskService(
      tripRepository,
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => currentNow, groundTransitRepository },
    );
    const externalOrigins = new ExternalExecutionOriginService(
      new PrismaExternalExecutionOriginRepository(managed.client),
      hubResolver,
      () => currentNow,
    );
    const impactInTrip = new InTripReadService(
      new PrismaInTripReadRepository(managed.client),
    );
    const impactGround = new GroundTransitService(
      groundTransitRepository,
      groundProvider,
      () => currentNow,
    );
    const impactHandoff = new GroundTransitRouteReevaluationService(
      tripRepository,
      groundTransitRepository,
      new PrismaGroundTransitRouteProgressRepository(managed.client),
      () => currentNow,
      externalOrigins,
    );
    return buildApi({
      tripImpactService: new TripImpactService(
        tripRepository,
        groundTransitRepository,
        impactGround,
        impactHandoff,
        impactInTrip,
        () => currentNow,
      ),
      inTripReadService: new InTripReadService(
        new PrismaInTripReadRepository(managed.client),
      ),
      externalExecutionOriginService: externalOrigins,
      readinessProbe: {
        async check() {
          return { name: 'postgresql', status: 'READY' };
        },
      },
      authService: new AuthService(
        new PrismaAuthRepository(managed.client),
        authConfig(),
      ),
      tripService: new TripService(tripRepository),
      staticBackupService: new StaticBackupService(
        new PrismaStaticBackupRepository(managed.client),
      ),
      routeQueryService: new RouteQueryService(
        tripRepository,
        provider,
        routePlanningRepository,
        {
          externalOrigins: new PrismaExternalExecutionOriginRepository(
            managed.client,
          ),
          candidateSnapshotTtlSeconds: 900,
          clock: { now: () => currentNow },
        },
      ),
      routePreviewService: new RoutePreviewService(
        tripRepository,
        routePlanningRepository,
        {
          externalOrigins: new PrismaExternalExecutionOriginRepository(
            managed.client,
          ),
          previewTtlSeconds: 600,
          clock: { now: () => currentNow },
        },
      ),
      routeAdoptionService: new RouteAdoptionService(
        routePlanningRepository,
        new TripService(tripRepository),
        { undoWindowSeconds: 600, clock: { now: () => currentNow } },
      ),
      routeUndoService: new RouteUndoService(
        routePlanningRepository,
        new TripService(tripRepository),
        { now: () => currentNow },
      ),
      groundTransitService: new GroundTransitService(
        groundTransitRepository,
        groundProvider,
        () => currentNow,
        executionRiskService,
      ),
      groundTransitRouteReevaluationService:
        new GroundTransitRouteReevaluationService(
          tripRepository,
          groundTransitRepository,
          new PrismaGroundTransitRouteProgressRepository(managed.client),
          () => currentNow,
          externalOrigins,
        ),
      executionRiskService,
      executionLocationService: new ExecutionLocationService(
        new PrismaExecutionLocationRepository(managed.client),
        executionRiskService,
        { trigger: async () => ({}) } as unknown as FlightMonitoringService,
        { now: () => currentNow },
      ),
    });
  }

  async function adoptedFixedGroundTrip(
    schedule: {
      readonly now: string;
      readonly departure: string;
      readonly arrival: string;
    } = {
      now: '2030-10-01T09:50:00Z',
      departure: '2030-10-01T10:00:00Z',
      arrival: '2030-10-01T11:00:00Z',
    },
    mode: 'RAIL' | 'BUS' = 'RAIL',
  ) {
    currentNow = new Date(schedule.now);
    const trip = await tripWithVisits(userA, [
      'Ground origin',
      'Ground destination',
    ]);
    const [from, to] = trip.days[0]!.nodes;
    const base = candidate(schedule.departure, schedule.arrival, 'UTC', 'UTC');
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...base,
          observedAt: currentNow,
          candidateId: `ground-operational-${randomUUID()}`,
          legs: [
            {
              ...base.legs[0]!,
              mode,
              groundTransit: {
                serviceClass: 'FIXED_SERVICE',
                serviceIdentityKey: 'synthetic:operational:1',
                lineRef: 'rail-1',
                lineName: 'Rail 1',
                directionRef: 'east',
                directionLabel: 'East',
                boardingHubRef: 'A',
                alightingHubRef: 'D',
                headwayMinSeconds: null,
                headwayMaxSeconds: null,
                minimumTransferSeconds: 300,
                boardingAccessMinimumSeconds: 0,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `ground-operational-${randomUUID()}`,
    );
    const leg = await managed.client.groundTransitLegExecution.findFirstOrThrow(
      {
        where: { tripId: trip.id },
      },
    );
    return { trip, adopted, leg, from: from! };
  }

  it('P6B-2 preserves adopted saved route legs without Query/Preview/Adopt or Trip writes', async () => {
    const f = await adoptedFixedGroundTrip();
    const t = f.adopted.trip;
    const backup = new StaticBackupService(
      new PrismaStaticBackupRepository(managed.client),
    );
    const before = await externalDurableState(t.id),
      calls = providerInputs.length;
    const saved = await backup.generate(userA.actor, t.id, {
      baseTripVersion: t.version,
      idempotencyKey: randomUUID(),
    });
    expect(saved.routes[0]!.legs).toEqual(
      t.savedRoutes![0]!.legs.map((l) => ({
        mode: l.mode,
        from: {
          name: l.from.name,
          address: null,
          latitude: l.from.latitude,
          longitude: l.from.longitude,
        },
        to: {
          name: l.to.name,
          address: null,
          latitude: l.to.latitude,
          longitude: l.to.longitude,
        },
        departure: l.departure,
        arrival: l.arrival,
        durationSeconds: l.durationSeconds,
        fixedService: l.fixedService,
        serviceLabel: l.serviceLabel,
      })),
    );
    expect(saved.transports.map((e) => e.id)).toEqual(
      t.connections.flatMap((c) => (c.transport ? [c.transport.id] : [])),
    );
    expect(await externalDurableState(t.id)).toEqual(before);
    expect(providerInputs.length).toBe(calls);
  });

  it('P6A-2 authoring cannot silently archive or move the endpoints of adopted transport', async () => {
    const f = await adoptedFixedGroundTrip();
    const trip = f.adopted.trip;
    const before = await externalDurableState(trip.id);
    const count = await managed.client.tripAuthoringReceipt.count({
      where: { tripId: trip.id },
    });
    const readSaved = async () => {
      const read = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}/in-trip`,
        headers: bearer(userA),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        tripVersion: trip.version,
        execution: { state: 'NOT_STARTED' },
      });
      const reopened = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}`,
        headers: bearer(userA),
      });
      expect(reopened.json().savedRoutes).toEqual(trip.savedRoutes);
      expect(await externalDurableState(trip.id)).toEqual(before);
    };
    await readSaved();
    for (const command of [
      {
        type: 'MOVE_NODE',
        nodeId: f.from.id,
        targetDay: { type: 'NEW', localDate: '2030-10-02', sequence: 1 },
        position: 0,
      },
      {
        type: 'ADD_FREE_ACTION',
        targetDay: {
          type: 'EXISTING',
          dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
        },
        position: 1,
        note: 'SYNTHETIC insert between selected transport',
      },
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/authoring`,
        headers: bearer(userA),
        payload: {
          baseTripVersion: trip.version,
          idempotencyKey: randomUUID(),
          command,
        },
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe('CONSTRAINT_CONFLICT');
      expect(await externalDurableState(trip.id)).toEqual(before);
      await readSaved();
      expect(
        await managed.client.tripAuthoringReceipt.count({
          where: { tripId: trip.id },
        }),
      ).toBe(count);
    }
  });

  function groundSequence(
    changes: readonly (
      | 'CANCELLED'
      | 'RECOVERY'
      | 'RECOVERY_WITH_SERVICE_DEPARTURE'
      | 'SHORT_TURN'
      | 'SHORT_TURN_F'
      | 'ACTUAL_MISS'
      | 'DELAY_16'
      | 'DELAY_17'
      | 'DELAY_31'
    )[],
  ): GroundTransitProvider {
    let index = 0;
    let replay = false;
    return {
      name: 'SYNTHETIC',
      async fetchObservation({ leg }) {
        const selected = replay ? index - 1 : index++;
        const kind = changes[Math.min(selected, changes.length - 1)]!;
        const source = new SyntheticGroundTransitProvider(
          kind === 'SHORT_TURN' || kind === 'SHORT_TURN_F'
            ? 'SHORT_TURN'
            : 'RECOVERY',
          () => currentNow,
        );
        const result = await source.fetchObservation({ leg });
        if (result.status !== 'SUCCESS') return result;
        const plannedArrival = leg.baseline?.plannedArrival ?? null;
        const delayMinutes =
          kind === 'DELAY_16'
            ? 16
            : kind === 'DELAY_17'
              ? 17
              : kind === 'DELAY_31'
                ? 31
                : null;
        return {
          status: 'SUCCESS',
          observation: {
            ...result.observation,
            ...(kind === 'SHORT_TURN_F'
              ? {
                  currentTerminusRef: 'synthetic:second-terminus',
                  operatingToHubRef: 'synthetic:second-terminus',
                  currentTerminusLabel: 'Synthetic F',
                }
              : {}),
            observationIdentity: `operational:${leg.id}:${selected}`,
            serviceStatus:
              kind === 'CANCELLED'
                ? ('CANCELLED' as const)
                : delayMinutes === null
                  ? ('ON_TIME' as const)
                  : ('DELAYED' as const),
            estimatedArrival:
              delayMinutes === null || plannedArrival === null
                ? null
                : new Date(plannedArrival.getTime() + delayMinutes * 60_000),
            actualDeparture:
              kind === 'ACTUAL_MISS' ||
              kind === 'RECOVERY_WITH_SERVICE_DEPARTURE'
                ? new Date('2030-10-01T10:00:00Z')
                : null,
          },
        };
      },
      // Tests switch this flag only for an exact accepted-observation replay.
      setReplay(value: boolean) {
        replay = value;
      },
    } as GroundTransitProvider & { setReplay(value: boolean): void };
  }

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await resetSyntheticData(managed);
    await managed.close();
  });

  // This test adapter returns the requested endpoints, like the synthetic production adapter.
  // Fault injection deliberately contradicts them for malformed-response regressions.
  function externalProviderResult(
    input: RouteProviderQueryInput,
  ): RouteProviderResult {
    if (providerResult.status !== 'SUCCESS') return providerResult;
    return {
      ...providerResult,
      candidates: providerResult.candidates.map((candidate) => ({
        ...candidate,
        legs: candidate.legs.map((leg, index) => ({
          ...leg,
          from:
            index === 0
              ? {
                  ...input.origin,
                  providerPlaceRef: null,
                  providerHubRef: null,
                  ...(externalEndpointFault === 'origin'
                    ? { latitude: input.origin.latitude! + 1 }
                    : {}),
                  ...(externalEndpointFault === 'hub'
                    ? { providerHubRef: 'synthetic:wrong-hub' }
                    : {}),
                  ...(externalEndpointFault === 'name'
                    ? { latitude: null, longitude: null }
                    : {}),
                }
              : leg.from,
          to:
            index === candidate.legs.length - 1
              ? {
                  ...input.destination,
                  providerPlaceRef: null,
                  providerHubRef: null,
                  ...(externalEndpointFault === 'destination'
                    ? { longitude: input.destination.longitude! + 1 }
                    : {}),
                }
              : leg.to,
        })),
      })),
    };
  }

  function cloneNodeRoute<T extends { anchorFromSnapshot: unknown }>(route: T) {
    const { anchorFromSnapshot: unused, ...rest } = route;
    void unused;
    return rest;
  }
  async function preserveLegacyExternalPreview(previewId: string) {
    const row = await managed.client.routePreview.findUniqueOrThrow({
      where: { id: previewId },
    });
    const payload = {
      ...(row.previewPayload as unknown as StoredRoutePreviewPayload),
      policyVersion: 'route-external-origin-preview-v1',
    };
    await managed.client.routePreview.update({
      where: { id: previewId },
      data: {
        policyVersion: payload.policyVersion,
        previewPayload: payload as unknown as JsonInput,
        previewHash: hashRoutePreviewPayload(payload),
      },
    });
    const result = await app.inject({
      method: 'GET',
      url: `/trips/${row.tripId}/previews/${row.id}`,
      headers: bearer(userA),
    });
    expect(result.json()).toMatchObject({
      status: 'ADOPT_UNSUPPORTED',
      adoptable: false,
      policyVersion: 'route-external-origin-preview-v1',
    });
  }

  async function externalFixture(
    changes: Parameters<typeof groundSequence>[0] = ['SHORT_TURN'],
  ) {
    const f = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(async (input) => {
        providerInputs.push(input);
        await providerHook?.();
        return externalProviderResult(input);
      }),
      groundSequence(changes),
    );
    const base = `/trips/${f.trip.id}/execution/ground-transit/${f.leg.transportEdgeId}`;
    const refreshed = await app.inject({
      method: 'POST',
      url: `${base}/refresh`,
      headers: bearer(userA),
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const trip = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    const view = (
      await app.inject({
        method: 'GET',
        url: `${base}/external-origin`,
        headers: bearer(userA),
      })
    ).json<ExternalOriginResponse>();
    return {
      ...f,
      trip,
      base,
      view,
      to: trip.days
        .flatMap((day) => day.nodes)
        .find(
          (node) => node.id !== f.from.id && node.source !== 'ROUTE_GENERATED',
        )!,
    };
  }
  function confirmExternal(
    f: Awaited<ReturnType<typeof externalFixture>>,
    key = randomUUID(),
    version = f.trip.version,
  ) {
    return app.inject({
      method: 'POST',
      url: `${f.base}/external-origin/confirm`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: version,
        candidateRef: f.view.candidate!.candidateRef,
        idempotencyKey: key,
      },
    });
  }
  async function externalFootprint(tripId: string) {
    return {
      planning: await repairDurableState(tripId),
      places: await managed.client.place.findMany({ orderBy: { id: 'asc' } }),
    };
  }
  async function nextExternalCandidate(
    f: Awaited<ReturnType<typeof externalFixture>>,
  ) {
    const originalResolver = new SyntheticGroundTransitHubResolver();
    hubResolver.resolveHub = async (input) =>
      input.provider === 'SYNTHETIC' &&
      input.providerHubRef === 'synthetic:second-terminus'
        ? {
            status: 'RESOLVED',
            hub: {
              provider: 'SYNTHETIC',
              providerHubRef: 'synthetic:second-terminus',
              canonicalHubRef: 'synthetic:hub:second-terminus',
              name: 'Synthetic Second Terminus',
              latitude: 35.71,
              longitude: 139.71,
              timeZone: 'Asia/Tokyo',
            },
          }
        : originalResolver.resolveHub(input);
    currentNow = new Date(currentNow.getTime() + 60_000);
    const refresh = await app.inject({
      method: 'POST',
      url: `${f.base}/refresh`,
      headers: bearer(userA),
    });
    expect(refresh.statusCode, refresh.body).toBe(200);
    f.trip = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    f.view = (
      await app.inject({
        method: 'GET',
        url: `${f.base}/external-origin`,
        headers: bearer(userA),
      })
    ).json<ExternalOriginResponse>();
    expect(f.view.candidate).toMatchObject({
      providerHubRef: 'synthetic:second-terminus',
    });
  }
  async function supersededExternalFixture() {
    const f = await externalFixture(['SHORT_TURN', 'SHORT_TURN_F']);
    const confirmation = await confirmExternal(f);
    expect(confirmation.statusCode, confirmation.body).toBe(200);
    const e = confirmation.json<ExternalOriginMutationResponse>();
    f.trip = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    currentNow = new Date(currentNow.getTime() + 60_000);
    await manualExecution(
      f.trip,
      f.from.id,
      'MANUAL_ARRIVAL',
      currentNow.toISOString(),
    );
    await nextExternalCandidate(f);
    expect(f.view).toMatchObject({
      availability: 'CONFIRMATION_REQUIRED',
      currentOrigin: {
        id: e.origin.id,
        status: 'ARRIVED',
        currentness: 'SUPERSEDED',
      },
    });
    return { f, e };
  }
  async function externalDurableState(tripId: string) {
    return {
      footprint: await externalFootprint(tripId),
      origins: await managed.client.externalExecutionOrigin.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      receipts: await managed.client.externalExecutionOriginReceipt.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
    };
  }
  async function externalPreviewFixture(
    sourceIndex = 1,
    changes: Parameters<typeof groundSequence>[0] = ['SHORT_TURN'],
  ) {
    const f = await suffixFixture(false, false, false);
    currentNow = new Date('2030-10-01T10:29:00Z');
    const source =
      await managed.client.groundTransitLegExecution.findFirstOrThrow({
        where: {
          adoptedRouteId: f.first.operationReceipt.adoptedRouteId,
          legIndex: sourceIndex,
        },
      });
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(async (input) => {
        providerInputs.push(input);
        await providerHook?.();
        return externalProviderResult(input);
      }),
      groundSequence(changes),
    );
    const base = `/trips/${f.first.trip.id}/execution/ground-transit/${source.transportEdgeId}`;
    const refreshed = await app.inject({
      method: 'POST',
      url: `${base}/refresh`,
      headers: bearer(userA),
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const candidateView = (
      await app.inject({
        method: 'GET',
        url: `${base}/external-origin`,
        headers: bearer(userA),
      })
    ).json<ExternalOriginResponse>();
    const confirmed = await app.inject({
      method: 'POST',
      url: `${base}/external-origin/confirm`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: await readVersion(f.first.trip.id),
        candidateRef: candidateView.candidate!.candidateRef,
        idempotencyKey: randomUUID(),
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const origin = confirmed.json<ExternalOriginMutationResponse>().origin;
    const externalCandidate = candidate(
      '2030-10-01T10:30:00Z',
      '2030-10-01T11:00:00Z',
      'Asia/Tokyo',
      'UTC',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...externalCandidate,
          legs: externalCandidate.legs.map((leg) => ({
            ...leg,
            mode: 'RAIL' as const,
          })),
        },
      ],
    };
    const queryResult = await app.inject({
      method: 'POST',
      url: `/trips/${f.first.trip.id}/execution/external-origins/${origin.id}/routes/query`,
      headers: bearer(userA),
      payload: {
        basisVersion: await readVersion(f.first.trip.id),
        toNodeId: f.D.id,
      },
    });
    expect(queryResult.statusCode, queryResult.body).toBe(200);
    const snapshotId = queryResult.json().candidates[0]
      .candidateSnapshotId as string;
    return { ...f, tripId: f.first.trip.id, source, origin, base, snapshotId };
  }
  async function previewFormalState(tripId: string) {
    const state = await externalDurableState(tripId);
    const { routePreviews: _previews, ...planning } = state.footprint.planning;
    void _previews;
    return {
      ...state,
      footprint: { ...state.footprint, planning },
      jobs: await managed.client.job.findMany({ orderBy: { id: 'asc' } }),
    };
  }
  async function previewFromExternalFixture(
    f: Awaited<ReturnType<typeof externalPreviewFixture>>,
    identity = userA,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${f.tripId}/previews`,
      headers: bearer(identity),
      payload: {
        basisVersion: await readVersion(f.tripId),
        candidateSnapshotId: f.snapshotId,
      },
    });
  }

  async function externalAdoptFixture(sourceIndex = 1) {
    const f = await externalPreviewFixture(sourceIndex);
    const previewResponse = await previewFromExternalFixture(f);
    expect(previewResponse.statusCode, previewResponse.body).toBe(201);
    const preview = previewResponse.json<RoutePreviewView>();
    expect(preview).toMatchObject({ status: 'ACTIVE', adoptable: true });
    return {
      ...f,
      preview,
      beforeTrip: { ...f.first.trip, version: preview.basisVersion },
    };
  }
  async function groundHistory(routeId: string) {
    return {
      legs: await managed.client.groundTransitLegExecution.findMany({
        where: { adoptedRouteId: routeId },
        orderBy: { id: 'asc' },
      }),
      observations: await managed.client.groundTransitObservation.findMany({
        where: { legExecution: { adoptedRouteId: routeId } },
        orderBy: { id: 'asc' },
      }),
      transitions: await managed.client.groundTransitStateTransition.findMany({
        where: { legExecution: { adoptedRouteId: routeId } },
        orderBy: { id: 'asc' },
      }),
    };
  }
  async function externalExecutionAdoptFixture(
    modes: readonly ('RAIL' | 'BUS' | 'WALKING')[] = ['RAIL'],
  ) {
    const f = await externalPreviewFixture();
    const route = candidate(
      '2030-10-01T10:30:00Z',
      '2030-10-01T11:00:00Z',
      'Asia/Tokyo',
      'UTC',
    );
    const template = route.legs[0]!;
    const transfer = {
      name: 'SYNTHETIC R2 transfer',
      latitude: 35.74,
      longitude: 139.74,
      providerHubRef: 'synthetic:r2:transfer',
      providerPlaceRef: null,
    };
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...route,
          legs: modes.map((mode, index) => ({
            ...template,
            mode,
            from: index === 0 ? template.from : transfer,
            to: index === modes.length - 1 ? template.to : transfer,
            departure:
              index === 0
                ? route.departure
                : {
                    instant: new Date('2030-10-01T10:45:00Z'),
                    timeZone: 'UTC',
                  },
            arrival:
              index === modes.length - 1
                ? route.arrival
                : {
                    instant: new Date('2030-10-01T10:45:00Z'),
                    timeZone: 'UTC',
                  },
            durationSeconds: 1800 / modes.length,
            fixedService: false,
            groundTransit:
              mode === 'WALKING'
                ? null
                : {
                    serviceClass: 'HIGH_FREQUENCY' as const,
                    serviceIdentityKey: `synthetic:r2:service:${index}`,
                    lineRef: `synthetic:r2:line:${index}`,
                    lineName: 'SYNTHETIC R2 line',
                    directionRef: 'synthetic:outbound',
                    directionLabel: 'Outbound',
                    boardingHubRef:
                      index === 0
                        ? f.origin.providerHubRef
                        : transfer.providerHubRef,
                    alightingHubRef:
                      index === modes.length - 1
                        ? 'synthetic:D'
                        : transfer.providerHubRef,
                    headwayMinSeconds: 120,
                    headwayMaxSeconds: 300,
                    minimumTransferSeconds: null,
                  },
          })),
        },
      ],
    };
    const queried = await app.inject({
      method: 'POST',
      url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
      headers: bearer(userA),
      payload: { basisVersion: await readVersion(f.tripId), toNodeId: f.D.id },
    });
    expect(queried.statusCode, queried.body).toBe(200);
    f.snapshotId = queried.json().candidates[0].candidateSnapshotId;
    const preview = (
      await previewFromExternalFixture(f)
    ).json<RoutePreviewView>();
    expect(preview).toMatchObject({ status: 'ACTIVE', adoptable: true });
    const response = await adopt(
      userA,
      { ...f.first.trip, version: preview.basisVersion },
      preview.previewId,
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(200);
    const adopted = response.json<AdoptRoutePreviewResponse>();
    return {
      ...f,
      adopted,
      delta: adopted.operationReceipt.delta as RouteAdoptDeltaV5,
    };
  }

  async function externalR2ObservationInput(
    f: Awaited<ReturnType<typeof externalExecutionAdoptFixture>>,
    legIndex = 0,
  ) {
    const leg = await managed.client.groundTransitLegExecution.findFirstOrThrow(
      {
        where: {
          adoptedRouteId: f.adopted.operationReceipt.adoptedRouteId,
          legIndex,
        },
      },
    );
    const repository = new PrismaGroundTransitRepository(managed.client);
    const current = await repository.findCurrentOwned({
      ownerUserId: userA.actor.userId,
      tripId: f.tripId,
      transportEdgeId: leg.transportEdgeId,
    });
    expect(current).not.toBeNull();
    const result = await new SyntheticGroundTransitProvider(
      'ON_TIME',
      () => currentNow,
    ).fetchObservation({ leg: current! });
    if (result.status !== 'SUCCESS')
      throw new Error('SYNTHETIC R2 observation unavailable');
    return {
      leg,
      input: {
        ownerUserId: userA.actor.userId,
        tripId: f.tripId,
        transportEdgeId: leg.transportEdgeId,
        observation: result.observation,
        now: currentNow,
      },
    };
  }
  async function commitExternalR2Observation(
    f: Awaited<ReturnType<typeof externalExecutionAdoptFixture>>,
    legIndex = 0,
  ) {
    const { leg, input } = await externalR2ObservationInput(f, legIndex);
    const committed = await new PrismaGroundTransitRepository(
      managed.client,
    ).commitObservation(input);
    expect(committed.status).toBe('APPLIED');
    return leg;
  }

  it('PR37 execution fence: real R2 Provider observation without TransportEdge ACTUAL blocks Undo with zero writes', async () => {
    const f = await externalExecutionAdoptFixture();
    const leg = await commitExternalR2Observation(f);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.temporalValue.count({
        where: {
          transportEdgeId: { in: [...f.delta.createdTransportEdgeIds] },
          layer: 'ACTUAL',
        },
      }),
    ).toBe(0);
    expect(await readVersion(f.tripId)).toBe(f.adopted.trip.version);
    const before = await previewFormalState(f.tripId);
    const history = await groundHistory(
      f.adopted.operationReceipt.adoptedRouteId,
    );
    const response = await undo(
      userA,
      f.adopted.trip,
      f.adopted.operationReceipt.id,
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'UNDO_CONFLICT' } });
    expect(await previewFormalState(f.tripId)).toEqual(before);
    expect(
      await groundHistory(f.adopted.operationReceipt.adoptedRouteId),
    ).toEqual(history);
  });
  it.each([
    { modes: ['RAIL'] as const },
    { modes: ['WALKING'] as const },
    { modes: ['RAIL', 'BUS'] as const },
  ])(
    'PR37 execution fence: immediate Undo includes initial transitions for %j',
    async ({ modes }) => {
      const f = await externalExecutionAdoptFixture(modes);
      const facts = f.delta.afterGroundTransitLegFacts;
      expect(facts).toHaveLength(
        modes.filter((mode) => mode !== 'WALKING').length,
      );
      expect(f.delta.createdGroundTransitTransportEdgeIds).toEqual(
        facts.map((leg) => String(leg.transportEdgeId)).sort(),
      );
      for (const leg of facts)
        expect(leg).toMatchObject({
          adoptedRouteId: f.adopted.operationReceipt.adoptedRouteId,
          tripId: f.tripId,
          state: 'PENDING',
          latestFetchedAt: null,
          latestObservationId: null,
          latestObservationHash: null,
          latestObservation: null,
          observations: [],
          stateTransitions: [
            {
              fromState: null,
              toState: 'PENDING',
              source: 'ROUTE_ADOPT',
              evidenceRef: `adopted-route:${f.adopted.operationReceipt.adoptedRouteId}`,
            },
          ],
        });
      await managed.client.groundTransitLegExecution.updateMany({
        where: { adoptedRouteId: f.adopted.operationReceipt.adoptedRouteId },
        data: { updatedAt: new Date('2031-01-01T00:00:00Z') },
      });
      const response = await undo(
        userA,
        f.adopted.trip,
        f.adopted.operationReceipt.id,
        randomUUID(),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(
        await managed.client.itineraryNode.count({
          where: { id: f.delta.materializedOriginNodeId },
        }),
      ).toBe(0);
    },
  );
  async function expectExecutionUndoConflict(
    f: Awaited<ReturnType<typeof externalExecutionAdoptFixture>>,
  ) {
    expect(
      await managed.client.temporalValue.count({
        where: {
          transportEdgeId: { in: [...f.delta.createdTransportEdgeIds] },
          layer: 'ACTUAL',
        },
      }),
    ).toBe(0);
    const before = await previewFormalState(f.tripId);
    const ground = await groundHistory(
      f.adopted.operationReceipt.adoptedRouteId,
    );
    const response = await undo(
      userA,
      f.adopted.trip,
      f.adopted.operationReceipt.id,
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'UNDO_CONFLICT' } });
    expect(await previewFormalState(f.tripId)).toEqual(before);
    expect(
      await groundHistory(f.adopted.operationReceipt.adoptedRouteId),
    ).toEqual(ground);
  }
  it.each([0, 1])(
    'PR37 execution fence: observation on either multi-leg R2 leg %s blocks Undo',
    async (index) => {
      const f = await externalExecutionAdoptFixture(['RAIL', 'BUS']);
      expect(f.delta.afterGroundTransitLegFacts).toHaveLength(2);
      await commitExternalR2Observation(f, index);
      await expectExecutionUndoConflict(f);
    },
  );
  it('PR37 execution fence: incomplete multi-leg receipt audit cannot ignore a live R2 ground leg', async () => {
    const f = await externalExecutionAdoptFixture(['RAIL', 'BUS']);
    const omitted = f.delta.afterGroundTransitLegFacts[0]!;
    await managed.client.operationReceipt.update({
      where: { id: f.adopted.operationReceipt.id },
      data: {
        delta: {
          ...f.delta,
          afterGroundTransitLegFacts:
            f.delta.afterGroundTransitLegFacts.slice(1),
          createdGroundTransitTransportEdgeIds:
            f.delta.createdGroundTransitTransportEdgeIds.filter(
              (id) => id !== omitted.transportEdgeId,
            ),
        } as unknown as JsonInput,
      },
    });
    await expectExecutionUndoConflict(f);
  });

  it('PR37 execution fence: real derived location state advancement without edge ACTUAL blocks Undo', async () => {
    const f = await externalExecutionAdoptFixture();
    await managed.client.tripAssistanceCapability.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: f.tripId,
        kind: 'LOCATION_ASSISTANCE',
        state: 'ENABLED',
        revision: 1,
        enabledAt: currentNow,
      },
    });
    await new PrismaGroundTransitRepository(
      managed.client,
    ).recordDerivedLocationTransition({
      ownerUserId: userA.actor.userId,
      tripId: f.tripId,
      nodeId: f.delta.materializedOriginNodeId,
      transition: 'DEPARTURE',
      observedAt: currentNow,
      expectedLocationCapabilityRevision: 1,
    });
    const ground = await groundHistory(
      f.adopted.operationReceipt.adoptedRouteId,
    );
    expect(ground.observations).toHaveLength(0);
    expect(ground.legs[0]).toMatchObject({ state: 'IN_PROGRESS' });
    expect(ground.transitions).toHaveLength(2);
    expect(
      ground.transitions.some((t) => t.source === 'LOCATION_ASSISTANCE'),
    ).toBe(true);
    expect(await readVersion(f.tripId)).toBe(f.adopted.trip.version);
    await expectExecutionUndoConflict(f);
  });
  it.each([
    'delete',
    'extra-leg',
    'baseline',
    'service-identity',
    'transport-edge',
    'state',
    'provider',
    'leg-index',
    'latest-fetched',
    'latest-id',
    'latest-hash',
    'latest-facts',
    'deviation-start',
    'deviation-count',
    'next-check',
    'transition-delete',
    'transition-edit',
    'transition-add',
    'observation-delete',
    'observation-edit',
  ])(
    'PR37 execution fence: %s tampering without version increment blocks Undo',
    async (kind) => {
      const f = await externalExecutionAdoptFixture();
      const leg =
        await managed.client.groundTransitLegExecution.findFirstOrThrow({
          where: { adoptedRouteId: f.adopted.operationReceipt.adoptedRouteId },
        });
      if (kind === 'delete')
        await managed.client.groundTransitLegExecution.delete({
          where: { id: leg.id },
        });
      else if (kind === 'extra-leg') {
        const { latestObservation: unused, ...copy } = leg;
        void unused;
        await managed.client.groundTransitLegExecution.create({
          data: {
            ...copy,
            id: randomUUID(),
            transportEdgeId: randomUUID(),
            baseline: leg.baseline as JsonInput,
          },
        });
      } else if (kind === 'transition-delete')
        await managed.client.groundTransitStateTransition.deleteMany({
          where: { legExecutionId: leg.id },
        });
      else if (kind === 'transition-edit')
        await managed.client.groundTransitStateTransition.updateMany({
          where: { legExecutionId: leg.id },
          data: { evidenceRef: 'SYNTHETIC tampered' },
        });
      else if (kind === 'transition-add')
        await managed.client.groundTransitStateTransition.create({
          data: {
            legExecutionId: leg.id,
            fromState: 'PENDING',
            toState: 'PENDING',
            source: 'PROVIDER_OBSERVATION',
            evidenceRef: 'SYNTHETIC additional transition',
            occurredAt: currentNow,
          },
        });
      else if (kind === 'observation-delete' || kind === 'observation-edit') {
        await commitExternalR2Observation(f);
        if (kind === 'observation-delete')
          await managed.client.groundTransitObservation.deleteMany({
            where: { legExecutionId: leg.id },
          });
        else
          await managed.client.groundTransitObservation.updateMany({
            where: { legExecutionId: leg.id },
            data: {
              factsHash: 'f'.repeat(64),
              facts: { schema: 'SYNTHETIC tampered' },
            },
          });
      } else {
        const data =
          kind === 'baseline'
            ? { baseline: { schemaVersion: 'SYNTHETIC tampered' } }
            : kind === 'service-identity'
              ? { serviceIdentityKey: 'SYNTHETIC tampered' }
              : kind === 'transport-edge'
                ? { transportEdgeId: randomUUID() }
                : kind === 'state'
                  ? { state: 'IN_PROGRESS' as const }
                  : kind === 'provider'
                    ? { provider: 'SYNTHETIC_OTHER' }
                    : kind === 'leg-index'
                      ? { legIndex: 9 }
                      : kind === 'latest-fetched'
                        ? { latestFetchedAt: currentNow }
                        : kind === 'latest-id'
                          ? { latestObservationId: 'SYNTHETIC changed' }
                          : kind === 'latest-hash'
                            ? { latestObservationHash: 'f'.repeat(64) }
                            : kind === 'latest-facts'
                              ? {
                                  latestObservation: {
                                    provider: 'SYNTHETIC changed',
                                  },
                                }
                              : kind === 'deviation-start'
                                ? { deviationStartedAt: currentNow }
                                : kind === 'deviation-count'
                                  ? { deviationCount: 1 }
                                  : { nextCheckAt: currentNow };
        await managed.client.groundTransitLegExecution.update({
          where: { id: leg.id },
          data,
        });
      }
      expect(await readVersion(f.tripId)).toBe(f.adopted.trip.version);
      await expectExecutionUndoConflict(f);
    },
  );
  function executionGate() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  async function waitForOwnerLockWait() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await managed.client.$queryRawUnsafe<{ count: number }[]>(
        `SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND position('pg_advisory_xact_lock' in query)>0 AND pid<>pg_backend_pid()`,
      );
      if ((rows[0]?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(
      'SYNTHETIC concurrent operation did not wait on owner lock',
    );
  }
  it.each(['undo', 'observation'] as const)(
    'PR37 execution fence: %s wins owner/Trip locks with no lost observation',
    async (winner) => {
      const f = await externalExecutionAdoptFixture();
      const { input, leg } = await externalR2ObservationInput(f);
      const held = executionGate();
      const release = executionGate();
      const extended = managed.client.$extends({
        query: {
          adoptedRoute: {
            async updateMany({ args, query }) {
              const result = await query(args);
              if (winner === 'undo' && args.data.status === 'UNDONE') {
                held.resolve();
                await release.promise;
              }
              return result;
            },
          },
          groundTransitObservation: {
            async create({ args, query }) {
              const result = await query(args);
              if (winner === 'observation') {
                held.resolve();
                await release.promise;
              }
              return result;
            },
          },
        },
      });
      const service = new RouteUndoService(
        new PrismaRoutePlanningRepository(
          extended as unknown as ManagedPrismaClient['client'],
        ),
        new TripService(tripRepository),
        { now: () => currentNow },
      );
      const repository = new PrismaGroundTransitRepository(
        extended as unknown as ManagedPrismaClient['client'],
      );
      const runUndo = () =>
        service
          .undoAdoption(userA.actor, f.tripId, f.adopted.operationReceipt.id, {
            baseTripVersion: f.adopted.trip.version,
            idempotencyKey: randomUUID(),
          })
          .then(
            (response) => ({ status: 'SUCCESS', response }),
            (error: { code: string }) => ({ status: error.code }),
          );
      let pendingUndo: ReturnType<typeof runUndo>;
      let pendingObservation: ReturnType<typeof repository.commitObservation>;
      try {
        if (winner === 'undo') {
          pendingUndo = runUndo();
          await held.promise;
          pendingObservation = repository.commitObservation(input);
        } else {
          pendingObservation = repository.commitObservation(input);
          await held.promise;
          pendingUndo = runUndo();
        }
        await waitForOwnerLockWait();
      } finally {
        release.resolve();
      }
      const [undoResult, observationResult] = await Promise.all([
        pendingUndo!,
        pendingObservation!,
      ]);
      expect(undoResult.status).toBe(
        winner === 'undo' ? 'SUCCESS' : 'UNDO_CONFLICT',
      );
      expect(observationResult.status).toBe(
        winner === 'undo' ? 'NOT_FOUND' : 'APPLIED',
      );
      expect(
        await managed.client.groundTransitObservation.count({
          where: { legExecutionId: leg.id },
        }),
      ).toBe(winner === 'undo' ? 0 : 1);
      if (winner === 'observation') {
        expect(
          await managed.client.itineraryNode.count({
            where: { id: f.delta.materializedOriginNodeId },
          }),
        ).toBe(1);
        expect(
          await managed.client.adoptedRoute.findUniqueOrThrow({
            where: { id: f.adopted.operationReceipt.adoptedRouteId },
          }),
        ).toMatchObject({ status: 'ACTIVE' });
      }
    },
  );
  function temporalEvidence(value: {
    id: string;
    nodeId: string | null;
    transportEdgeId: string | null;
    [key: string]: unknown;
  }) {
    const { id, nodeId, transportEdgeId, ...evidence } = value;
    void id;
    void nodeId;
    void transportEdgeId;
    return evidence;
  }

  it.each([0, 1, 2])(
    'P5E2 5B2B: first/middle/last edge %s Adopt and Undo remove formal E, retain execution and restore exact suffix',
    async (sourceIndex) => {
      const f = await externalPreviewFixture(sourceIndex);
      const originalOrder = [f.A.id, f.B.id, f.C.id, f.D.id];
      const sourceRouteId = f.source.adoptedRouteId;
      const originBefore =
        await managed.client.externalExecutionOrigin.findUniqueOrThrow({
          where: { id: f.origin.id },
        });
      const originReceipts =
        await managed.client.externalExecutionOriginReceipt.findMany({
          where: { externalOriginId: f.origin.id },
          orderBy: { id: 'asc' },
        });
      // Every provider ACTUAL is archived, not just the latest point/layer value.
      for (const [index, pointKind] of (
        ['DEPARTURE', 'ARRIVAL'] as const
      ).entries()) {
        await managed.client.temporalValue.create({
          data: {
            transportEdgeId: f.source.transportEdgeId,
            layer: 'ACTUAL',
            pointKind,
            instant: new Date(`2030-10-01T10:${20 + index}:00Z`),
            timeZone: 'Asia/Tokyo',
            sourceKind: 'PROVIDER_OBSERVATION',
            sourceRef: `SYNTHETIC:vehicle:${index}`,
            observedAt: new Date('2030-10-01T10:28:00Z'),
            createdAt: new Date('2030-10-01T10:28:01Z'),
            updatedAt: new Date('2030-10-01T10:28:02Z'),
          },
        });
      }
      const oldHistory = await groundHistory(sourceRouteId);
      const oldEdges = await managed.client.transportEdge.findMany({
        where: { tripId: f.tripId },
        include: {
          temporalValues: { orderBy: { id: 'asc' } },
          dayProjections: true,
        },
        orderBy: { id: 'asc' },
      });
      const beforeNodes = await managed.client.itineraryNode.findMany({
        where: { tripId: f.tripId },
        orderBy: { id: 'asc' },
      });
      const beforeDays = await managed.client.dayOccurrence.findMany({
        where: { tripId: f.tripId },
        orderBy: { id: 'asc' },
      });
      const previewResponse = await previewFromExternalFixture(f);
      expect(previewResponse.statusCode, previewResponse.body).toBe(201);
      const preview = previewResponse.json<RoutePreviewView>();
      const plan = preview.changeSummary.externalOriginReplacement!;
      const beforePrefixHash = await hashPreservedRoutePrefix(
        managed.client,
        f.tripId,
        plan.preservedPrefixNodeIds,
        plan.preservedPrefixTransportEdgeIds,
      );
      expect(preview).toMatchObject({
        status: 'ACTIVE',
        adoptable: true,
        policyVersion: 'route-external-origin-preview-v2',
      });
      expect(
        preview.changeSummary.archivableProviderActualTransportEdgeIds,
      ).toContain(f.source.transportEdgeId);
      const key = `SYNTHETIC:external-adopt:${sourceIndex}`;
      const beforeTrip = { ...f.first.trip, version: preview.basisVersion };
      const result = await adopt(userA, beforeTrip, preview.previewId, key);
      expect(result.statusCode, result.body).toBe(200);
      const adopted = result.json<AdoptRoutePreviewResponse>();
      const delta = adopted.operationReceipt.delta as RouteAdoptDeltaV5;
      expect(delta).toMatchObject({
        schemaVersion: 'route-adopt-delta-v5',
        replacementScope: 'EXTERNAL_ORIGIN',
        externalOriginId: f.origin.id,
        sourceAdoptedRouteId: sourceRouteId,
        sourceTransportEdgeId: f.source.transportEdgeId,
        sourceGroundTransitLegExecutionId: f.source.id,
        sourceDivergenceNodeId: originalOrder[sourceIndex],
        previousActiveAdoptedRouteId: sourceRouteId,
        replacementNodeIds: originalOrder.slice(sourceIndex),
        preservedPrefixNodeIds: originalOrder.slice(0, sourceIndex + 1),
        preservedPrefixHash: beforePrefixHash,
        archivedTransportEdgeIds: plan.replacementTransportEdgeIds,
        archivableProviderActualTransportEdgeIds: [f.source.transportEdgeId],
      });
      expect(adopted.trip.version).toBe(preview.basisVersion + 1);
      expect(
        adopted.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
      ).toEqual([
        ...originalOrder.slice(0, sourceIndex + 1),
        delta.materializedOriginNodeId,
        f.D.id,
      ]);
      const route = await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.adoptedRouteId },
      });
      expect(route).toMatchObject({
        status: 'ACTIVE',
        anchorOriginKind: 'EXTERNAL_EXECUTION_ORIGIN',
        anchorFromNodeId: delta.materializedOriginNodeId,
        anchorFromExternalOriginId: f.origin.id,
        anchorToNodeId: f.D.id,
        anchorFromSnapshot: delta.materializedOriginAnchorSnapshot,
      });
      expect(route.anchorFromSnapshot).toMatchObject({
        schemaVersion: 'external-adopted-route-anchor-v1',
        externalOrigin: { externalOriginId: f.origin.id },
      });
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: sourceRouteId },
        }),
      ).toMatchObject({ status: 'REPLACED' });
      const e = await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: delta.materializedOriginNodeId },
        include: { place: true },
      });
      expect(e).toMatchObject({
        source: 'ROUTE_GENERATED',
        autoReplaceable: true,
        provider: 'SYNTHETIC',
        providerHubRef: f.origin.providerHubRef,
        providerPlaceRef: null,
        note: null,
        userModifiedAt: null,
        adoptedRouteId: route.id,
        sourceOperationId: adopted.operationReceipt.id,
        place: {
          id: delta.materializedOriginPlaceId,
          name: f.origin.name,
          address: null,
        },
      });
      expect(
        await managed.client.temporalValue.count({
          where: { nodeId: e.id, layer: 'ACTUAL' },
        }),
      ).toBe(0);
      expect(
        await managed.client.executionEvent.count({ where: { nodeId: e.id } }),
      ).toBe(0);
      expect(
        await managed.client.transportEdge.count({
          where: { fromNodeId: plan.sourceDivergenceNodeId, toNodeId: e.id },
        }),
      ).toBe(0);
      expect(
        await managed.client.transportEdge.count({
          where: { id: { in: [...plan.replacementTransportEdgeIds] } },
        }),
      ).toBe(0);
      expect(await groundHistory(sourceRouteId)).toEqual(oldHistory);
      expect(
        await managed.client.groundTransitLegExecution.count({
          where: { adoptedRouteId: route.id },
        }),
      ).toBe(1);
      expect(
        await hashPreservedRoutePrefix(
          managed.client,
          f.tripId,
          plan.preservedPrefixNodeIds,
          plan.preservedPrefixTransportEdgeIds,
        ),
      ).toBe(beforePrefixHash);
      const archived =
        await managed.client.transportEdgeHistory.findFirstOrThrow({
          where: { originalTransportEdgeId: f.source.transportEdgeId },
          include: { temporalValues: true },
        });
      const actualBefore = oldEdges
        .find((edge) => edge.id === f.source.transportEdgeId)!
        .temporalValues.filter((v) => v.layer === 'ACTUAL')
        .map(temporalEvidence)
        .sort((a, b) => String(a.sourceRef).localeCompare(String(b.sourceRef)));
      expect(
        archived.temporalValues
          .filter((v) => v.layer === 'ACTUAL')
          .map((v) => ({
            layer: v.layer,
            pointKind: v.pointKind,
            instant: v.instant,
            timeZone: v.timeZone,
            sourceKind: v.sourceKind,
            sourceRef: v.sourceRef,
            observedAt: v.observedAt,
            createdAt: v.originalCreatedAt,
            updatedAt: v.originalUpdatedAt,
          }))
          .sort((a, b) =>
            String(a.sourceRef).localeCompare(String(b.sourceRef)),
          ),
      ).toEqual(actualBefore);
      const stateAfterAdopt = await externalDurableState(f.tripId);
      currentNow = new Date(currentNow.getTime() + 1000);
      expect(
        (await adopt(userA, beforeTrip, preview.previewId, key)).json(),
      ).toEqual(adopted);
      expect(await externalDurableState(f.tripId)).toEqual(stateAfterAdopt);
      const undoneResponse = await undo(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        `SYNTHETIC:external-undo:${sourceIndex}`,
      );
      expect(undoneResponse.statusCode, undoneResponse.body).toBe(200);
      const undone = undoneResponse.json<{
        trip: TripView;
        operationReceipt: { delta: Record<string, unknown> };
      }>();
      expect(undone.trip.version).toBe(adopted.trip.version + 1);
      expect(undone.operationReceipt.delta).toMatchObject({
        schemaVersion: 'route-undo-delta-v3',
        dematerializedExternalOriginNodeId: e.id,
        dematerializedExternalOriginPlaceId: delta.materializedOriginPlaceId,
        retainedExternalOriginId: f.origin.id,
      });
      expect(
        undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
      ).toEqual(originalOrder);
      expect(
        await managed.client.itineraryNode.findUnique({ where: { id: e.id } }),
      ).toBeNull();
      expect(
        await managed.client.place.findUnique({
          where: { id: delta.materializedOriginPlaceId },
        }),
      ).toBeNull();
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route.id },
        }),
      ).toMatchObject({
        status: 'UNDONE',
        anchorFromNodeId: null,
        anchorFromExternalOriginId: f.origin.id,
        anchorFromSnapshot: route.anchorFromSnapshot,
      });
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: sourceRouteId },
        }),
      ).toMatchObject({ status: 'ACTIVE', replacedAt: null, undoneAt: null });
      const restored = await managed.client.transportEdge.findMany({
        where: { tripId: f.tripId },
        include: { temporalValues: true },
        orderBy: { id: 'asc' },
      });
      expect(restored.map((edge) => edge.id)).toEqual(
        oldEdges.map((edge) => edge.id),
      );
      expect(
        restored
          .find((edge) => edge.id === f.source.transportEdgeId)!
          .temporalValues.filter((v) => v.layer === 'ACTUAL')
          .map(temporalEvidence)
          .sort((a, b) =>
            String(a.sourceRef).localeCompare(String(b.sourceRef)),
          ),
      ).toEqual(actualBefore);
      expect(await groundHistory(sourceRouteId)).toEqual(oldHistory);
      expect(
        await managed.client.externalExecutionOrigin.findUniqueOrThrow({
          where: { id: f.origin.id },
        }),
      ).toEqual(originBefore);
      expect(
        await managed.client.externalExecutionOriginReceipt.findMany({
          where: { externalOriginId: f.origin.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(originReceipts);
      expect(
        await hashPreservedRoutePrefix(
          managed.client,
          f.tripId,
          plan.preservedPrefixNodeIds,
          plan.preservedPrefixTransportEdgeIds,
        ),
      ).toBe(beforePrefixHash);
      const placements = (nodes: typeof beforeNodes) =>
        nodes.map((node) => ({
          id: node.id,
          dayOccurrenceId: node.dayOccurrenceId,
          position: node.position,
          placeId: node.placeId,
          adoptedRouteId: node.adoptedRouteId,
          providerHubRef: node.providerHubRef,
        }));
      expect(
        placements(
          await managed.client.itineraryNode.findMany({
            where: { tripId: f.tripId },
            orderBy: { id: 'asc' },
          }),
        ),
      ).toEqual(placements(beforeNodes));
      expect(
        (
          await managed.client.dayOccurrence.findMany({
            where: { tripId: f.tripId },
            orderBy: { id: 'asc' },
          })
        ).map((day) => ({
          id: day.id,
          localDate: day.localDate,
          sequence: day.sequence,
        })),
      ).toEqual(
        beforeDays.map((day) => ({
          id: day.id,
          localDate: day.localDate,
          sequence: day.sequence,
        })),
      );
      expect(
        await managed.client.transportEdgeHistory.count({
          where: { id: { in: [...delta.archivedTransportHistoryIds] } },
        }),
      ).toBe(0);
      const stateAfterUndo = await externalDurableState(f.tripId);
      expect(
        (
          await undo(
            userA,
            adopted.trip,
            adopted.operationReceipt.id,
            `SYNTHETIC:external-undo:${sourceIndex}`,
          )
        ).json(),
      ).toEqual(undone);
      expect(await externalDurableState(f.tripId)).toEqual(stateAfterUndo);
      const handoff = await app.inject({
        method: 'GET',
        url: `${f.base}/route-reevaluation`,
        headers: bearer(userA),
      });
      expect(handoff.json()).toMatchObject({
        readiness: 'READY',
        originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
        query: null,
        externalQuery: {
          externalOriginId: f.origin.id,
          basisVersion: undone.trip.version,
          toNodeId: f.D.id,
        },
      });
      expect(await externalDurableState(f.tripId)).toEqual(stateAfterUndo);
    },
  );

  it.each(['same', 'different'] as const)(
    'P5E2 5B2B: %s-key concurrent Adopt and Undo each commit once',
    async (keys) => {
      const f = await externalAdoptFixture();
      const key = randomUUID();
      const results = await Promise.all([
        adopt(userA, f.beforeTrip, f.preview.previewId, key),
        adopt(
          userA,
          f.beforeTrip,
          f.preview.previewId,
          keys === 'same' ? key : randomUUID(),
        ),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual(
        keys === 'same' ? [200, 200] : [200, 409],
      );
      if (keys === 'same')
        expect(results[0]!.json()).toEqual(results[1]!.json());
      else
        expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject(
          { error: { code: 'VERSION_CONFLICT' } },
        );
      const adopted = results
        .find((r) => r.statusCode === 200)!
        .json<AdoptRoutePreviewResponse>();
      const delta = adopted.operationReceipt.delta as RouteAdoptDeltaV5;
      expect(await readVersion(f.tripId)).toBe(f.beforeTrip.version + 1);
      expect(
        await managed.client.adoptedRoute.count({
          where: {
            tripId: f.tripId,
            anchorOriginKind: 'EXTERNAL_EXECUTION_ORIGIN',
          },
        }),
      ).toBe(1);
      expect(
        await managed.client.itineraryNode.count({
          where: { id: delta.materializedOriginNodeId },
        }),
      ).toBe(1);
      expect(
        await managed.client.place.count({
          where: { id: delta.materializedOriginPlaceId },
        }),
      ).toBe(1);
      expect(
        await managed.client.operationReceipt.count({
          where: {
            adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
            operationType: 'ROUTE_ADOPT',
          },
        }),
      ).toBe(1);
      // A successful receipt wins over later preview expiry and current route changes.
      await managed.client.routePreview.update({
        where: { id: f.preview.previewId },
        data: { expiresAt: new Date(currentNow.getTime() + 1) },
      });
      currentNow = new Date(currentNow.getTime() + 2);
      const state = await externalDurableState(f.tripId);
      const replayKey = (
        await managed.client.operationReceipt.findUniqueOrThrow({
          where: { id: adopted.operationReceipt.id },
        })
      ).idempotencyKey;
      expect(
        (
          await adopt(userA, f.beforeTrip, f.preview.previewId, replayKey)
        ).json(),
      ).toEqual(adopted);
      expect(await externalDurableState(f.tripId)).toEqual(state);
      const undoKey = randomUUID();
      const undone = await Promise.all([
        undo(userA, adopted.trip, adopted.operationReceipt.id, undoKey),
        undo(
          userA,
          adopted.trip,
          adopted.operationReceipt.id,
          keys === 'same' ? undoKey : randomUUID(),
        ),
      ]);
      expect(undone.map((r) => r.statusCode).sort()).toEqual(
        keys === 'same' ? [200, 200] : [200, 409],
      );
      if (keys === 'same') expect(undone[0]!.json()).toEqual(undone[1]!.json());
      else
        expect(undone.find((r) => r.statusCode === 409)!.json()).toMatchObject({
          error: { code: 'UNDO_CONFLICT' },
        });
      expect(await readVersion(f.tripId)).toBe(f.beforeTrip.version + 2);
      expect(
        await managed.client.operationReceipt.count({
          where: { targetOperationReceiptId: adopted.operationReceipt.id },
        }),
      ).toBe(1);
      expect(
        await managed.client.outboxEvent.count({
          where: { operationReceiptId: adopted.operationReceipt.id },
        }),
      ).toBe(1);
    },
  );

  it.each([
    'DEPARTED',
    'SUPERSEDED',
    'INVALIDATED',
    'CONFLICT',
    'REPLACED',
    'UNDONE',
    'edge-delete',
    'edge-route',
    'edge-MANUAL',
    'leg-delete',
    'leg-route',
    'metadata',
    'node-actual',
    'node-note',
    'node-intent',
    'historical-anchor',
    'retained-reference',
    'USER_VALUE',
    'EXECUTION_OBSERVATION',
    'DERIVED',
    'SYSTEM_SUGGESTION',
    'ADOPTED_TRANSPORT_FACT',
    'PROVIDER_OBSERVATION',
    'TTL',
    'candidate-departed',
    'prefix-topology',
    'destination-endpoint',
  ] as const)(
    'P5E2 5B2B: locked Adopt rejects changed %s evidence with zero formal writes',
    async (kind) => {
      const f = await externalAdoptFixture();
      if (kind === 'DEPARTED' || kind === 'INVALIDATED')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: {
            status: kind,
            ...(kind === 'DEPARTED'
              ? { departedAt: currentNow }
              : { invalidatedAt: currentNow }),
          },
        });
      else if (kind === 'SUPERSEDED')
        await managed.client.executionEvent.create({
          data: {
            ownerUserId: userA.actor.userId,
            tripId: f.tripId,
            nodeId: f.A.id,
            type: 'ARRIVAL',
            source: 'MANUAL',
            occurredAt: new Date(currentNow.getTime() + 1),
          },
        });
      else if (kind === 'CONFLICT')
        await managed.client.externalExecutionOrigin.create({
          data: {
            ...(await managed.client.externalExecutionOrigin.findUniqueOrThrow({
              where: { id: f.origin.id },
            })),
            id: randomUUID(),
          },
        });
      else if (kind === 'REPLACED' || kind === 'UNDONE')
        await managed.client.adoptedRoute.update({
          where: { id: f.source.adoptedRouteId },
          data: { status: kind },
        });
      else if (kind === 'edge-delete' || kind === 'prefix-topology')
        await managed.client.transportEdge.delete({
          where: {
            id: kind === 'edge-delete' ? f.source.transportEdgeId : f.prefix.id,
          },
        });
      else if (kind === 'edge-route')
        await managed.client.transportEdge.update({
          where: { id: f.source.transportEdgeId },
          data: { adoptedRouteId: await externalPreviewHistoricalRoute(f) },
        });
      else if (kind === 'edge-MANUAL')
        await managed.client.transportEdge.update({
          where: { id: f.source.transportEdgeId },
          data: { source: 'MANUAL', adoptedRouteId: null },
        });
      else if (kind === 'leg-delete')
        await managed.client.groundTransitLegExecution.delete({
          where: { id: f.source.id },
        });
      else if (kind === 'leg-route')
        await managed.client.groundTransitLegExecution.update({
          where: { id: f.source.id },
          data: { adoptedRouteId: await externalPreviewHistoricalRoute(f) },
        });
      else if (kind === 'metadata')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: { latitude: 35.72 },
        });
      else if (kind === 'node-note')
        await managed.client.itineraryNode.update({
          where: { id: f.C.id },
          data: { note: 'SYNTHETIC later user note' },
        });
      else if (kind === 'node-intent')
        await managed.client.userTimeIntent.create({
          data: {
            tripId: f.tripId,
            nodeId: f.C.id,
            kind: 'MIN_DWELL',
            operator: 'MINIMUM',
            durationSeconds: 600,
          },
        });
      else if (kind === 'historical-anchor' || kind === 'retained-reference')
        await retainExternalPreviewNode(
          f,
          kind === 'historical-anchor' ? 'anchor' : 'receipt',
        );
      else if (kind === 'TTL')
        currentNow = new Date(currentNow.getTime() + 3_600_000);
      else if (kind === 'candidate-departed')
        currentNow = new Date('2030-10-01T10:30:01Z');
      else if (kind === 'destination-endpoint')
        await managed.client.place.update({
          where: { id: f.D.place!.id },
          data: { latitude: 0 },
        });
      else
        await managed.client.temporalValue.create({
          data: {
            ...(kind === 'node-actual'
              ? { nodeId: f.C.id }
              : { transportEdgeId: f.source.transportEdgeId }),
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: currentNow,
            timeZone: 'UTC',
            sourceKind: kind === 'node-actual' ? 'USER_VALUE' : kind,
          },
        });
      const before = await previewFormalState(f.tripId);
      const result = await adopt(
        userA,
        f.beforeTrip,
        f.preview.previewId,
        randomUUID(),
      );
      const blocked = [
        'node-actual',
        'node-note',
        'node-intent',
        'historical-anchor',
        'retained-reference',
        'USER_VALUE',
        'EXECUTION_OBSERVATION',
        'DERIVED',
        'SYSTEM_SUGGESTION',
        'ADOPTED_TRANSPORT_FACT',
      ].includes(kind);
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: blocked ? 'PREVIEW_BLOCKED' : 'PREVIEW_STALE' },
      });
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  it('P5E2 5B2B: real departure between v2 Preview and Adopt uses version fencing', async () => {
    const f = await externalAdoptFixture();
    const departed = await app.inject({
      method: 'POST',
      url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/depart`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: f.beforeTrip.version,
        idempotencyKey: randomUUID(),
      },
    });
    expect(departed.statusCode, departed.body).toBe(200);
    const before = await previewFormalState(f.tripId);
    const result = await adopt(
      userA,
      f.beforeTrip,
      f.preview.previewId,
      randomUUID(),
    );
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
    });
    expect(await previewFormalState(f.tripId)).toEqual(before);
  });

  it.each([
    'node-note',
    'node-actual',
    'execution-event',
    'place',
    'intent',
    'move',
    'edge-user-actual',
    'edge-provider-actual',
    'anchor-snapshot',
    'anchor-node',
    'prefix',
    'history',
    'day-date',
  ] as const)(
    'P5E2 5B2B: defensive Undo rejects %s even without Trip.version change',
    async (kind) => {
      const f = await externalAdoptFixture();
      const response = await adopt(
        userA,
        f.beforeTrip,
        f.preview.previewId,
        randomUUID(),
      );
      expect(response.statusCode, response.body).toBe(200);
      const adopted = response.json<AdoptRoutePreviewResponse>();
      const d = adopted.operationReceipt.delta as RouteAdoptDeltaV5;
      if (kind === 'node-note')
        await managed.client.itineraryNode.update({
          where: { id: d.materializedOriginNodeId },
          data: { note: 'SYNTHETIC retained user note' },
        });
      else if (kind === 'execution-event')
        await managed.client.executionEvent.create({
          data: {
            ownerUserId: userA.actor.userId,
            tripId: f.tripId,
            nodeId: d.materializedOriginNodeId,
            type: 'ARRIVAL',
            source: 'MANUAL',
            occurredAt: currentNow,
          },
        });
      else if (kind === 'place')
        await managed.client.place.update({
          where: { id: d.materializedOriginPlaceId },
          data: { name: 'SYNTHETIC user renamed E' },
        });
      else if (kind === 'intent')
        await managed.client.userTimeIntent.create({
          data: {
            tripId: f.tripId,
            nodeId: d.materializedOriginNodeId,
            kind: 'MIN_DWELL',
            operator: 'MINIMUM',
            durationSeconds: 600,
          },
        });
      else if (kind === 'move')
        await managed.client.itineraryNode.update({
          where: { id: d.materializedOriginNodeId },
          data: { position: 1000 },
        });
      else if (kind === 'anchor-node')
        await managed.client.adoptedRoute.update({
          where: { id: adopted.operationReceipt.adoptedRouteId },
          data: { anchorFromNodeId: f.A.id },
        });
      else if (kind === 'anchor-snapshot')
        await managed.client.adoptedRoute.update({
          where: { id: adopted.operationReceipt.adoptedRouteId },
          data: {
            anchorFromSnapshot: {
              ...d.materializedOriginAnchorSnapshot,
              localDate: '2030-10-02',
            } as unknown as JsonInput,
          },
        });
      else if (kind === 'prefix')
        await managed.client.itineraryNode.update({
          where: { id: f.B.id },
          data: { note: 'SYNTHETIC preserved prefix changed' },
        });
      else if (kind === 'history')
        await managed.client.transportEdgeHistory.update({
          where: { id: d.archivedTransportHistoryIds[0]! },
          data: { note: 'SYNTHETIC tampered history' },
        });
      else if (kind === 'day-date')
        await managed.client.dayOccurrence.update({
          where: { id: d.materializedOriginDayOccurrenceId },
          data: { localDate: new Date('2030-10-02T00:00:00Z') },
        });
      else
        await managed.client.temporalValue.create({
          data: {
            ...(kind === 'node-actual'
              ? { nodeId: d.materializedOriginNodeId }
              : { transportEdgeId: d.createdTransportEdgeIds[0]! }),
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: currentNow,
            timeZone: 'UTC',
            sourceKind:
              kind === 'edge-provider-actual'
                ? 'PROVIDER_OBSERVATION'
                : 'USER_VALUE',
          },
        });
      const before = await previewFormalState(f.tripId);
      const result = await undo(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        randomUUID(),
      );
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json()).toMatchObject({ error: { code: 'UNDO_CONFLICT' } });
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  it.each(['USER', 'ADMIN'] as const)(
    'P5E2 5B2B: other %s cannot Adopt/Undo external private planning',
    async (role) => {
      const f = await externalAdoptFixture();
      const actor = role === 'USER' ? userB : admin;
      const before = await previewFormalState(f.tripId);
      expect(
        (await adopt(actor, f.beforeTrip, f.preview.previewId, randomUUID()))
          .statusCode,
      ).toBe(404);
      expect(await previewFormalState(f.tripId)).toEqual(before);
      const result = await adopt(
        userA,
        f.beforeTrip,
        f.preview.previewId,
        randomUUID(),
      );
      expect(result.statusCode, result.body).toBe(200);
      const adopted = result.json<AdoptRoutePreviewResponse>();
      const after = await previewFormalState(f.tripId);
      expect(
        (
          await undo(
            actor,
            adopted.trip,
            adopted.operationReceipt.id,
            randomUUID(),
          )
        ).statusCode,
      ).toBe(404);
      expect(await previewFormalState(f.tripId)).toEqual(after);
    },
  );

  async function queryExternalCandidate(
    f: Awaited<ReturnType<typeof externalPreviewFixture>>,
  ) {
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
      headers: bearer(userA),
      payload: { basisVersion: await readVersion(f.tripId), toNodeId: f.D.id },
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      ...f,
      snapshotId: response.json().candidates[0].candidateSnapshotId as string,
    };
  }
  it('P5E2 5B2B: same-ID C reuse retains historical anchor and Undo restores R1 metadata and placement', async () => {
    const f = await externalPreviewFixture();
    await retainExternalPreviewNode(f, 'anchor');
    const before = await managed.client.itineraryNode.findUniqueOrThrow({
      where: { id: f.C.id },
    });
    const base = suffixFoundationCandidate(false).candidates[0]!;
    const c = base.legs[2]!.from;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...base,
          candidateId: 'SYNTHETIC:external-reuse-C',
          departure: {
            instant: new Date('2030-10-01T10:30:00Z'),
            timeZone: 'Asia/Tokyo',
          },
          durationSeconds: 1800,
          legs: [
            {
              ...base.legs[0]!,
              to: c,
              departure: {
                instant: new Date('2030-10-01T10:30:00Z'),
                timeZone: 'Asia/Tokyo',
              },
              arrival: {
                instant: new Date('2030-10-01T10:40:00Z'),
                timeZone: 'UTC',
              },
              durationSeconds: 600,
            },
            base.legs[2]!,
          ],
        },
      ],
    };
    const next = await queryExternalCandidate(f);
    const previewResponse = await previewFromExternalFixture(next);
    expect(previewResponse.statusCode, previewResponse.body).toBe(201);
    const preview = previewResponse.json<RoutePreviewView>();
    expect(preview).toMatchObject({ status: 'ACTIVE', adoptable: true });
    expect(preview.changeSummary.nodesToReuse?.map((n) => n.nodeId)).toEqual([
      f.C.id,
    ]);
    expect(preview.changeSummary.nodesToRemove).toEqual([]);
    const adoptedResponse = await adopt(
      userA,
      { ...f.first.trip, version: preview.basisVersion },
      preview.previewId,
      randomUUID(),
    );
    expect(adoptedResponse.statusCode, adoptedResponse.body).toBe(200);
    const adopted = adoptedResponse.json<AdoptRoutePreviewResponse>();
    const d = adopted.operationReceipt.delta as RouteAdoptDeltaV5;
    expect(d.reusedNodeIds).toEqual([f.C.id]);
    expect(d.removedGeneratedNodes).toEqual([]);
    expect(
      adopted.trip.days.flatMap((day) => day.nodes).map((n) => n.id),
    ).toEqual([f.A.id, f.B.id, d.materializedOriginNodeId, f.C.id, f.D.id]);
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: f.C.id },
      }),
    ).toMatchObject({
      adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
      sourceOperationId: adopted.operationReceipt.id,
    });
    const result = await undo(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      randomUUID(),
    );
    expect(result.statusCode, result.body).toBe(200);
    const { updatedAt: oldUpdated, ...oldFacts } = before;
    void oldUpdated;
    const { updatedAt: newUpdated, ...newFacts } =
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: f.C.id },
      });
    void newUpdated;
    expect(newFacts).toEqual(oldFacts);
    expect(
      await managed.client.adoptedRoute.count({
        where: { anchorFromNodeId: f.C.id, status: 'UNDONE' },
      }),
    ).toBe(1);
  });

  it.each(['new-date', 'repeated-date'] as const)(
    'P5E2 5B2B: %s creates a distinct E occurrence, splits suffix placement and restores original cards',
    async (kind) => {
      const f = await externalPreviewFixture();
      if (kind === 'repeated-date') {
        // Two distinct same-date cards surround the source suffix: the plan must
        // use a new E card, not guess either existing occurrence by calendar date.
        const day = await managed.client.dayOccurrence.findFirstOrThrow({
          where: { tripId: f.tripId },
        });
        const second = await managed.client.dayOccurrence.create({
          data: { tripId: f.tripId, localDate: day.localDate, sequence: 1 },
        });
        await managed.client.itineraryNode.update({
          where: { id: f.D.id },
          data: { dayOccurrenceId: second.id, position: 0 },
        });
      } else {
        const next = candidate(
          '2030-10-01T15:30:00Z',
          '2030-10-01T16:00:00Z',
          'Asia/Tokyo',
          'UTC',
        );
        providerResult = {
          status: 'SUCCESS',
          candidates: [
            {
              ...next,
              legs: next.legs.map((leg) => ({ ...leg, mode: 'RAIL' as const })),
            },
          ],
        };
      }
      const beforeDays = await managed.client.dayOccurrence.findMany({
        where: { tripId: f.tripId },
        orderBy: { sequence: 'asc' },
      });
      const beforeNodes = await managed.client.itineraryNode.findMany({
        where: { tripId: f.tripId },
        orderBy: { id: 'asc' },
      });
      const next = await queryExternalCandidate(f);
      const previewResponse = await previewFromExternalFixture(next);
      expect(previewResponse.statusCode, previewResponse.body).toBe(201);
      const preview = previewResponse.json<RoutePreviewView>();
      expect(
        preview.changeSummary.externalOriginReplacement!.materializedOrigin
          .dayOccurrenceId,
      ).toBeNull();
      const result = await adopt(
        userA,
        { ...f.first.trip, version: preview.basisVersion },
        preview.previewId,
        randomUUID(),
      );
      expect(result.statusCode, result.body).toBe(200);
      const adopted = result.json<AdoptRoutePreviewResponse>();
      const d = adopted.operationReceipt.delta as RouteAdoptDeltaV5;
      expect(d.createdDayOccurrenceIds).toContain(
        d.materializedOriginDayOccurrenceId,
      );
      expect(beforeDays.map((day) => day.id)).not.toContain(
        d.materializedOriginDayOccurrenceId,
      );
      expect(
        adopted.trip.days.flatMap((day) => day.nodes).map((n) => n.id),
      ).toEqual([f.A.id, f.B.id, d.materializedOriginNodeId, f.D.id]);
      const undone = await undo(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        randomUUID(),
      );
      expect(undone.statusCode, undone.body).toBe(200);
      expect(
        (
          await managed.client.dayOccurrence.findMany({
            where: { tripId: f.tripId },
            orderBy: { sequence: 'asc' },
          })
        ).map((day) => ({
          id: day.id,
          date: day.localDate,
          sequence: day.sequence,
        })),
      ).toEqual(
        beforeDays.map((day) => ({
          id: day.id,
          date: day.localDate,
          sequence: day.sequence,
        })),
      );
      expect(
        (
          await managed.client.itineraryNode.findMany({
            where: { tripId: f.tripId },
            orderBy: { id: 'asc' },
          })
        ).map((n) => ({
          id: n.id,
          day: n.dayOccurrenceId,
          position: n.position,
        })),
      ).toEqual(
        beforeNodes.map((n) => ({
          id: n.id,
          day: n.dayOccurrenceId,
          position: n.position,
        })),
      );
    },
  );

  it.each([0, 1, 2])(
    'P5E2 5B2A: first/middle/last source edge %s has correct replacement plan and zero formal footprint',
    async (sourceIndex) => {
      const f = await externalPreviewFixture(sourceIndex);
      const ordered = [f.A.id, f.B.id, f.C.id, f.D.id];
      const edges = await managed.client.transportEdge.findMany({
        where: { tripId: f.tripId },
      });
      const edgeIds = ordered
        .slice(0, -1)
        .map((id) => edges.find((edge) => edge.fromNodeId === id)!.id);
      const before = await previewFormalState(f.tripId);
      const previewCount = await managed.client.routePreview.count({
        where: { tripId: f.tripId },
      });
      const response = await previewFromExternalFixture(f);
      expect(response.statusCode, response.body).toBe(201);
      const preview = response.json<RoutePreviewView>();
      expect(preview).toMatchObject({
        policyVersion: 'route-external-origin-preview-v2',
        status: 'ACTIVE',
        adoptable: true,
        currentConnection: {
          fromNodeId: ordered[sourceIndex],
          toNodeId: ordered[sourceIndex + 1],
          state: 'ACTIVE',
          transport: { id: f.source.transportEdgeId },
        },
      });
      expect(preview.changeSummary.routeCorridor).toBeUndefined();
      expect(preview.changeSummary.externalOriginReplacement).toMatchObject({
        replacementScope: 'EXTERNAL_ORIGIN',
        externalOriginId: f.origin.id,
        sourceAdoptedRouteId: f.source.adoptedRouteId,
        sourceTransportEdgeId: f.source.transportEdgeId,
        sourceGroundTransitLegExecutionId: f.source.id,
        sourceRouteAnchorFromNodeId: f.A.id,
        sourceRouteAnchorToNodeId: f.D.id,
        sourceDivergenceNodeId: ordered[sourceIndex],
        destinationNodeId: f.D.id,
        preservedPrefixNodeIds: ordered.slice(0, sourceIndex + 1),
        preservedPrefixTransportEdgeIds: edgeIds.slice(0, sourceIndex),
        replacementNodeIds: ordered.slice(sourceIndex),
        replacementTransportEdgeIds: edgeIds.slice(sourceIndex),
        materializedOrigin: {
          ref: 'EXTERNAL_ORIGIN',
          action: 'CREATE',
          nodeId: null,
          kind: 'PLACE_VISIT',
          source: 'ROUTE_GENERATED',
          autoReplaceable: true,
          userModifiedAt: null,
          evidence: 'USER_CONFIRMED',
          provider: 'SYNTHETIC',
          providerPlaceRef: null,
          providerHubRef: f.origin.providerHubRef,
          localDate: '2030-10-01',
          location: {
            name: f.origin.name,
            latitude: f.origin.latitude,
            longitude: f.origin.longitude,
          },
          temporalValues: [],
          executionEvents: [],
        },
      });
      expect(
        preview.changeSummary.nodesToRemove?.map((node) => node.nodeId),
      ).toEqual(ordered.slice(sourceIndex + 1, -1));
      expect(preview.changeSummary.proposedSegments[0]!.fromRef).toBe(
        'EXTERNAL_ORIGIN',
      );
      expect(preview.changeSummary.proposedSegments.at(-1)!.toRef).toBe(
        'TO_NODE',
      );
      expect(
        preview.changeSummary.proposedSegments.some(
          (segment) => segment.fromRef === 'FROM_NODE',
        ),
      ).toBe(false);
      expect(preview.changeSummary.requiredUserAdjustments).toEqual([]);
      expect(await previewFormalState(f.tripId)).toEqual(before);
      expect(
        await managed.client.routePreview.count({
          where: { tripId: f.tripId },
        }),
      ).toBe(previewCount + 1);
      const fetched = await app.inject({
        method: 'GET',
        url: `/trips/${f.tripId}/previews/${preview.previewId}`,
        headers: bearer(userA),
      });
      expect(fetched.json()).toEqual(preview);
      await preserveLegacyExternalPreview(preview.previewId);
      const rejected = await adopt(
        userA,
        { ...f.first.trip, version: preview.basisVersion },
        preview.previewId,
        'synthetic-external-adopt-unsupported',
      );
      expect(rejected.statusCode, rejected.body).toBe(422);
      expect(rejected.json()).toMatchObject({
        error: { code: 'PREVIEW_UNSUPPORTED' },
      });
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  it.each([
    'PROVIDER_OBSERVATION',
    'USER_VALUE',
    'EXECUTION_OBSERVATION',
    'DERIVED',
    'SYSTEM_SUGGESTION',
    'ADOPTED_TRANSPORT_FACT',
  ] as const)(
    'P5E2 5B2A: suffix transport ACTUAL %s is classified without mutation',
    async (sourceKind) => {
      const f = await externalPreviewFixture();
      await managed.client.temporalValue.create({
        data: {
          transportEdgeId: f.source.transportEdgeId,
          layer: 'ACTUAL',
          pointKind: 'DEPARTURE',
          instant: new Date('2030-10-01T10:20:00Z'),
          timeZone: 'UTC',
          sourceKind,
        },
      });
      // Executed prefix facts never block the abandoned source suffix.
      await managed.client.temporalValue.create({
        data: {
          transportEdgeId: f.prefix.id,
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: new Date('2030-10-01T10:20:00Z'),
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      });
      const before = await previewFormalState(f.tripId);
      const response = await previewFromExternalFixture(f);
      expect(response.statusCode, response.body).toBe(201);
      const preview = response.json<RoutePreviewView>();
      const vehicle = sourceKind === 'PROVIDER_OBSERVATION';
      expect(preview.status).toBe(vehicle ? 'ACTIVE' : 'BLOCKED');
      expect(preview.adoptable).toBe(vehicle);
      expect(
        preview.changeSummary.archivableProviderActualTransportEdgeIds,
      ).toEqual(vehicle ? [f.source.transportEdgeId] : []);
      expect(preview.changeSummary.protectedBlockingTransportEdgeIds).toEqual(
        vehicle ? [] : [f.source.transportEdgeId],
      );
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  it.each([
    'node-actual',
    'note',
    'time-intent',
    'auto-replaceable',
    'user-modified',
    'anchor',
    'retained-snapshot',
    'retained-receipt',
  ] as const)(
    'P5E2 5B2A: generated suffix %s protection is preserved',
    async (kind) => {
      const f = await externalPreviewFixture();
      if (kind === 'node-actual')
        await managed.client.temporalValue.create({
          data: {
            nodeId: f.C.id,
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: new Date('2030-10-01T10:40:00Z'),
            timeZone: 'UTC',
            sourceKind: 'EXECUTION_OBSERVATION',
          },
        });
      else if (kind === 'note')
        await managed.client.itineraryNode.update({
          where: { id: f.C.id },
          data: { note: 'SYNTHETIC user content' },
        });
      else if (kind === 'auto-replaceable')
        await managed.client.itineraryNode.update({
          where: { id: f.C.id },
          data: { autoReplaceable: false },
        });
      else if (kind === 'user-modified')
        await managed.client.itineraryNode.update({
          where: { id: f.C.id },
          data: { userModifiedAt: currentNow },
        });
      else if (kind === 'time-intent')
        await managed.client.userTimeIntent.create({
          data: {
            nodeId: f.C.id,
            tripId: f.tripId,
            kind: 'MIN_DWELL',
            operator: 'MINIMUM',
            durationSeconds: 60,
            locked: true,
          },
        });
      else
        await retainExternalPreviewNode(
          f,
          kind === 'retained-receipt'
            ? 'receipt'
            : kind === 'retained-snapshot'
              ? 'snapshot'
              : 'anchor',
        );
      const before = await previewFormalState(f.tripId);
      const response = await previewFromExternalFixture(f);
      expect(response.statusCode, response.body).toBe(201);
      const preview = response.json<RoutePreviewView>();
      expect(preview.status).toBe('BLOCKED');
      expect(preview.changeSummary.protectedBlockingNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: f.C.id, protected: true }),
        ]),
      );
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  async function retainExternalPreviewNode(
    f: Awaited<ReturnType<typeof externalPreviewFixture>>,
    kind: 'anchor' | 'snapshot' | 'receipt',
  ) {
    const sourceRoute = await managed.client.adoptedRoute.findUniqueOrThrow({
      where: { id: f.source.adoptedRouteId },
    });
    const snapshot =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: { id: sourceRoute.candidateSnapshotId },
      });
    const { externalOriginSnapshot: _unusedEvidence, ...nodeSnapshot } =
      snapshot;
    void _unusedEvidence;
    const retained = await managed.client.routeCandidateSnapshot.create({
      data: {
        ...nodeSnapshot,
        candidatePayload: snapshot.candidatePayload as JsonInput,
        queryTimeCondition: snapshot.queryTimeCondition as JsonInput,
        id: randomUUID(),
        fromNodeId: f.C.id,
      },
    });
    if (kind !== 'snapshot') {
      const sourcePreview = await managed.client.routePreview.findUniqueOrThrow(
        { where: { id: sourceRoute.sourcePreviewId } },
      );
      const preview = await managed.client.routePreview.create({
        data: {
          ...sourcePreview,
          previewPayload: sourcePreview.previewPayload as JsonInput,
          id: randomUUID(),
          candidateSnapshotId: kind === 'receipt' ? retained.id : snapshot.id,
        },
      });
      if (kind === 'receipt') {
        const receipt = await managed.client.operationReceipt.findUniqueOrThrow(
          { where: { id: f.first.operationReceipt.id } },
        );
        await managed.client.operationReceipt.create({
          data: {
            ...receipt,
            delta: receipt.delta as JsonInput,
            id: randomUUID(),
            idempotencyKey: randomUUID(),
            previewId: preview.id,
          },
        });
      } else
        await managed.client.adoptedRoute.create({
          data: {
            ...cloneNodeRoute(sourceRoute),
            id: randomUUID(),
            status: 'UNDONE',
            anchorFromNodeId: f.C.id,
            sourcePreviewId: preview.id,
            candidateSnapshotId: snapshot.id,
          },
        });
    } else {
      // A historical AdoptedRoute retaining a snapshot protects its dependent node.
      await managed.client.adoptedRoute.create({
        data: {
          ...cloneNodeRoute(sourceRoute),
          id: randomUUID(),
          status: 'REPLACED',
          sourcePreviewId: await externalPreviewCopySourcePreview(f),
          candidateSnapshotId: retained.id,
        },
      });
    }
  }

  it.each([
    'DEPARTED',
    'SUPERSEDED',
    'INVALIDATED',
    'CONFLICT',
    'REPLACED',
    'UNDONE',
    'missing-edge',
    'wrong-edge',
    'MANUAL-edge',
    'leg-id',
    'leg-route',
    'leg-trip',
    'metadata',
    'past-departure',
    'TTL',
    'provider-TTL',
    'candidate-hash',
    'legacy-hash',
    'timezone',
  ] as const)(
    'P5E2 5B2A: %s rejects external Preview as stale before persistence',
    async (kind) => {
      const f = await externalPreviewFixture();
      if (kind === 'DEPARTED')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: { status: 'DEPARTED', departedAt: currentNow },
        });
      else if (kind === 'INVALIDATED')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: { status: 'INVALIDATED', invalidatedAt: currentNow },
        });
      else if (kind === 'SUPERSEDED') {
        currentNow = new Date(currentNow.getTime() + 60000);
        await manualExecution(
          { ...f.first.trip, version: await readVersion(f.tripId) },
          f.A.id,
          'MANUAL_ARRIVAL',
          currentNow.toISOString(),
        );
      } else if (kind === 'CONFLICT') {
        const row =
          await managed.client.externalExecutionOrigin.findUniqueOrThrow({
            where: { id: f.origin.id },
          });
        await managed.client.externalExecutionOrigin.create({
          data: { ...row, id: randomUUID() },
        });
      } else if (kind === 'REPLACED' || kind === 'UNDONE')
        await managed.client.adoptedRoute.update({
          where: { id: f.source.adoptedRouteId },
          data: { status: kind },
        });
      else if (kind === 'missing-edge')
        await managed.client.transportEdge.delete({
          where: { id: f.source.transportEdgeId },
        });
      else if (kind === 'wrong-edge')
        await managed.client.transportEdge.update({
          where: { id: f.source.transportEdgeId },
          data: { adoptedRouteId: await externalPreviewHistoricalRoute(f) },
        });
      else if (kind === 'MANUAL-edge')
        await managed.client.transportEdge.update({
          where: { id: f.source.transportEdgeId },
          data: {
            source: 'MANUAL',
            adoptedRouteId: null,
            provider: null,
            providerRef: null,
          },
        });
      else if (kind === 'leg-id')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: { sourceGroundTransitLegExecutionId: randomUUID() },
        });
      else if (kind === 'leg-route')
        await managed.client.groundTransitLegExecution.update({
          where: { id: f.source.id },
          data: { adoptedRouteId: await externalPreviewHistoricalRoute(f) },
        });
      else if (kind === 'leg-trip')
        await managed.client.groundTransitLegExecution.update({
          where: { id: f.source.id },
          data: {
            tripId: await externalPreviewOtherTrip(f),
            adoptedRouteId: await externalPreviewHistoricalRoute(f, true),
          },
        });
      else if (kind === 'metadata')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: { name: 'SYNTHETIC changed hub metadata' },
        });
      else if (kind === 'timezone')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: { timeZone: 'Invalid/Zone' },
        });
      else if (kind === 'past-departure')
        currentNow = new Date('2030-10-01T10:31:00Z');
      else if (kind === 'TTL')
        await managed.client.routeCandidateSnapshot.update({
          where: { id: f.snapshotId },
          data: {
            expiresAt: currentNow,
            createdAt: new Date(currentNow.getTime() - 60000),
          },
        });
      else if (kind === 'provider-TTL')
        await managed.client.routeCandidateSnapshot.update({
          where: { id: f.snapshotId },
          data: {
            providerValidUntil: currentNow,
            expiresAt: currentNow,
            createdAt: new Date(currentNow.getTime() - 60000),
          },
        });
      else if (kind === 'legacy-hash') {
        const snapshot = await new PrismaRoutePlanningRepository(
          managed.client,
        ).findSnapshotOwned({
          ownerUserId: userA.actor.userId,
          tripId: f.tripId,
          snapshotId: f.snapshotId,
        });
        await managed.client.routeCandidateSnapshot.update({
          where: { id: f.snapshotId },
          data: {
            candidateHash: hashRouteCandidateSnapshot({
              tripId: f.tripId,
              basisVersion: snapshot!.basisVersion,
              fromNodeId: f.origin.id,
              toNodeId: f.D.id,
              provider: snapshot!.provider,
              observedAt: snapshot!.observedAt.toISOString(),
              candidatePayload: snapshot!.candidatePayload,
            }),
          },
        });
      } else
        await managed.client.routeCandidateSnapshot.update({
          where: { id: f.snapshotId },
          data: { candidateHash: '0'.repeat(64) },
        });
      const before = await previewFormalState(f.tripId);
      const count = await managed.client.routePreview.count({
        where: { tripId: f.tripId },
      });
      const response = await previewFromExternalFixture(f);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'PREVIEW_STALE' },
      });
      expect(
        await managed.client.routePreview.count({
          where: { tripId: f.tripId },
        }),
      ).toBe(count);
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  it.each([
    'departure',
    'supersession',
    'REPLACED',
    'UNDONE',
    'edge-delete',
    'edge-route',
    'edge-MANUAL',
    'leg-delete',
    'leg-route',
    'metadata',
    'node-actual',
    'historical-anchor',
    'retained-reference',
    'user-actual',
    'provider-actual',
    'prefix-topology',
    'TTL',
    'snapshot-hash',
    'destination-endpoint',
  ] as const)(
    'P5E2 5B2A: locked Preview revalidates race %s with zero writes',
    async (kind) => {
      const f = await externalPreviewFixture();
      const repo = new PrismaRoutePlanningRepository(managed.client, {
        now: () => currentNow,
      });
      const snapshot = (await repo.findSnapshotOwned({
        ownerUserId: userA.actor.userId,
        tripId: f.tripId,
        snapshotId: f.snapshotId,
      }))!;
      const trip = (await tripRepository.findOwnedById({
        ownerUserId: userA.actor.userId,
        tripId: f.tripId,
      }))!;
      const context = (await new PrismaExternalExecutionOriginRepository(
        managed.client,
      ).readPlanning({
        ownerUserId: userA.actor.userId,
        tripId: f.tripId,
        externalOriginId: f.origin.id,
      }))!;
      const payload = buildExternalOriginPreviewPayload({
        trip,
        snapshot,
        context,
        now: currentNow,
      });
      if (kind === 'destination-endpoint') {
        const destination = trip.dayOccurrences
          .flatMap((day) => day.nodes)
          .find((node) => node.id === snapshot.toNodeId);
        if (!destination?.place) throw new Error('missing destination');
        await managed.client.place.update({
          where: { id: destination.place.id },
          data: { latitude: 0 },
        });
      } else if (kind === 'departure') {
        const response = await app.inject({
          method: 'POST',
          url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/depart`,
          headers: bearer(userA),
          payload: {
            baseTripVersion: trip.version,
            idempotencyKey: randomUUID(),
          },
        });
        expect(response.statusCode, response.body).toBe(200);
      } else if (kind === 'supersession') {
        currentNow = new Date(currentNow.getTime() + 60000);
        await manualExecution(
          { ...f.first.trip, version: trip.version },
          f.A.id,
          'MANUAL_ARRIVAL',
          currentNow.toISOString(),
        );
      } else if (kind === 'REPLACED' || kind === 'UNDONE')
        await managed.client.adoptedRoute.update({
          where: { id: f.source.adoptedRouteId },
          data: { status: kind },
        });
      else if (kind === 'edge-delete' || kind === 'prefix-topology')
        await managed.client.transportEdge.delete({
          where: {
            id:
              kind === 'prefix-topology'
                ? f.prefix.id
                : f.source.transportEdgeId,
          },
        });
      else if (kind === 'edge-route')
        await managed.client.transportEdge.update({
          where: { id: f.source.transportEdgeId },
          data: { adoptedRouteId: await externalPreviewHistoricalRoute(f) },
        });
      else if (kind === 'edge-MANUAL')
        await managed.client.transportEdge.update({
          where: { id: f.source.transportEdgeId },
          data: {
            source: 'MANUAL',
            adoptedRouteId: null,
            provider: null,
            providerRef: null,
          },
        });
      else if (kind === 'leg-delete')
        await managed.client.groundTransitLegExecution.delete({
          where: { id: f.source.id },
        });
      else if (kind === 'leg-route')
        await managed.client.groundTransitLegExecution.update({
          where: { id: f.source.id },
          data: { adoptedRouteId: await externalPreviewHistoricalRoute(f) },
        });
      else if (kind === 'metadata')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.origin.id },
          data: { latitude: 35.72 },
        });
      else if (kind === 'node-actual')
        await managed.client.temporalValue.create({
          data: {
            nodeId: f.C.id,
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: currentNow,
            timeZone: 'UTC',
            sourceKind: 'EXECUTION_OBSERVATION',
          },
        });
      else if (kind === 'historical-anchor' || kind === 'retained-reference')
        await retainExternalPreviewNode(
          f,
          kind === 'historical-anchor' ? 'anchor' : 'receipt',
        );
      else if (kind === 'user-actual' || kind === 'provider-actual')
        await managed.client.temporalValue.create({
          data: {
            transportEdgeId: f.source.transportEdgeId,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
            instant: currentNow,
            timeZone: 'UTC',
            sourceKind:
              kind === 'provider-actual'
                ? 'PROVIDER_OBSERVATION'
                : 'USER_VALUE',
          },
        });
      else if (kind === 'TTL')
        currentNow = new Date(currentNow.getTime() + 1800000);
      else
        await managed.client.routeCandidateSnapshot.update({
          where: { id: snapshot.id },
          data: { candidateHash: 'f'.repeat(64) },
        });
      const before = await previewFormalState(f.tripId);
      const count = await managed.client.routePreview.count({
        where: { tripId: f.tripId },
      });
      expect(
        await repo.createExternalOriginPreview({
          ownerUserId: userA.actor.userId,
          tripId: f.tripId,
          basisVersion: trip.version,
          snapshotId: snapshot.id,
          expectedCandidateHash: snapshot.candidateHash,
          policyVersion: payload.policyVersion,
          previewPayload: payload,
          previewHash: hashRoutePreviewPayload(payload),
          now: snapshot.createdAt,
          createdAt: snapshot.createdAt,
          expiresAt: new Date(snapshot.createdAt.getTime() + 600000),
        }),
      ).toEqual({ status: 'PREVIEW_STALE' });
      expect(
        await managed.client.routePreview.count({
          where: { tripId: f.tripId },
        }),
      ).toBe(count);
      expect(await previewFormalState(f.tripId)).toEqual(before);
      if (kind === 'provider-actual') {
        const refreshed = await previewFromExternalFixture(f);
        expect(refreshed.statusCode, refreshed.body).toBe(201);
        expect(refreshed.json()).toMatchObject({
          status: 'ACTIVE',
          changeSummary: {
            archivableProviderActualTransportEdgeIds: [
              f.source.transportEdgeId,
            ],
          },
        });
      }
    },
  );

  it.each(['USER', 'ADMIN'] as const)(
    'P5E2 5B2A: another %s cannot create/read an external Preview',
    async (role) => {
      const f = await externalPreviewFixture();
      const preview = (
        await previewFromExternalFixture(f)
      ).json<RoutePreviewView>();
      const before = await previewFormalState(f.tripId);
      const other = role === 'ADMIN' ? admin : userB;
      expect((await previewFromExternalFixture(f, other)).statusCode).toBe(404);
      const response = await app.inject({
        method: 'GET',
        url: `/trips/${f.tripId}/previews/${preview.previewId}`,
        headers: bearer(other),
      });
      expect(response.statusCode).toBe(404);
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  it('P5E2 5B2A: vehicle recovery alone keeps E Preview eligible', async () => {
    const f = await externalPreviewFixture(1, ['SHORT_TURN', 'RECOVERY']);
    currentNow = new Date(currentNow.getTime() + 60000);
    const refresh = await app.inject({
      method: 'POST',
      url: `${f.base}/refresh`,
      headers: bearer(userA),
    });
    expect(refresh.statusCode, refresh.body).toBe(200);
    const response = await previewFromExternalFixture(f);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ status: 'ACTIVE' });
  });

  let externalPreviewForeignTrip:
    { id: string; from: string; to: string } | undefined;
  async function externalPreviewOtherTrip(
    f: Awaited<ReturnType<typeof externalPreviewFixture>>,
  ) {
    const trip = await managed.client.trip.findUniqueOrThrow({
      where: { id: f.tripId },
    });
    const other = await managed.client.trip.create({
      data: { ...trip, id: randomUUID() },
    });
    const day = await managed.client.dayOccurrence.findFirstOrThrow({
      where: { tripId: f.tripId },
    });
    const otherDay = await managed.client.dayOccurrence.create({
      data: { ...day, id: randomUUID(), tripId: other.id },
    });
    const endpoints = await managed.client.itineraryNode.findMany({
      where: { id: { in: [f.A.id, f.D.id] } },
      orderBy: { position: 'asc' },
    });
    const ids: string[] = [];
    for (const [position, endpoint] of endpoints.entries())
      ids.push(
        (
          await managed.client.itineraryNode.create({
            data: {
              ...endpoint,
              id: randomUUID(),
              tripId: other.id,
              dayOccurrenceId: otherDay.id,
              position,
            },
          })
        ).id,
      );
    externalPreviewForeignTrip = { id: other.id, from: ids[0]!, to: ids[1]! };
    return other.id;
  }
  async function externalPreviewCopySourcePreview(
    f: Awaited<ReturnType<typeof externalPreviewFixture>>,
  ) {
    const route = await managed.client.adoptedRoute.findUniqueOrThrow({
      where: { id: f.source.adoptedRouteId },
    });
    const preview = await managed.client.routePreview.findUniqueOrThrow({
      where: { id: route.sourcePreviewId },
    });
    return (
      await managed.client.routePreview.create({
        data: {
          ...preview,
          previewPayload: preview.previewPayload as JsonInput,
          id: randomUUID(),
        },
      })
    ).id;
  }
  async function externalPreviewHistoricalRoute(
    f: Awaited<ReturnType<typeof externalPreviewFixture>>,
    foreign = false,
  ) {
    const route = await managed.client.adoptedRoute.findUniqueOrThrow({
      where: { id: f.source.adoptedRouteId },
    });
    const history = await managed.client.adoptedRoute.create({
      data: {
        ...cloneNodeRoute(route),
        id: randomUUID(),
        status: 'UNDONE',
        sourcePreviewId: await externalPreviewCopySourcePreview(f),
        ...(foreign
          ? {
              tripId: externalPreviewForeignTrip!.id,
              anchorFromNodeId: externalPreviewForeignTrip!.from,
              anchorToNodeId: externalPreviewForeignTrip!.to,
            }
          : {}),
      },
    });
    return history.id;
  }

  it('P5E2 5B2A: legal same-ID transfer reuse ignores deletion-only historical anchor protection', async () => {
    const f = await externalPreviewFixture();
    await retainExternalPreviewNode(f, 'anchor');
    const node = await managed.client.itineraryNode.findUniqueOrThrow({
      where: { id: f.C.id },
      include: { place: true },
    });
    const source = suffixFoundationCandidate(true).candidates[0]!;
    const transfer = {
      name: node.place!.name,
      latitude: node.place!.latitude.toNumber(),
      longitude: node.place!.longitude.toNumber(),
      providerPlaceRef: node.providerPlaceRef,
      providerHubRef: node.providerHubRef,
    };
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...source,
          legs: [
            {
              ...source.legs[0]!,
              from: {
                name: f.origin.name,
                latitude: f.origin.latitude,
                longitude: f.origin.longitude,
                providerPlaceRef: null,
                providerHubRef: f.origin.providerHubRef,
              },
              to: transfer,
            },
            { ...source.legs[1]!, from: transfer },
          ],
        },
      ],
    };
    const queried = await app.inject({
      method: 'POST',
      url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
      headers: bearer(userA),
      payload: { basisVersion: await readVersion(f.tripId), toNodeId: f.D.id },
    });
    expect(queried.statusCode, queried.body).toBe(200);
    f.snapshotId = queried.json().candidates[0].candidateSnapshotId;
    const response = await previewFromExternalFixture(f);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'ACTIVE',
      changeSummary: {
        nodesToRemove: [],
        protectedBlockingNodes: [],
        nodesToReuse: [{ nodeId: f.C.id }],
        externalOriginReplacement: {
          materializedOrigin: { nodeId: null, action: 'CREATE' },
        },
      },
    });
  });

  describe('Draft TTL EXTERNAL_EXECUTION_ORIGIN', () => {
    const requestAt = new Date('2030-10-01T10:29:01Z');
    const expiry = new Date('2030-10-01T10:29:02Z');
    const expired = new Date('2030-10-01T10:29:03Z');
    for (const phase of ['query', 'preview'] as const) {
      const kinds =
        phase === 'query'
          ? (['snapshot', 'provider'] as const)
          : (['snapshot', 'provider', 'preview'] as const);
      for (const timing of ['owner', 'Trip', 'insert'] as const) {
        it.each(kinds)(
          `${phase} ${timing} crossing %s TTL preserves the complete database footprint`,
          async (kind) => {
            const f = await externalPreviewFixture();
            if (phase === 'preview' && kind !== 'preview')
              await setSyntheticSnapshotExpiry(
                managed,
                f.snapshotId,
                expiry,
                kind === 'provider' ? expiry : null,
              );
            if (providerResult.status !== 'SUCCESS')
              throw new Error('SYNTHETIC fixture must be successful');
            providerResult = {
              ...providerResult,
              candidates: providerResult.candidates.map((candidate) => ({
                ...candidate,
                validUntil: kind === 'provider' ? expiry : null,
              })),
            };
            currentNow = requestAt;
            let advance = false;
            const draftApp = draftPlanningApi(
              managed,
              () => currentNow,
              new SyntheticRouteProvider(async (input) =>
                externalProviderResult(input),
              ),
              {
                snapshotTtlSeconds:
                  phase === 'query' && kind === 'snapshot' ? 1 : 900,
                previewTtlSeconds: kind === 'preview' ? 1 : 600,
                afterSnapshot: () => {
                  if (advance && phase === 'query') currentNow = expired;
                },
                afterPreview: () => {
                  if (advance && phase === 'preview') currentNow = expired;
                },
              },
            );
            try {
              const version = await readVersion(f.tripId);
              const before = await adoptionFootprint(
                managed,
                f.tripId,
                userA.actor.userId,
              );
              const request = () =>
                draftApp.inject({
                  method: 'POST',
                  url:
                    phase === 'query'
                      ? `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`
                      : `/trips/${f.tripId}/previews`,
                  headers: bearer(userA),
                  payload:
                    phase === 'query'
                      ? { basisVersion: version, toNodeId: f.D.id }
                      : {
                          basisVersion: version,
                          candidateSnapshotId: f.snapshotId,
                        },
                });
              advance = timing === 'insert';
              const response =
                timing === 'insert'
                  ? await request()
                  : await withHeldDraftLock(
                      managed,
                      userA.actor.userId,
                      f.tripId,
                      timing,
                      request,
                      () => {
                        currentNow = expired;
                      },
                    );
              const after = await adoptionFootprint(
                managed,
                f.tripId,
                userA.actor.userId,
              );
              await draftEvidence(
                `external-${phase}-${timing}-${kind}`,
                before,
                after,
                {
                  requestAt: requestAt.toISOString(),
                  expiresAt: expiry.toISOString(),
                  finalClock: currentNow.toISOString(),
                  httpStatus: response.statusCode,
                  errorCode: response.json().error?.code ?? null,
                },
              );
              expect(response.statusCode, response.body).toBe(
                phase === 'query' ? 404 : 409,
              );
              expect(response.json().error.code).toBe(
                phase === 'query' ? 'NO_MATCHING_CANDIDATE' : 'PREVIEW_STALE',
              );
              expect(after).toEqual(before);
            } finally {
              await draftApp.close();
            }
          },
        );
      }
    }
    it.each([-1, 0, 1])(
      'external Preview exact TTL boundary (%s ms), nullable Provider, readonly stale lookup',
      async (offset) => {
        const f = await externalPreviewFixture();
        await setSyntheticSnapshotExpiry(managed, f.snapshotId, expiry, null);
        currentNow = requestAt;
        const before = await adoptionFootprint(
          managed,
          f.tripId,
          userA.actor.userId,
        );
        const response = await withHeldDraftLock(
          managed,
          userA.actor.userId,
          f.tripId,
          'owner',
          () => previewFromExternalFixture(f),
          () => {
            currentNow = new Date(expiry.getTime() + offset);
          },
        );
        expect(response.statusCode, response.body).toBe(offset < 0 ? 201 : 409);
        if (offset >= 0) {
          expect(
            await adoptionFootprint(managed, f.tripId, userA.actor.userId),
          ).toEqual(before);
        } else {
          currentNow = expiry;
          const saved = await adoptionFootprint(
            managed,
            f.tripId,
            userA.actor.userId,
          );
          const read = await app.inject({
            method: 'GET',
            url: `/trips/${f.tripId}/previews/${response.json().previewId}`,
            headers: bearer(userA),
          });
          expect(read.statusCode, read.body).toBe(200);
          expect(read.json()).toMatchObject({
            status: 'EXPIRED',
            adoptable: false,
          });
          expect(
            await adoptionFootprint(managed, f.tripId, userA.actor.userId),
          ).toEqual(saved);
        }
      },
    );
  });

  describe('Draft TTL external Query boundaries and successful chain', () => {
    const requestAt = new Date('2030-10-01T10:29:01Z');
    const expiry = new Date('2030-10-01T10:29:02Z');
    const expired = new Date('2030-10-01T10:29:03Z');
    it.each([-1, 0, 1])(
      'external Query null Provider TTL at boundary (%s ms)',
      async (offset) => {
        const f = await externalPreviewFixture();
        if (providerResult.status !== 'SUCCESS')
          throw new Error('SYNTHETIC fixture must be successful');
        providerResult = {
          ...providerResult,
          candidates: providerResult.candidates.map((candidate) => ({
            ...candidate,
            validUntil: null,
          })),
        };
        currentNow = requestAt;
        const draftApp = draftPlanningApi(
          managed,
          () => currentNow,
          new SyntheticRouteProvider(async (input) =>
            externalProviderResult(input),
          ),
          { snapshotTtlSeconds: 1 },
        );
        try {
          const version = await readVersion(f.tripId);
          const before = await adoptionFootprint(
            managed,
            f.tripId,
            userA.actor.userId,
          );
          const response = await withHeldDraftLock(
            managed,
            userA.actor.userId,
            f.tripId,
            'Trip',
            () =>
              draftApp.inject({
                method: 'POST',
                url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
                headers: bearer(userA),
                payload: { basisVersion: version, toNodeId: f.D.id },
              }),
            () => {
              currentNow = new Date(expiry.getTime() + offset);
            },
          );
          expect(response.statusCode, response.body).toBe(
            offset < 0 ? 200 : 404,
          );
          if (offset >= 0)
            expect(
              await adoptionFootprint(managed, f.tripId, userA.actor.userId),
            ).toEqual(before);
          else
            expect(
              (
                await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
                  where: {
                    id: response.json().candidates[0].candidateSnapshotId,
                  },
                })
              ).providerValidUntil,
            ).toBeNull();
        } finally {
          await draftApp.close();
        }
      },
    );
    it.each(['owner', 'insert'] as const)(
      'external mixed Query candidates at %s',
      async (timing) => {
        const f = await externalPreviewFixture();
        if (providerResult.status !== 'SUCCESS')
          throw new Error('SYNTHETIC fixture must be successful');
        const base = providerResult.candidates[0]!;
        providerResult = {
          status: 'SUCCESS',
          candidates: [
            {
              ...base,
              candidateId: 'SYNTHETIC:external-short',
              validUntil: expiry,
            },
            {
              ...base,
              candidateId: 'SYNTHETIC:external-long',
              validUntil: new Date('2030-10-01T10:38:00Z'),
            },
          ],
        };
        currentNow = requestAt;
        const draftApp = draftPlanningApi(
          managed,
          () => currentNow,
          new SyntheticRouteProvider(async (input) =>
            externalProviderResult(input),
          ),
          {
            afterSnapshot: () => {
              if (timing === 'insert') currentNow = expired;
            },
          },
        );
        try {
          const version = await readVersion(f.tripId);
          const before = await adoptionFootprint(
            managed,
            f.tripId,
            userA.actor.userId,
          );
          const request = () =>
            draftApp.inject({
              method: 'POST',
              url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
              headers: bearer(userA),
              payload: { basisVersion: version, toNodeId: f.D.id },
            });
          const response =
            timing === 'insert'
              ? await request()
              : await withHeldDraftLock(
                  managed,
                  userA.actor.userId,
                  f.tripId,
                  'owner',
                  request,
                  () => {
                    currentNow = expired;
                  },
                );
          if (timing === 'insert') {
            expect(response.statusCode, response.body).toBe(404);
            expect(
              await adoptionFootprint(managed, f.tripId, userA.actor.userId),
            ).toEqual(before);
          } else {
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().candidates).toHaveLength(1);
            expect(response.json().candidates[0].candidateId).toBe(
              'SYNTHETIC:external-long',
            );
            const inserted =
              await managed.client.routeCandidateSnapshot.findMany({
                where: {
                  tripId: f.tripId,
                  fromExternalOriginId: f.origin.id,
                  id: { not: f.snapshotId },
                },
              });
            expect(inserted).toHaveLength(1);
            const after = await adoptionFootprint(
              managed,
              f.tripId,
              userA.actor.userId,
            );
            expect({ ...after, snapshots: before.snapshots }).toEqual(before);
            expect(
              inserted.some(
                (row) =>
                  row.id ===
                    response.json().candidates[0].candidateSnapshotId &&
                  row.expiresAt > currentNow,
              ),
            ).toBe(true);
          }
        } finally {
          await draftApp.close();
        }
      },
    );
    it('external post-Provider I/O samples a fresh Clock and persists no expired evidence', async () => {
      const f = await externalPreviewFixture();
      if (providerResult.status !== 'SUCCESS')
        throw new Error('SYNTHETIC fixture must be successful');
      providerResult = {
        ...providerResult,
        candidates: providerResult.candidates.map((candidate) => ({
          ...candidate,
          validUntil: expiry,
        })),
      };
      currentNow = requestAt;
      const draftApp = draftPlanningApi(
        managed,
        () => currentNow,
        new SyntheticRouteProvider(async (input) => {
          currentNow = expired;
          return externalProviderResult(input);
        }),
      );
      try {
        const before = await adoptionFootprint(
          managed,
          f.tripId,
          userA.actor.userId,
        );
        const response = await draftApp.inject({
          method: 'POST',
          url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
          headers: bearer(userA),
          payload: {
            basisVersion: await readVersion(f.tripId),
            toNodeId: f.D.id,
          },
        });
        expect(response.statusCode, response.body).toBe(404);
        expect(
          await adoptionFootprint(managed, f.tripId, userA.actor.userId),
        ).toEqual(before);
      } finally {
        await draftApp.close();
      }
    });
    it('external valid evidence supports fresh Query → Preview → Adopt → expired-evidence receipt replay → Undo', async () => {
      const f = await externalPreviewFixture();
      await setSyntheticSnapshotExpiry(managed, f.snapshotId, expiry, expiry);
      currentNow = requestAt;
      const previewResponse = await previewFromExternalFixture(f);
      expect(previewResponse.statusCode, previewResponse.body).toBe(201);
      const trip = {
        ...f.first.trip,
        version: previewResponse.json().basisVersion,
      };
      const adopted = await adoptSuccessfully(
        userA,
        trip,
        previewResponse.json().previewId,
        'SYNTHETIC:external-draft-TTL',
      );
      currentNow = expired;
      const replay = await adopt(
        userA,
        trip,
        previewResponse.json().previewId,
        'SYNTHETIC:external-draft-TTL',
      );
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().operationReceipt.id).toBe(
        adopted.operationReceipt.id,
      );
      await undoSuccessfully(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        'SYNTHETIC:external-draft-TTL-undo',
      );
    });
  });

  describe('I59-01 EXTERNAL_EXECUTION_ORIGIN evidence TTL', () => {
    const requestAt = new Date('2030-10-01T10:29:01Z');
    const expiresAt = new Date('2030-10-01T10:29:02Z');
    const afterExpiry = new Date('2030-10-01T10:29:03Z');
    const later = new Date('2030-10-01T10:38:00Z');
    type Kind = 'preview' | 'snapshot' | 'provider' | 'all';

    async function prepared(kind: Kind, nullable = false) {
      const f = await externalPreviewFixture();
      await setSyntheticSnapshotExpiry(
        managed,
        f.snapshotId,
        // PostgreSQL requires Snapshot.expiresAt <= providerValidUntil.
        kind === 'snapshot' || kind === 'provider' || kind === 'all'
          ? expiresAt
          : later,
        nullable
          ? null
          : kind === 'provider' || kind === 'all'
            ? expiresAt
            : later,
      );
      const response = await previewFromExternalFixture(f);
      expect(response.statusCode, response.body).toBe(201);
      const preview = response.json<RoutePreviewView>();
      await managed.client.routePreview.update({
        where: { id: preview.previewId },
        data: {
          expiresAt: kind === 'preview' || kind === 'all' ? expiresAt : later,
        },
      });
      currentNow = requestAt;
      return {
        f,
        preview,
        trip: { ...f.first.trip, version: preview.basisVersion },
      };
    }

    for (const lock of ['owner', 'Trip', 'external source'] as const) {
      it.each(['preview', 'snapshot', 'provider', 'all'] as const)(
        `${lock} lock wait crossing %s TTL rejects without any writes`,
        async (kind) => {
          const { f, preview, trip } = await prepared(kind);
          const before = await adoptionFootprint(
            managed,
            f.tripId,
            userA.actor.userId,
          );
          const held = gate(),
            release = gate();
          let pid = 0;
          const holder = managed.client.$transaction(
            async (tx) => {
              pid = (
                await tx.$queryRaw<
                  { pid: number }[]
                >`SELECT pg_backend_pid() AS pid`
              )[0]!.pid;
              if (lock === 'owner')
                await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${userA.actor.userId},2))`;
              else if (lock === 'Trip')
                await tx.$queryRaw`SELECT id FROM "Trip" WHERE id=${f.tripId}::uuid FOR UPDATE`;
              else
                await tx.$queryRaw`SELECT id FROM "AdoptedRoute" WHERE id=${f.source.adoptedRouteId}::uuid FOR UPDATE`;
              held.release();
              await release.pending;
            },
            { timeout: 15000 },
          );
          await held.pending;
          const request = adopt(userA, trip, preview.previewId, randomUUID());
          try {
            await waitForAdoptionLock(managed, pid);
            currentNow = afterExpiry;
            release.release();
            const response = await request;
            const after = await adoptionFootprint(
              managed,
              f.tripId,
              userA.actor.userId,
            );
            if (kind === 'preview')
              await ttlEvidence(
                `external-preview-${lock}-wait`,
                before,
                after,
                {
                  requestAt: requestAt.toISOString(),
                  expiresAt: expiresAt.toISOString(),
                  checkedAt: currentNow.toISOString(),
                  httpStatus: response.statusCode,
                  errorCode: response.json().error?.code ?? null,
                },
              );
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json().error.code).toBe('PREVIEW_STALE');
            expect(after).toEqual(before);
          } finally {
            release.release();
            await holder;
            await request;
          }
        },
      );
    }

    it.each(['preview', 'snapshot', 'provider', 'all'] as const)(
      'tentative external materialization crossing %s TTL rolls back every row',
      async (kind) => {
        const { f, preview, trip } = await prepared(kind);
        const before = await adoptionFootprint(
          managed,
          f.tripId,
          userA.actor.userId,
        );
        let observedWrites = 0;
        const adoptionApi = ttlAdoptionApi(
          managed,
          () => currentNow,
          () => {
            observedWrites++;
            currentNow = afterExpiry;
          },
        );
        try {
          const response = await adoptionApi.inject({
            method: 'POST',
            headers: bearer(userA),
            url: `/trips/${f.tripId}/previews/${preview.previewId}/adopt`,
            payload: {
              baseTripVersion: trip.version,
              idempotencyKey: randomUUID(),
            },
          });
          const after = await adoptionFootprint(
            managed,
            f.tripId,
            userA.actor.userId,
          );
          if (kind === 'all')
            await ttlEvidence('external-all-writes', before, after, {
              requestAt: requestAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              checkedAt: currentNow.toISOString(),
              observedTentativeOutboxWrites: observedWrites,
              httpStatus: response.statusCode,
              errorCode: response.json().error?.code ?? null,
            });
          expect(observedWrites).toBe(1);
          expect(response.statusCode, response.body).toBe(409);
          expect(response.json().error.code).toBe('PREVIEW_STALE');
          expect(after).toEqual(before);
        } finally {
          await adoptionApi.close();
        }
      },
    );

    it.each(['preview', 'snapshot', 'provider'] as const)(
      'exact equality at %s expiry rejects',
      async (kind) => {
        const { f, preview, trip } = await prepared(kind);
        currentNow = expiresAt;
        const before = await adoptionFootprint(
          managed,
          f.tripId,
          userA.actor.userId,
        );
        const response = await adopt(
          userA,
          trip,
          preview.previewId,
          randomUUID(),
        );
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().error.code).toBe('PREVIEW_STALE');
        expect(
          await adoptionFootprint(managed, f.tripId, userA.actor.userId),
        ).toEqual(before);
      },
    );

    it.each([false, true])(
      'provider TTL null=%s permits valid external Adopt, expired-evidence replay and Undo',
      async (nullable) => {
        const { f, preview, trip } = await prepared('all', nullable);
        const key = randomUUID();
        const response = await adopt(userA, trip, preview.previewId, key);
        expect(response.statusCode, response.body).toBe(200);
        const accepted = response.json<AdoptRoutePreviewResponse>();
        expect(accepted.operationReceipt.undoExpiresAt).toBe(
          '2030-10-01T10:39:01.000Z',
        );
        currentNow = afterExpiry;
        const before = await adoptionFootprint(
          managed,
          f.tripId,
          userA.actor.userId,
        );
        const replay = await adopt(userA, trip, preview.previewId, key);
        expect(replay.statusCode, replay.body).toBe(200);
        expect(
          replay.json<AdoptRoutePreviewResponse>().operationReceipt,
        ).toEqual(accepted.operationReceipt);
        expect(
          await adoptionFootprint(managed, f.tripId, userA.actor.userId),
        ).toEqual(before);
        const conflictingReplay = await adopt(
          userA,
          accepted.trip,
          preview.previewId,
          key,
        );
        expect(conflictingReplay.statusCode, conflictingReplay.body).toBe(409);
        expect(conflictingReplay.json().error.code).toBe(
          'IDEMPOTENCY_CONFLICT',
        );
        expect(
          await adoptionFootprint(managed, f.tripId, userA.actor.userId),
        ).toEqual(before);
        const undone = await undo(
          userA,
          accepted.trip,
          accepted.operationReceipt.id,
          randomUUID(),
        );
        expect(undone.statusCode, undone.body).toBe(200);
        expect(undone.json().trip.version).toBe(accepted.trip.version + 1);
        expect(
          (await adoptionFootprint(managed, f.tripId, userA.actor.userId))
            .execution,
        ).toEqual(before.execution);
      },
    );
  });

  it('RWS-02 external: elapsed fixed departure during Provider I/O cannot save a snapshot', async () => {
    const f = await externalPreviewFixture(); // 10:29, fixed RAIL 10:30.
    const version = await readVersion(f.tripId);
    const before = await externalDurableState(f.tripId);
    providerHook = async () => {
      currentNow = new Date('2030-10-01T10:31:00Z');
    };
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
      headers: bearer(userA),
      payload: { basisVersion: version, toNodeId: f.D.id },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error.code).toBe('NO_MATCHING_CANDIDATE');
    expect(await externalDurableState(f.tripId)).toEqual(before);
  });
  it.each(['query', 'preview', 'adopt'] as const)(
    'RWS-02 external: %s rechecks fixed departure after the owner lock',
    async (phase) => {
      const f = await externalPreviewFixture();
      const previewResponse = await previewFromExternalFixture(f);
      expect(previewResponse.statusCode, previewResponse.body).toBe(201);
      const preview = previewResponse.json<RoutePreviewView>();
      expect(preview.expiresAt).toBe('2030-10-01T10:39:00.000Z');
      const before = await externalDurableState(f.tripId);
      const locked = gate(),
        release = gate();
      const holder = managed.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${userA.actor.userId}, 2))`;
          locked.release();
          await release.pending;
        },
        { timeout: 15000 },
      );
      await locked.pending;
      const request =
        phase === 'query'
          ? app.inject({
              method: 'POST',
              url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/routes/query`,
              headers: bearer(userA),
              payload: { basisVersion: preview.basisVersion, toNodeId: f.D.id },
            })
          : phase === 'preview'
            ? previewFromExternalFixture(f)
            : adopt(
                userA,
                { ...f.first.trip, version: preview.basisVersion },
                preview.previewId,
                randomUUID(),
              );
      try {
        await waitForOwnerLock(managed, 1);
        currentNow = new Date('2030-10-01T10:31:00Z');
        release.release();
        const response = await request;
        expect(response.statusCode, response.body).toBe(
          phase === 'query' ? 404 : 409,
        );
        expect(response.json().error.code).toBe(
          phase === 'query' ? 'NO_MATCHING_CANDIDATE' : 'PREVIEW_STALE',
        );
        const read = await app.inject({
          method: 'GET',
          url: `/trips/${f.tripId}/previews/${preview.previewId}`,
          headers: bearer(userA),
        });
        expect(read.statusCode, read.body).toBe(409);
        expect(read.json().error.code).toBe('PREVIEW_STALE');
        expect(await externalDurableState(f.tripId)).toEqual(before);
      } finally {
        release.release();
        await holder;
        await request;
      }
    },
  );
  it('P5E2 5B2A: destination minimum dwell and downstream hard departure are revalidated', async () => {
    const f = await externalPreviewFixture();
    await managed.client.userTimeIntent.create({
      data: {
        tripId: f.tripId,
        nodeId: f.D.id,
        kind: 'MIN_DWELL',
        operator: 'MINIMUM',
        durationSeconds: 600,
        locked: true,
      },
    });
    const constraint = await managed.client.userTimeIntent.create({
      data: {
        tripId: f.tripId,
        nodeId: f.D.id,
        kind: 'POINT_TIME',
        operator: 'NOT_AFTER',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T11:10:00Z'),
        timeZone: 'UTC',
        locked: true,
      },
    });
    const good = await previewFromExternalFixture(f);
    expect(good.statusCode, good.body).toBe(201);
    expect(good.json().changeSummary.downstreamImpact).toMatchObject({
      nodeId: f.D.id,
      userMinimumDwellSeconds: 600,
      projectedDwellSeconds: 600,
      status: 'NORMAL',
      requiredUserAdjustments: [],
    });
    await managed.client.userTimeIntent.update({
      where: { id: constraint.id },
      data: { instant: new Date('2030-10-01T11:05:00Z') },
    });
    const before = await previewFormalState(f.tripId);
    const stale = await previewFromExternalFixture(f);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'PREVIEW_STALE' } });
    expect(await previewFormalState(f.tripId)).toEqual(before);
  });

  it('P5E2 5B2A: E-to-F rollover rejects E snapshot and accepts CURRENT F preview', async () => {
    const f = await confirmedExternalQueryFixture([
      'SHORT_TURN',
      'SHORT_TURN_F',
    ]);
    const queryE = await externalQuery(f);
    expect(queryE.statusCode, queryE.body).toBe(200);
    currentNow = new Date(currentNow.getTime() + 60000);
    await manualExecution(
      { ...f.trip, version: await readVersion(f.trip.id) },
      f.from.id,
      'MANUAL_ARRIVAL',
      currentNow.toISOString(),
    );
    await nextExternalCandidate(f);
    const confirmedF = await confirmExternal(f);
    expect(confirmedF.statusCode, confirmedF.body).toBe(200);
    const current = confirmedF.json<ExternalOriginMutationResponse>();
    const version = await readVersion(f.trip.id);
    const stale = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: version,
        candidateSnapshotId: queryE.json().candidates[0].candidateSnapshotId,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'PREVIEW_STALE' } });
    const queryF = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/execution/external-origins/${current.origin.id}/routes/query`,
      headers: bearer(userA),
      payload: { basisVersion: version, toNodeId: f.to.id },
    });
    expect(queryF.statusCode, queryF.body).toBe(200);
    const preview = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: version,
        candidateSnapshotId: queryF.json().candidates[0].candidateSnapshotId,
      },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    expect(preview.json()).toMatchObject({
      status: 'ACTIVE',
      changeSummary: {
        externalOriginReplacement: { externalOriginId: current.origin.id },
      },
    });
  });

  it('P5E2 5B2A: departure does not turn unsupported external Adopt into a legacy stale path', async () => {
    const f = await externalPreviewFixture();
    const preview = (
      await previewFromExternalFixture(f)
    ).json<RoutePreviewView>();
    await preserveLegacyExternalPreview(preview.previewId);
    const departed = await app.inject({
      method: 'POST',
      url: `/trips/${f.tripId}/execution/external-origins/${f.origin.id}/depart`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: preview.basisVersion,
        idempotencyKey: randomUUID(),
      },
    });
    expect(departed.statusCode, departed.body).toBe(200);
    const before = await previewFormalState(f.tripId);
    const rejected = await adopt(
      userA,
      { ...f.first.trip, version: preview.basisVersion },
      preview.previewId,
      'synthetic-external-stale-unsupported',
    );
    expect(rejected.statusCode, rejected.body).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: 'PREVIEW_UNSUPPORTED' },
    });
    expect(await previewFormalState(f.tripId)).toEqual(before);
  });

  async function confirmedExternalQueryFixture(
    changes: Parameters<typeof groundSequence>[0] = ['SHORT_TURN'],
  ) {
    const f = await externalFixture(changes);
    const confirmed = await confirmExternal(f);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const result = confirmed.json<ExternalOriginMutationResponse>();
    const body = {
      basisVersion: result.resultingTripVersion,
      toNodeId: f.to.id,
    };
    const url = `/trips/${f.trip.id}/execution/external-origins/${result.origin.id}/routes/query`;
    providerInputs.length = 0;
    return { ...f, result, body, url };
  }
  it.each(['origin', 'destination', 'hub', 'name'] as const)(
    'rejects external Provider endpoint fault %s without writes',
    async (fault) => {
      const f = await confirmedExternalQueryFixture();
      externalEndpointFault = fault;
      const before = await externalDurableState(f.trip.id);
      const response = await externalQuery(f);
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'PROVIDER_UNAVAILABLE' },
      });
      expect(await externalDurableState(f.trip.id)).toEqual(before);
    },
  );

  it('accepts external Query exact-coordinate fallback without structured refs', async () => {
    const f = await confirmedExternalQueryFixture();
    const response = await externalQuery(f);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().candidates[0].legs[0].from).toMatchObject({
      latitude: f.result.origin.latitude,
      longitude: f.result.origin.longitude,
      providerPlaceRef: null,
      providerHubRef: null,
    });
  });

  it.each(['origin', 'destination'] as const)(
    'rejects valid-hash persisted external candidate with wrong %s',
    async (endpoint) => {
      const f = await externalPreviewFixture();
      const repository = new PrismaRoutePlanningRepository(managed.client);
      const snapshot = await repository.findSnapshotOwned({
        ownerUserId: userA.actor.userId,
        tripId: f.tripId,
        snapshotId: f.snapshotId,
      });
      if (!snapshot || snapshot.origin.type !== 'EXTERNAL_EXECUTION_ORIGIN')
        throw new Error('missing external snapshot');
      const payload = {
        ...snapshot.candidatePayload,
        legs: snapshot.candidatePayload.legs.map((leg, index) => ({
          ...leg,
          from:
            endpoint === 'origin' && index === 0
              ? { ...leg.from, latitude: 0, providerHubRef: 'wrong' }
              : leg.from,
          to:
            endpoint === 'destination' &&
            index === snapshot.candidatePayload.legs.length - 1
              ? {
                  ...leg.to,
                  longitude: 0,
                  providerPlaceRef: null,
                  providerHubRef: null,
                }
              : leg.to,
        })),
      };
      const candidateHash = hashExternalRouteCandidateSnapshot({
        tripId: f.tripId,
        basisVersion: snapshot.basisVersion,
        toNodeId: snapshot.toNodeId,
        provider: snapshot.provider,
        observedAt: snapshot.observedAt.toISOString(),
        candidatePayload: payload,
        externalOriginSnapshot: snapshot.origin.snapshot,
      });
      await managed.client.routeCandidateSnapshot.update({
        where: { id: f.snapshotId },
        data: {
          candidatePayload: payload as unknown as JsonInput,
          candidateHash,
        },
      });
      const before = await previewFormalState(f.tripId);
      const previewCount = await managed.client.routePreview.count({
        where: { tripId: f.tripId },
      });
      const response = await previewFromExternalFixture(f);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'PREVIEW_STALE' },
      });
      expect(
        await managed.client.routePreview.count({
          where: { tripId: f.tripId },
        }),
      ).toBe(previewCount);
      expect(await previewFormalState(f.tripId)).toEqual(before);
    },
  );

  async function readVersion(tripId: string) {
    return (
      await managed.client.trip.findUniqueOrThrow({ where: { id: tripId } })
    ).version;
  }
  function externalQuery(
    f: Awaited<ReturnType<typeof confirmedExternalQueryFixture>>,
    body: object = f.body,
    identity = userA,
  ) {
    return app.inject({
      method: 'POST',
      url: f.url,
      headers: bearer(identity),
      payload: body,
    });
  }
  async function assertExternalHandoffProvenance(
    handoff: { sourceTransportEdgeId: string; adoptedRouteId: string },
    origin: ExternalOriginMutationResponse['origin'],
  ) {
    expect(handoff).toMatchObject({
      sourceTransportEdgeId: origin.sourceTransportEdgeId,
      adoptedRouteId: origin.sourceAdoptedRouteId,
    });
    expect(
      await managed.client.groundTransitLegExecution.findUniqueOrThrow({
        where: { id: origin.sourceGroundTransitLegExecutionId },
      }),
    ).toMatchObject({
      id: origin.sourceGroundTransitLegExecutionId,
      transportEdgeId: handoff.sourceTransportEdgeId,
      adoptedRouteId: handoff.adoptedRouteId,
    });
  }
  it.each(['same-route/different-edge', 'different-route'] as const)(
    'P5E2 5B1 repair: %s handoff does not inherit another leg external origin',
    async (kind) => {
      const f = await suffixFixture(false, false, false);
      let trip = f.first.trip;
      const requestedLeg =
        await managed.client.groundTransitLegExecution.findFirstOrThrow({
          where: { tripId: trip.id, transportEdgeId: f.prefix.id },
        });
      let sourceLeg =
        await managed.client.groundTransitLegExecution.findFirstOrThrow({
          where: {
            tripId: trip.id,
            transportEdgeId: f.suffixEdges.find(
              (edge) => edge.fromNodeId === f.B.id,
            )!.id,
          },
        });
      let toNodeId = f.D.id;
      if (kind === 'different-route') {
        trip = await addVisit(userA, trip, 'SYNTHETIC P', '2030-10-01');
        trip = await addVisit(userA, trip, 'SYNTHETIC Q', '2030-10-01');
        const [P, Q] = trip.days.flatMap((day) => day.nodes).slice(-2);
        const base = candidate(
          '2030-10-01T11:30:00Z',
          '2030-10-01T12:30:00Z',
          'UTC',
          'UTC',
        );
        providerResult = {
          status: 'SUCCESS',
          candidates: [
            {
              ...base,
              legs: [
                {
                  ...base.legs[0]!,
                  mode: 'RAIL',
                  groundTransit: {
                    ...suffixFoundationCandidate(false).candidates[0]!.legs[0]!
                      .groundTransit!,
                    serviceIdentityKey: 'synthetic:repair:second-route',
                    boardingHubRef: 'synthetic:P',
                    alightingHubRef: 'synthetic:Q',
                  },
                },
              ],
            },
          ],
        };
        const preview = await createPreview(userA, trip, P!.id, Q!.id, {
          type: 'DEPART_AT',
          instant: '2030-10-01T11:30:00Z',
          timeZone: 'UTC',
        });
        const adopted = await adoptSuccessfully(
          userA,
          trip,
          preview.previewId,
          'synthetic-repair-second-route',
        );
        trip = adopted.trip;
        sourceLeg =
          await managed.client.groundTransitLegExecution.findFirstOrThrow({
            where: { adoptedRouteId: adopted.operationReceipt.adoptedRouteId },
          });
        toNodeId = Q!.id;
        expect(
          await managed.client.adoptedRoute.count({
            where: { tripId: trip.id, status: 'ACTIVE' },
          }),
        ).toBe(2);
        expect(sourceLeg.adoptedRouteId).not.toBe(requestedLeg.adoptedRouteId);
      } else {
        expect(sourceLeg.adoptedRouteId).toBe(requestedLeg.adoptedRouteId);
        expect(sourceLeg.transportEdgeId).not.toBe(
          requestedLeg.transportEdgeId,
        );
      }
      await app.close();
      app = buildTestApi(
        new SyntheticRouteProvider(async (input) => {
          providerInputs.push(input);
          return {
            status: 'SUCCESS',
            candidates: [
              {
                ...candidate('2030-10-01T10:00:00Z', '2030-10-01T11:00:00Z'),
                legs: candidate(
                  '2030-10-01T10:00:00Z',
                  '2030-10-01T11:00:00Z',
                ).legs.map((leg) => ({
                  ...leg,
                  from: { ...input.origin, providerPlaceRef: null },
                  to: { ...input.destination, providerPlaceRef: null },
                })),
              },
            ],
          };
        }),
        groundSequence(['SHORT_TURN']),
      );
      const base = `/trips/${trip.id}/execution/ground-transit/${sourceLeg.transportEdgeId}`;
      const refresh = await app.inject({
        method: 'POST',
        url: `${base}/refresh`,
        headers: bearer(userA),
      });
      expect(refresh.statusCode, refresh.body).toBe(200);
      const view = (
        await app.inject({
          method: 'GET',
          url: `${base}/external-origin`,
          headers: bearer(userA),
        })
      ).json<ExternalOriginResponse>();
      expect(view.availability).toBe('CONFIRMATION_REQUIRED');
      const confirmed = await app.inject({
        method: 'POST',
        url: `${base}/external-origin/confirm`,
        headers: bearer(userA),
        payload: {
          baseTripVersion: await readVersion(trip.id),
          candidateRef: view.candidate!.candidateRef,
          idempotencyKey: randomUUID(),
        },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const result = confirmed.json<ExternalOriginMutationResponse>();
      expect(result.origin).toMatchObject({
        sourceTransportEdgeId: sourceLeg.transportEdgeId,
        sourceGroundTransitLegExecutionId: sourceLeg.id,
        sourceAdoptedRouteId: sourceLeg.adoptedRouteId,
        currentness: 'CURRENT',
      });
      providerInputs.length = 0;
      const before = await externalDurableState(trip.id);
      const mismatched = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}/execution/ground-transit/${requestedLeg.transportEdgeId}/route-reevaluation`,
        headers: bearer(userA),
      });
      expect(mismatched.statusCode, mismatched.body).toBe(200);
      expect(mismatched.json().originBasis).not.toBe(
        'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
      );
      expect(mismatched.json().externalQuery ?? null).toBeNull();
      expect(mismatched.json()).toMatchObject({
        sourceTransportEdgeId: requestedLeg.transportEdgeId,
        adoptedRouteId: requestedLeg.adoptedRouteId,
        readiness: 'NOT_REQUIRED',
      });
      expect(await externalDurableState(trip.id)).toEqual(before);
      const matching = await app.inject({
        method: 'GET',
        url: `${base}/route-reevaluation`,
        headers: bearer(userA),
      });
      expect(matching.statusCode, matching.body).toBe(200);
      expect(matching.json()).toMatchObject({
        readiness: 'READY',
        originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
        query: null,
        externalQuery: { externalOriginId: result.origin.id, toNodeId },
      });
      await assertExternalHandoffProvenance(matching.json(), result.origin);
      expect(await externalDurableState(trip.id)).toEqual(before);
      expect(providerInputs).toHaveLength(0);
      const queried = await app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/execution/external-origins/${result.origin.id}/routes/query`,
        headers: bearer(userA),
        payload: { basisVersion: result.resultingTripVersion, toNodeId },
      });
      expect(queried.statusCode, queried.body).toBe(200);
      expect(providerInputs).toHaveLength(1);
    },
  );
  it('P5E2 5B1 repair: matching edge/route with mismatched leg execution ID cannot expose external Query', async () => {
    const f = await confirmedExternalQueryFixture();
    await managed.client.externalExecutionOrigin.update({
      where: { id: f.result.origin.id },
      data: { sourceGroundTransitLegExecutionId: randomUUID() },
    });
    const before = await externalDurableState(f.trip.id);
    const response = await app.inject({
      method: 'GET',
      url: `${f.base}/route-reevaluation`,
      headers: bearer(userA),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().originBasis).not.toBe(
      'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
    );
    expect(response.json().externalQuery ?? null).toBeNull();
    expect(await externalDurableState(f.trip.id)).toEqual(before);
    expect(providerInputs).toHaveLength(0);
  });
  it('P5E2 5B1/5B2A: handoff and Query stay read-only; external Preview is a plan only', async () => {
    const f = await confirmedExternalQueryFixture();
    const nodeSnapshot =
      await managed.client.routeCandidateSnapshot.findFirstOrThrow({
        where: { tripId: f.trip.id, originKind: 'ITINERARY_NODE' },
      });
    expect(nodeSnapshot).toMatchObject({
      originKind: 'ITINERARY_NODE',
      fromNodeId: f.from.id,
      fromExternalOriginId: null,
      externalOriginSnapshot: null,
    });
    expect(
      (
        await new PrismaRoutePlanningRepository(
          managed.client,
        ).findSnapshotOwned({
          ownerUserId: userA.actor.userId,
          tripId: f.trip.id,
          snapshotId: nodeSnapshot.id,
        })
      )?.origin,
    ).toEqual({ type: 'ITINERARY_NODE', nodeId: f.from.id });
    const before = await externalDurableState(f.trip.id);
    const handoff = await app.inject({
      method: 'GET',
      url: `${f.base}/route-reevaluation`,
      headers: bearer(userA),
    });
    expect(handoff.json()).toMatchObject({
      readiness: 'READY',
      originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
      query: null,
      externalQuery: {
        externalOriginId: f.result.origin.id,
        ...f.body,
        hint: { type: 'DEPART_AT', timeZone: 'Asia/Tokyo' },
      },
    });
    await assertExternalHandoffProvenance(handoff.json(), f.result.origin);
    expect(await externalDurableState(f.trip.id)).toEqual(before);
    expect(providerInputs).toHaveLength(0);
    const response = await externalQuery(f);
    expect(response.statusCode, response.body).toBe(200);
    expect(providerInputs).toHaveLength(1);
    expect(providerInputs[0]).toMatchObject({
      origin: {
        placeId: f.result.origin.id,
        name: f.result.origin.name,
        latitude: f.result.origin.latitude,
        longitude: f.result.origin.longitude,
      },
      earliestDeparture: currentNow,
    });
    const payload = response.json();
    expect(payload).toMatchObject({
      externalOriginId: f.result.origin.id,
      ...f.body,
      timeCondition: {
        hardEarliestDeparture: currentNow.toISOString(),
        planningEarliestDeparture: null,
        lookbackSeconds: 0,
      },
    });
    const stored =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: { id: payload.candidates[0].candidateSnapshotId },
      });
    expect(stored).toMatchObject({
      originKind: 'EXTERNAL_EXECUTION_ORIGIN',
      fromNodeId: null,
      fromExternalOriginId: f.result.origin.id,
      externalOriginSnapshot: {
        schema: 'external-route-origin-v1',
        externalOriginId: f.result.origin.id,
        sourceObservationIdentity: f.result.origin.sourceObservationIdentity,
        timeZone: 'Asia/Tokyo',
      },
    });
    const record = await new PrismaRoutePlanningRepository(
      managed.client,
    ).findSnapshotOwned({
      ownerUserId: userA.actor.userId,
      tripId: f.trip.id,
      snapshotId: stored.id,
    });
    expect(record?.origin).toMatchObject({
      type: 'EXTERNAL_EXECUTION_ORIGIN',
      externalOriginId: f.result.origin.id,
    });
    const after = await externalDurableState(f.trip.id);
    expect({
      ...after,
      footprint: {
        ...after.footprint,
        planning: {
          ...after.footprint.planning,
          routeCandidateSnapshots:
            before.footprint.planning.routeCandidateSnapshots,
        },
      },
    }).toEqual(before);
    const preview = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: f.body.basisVersion,
        candidateSnapshotId: stored.id,
      },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    expect(preview.json()).toMatchObject({
      status: 'ACTIVE',
      adoptable: true,
    });
    const previewAfter = await externalDurableState(f.trip.id);
    expect({
      ...previewAfter,
      footprint: {
        ...previewAfter.footprint,
        planning: {
          ...previewAfter.footprint.planning,
          routePreviews: after.footprint.planning.routePreviews,
        },
      },
    }).toEqual(after);
    expect(
      await new PrismaRoutePlanningRepository(managed.client).createPreview({
        ownerUserId: userA.actor.userId,
        tripId: f.trip.id,
        basisVersion: f.body.basisVersion,
        snapshotId: stored.id,
        expectedCandidateHash: stored.candidateHash,
        fromNodeId: f.from.id,
        toNodeId: f.to.id,
        policyVersion: 'route-adoption-preview-v3',
        previewPayload: {} as StoredRoutePreviewPayload,
        previewHash: 'a'.repeat(64),
        now: currentNow,
        createdAt: currentNow,
        expiresAt: new Date(currentNow.getTime() + 60000),
      }),
    ).toEqual({ status: 'PREVIEW_UNSUPPORTED' });
  });
  it.each([
    'destination',
    'REPLACED',
    'UNDONE',
    'missing-edge',
    'wrong-edge',
    'SUPERSEDED',
    'DEPARTED',
    'INVALIDATED',
    'CONFLICT',
    'timezone',
    'stored-timezone',
  ] as const)(
    'P5E2 5B1: %s rejects before Provider with zero snapshots',
    async (kind) => {
      const f = await confirmedExternalQueryFixture();
      if (kind === 'destination') f.body.toNodeId = f.from.id;
      if (kind === 'REPLACED' || kind === 'UNDONE')
        await managed.client.adoptedRoute.update({
          where: { id: f.result.origin.sourceAdoptedRouteId },
          data: { status: kind },
        });
      if (kind === 'missing-edge')
        await managed.client.transportEdge.delete({
          where: { id: f.leg.transportEdgeId },
        });
      if (kind === 'wrong-edge')
        await managed.client.transportEdge.update({
          where: { id: f.leg.transportEdgeId },
          data: { source: 'MANUAL', adoptedRouteId: null },
        });
      if (kind === 'DEPARTED')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.result.origin.id },
          data: { status: 'DEPARTED', departedAt: currentNow },
        });
      if (kind === 'INVALIDATED')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.result.origin.id },
          data: { status: 'INVALIDATED', invalidatedAt: currentNow },
        });
      if (kind === 'SUPERSEDED')
        await managed.client.executionEvent.create({
          data: {
            ownerUserId: userA.actor.userId,
            tripId: f.trip.id,
            nodeId: f.from.id,
            type: 'ARRIVAL',
            source: 'MANUAL',
            occurredAt: new Date(currentNow.getTime() + 60000),
          },
        });
      if (kind === 'CONFLICT')
        await managed.client.temporalValue.createMany({
          data: [f.from.id, f.to.id].map((nodeId) => ({
            nodeId,
            layer: 'ACTUAL' as const,
            pointKind: 'ARRIVAL' as const,
            instant: currentNow,
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE' as const,
          })),
        });
      if (kind === 'stored-timezone')
        await managed.client.externalExecutionOrigin.update({
          where: { id: f.result.origin.id },
          data: { timeZone: 'invalid/Zone' },
        });
      if (kind === 'timezone')
        f.body = {
          ...f.body,
          hint: {
            type: 'DEPART_AT',
            instant: currentNow.toISOString(),
            timeZone: 'UTC',
          },
        } as typeof f.body;
      const before = await externalDurableState(f.trip.id);
      const response = await externalQuery(f);
      expect(response.statusCode, response.body).toBe(
        kind === 'timezone' ? 400 : 422,
      );
      expect(providerInputs).toHaveLength(0);
      expect(await externalDurableState(f.trip.id)).toEqual(before);
    },
  );
  it.each(['departure', 'supersession', 'route', 'edge', 'metadata'] as const)(
    'P5E2 5B1: %s during Provider is fenced by locked snapshot revalidation',
    async (kind) => {
      const f = await confirmedExternalQueryFixture();
      const snapshots = await managed.client.routeCandidateSnapshot.count();
      providerHook = async () => {
        if (kind === 'departure') {
          const response = await app.inject({
            method: 'POST',
            url: `/trips/${f.trip.id}/execution/external-origins/${f.result.origin.id}/depart`,
            headers: bearer(userA),
            payload: {
              baseTripVersion: f.body.basisVersion,
              idempotencyKey: randomUUID(),
            },
          });
          expect(response.statusCode, response.body).toBe(200);
        }
        // Deliberately retain Trip.version to exercise the independent locked
        // proof checks, not just the normal version conflict path.
        if (kind === 'supersession')
          await managed.client.executionEvent.create({
            data: {
              ownerUserId: userA.actor.userId,
              tripId: f.trip.id,
              nodeId: f.from.id,
              type: 'ARRIVAL',
              source: 'MANUAL',
              occurredAt: new Date(currentNow.getTime() + 60000),
            },
          });
        if (kind === 'route')
          await managed.client.adoptedRoute.update({
            where: { id: f.result.origin.sourceAdoptedRouteId },
            data: { status: 'REPLACED' },
          });
        if (kind === 'edge')
          await managed.client.transportEdge.update({
            where: { id: f.leg.transportEdgeId },
            data: { source: 'MANUAL', adoptedRouteId: null },
          });
        if (kind === 'metadata')
          await managed.client.externalExecutionOrigin.update({
            where: { id: f.result.origin.id },
            data: { name: 'SYNTHETIC changed metadata' },
          });
      };
      const response = await externalQuery(f);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'VERSION_CONFLICT' },
      });
      expect(providerInputs).toHaveLength(1);
      expect(await managed.client.routeCandidateSnapshot.count()).toBe(
        snapshots,
      );
    },
  );
  it('P5E2 5B1: departing after handoff rejects the old request before Provider', async () => {
    const f = await confirmedExternalQueryFixture();
    const handoff = (
      await app.inject({
        method: 'GET',
        url: `${f.base}/route-reevaluation`,
        headers: bearer(userA),
      })
    ).json();
    await assertExternalHandoffProvenance(handoff, f.result.origin);
    await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/execution/external-origins/${f.result.origin.id}/depart`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: f.body.basisVersion,
        idempotencyKey: randomUUID(),
      },
    });
    const { externalOriginId: _id, ...request } = handoff.externalQuery;
    void _id;
    expect((await externalQuery(f, request)).statusCode).toBe(409);
    expect(providerInputs).toHaveLength(0);
  });
  it('P5E2 5B1: E→F rollover rejects historical E and allows CURRENT F', async () => {
    const { f, e } = await supersededExternalFixture();
    const next = (
      await confirmExternal(f)
    ).json<ExternalOriginMutationResponse>();
    const url = `/trips/${f.trip.id}/execution/external-origins/`;
    const body = { basisVersion: next.resultingTripVersion, toNodeId: f.to.id };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}${e.origin.id}/routes/query`,
          headers: bearer(userA),
          payload: body,
        })
      ).statusCode,
    ).toBe(422);
    const response = await app.inject({
      method: 'POST',
      url: `${url}${next.origin.id}/routes/query`,
      headers: bearer(userA),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
  });
  it('P5E2 5B1: vehicle recovery preserves CURRENT E planning authorization', async () => {
    const f = await confirmedExternalQueryFixture(['SHORT_TURN', 'RECOVERY']);
    await app.inject({
      method: 'POST',
      url: `${f.base}/refresh`,
      headers: bearer(userA),
    });
    f.body.basisVersion = await readVersion(f.trip.id);
    const response = await externalQuery(f);
    expect(response.statusCode, response.body).toBe(200);
    const handoff = (
      await app.inject({
        method: 'GET',
        url: `${f.base}/route-reevaluation`,
        headers: bearer(userA),
      })
    ).json();
    await assertExternalHandoffProvenance(handoff, f.result.origin);
    expect(handoff).toMatchObject({
      readiness: 'READY',
      originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
    });
  });
  it.each(['USER', 'ADMIN'] as const)(
    'P5E2 5B1: another %s cannot query private external origin',
    async (role) => {
      const f = await confirmedExternalQueryFixture();
      const before = await externalDurableState(f.trip.id);
      expect(
        (await externalQuery(f, f.body, role === 'ADMIN' ? admin : userB))
          .statusCode,
      ).toBe(404);
      expect(providerInputs).toHaveLength(0);
      expect(await externalDurableState(f.trip.id)).toEqual(before);
    },
  );
  it.each(['past', 'future', 'arrive-by', 'no-hint'] as const)(
    'P5E2 5B1: %s external time semantics use server floor without dwell',
    async (kind) => {
      const f = await confirmedExternalQueryFixture();
      const currentTrip = (
        await app.inject({
          method: 'GET',
          url: `/trips/${f.trip.id}`,
          headers: bearer(userA),
        })
      ).json<TripView>();
      const constrained = await command(userA, currentTrip, {
        type: 'SET_TIME_INTENT',
        nodeId: f.to.id,
        pointKind: 'ARRIVAL',
        operator: 'NOT_AFTER',
        instant: '2030-10-01T11:00:00Z',
        timeZone: 'UTC',
        locked: true,
      });
      f.body.basisVersion = constrained.version;
      const hint =
        kind === 'no-hint'
          ? undefined
          : {
              type: kind === 'arrive-by' ? 'ARRIVE_BY' : 'DEPART_AT',
              instant:
                kind === 'past'
                  ? '2030-10-01T09:00:00Z'
                  : kind === 'future'
                    ? '2030-10-01T09:55:00Z'
                    : '2030-10-01T11:30:00Z',
              timeZone: 'Asia/Tokyo',
            };
      const response = await externalQuery(f, {
        ...f.body,
        ...(hint === undefined ? {} : { hint }),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(providerInputs[0]!.earliestDeparture).toEqual(
        kind === 'future' ? new Date('2030-10-01T09:55:00Z') : currentNow,
      );
      if (kind === 'arrive-by')
        expect(providerInputs[0]!.latestArrival).toEqual(
          new Date('2030-10-01T11:00:00Z'),
        ); // tighter destination requirement wins
      expect(
        response.json().candidates[0].planningAssessment
          .requiredUserAdjustments,
      ).toEqual([]);
      const resultCandidate = response.json().candidates[0];
      expect(resultCandidate.planningAssessment.effectiveTotalTimeSeconds).toBe(
        (Date.parse(resultCandidate.overall.arrival.instant) -
          providerInputs[0]!.earliestDeparture!.getTime()) /
          1000,
      );
    },
  );
  it('P5E2 5B1: old source vehicle ACTUAL and expired planned service do not constrain external departure', async () => {
    const f = await confirmedExternalQueryFixture();
    await managed.client.temporalValue.createMany({
      data: [
        {
          transportEdgeId: f.leg.transportEdgeId,
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: new Date('2030-10-01T09:40:00Z'),
          timeZone: 'UTC',
          sourceKind: 'PROVIDER_OBSERVATION',
        },
        {
          transportEdgeId: f.leg.transportEdgeId,
          layer: 'ACTUAL',
          pointKind: 'DEPARTURE',
          instant: new Date('2030-10-01T10:30:00Z'),
          timeZone: 'UTC',
          sourceKind: 'PROVIDER_OBSERVATION',
        },
      ],
    });
    const before = await externalDurableState(f.trip.id);
    const response = await externalQuery(f);
    expect(response.statusCode, response.body).toBe(200);
    expect(providerInputs[0]!.earliestDeparture).toEqual(currentNow);
    expect(providerInputs[0]!.latestArrival).toBeNull();
    expect((await externalDurableState(f.trip.id)).origins).toEqual(
      before.origins,
    );
  });
  it('P5E2 5B1: destination dwell and downstream departure hard window constrain external arrival', async () => {
    const f = await confirmedExternalQueryFixture();
    let trip = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: f.to.id,
      durationSeconds: 600,
      locked: true,
    });
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: f.to.id,
      pointKind: 'DEPARTURE',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T11:10:00Z',
      timeZone: 'UTC',
      locked: true,
    });
    f.body.basisVersion = trip.version;
    const response = await externalQuery(f);
    expect(response.statusCode, response.body).toBe(200);
    expect(providerInputs[0]!.latestArrival).toEqual(
      new Date('2030-10-01T11:00:00Z'),
    );
    expect(
      response.json().candidates[0].planningAssessment.requiredUserAdjustments,
    ).toEqual([]);
  });
  it('P5E2 5B1: rejects client origin metadata and invalid Provider candidates without snapshots', async () => {
    const f = await confirmedExternalQueryFixture();
    expect(
      (
        await externalQuery(f, {
          ...f.body,
          latitude: 35,
          fromNodeId: f.from.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(providerInputs).toHaveLength(0);
    const count = await managed.client.routeCandidateSnapshot.count();
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate(
          '2030-10-01T10:00:00Z',
          '2030-10-01T11:00:00Z',
          'invalid/Zone',
          'UTC',
        ),
      ],
    };
    expect((await externalQuery(f)).statusCode).toBe(503);
    expect(await managed.client.routeCandidateSnapshot.count()).toBe(count);
  });
  it('P5E2 5A: candidate is deterministic and read-only; confirmed/departed execution never mutates itinerary or planning', async () => {
    const f = await externalFixture();
    expect(f.view).toMatchObject({
      availability: 'CONFIRMATION_REQUIRED',
      candidate: {
        provider: 'SYNTHETIC',
        providerHubRef: 'synthetic:short-terminus',
        canonicalHubRef: 'synthetic:hub:short-terminus',
        latitude: 35.705,
        longitude: 139.705,
        timeZone: 'Asia/Tokyo',
      },
      currentOrigin: null,
    });
    const before = await externalFootprint(f.trip.id);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/external-origin`,
          headers: bearer(userA),
        })
      ).json(),
    ).toEqual(f.view);
    expect(await externalFootprint(f.trip.id)).toEqual(before);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/route-reevaluation`,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      query: null,
      reasonCodes: expect.arrayContaining([
        'EXTERNAL_EXECUTION_ORIGIN_CONFIRMATION_REQUIRED',
      ]),
    });
    const response = await confirmExternal(f);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<ExternalOriginMutationResponse>();
    expect(result).toMatchObject({
      resultingTripVersion: f.trip.version + 1,
      origin: {
        status: 'ARRIVED',
        currentness: 'CURRENT',
        confirmationSource: 'MANUAL',
        arrivedAt: currentNow.toISOString(),
        sourceAdoptedRouteId: f.leg.adoptedRouteId,
        sourceGroundTransitLegExecutionId: f.leg.id,
      },
    });
    const after = await externalFootprint(f.trip.id);
    expect({
      ...after,
      planning: {
        ...after.planning,
        version: before.planning.version,
        updatedAt: before.planning.updatedAt,
      },
    }).toEqual(before);
    expect(
      await managed.client.externalExecutionOriginReceipt.count({
        where: { tripId: f.trip.id },
      }),
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/route-reevaluation`,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      readiness: 'READY',
      originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
      query: null,
      externalQuery: {
        externalOriginId: result.origin.id,
        basisVersion: result.resultingTripVersion,
        toNodeId: f.to.id,
      },
    });
    await assertExternalHandoffProvenance(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/route-reevaluation`,
          headers: bearer(userA),
        })
      ).json(),
      result.origin,
    );
    currentNow = new Date(currentNow.getTime() + 60_000);
    const key = randomUUID();
    const request = {
      baseTripVersion: result.resultingTripVersion,
      idempotencyKey: key,
    };
    const departed = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/execution/external-origins/${result.origin.id}/depart`,
      headers: bearer(userA),
      payload: request,
    });
    expect(departed.statusCode, departed.body).toBe(200);
    expect(departed.json()).toMatchObject({
      resultingTripVersion: f.trip.version + 2,
      origin: {
        status: 'DEPARTED',
        currentness: 'DEPARTED',
        departedAt: currentNow.toISOString(),
      },
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/execution/external-origins/${result.origin.id}/depart`,
      headers: bearer(userA),
      payload: request,
    });
    expect(replay.json()).toEqual(departed.json());
    const end = await externalFootprint(f.trip.id);
    expect({
      ...end,
      planning: {
        ...end.planning,
        version: before.planning.version,
        updatedAt: before.planning.updatedAt,
      },
    }).toEqual(before);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/external-origin`,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      currentOrigin: { status: 'DEPARTED', currentness: 'DEPARTED' },
    });
  });
  it('P5E2 5A: confirm idempotency replays a stable receipt and rejects changed payload', async () => {
    const f = await externalFixture();
    const key = randomUUID();
    const first = await confirmExternal(f, key);
    expect(first.statusCode).toBe(200);
    expect((await confirmExternal(f, key)).json()).toEqual(first.json());
    const conflict = await confirmExternal(f, key, f.trip.version + 1);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(await managed.client.externalExecutionOrigin.count()).toBe(1);
  });
  it('P5E2 5A: durable external origin cannot be used as an itinerary RouteQuery endpoint', async () => {
    const f = await externalFixture();
    const confirmed = await confirmExternal(f);
    expect(confirmed.statusCode).toBe(200);
    const result = confirmed.json<ExternalOriginMutationResponse>();
    const before = await externalFootprint(f.trip.id);
    const query = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/routes/query`,
      headers: bearer(userA),
      payload: {
        basisVersion: result.resultingTripVersion,
        fromNodeId: result.origin.id,
        toNodeId: f.trip.days[0]!.nodes.at(-1)!.id,
        hint: {
          type: 'DEPART_AT',
          instant: currentNow.toISOString(),
          timeZone: result.origin.timeZone,
        },
      },
    });
    expect(query.statusCode, query.body).toBe(404);
    expect(query.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await externalFootprint(f.trip.id)).toEqual(before);
  });
  it.each(['different-keys', 'same-key'] as const)(
    'P5E2 5A: concurrent confirmations maintain one ARRIVED origin (%s)',
    async (mode) => {
      const f = await externalFixture();
      const key = randomUUID();
      const responses = await Promise.all([
        confirmExternal(f, key),
        confirmExternal(f, mode === 'same-key' ? key : randomUUID()),
      ]);
      expect(responses.map((r) => r.statusCode).sort()).toEqual(
        mode === 'same-key' ? [200, 200] : [200, 409],
      );
      if (mode === 'same-key')
        expect(responses[0]!.json()).toEqual(responses[1]!.json());
      expect(
        await managed.client.externalExecutionOrigin.count({
          where: { tripId: f.trip.id, status: 'ARRIVED' },
        }),
      ).toBe(1);
      expect(await managed.client.externalExecutionOriginReceipt.count()).toBe(
        1,
      );
      const view = (
        await app.inject({
          method: 'GET',
          url: `${f.base}/external-origin`,
          headers: bearer(userA),
        })
      ).json<ExternalOriginResponse>();
      f.view = view;
      f.trip = { ...f.trip, version: f.trip.version + 1 };
      expect((await confirmExternal(f)).json()).toMatchObject({
        error: { code: 'EXTERNAL_ORIGIN_CONFLICT' },
      });
    },
  );
  it.each(['recovery', 'resolver-change', 'version'] as const)(
    'P5E2 5A: stale confirmation %s writes nothing',
    async (kind) => {
      const f = await externalFixture(['SHORT_TURN', 'RECOVERY']);
      if (kind === 'recovery') {
        currentNow = new Date(currentNow.getTime() + 60_000);
        await app.inject({
          method: 'POST',
          url: `${f.base}/refresh`,
          headers: bearer(userA),
        });
      }
      if (kind === 'resolver-change')
        hubResolver.resolveHub = async (input) => {
          const result =
            await new SyntheticGroundTransitHubResolver().resolveHub(input);
          return result.status === 'RESOLVED'
            ? {
                ...result,
                hub: { ...result.hub, canonicalHubRef: 'synthetic:changed' },
              }
            : result;
        };
      if (kind === 'version')
        await managed.client.trip.update({
          where: { id: f.trip.id },
          data: { version: { increment: 1 } },
        });
      const before = await externalFootprint(f.trip.id);
      const response = await confirmExternal(f);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code:
            kind === 'version'
              ? 'VERSION_CONFLICT'
              : 'EXTERNAL_ORIGIN_CANDIDATE_STALE',
        },
      });
      expect(await externalFootprint(f.trip.id)).toEqual(before);
      expect(await managed.client.externalExecutionOrigin.count()).toBe(0);
      expect(await managed.client.externalExecutionOriginReceipt.count()).toBe(
        0,
      );
    },
  );
  it.each([
    'UNAVAILABLE',
    'AMBIGUOUS',
    'NOT_FOUND',
    'invalid-zone',
    'invalid-coordinate',
    'blank-name',
    'wrong-provider-ref',
  ] as const)(
    'P5E2 5A: unsafe resolver %s cannot create an origin',
    async (kind) => {
      hubResolver = {
        resolveHub: async (input) => {
          if (['UNAVAILABLE', 'AMBIGUOUS', 'NOT_FOUND'].includes(kind))
            return {
              status: kind as 'UNAVAILABLE' | 'AMBIGUOUS' | 'NOT_FOUND',
            };
          const resolved =
            await new SyntheticGroundTransitHubResolver().resolveHub(input);
          if (resolved.status !== 'RESOLVED') return resolved;
          return {
            ...resolved,
            hub: {
              ...resolved.hub,
              ...(kind === 'invalid-zone'
                ? { timeZone: 'Invalid/Zone' }
                : kind === 'invalid-coordinate'
                  ? { latitude: 91 }
                  : kind === 'blank-name'
                    ? { name: '' }
                    : { providerHubRef: 'different' }),
            },
          };
        },
      };
      const f = await externalFixture();
      expect(f.view).toMatchObject({
        availability: 'UNRESOLVED',
        candidate: null,
      });
      expect(await managed.client.externalExecutionOrigin.count()).toBe(0);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${f.base}/route-reevaluation`,
            headers: bearer(userA),
          })
        ).json(),
      ).toMatchObject({ readiness: 'ORIGIN_UNRESOLVED', query: null });
    },
  );
  it('P5E2 5A: provider vehicle ACTUAL and reliable GPS do not create user external execution', async () => {
    const f = await externalFixture();
    await managed.client.temporalValue.createMany({
      data: ['ARRIVAL', 'DEPARTURE'].map((pointKind) => ({
        transportEdgeId: f.leg.transportEdgeId,
        layer: 'ACTUAL',
        pointKind: pointKind as 'ARRIVAL' | 'DEPARTURE',
        instant: currentNow,
        timeZone: 'UTC',
        sourceKind: 'PROVIDER_OBSERVATION',
      })),
    });
    await managed.client.executionLocationState.create({
      data: {
        tripId: f.trip.id,
        currentNodeId: f.from.id,
        lastObservedAt: currentNow,
        outsideTargetConsecutiveCount: 0,
        locationStatus: 'RELIABLE',
      },
    });
    const view = (
      await app.inject({
        method: 'GET',
        url: `${f.base}/external-origin`,
        headers: bearer(userA),
      })
    ).json();
    expect(view).toMatchObject({ currentOrigin: null });
    expect(await managed.client.externalExecutionOrigin.count()).toBe(0);
  });
  it('P5E2 5A: later valid itinerary ExecutionEvent supersedes E without rewriting its history', async () => {
    const f = await externalFixture(['SHORT_TURN', 'SHORT_TURN_F']);
    const confirmed = (
      await confirmExternal(f)
    ).json<ExternalOriginMutationResponse>();
    currentNow = new Date(currentNow.getTime() + 60_000);
    const trip = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    await manualExecution(
      trip,
      f.from.id,
      'MANUAL_ARRIVAL',
      currentNow.toISOString(),
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/external-origin`,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      currentOrigin: {
        id: confirmed.origin.id,
        status: 'ARRIVED',
        currentness: 'SUPERSEDED',
      },
    });
    expect(
      (
        await managed.client.externalExecutionOrigin.findUniqueOrThrow({
          where: { id: confirmed.origin.id },
        })
      ).status,
    ).toBe('ARRIVED');
    const beforeOrigin =
      await managed.client.externalExecutionOrigin.findUniqueOrThrow({
        where: { id: confirmed.origin.id },
      });
    const beforeReceipt =
      await managed.client.externalExecutionOriginReceipt.findMany({
        where: { tripId: f.trip.id },
      });
    await nextExternalCandidate(f);
    expect(f.view).toMatchObject({
      availability: 'CONFIRMATION_REQUIRED',
      currentOrigin: {
        id: confirmed.origin.id,
        status: 'ARRIVED',
        currentness: 'SUPERSEDED',
      },
    });
    const beforePlanning = await externalFootprint(f.trip.id);
    const key = randomUUID();
    const next = await confirmExternal(f, key);
    expect(next.statusCode, next.body).toBe(200);
    const result = next.json<ExternalOriginMutationResponse>();
    expect(result).toMatchObject({
      resultingTripVersion: f.trip.version + 1,
      origin: {
        providerHubRef: 'synthetic:second-terminus',
        status: 'ARRIVED',
        currentness: 'CURRENT',
      },
    });
    const old = await managed.client.externalExecutionOrigin.findUniqueOrThrow({
      where: { id: confirmed.origin.id },
    });
    expect({
      ...old,
      status: beforeOrigin.status,
      invalidatedAt: beforeOrigin.invalidatedAt,
      updatedAt: beforeOrigin.updatedAt,
    }).toEqual(beforeOrigin);
    expect(old).toMatchObject({
      status: 'INVALIDATED',
      invalidatedAt: currentNow,
      departedAt: null,
    });
    const context = await new PrismaExternalExecutionOriginRepository(
      managed.client,
    ).read({
      ownerUserId: userA.actor.userId,
      tripId: f.trip.id,
      transportEdgeId: f.leg.transportEdgeId,
    });
    expect(externalOriginView(old, context!)).toMatchObject({
      status: 'INVALIDATED',
      currentness: 'SUPERSEDED',
      arrivedAt: confirmed.origin.arrivedAt,
      departedAt: null,
    });
    expect(
      await managed.client.externalExecutionOriginReceipt.findMany({
        where: { id: { in: beforeReceipt.map((row) => row.id) } },
      }),
    ).toEqual(beforeReceipt);
    const arrival =
      await managed.client.externalExecutionOriginReceipt.findUniqueOrThrow({
        where: {
          ownerUserId_idempotencyKey: {
            ownerUserId: userA.actor.userId,
            idempotencyKey: key,
          },
        },
      });
    const invalidation =
      await managed.client.externalExecutionOriginReceipt.findFirstOrThrow({
        where: { tripId: f.trip.id, transition: 'INVALIDATION' },
      });
    expect(invalidation).toMatchObject({
      externalOriginId: confirmed.origin.id,
      triggeringReceiptId: arrival.id,
      idempotencyKey: null,
      invalidationReason: 'SUPERSEDED_BY_LATER_EXECUTION',
      occurredAt: currentNow,
      resultingTripVersion: f.trip.version + 1,
      requestHash: arrival.requestHash,
      response: {
        newExternalOriginId: result.origin.id,
        triggeringReceiptId: arrival.id,
        reason: 'SUPERSEDED_BY_LATER_EXECUTION',
        origin: {
          id: confirmed.origin.id,
          status: 'INVALIDATED',
          currentness: 'SUPERSEDED',
        },
      },
    });
    const afterPlanning = await externalFootprint(f.trip.id);
    expect({
      ...afterPlanning,
      planning: {
        ...afterPlanning.planning,
        version: beforePlanning.planning.version,
        updatedAt: beforePlanning.planning.updatedAt,
      },
    }).toEqual(beforePlanning);
    const state = await externalDurableState(f.trip.id);
    currentNow = new Date(currentNow.getTime() + 60_000);
    const replay = await confirmExternal(f, key);
    expect(replay.json()).toEqual(result);
    expect(await externalDurableState(f.trip.id)).toEqual(state);
  });
  it('P5E2 5A repair: CURRENT E blocks a valid F candidate without writes', async () => {
    const f = await externalFixture(['SHORT_TURN', 'SHORT_TURN_F']);
    expect((await confirmExternal(f)).statusCode).toBe(200);
    await nextExternalCandidate(f);
    expect(f.view.currentOrigin?.currentness).toBe('CURRENT');
    const before = await externalDurableState(f.trip.id);
    const denied = await confirmExternal(f);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({
      error: { code: 'EXTERNAL_ORIGIN_CONFLICT' },
    });
    expect(await externalDurableState(f.trip.id)).toEqual(before);
  });
  it('P5E2 5A repair: CONFLICT E is not automatically invalidated', async () => {
    const { f } = await supersededExternalFixture();
    currentNow = new Date(currentNow.getTime() + 60_000);
    await manualExecution(
      f.trip,
      f.trip.days[0]!.nodes.at(-1)!.id,
      'MANUAL_ARRIVAL',
      currentNow.toISOString(),
    );
    // Re-read the same F evidence after the durable frontier becomes inconsistent.
    f.trip = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    f.view = (
      await app.inject({
        method: 'GET',
        url: `${f.base}/external-origin`,
        headers: bearer(userA),
      })
    ).json<ExternalOriginResponse>();
    expect(f.view.currentOrigin?.currentness).toBe('CONFLICT');
    const before = await externalDurableState(f.trip.id);
    const denied = await confirmExternal(f);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({
      error: { code: 'EXTERNAL_ORIGIN_CONFLICT' },
    });
    expect(await externalDurableState(f.trip.id)).toEqual(before);
  });
  it('P5E2 5A repair: locked confirmation rechecks supersession after candidate GET', async () => {
    const { f } = await supersededExternalFixture();
    const event = await managed.client.executionEvent.findFirstOrThrow({
      where: { tripId: f.trip.id, nodeId: f.from.id, undoneAt: null },
    });
    // Deliberately preserve Trip.version to isolate locked proof validation from
    // normal Execution Undo version fencing. Remove the linked ACTUAL as well.
    await managed.client.$transaction(async (tx) => {
      await tx.executionEvent.update({
        where: { id: event.id },
        data: { undoneAt: currentNow },
      });
      await tx.temporalValue.deleteMany({
        where: {
          nodeId: f.from.id,
          layer: 'ACTUAL',
          sourceRef: `execution-event:${event.id}`,
        },
      });
    });
    const before = await externalDurableState(f.trip.id);
    const denied = await confirmExternal(f);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({
      error: { code: 'EXTERNAL_ORIGIN_CONFLICT' },
    });
    expect(await externalDurableState(f.trip.id)).toEqual(before);
  });
  it.each(['same-key', 'different-key'] as const)(
    'P5E2 5A repair: superseded E and concurrent F confirmations (%s)',
    async (kind) => {
      const { f, e } = await supersededExternalFixture();
      const key = randomUUID();
      const results = await Promise.all([
        confirmExternal(f, key),
        confirmExternal(f, kind === 'same-key' ? key : randomUUID()),
      ]);
      const successes = results.filter((row) => row.statusCode === 200);
      expect(successes).toHaveLength(kind === 'same-key' ? 2 : 1);
      if (kind === 'same-key')
        expect(successes[0]!.json()).toEqual(successes[1]!.json());
      else
        expect(
          results.find((row) => row.statusCode !== 200)!.json(),
        ).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
      expect(
        await managed.client.externalExecutionOrigin.count({
          where: { tripId: f.trip.id, status: 'ARRIVED' },
        }),
      ).toBe(1);
      expect(
        await managed.client.externalExecutionOrigin.count({
          where: { tripId: f.trip.id },
        }),
      ).toBe(2);
      expect(
        await managed.client.externalExecutionOrigin.findUniqueOrThrow({
          where: { id: e.origin.id },
        }),
      ).toMatchObject({
        status: 'INVALIDATED',
        departedAt: null,
        invalidatedAt: currentNow,
      });
      expect(
        await managed.client.externalExecutionOriginReceipt.count({
          where: { tripId: f.trip.id, transition: 'INVALIDATION' },
        }),
      ).toBe(1);
      expect(
        await managed.client.externalExecutionOriginReceipt.count({
          where: { tripId: f.trip.id },
        }),
      ).toBe(3);
      expect(
        (
          await managed.client.trip.findUniqueOrThrow({
            where: { id: f.trip.id },
          })
        ).version,
      ).toBe(f.trip.version + 1);
    },
  );
  it('P5E2 5A repair: explicit E departure/replay still allows later F confirmation', async () => {
    const f = await externalFixture(['SHORT_TURN', 'SHORT_TURN_F']);
    const e = (await confirmExternal(f)).json<ExternalOriginMutationResponse>();
    currentNow = new Date(currentNow.getTime() + 60_000);
    const request = {
      method: 'POST' as const,
      url: `/trips/${f.trip.id}/execution/external-origins/${e.origin.id}/depart`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: e.resultingTripVersion,
        idempotencyKey: randomUUID(),
      },
    };
    const departure = await app.inject(request);
    expect(departure.statusCode, departure.body).toBe(200);
    expect((await app.inject(request)).json()).toEqual(departure.json());
    const old = await managed.client.externalExecutionOrigin.findUniqueOrThrow({
      where: { id: e.origin.id },
    });
    await nextExternalCandidate(f);
    const next = await confirmExternal(f);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json()).toMatchObject({
      resultingTripVersion: f.trip.version + 1,
      origin: { status: 'ARRIVED', currentness: 'CURRENT' },
    });
    expect(
      await managed.client.externalExecutionOrigin.findUniqueOrThrow({
        where: { id: e.origin.id },
      }),
    ).toEqual(old);
    expect(
      await managed.client.externalExecutionOriginReceipt.count({
        where: { tripId: f.trip.id, transition: 'INVALIDATION' },
      }),
    ).toBe(0);
  });
  it('P5E2 5A: provider recovery preserves confirmed user ARRIVAL and CURRENT external Query', async () => {
    const f = await externalFixture(['SHORT_TURN', 'RECOVERY']);
    const result = (
      await confirmExternal(f)
    ).json<ExternalOriginMutationResponse>();
    currentNow = new Date(currentNow.getTime() + 60_000);
    await app.inject({
      method: 'POST',
      url: `${f.base}/refresh`,
      headers: bearer(userA),
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/external-origin`,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      availability: 'CONFIRMED',
      candidate: null,
      currentOrigin: {
        id: result.origin.id,
        currentness: 'CURRENT',
        status: 'ARRIVED',
      },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/route-reevaluation`,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      readiness: 'READY',
      originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
      query: null,
      externalQuery: { externalOriginId: result.origin.id },
    });
    await assertExternalHandoffProvenance(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/route-reevaluation`,
          headers: bearer(userA),
        })
      ).json(),
      result.origin,
    );
  });
  it('P5E2 5A: owner isolation covers candidate, confirm and departure including administrators', async () => {
    const f = await externalFixture();
    const origin = (
      await confirmExternal(f)
    ).json<ExternalOriginMutationResponse>();
    for (const identity of [userB, admin]) {
      for (const [method, url, payload] of [
        ['GET', `${f.base}/external-origin`, undefined],
        [
          'POST',
          `${f.base}/external-origin/confirm`,
          {
            baseTripVersion: origin.resultingTripVersion,
            candidateRef: f.view.candidate!.candidateRef,
            idempotencyKey: randomUUID(),
          },
        ],
        [
          'POST',
          `/trips/${f.trip.id}/execution/external-origins/${origin.origin.id}/depart`,
          {
            baseTripVersion: origin.resultingTripVersion,
            idempotencyKey: randomUUID(),
          },
        ],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers: bearer(identity),
          ...(payload === undefined ? {} : { payload }),
        });
        expect(response.statusCode).toBe(404);
      }
    }
    expect(await managed.client.externalExecutionOrigin.count()).toBe(1);
  });
  it('P5E2 5A: client metadata cannot be submitted as external confirmation', async () => {
    const f = await externalFixture();
    const response = await app.inject({
      method: 'POST',
      url: `${f.base}/external-origin/confirm`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: f.trip.version,
        candidateRef: f.view.candidate!.candidateRef,
        idempotencyKey: randomUUID(),
        latitude: 0,
        arrivedAt: currentNow.toISOString(),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await managed.client.externalExecutionOrigin.count()).toBe(0);
  });
  it('P5E2 5A: external ARRIVAL fences an old confirmed itinerary suffix origin', async () => {
    const f = await suffixFixture(false);
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['SHORT_TURN']),
    );
    const edge = f.suffixEdges[0]!;
    const base = `/trips/${f.first.trip.id}/execution/ground-transit/${edge.id}`;
    await app.inject({
      method: 'POST',
      url: `${base}/refresh`,
      headers: bearer(userA),
    });
    currentNow = new Date(currentNow.getTime() + 60_000);
    const view = (
      await app.inject({
        method: 'GET',
        url: `${base}/external-origin`,
        headers: bearer(userA),
      })
    ).json<ExternalOriginResponse>();
    const response = await app.inject({
      method: 'POST',
      url: `${base}/external-origin/confirm`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: f.first.trip.version,
        candidateRef: view.candidate!.candidateRef,
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    f.first.trip = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.first.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    const count = await managed.client.routeCandidateSnapshot.count();
    expect(
      (
        await query(userA, f.first.trip, f.B.id, f.D.id, {
          type: 'DEPART_AT',
          instant: '2030-10-01T10:30:00Z',
          timeZone: 'UTC',
        })
      ).json(),
    ).toMatchObject({ error: { code: 'ROUTE_QUERY_UNSUPPORTED' } });
    expect(await managed.client.routeCandidateSnapshot.count()).toBe(count);
  });

  it('persists a candidate snapshot without mutating official Trip facts', async () => {
    const trip = await tripWithVisits(userA, ['Tokyo', 'Los Angeles']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const before = await databaseFacts(trip.id);

    const response = await query(userA, trip, from!.id, to!.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T19:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as RouteQueryResponse;
    expect(body).toMatchObject({
      tripId: trip.id,
      basisVersion: trip.version,
      candidates: [
        {
          provider: 'SYNTHETIC',
          queryBasisVersion: trip.version,
          overall: { durationSeconds: 3600 },
          candidateSnapshotId: expect.any(String),
          snapshotExpiresAt: '2030-09-01T00:15:00.000Z',
        },
      ],
    });
    expect(providerInputs[0]).toMatchObject({
      origin: { name: 'Tokyo' },
      destination: { name: 'Los Angeles' },
      earliestDeparture: new Date('2030-10-01T10:00:00Z'),
    });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(await databaseFacts(trip.id)).toEqual(before);
  });

  it('does not notify for a missing onward transfer when no protected connection exists', async () => {
    currentNow = new Date('2030-10-01T09:50:00Z');
    const trip = await tripWithVisits(userA, ['Bus origin', 'Bus destination']);
    const [from, to] = trip.days[0]!.nodes;
    const base = candidate(
      '2030-10-01T10:00:00Z',
      '2030-10-01T10:30:00Z',
      'UTC',
      'UTC',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...base,
          observedAt: currentNow,
          legs: [
            {
              ...base.legs[0]!,
              mode: 'BUS',
              fixedService: false,
              groundTransit: {
                serviceClass: 'HIGH_FREQUENCY',
                serviceIdentityKey: null,
                lineRef: 'bus-1',
                lineName: 'Bus 1',
                directionRef: 'east',
                directionLabel: 'East',
                boardingHubRef: 'origin',
                alightingHubRef: 'destination',
                headwayMinSeconds: 180,
                headwayMaxSeconds: 300,
                minimumTransferSeconds: null,
                boardingAccessMinimumSeconds: 0,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `no-onward-${randomUUID()}`,
    );
    const ground = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(ground.statusCode).toBe(200);
    const noOnwardSafety =
      ground.json<GroundTransitExecutionResponse>().legs[0]!.safety;
    expect(noOnwardSafety.boarding).toMatchObject({
      headwayWaitReserveSeconds: 300,
      totalSystemMinimumSeconds: 300,
    });
    expect(noOnwardSafety.transferToNext).toBeNull();
    expect(noOnwardSafety).not.toHaveProperty('totalSystemMinimumSeconds');
    expect(noOnwardSafety).not.toHaveProperty('transferMinimumSeconds');
    const recorded = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: adopted.trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: currentNow.toISOString(),
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(recorded.statusCode).toBe(200);
    const evaluated = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/evaluate`,
      headers: bearer(userA),
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json<{ risks: unknown[] }>().risks).toEqual([]);
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
  });

  it('reopens a baseline headway risk after fresh realtime expires and Provider becomes unavailable', async () => {
    currentNow = new Date('2030-10-01T09:56:00Z');
    await app.close();
    const routeProvider = createDevelopmentSyntheticGroundTransitRouteProvider(
      () => currentNow,
    );
    app = buildTestApi(
      routeProvider,
      new SyntheticGroundTransitProvider('NEXT_DEPARTURE_2', () => currentNow),
    );
    const trip = await tripWithVisits(userA, [
      'Ground origin',
      'Ground destination',
    ]);
    const [from, to] = trip.days[0]!.nodes;
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `ground-fallback-${randomUUID()}`,
    );
    const legs = await managed.client.groundTransitLegExecution.findMany({
      where: { tripId: trip.id },
      orderBy: { legIndex: 'asc' },
    });
    const high = legs.find((leg) => leg.serviceClass === 'HIGH_FREQUENCY')!;
    const initialGround = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(initialGround.statusCode).toBe(200);
    const initialSafety = initialGround
      .json<GroundTransitExecutionResponse>()
      .legs.find((leg) => leg.id === high.id)!.safety;
    expect(initialSafety.boarding).toMatchObject({
      headwayWaitReserveSeconds: 300,
      totalSystemMinimumSeconds: 300,
    });
    expect(initialSafety.transferToNext).toMatchObject({
      transferMinimumSeconds: 300,
      transferBasis: 'ADOPTED',
      totalSystemMinimumSeconds: 300,
    });
    expect(initialSafety).not.toHaveProperty('totalSystemMinimumSeconds');
    const recorded = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: adopted.trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: currentNow.toISOString(),
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(recorded.statusCode).toBe(200);
    const evaluate = () =>
      app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/execution/evaluate`,
        headers: bearer(userA),
      });
    expect(
      (await evaluate()).json<{ risks: { kind: string }[] }>().risks,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'BUFFER_BELOW_SYSTEM_MINIMUM' }),
      ]),
    );
    const refreshed = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${high.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      leg: {
        safety: {
          boarding: {
            headwayWaitReserveSeconds: 120,
            totalSystemMinimumSeconds: 120,
          },
          transferToNext: { totalSystemMinimumSeconds: 300 },
        },
      },
    });
    expect(
      (await evaluate())
        .json<{ risks: { sourceTransportEdgeId: string }[] }>()
        .risks.filter(
          (risk) => risk.sourceTransportEdgeId === high.transportEdgeId,
        ),
    ).toEqual([]);
    const observationCount =
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: high.id },
      });
    await app.close();
    app = buildTestApi(routeProvider, new UnconfiguredGroundTransitProvider());
    currentNow = new Date('2030-10-01T09:59:00Z');
    const unavailable = () =>
      app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/execution/ground-transit/${high.transportEdgeId}/refresh`,
        headers: bearer(userA),
      });
    expect((await unavailable()).statusCode).toBe(503);
    expect(
      (await evaluate())
        .json<{ risks: { sourceTransportEdgeId: string }[] }>()
        .risks.filter(
          (risk) => risk.sourceTransportEdgeId === high.transportEdgeId,
        ),
    ).toEqual([]);
    currentNow = new Date('2030-10-01T10:05:00Z');
    await managed.client.tripAssistanceCapability.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: currentNow,
      },
    });
    const repository = new PrismaGroundTransitRepository(managed.client);
    const riskService = new ExecutionRiskService(
      tripRepository,
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => currentNow, groundTransitRepository: repository },
    );
    const monitor = new GroundTransitService(
      repository,
      new UnconfiguredGroundTransitProvider(),
      () => currentNow,
      riskService,
    );
    await expect(
      monitor.executeJob(high.adoptedRouteId, 1),
    ).rejects.toMatchObject({
      code: 'GROUND_TRANSIT_PROVIDER_UNAVAILABLE',
    });
    const reopened = await managed.client.executionRisk.findMany({
      where: {
        tripId: trip.id,
        sourceTransportEdgeId: high.transportEdgeId,
        status: 'OPEN',
      },
    });
    expect(reopened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'BUFFER_BELOW_SYSTEM_MINIMUM' }),
      ]),
    );
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: high.id },
      }),
    ).toBe(observationCount);
    expect(
      (
        await managed.client.groundTransitLegExecution.findUniqueOrThrow({
          where: { id: high.id },
        })
      ).nextCheckAt,
    ).toEqual(new Date('2030-10-01T10:01:00Z'));
    await managed.client.groundTransitLegExecution.update({
      where: { id: high.id },
      data: {
        baseline: {
          ...(high.baseline as Record<string, unknown>),
          minimumTransferSeconds: null,
        } as never,
      },
    });
    const missingTransfer = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(missingTransfer.statusCode).toBe(200);
    const missingSafety = missingTransfer
      .json<GroundTransitExecutionResponse>()
      .legs.find((leg) => leg.id === high.id)!.safety;
    expect(missingSafety.boarding.totalSystemMinimumSeconds).toBe(300);
    expect(missingSafety.transferToNext).toMatchObject({
      transferMinimumSeconds: null,
      transferBasis: 'UNKNOWN',
      totalSystemMinimumSeconds: null,
      feasibility: 'UNKNOWN',
      reasonCodes: expect.arrayContaining(['TRANSFER_MINIMUM_UNKNOWN']),
    });
    expect(missingSafety).not.toHaveProperty('reasonCodes');
    currentNow = new Date('2030-10-01T10:06:00Z');
    const staleFailure = await unavailable();
    expect(staleFailure.statusCode).toBe(503);
    expect(staleFailure.json()).toMatchObject({
      error: { code: 'GROUND_TRANSIT_PROVIDER_UNAVAILABLE' },
    });
    const unknown = await managed.client.executionRisk.findFirst({
      where: {
        tripId: trip.id,
        sourceTransportEdgeId: high.transportEdgeId,
        kind: 'UNKNOWN_EXECUTION_MARGIN',
        status: 'OPEN',
      },
    });
    expect(unknown).toMatchObject({ severity: 'UNKNOWN' });
    await managed.client.groundTransitLegExecution.update({
      where: { id: high.id },
      data: {
        baseline: {
          ...(high.baseline as Record<string, unknown>),
          minimumTransferSeconds: 480,
        } as never,
      },
    });
    const knownTransfer = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(knownTransfer.statusCode).toBe(200);
    expect(
      knownTransfer
        .json<GroundTransitExecutionResponse>()
        .legs.find((leg) => leg.id === high.id)!.safety.transferToNext,
    ).toMatchObject({
      transferMinimumSeconds: 480,
      totalSystemMinimumSeconds: 480,
      transferBasis: 'ADOPTED',
    });
    const riskCountBeforePause = await managed.client.executionRisk.count({
      where: { tripId: trip.id },
    });
    const notificationCountBeforePause =
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      });
    await managed.client.tripAssistanceCapability.update({
      where: {
        tripId_kind: { tripId: trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      },
      data: { state: 'PAUSED', revision: 2, pausedAt: currentNow },
    });
    await expect(
      riskService.evaluateTripRisks(userA.actor, trip.id, {
        groupKey: 'stale-ground-monitor',
        sourceTransportEdgeId: high.transportEdgeId,
        expectedGroundTransitCapabilityRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
    expect(
      await managed.client.executionRisk.count({ where: { tripId: trip.id } }),
    ).toBe(riskCountBeforePause);
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(notificationCountBeforePause);
  });

  it('accepts cancellation once, aggregates one strong presentation, and restores the same adopted route', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip({
      now: '2030-10-01T09:49:59Z',
      departure: '2030-10-01T10:00:00Z',
      arrival: '2030-10-01T11:00:00Z',
    });
    // Independent actions need distinct fixture times; equal occurredAt values
    // have no chronological ordering guarantee in PostgreSQL.
    currentNow = new Date('2030-10-01T09:50:00Z');
    const groundProvider = groundSequence([
      'CANCELLED',
      'RECOVERY',
    ]) as GroundTransitProvider & { setReplay(value: boolean): void };
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundProvider,
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    const first = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        state: 'NO_LONGER_FEASIBLE',
        operational: {
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
          requiredAction: 'ROUTE_REEVALUATION_REQUIRED',
          changeKinds: ['SERVICE_CANCELLED'],
        },
      },
    });
    const active = await managed.client.notificationEvent.findMany({
      where: {
        tripId: trip.id,
        presentationGroupKey: {
          startsWith: `ground-transit-observation:${leg.id}:`,
        },
        presentationActive: true,
      },
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ priority: 'STRONG' });
    expect(active[0]!.changeKinds).toContain('SERVICE_CANCELLED');
    expect(
      await managed.client.transportEdge.count({
        where: { id: leg.transportEdgeId, adoptedRoute: { status: 'ACTIVE' } },
      }),
    ).toBe(1);
    const countBeforeReplay = await managed.client.notificationEvent.count({
      where: { tripId: trip.id },
    });
    groundProvider.setReplay(true);
    const replay = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(replay.json()).toMatchObject({ status: 'IDEMPOTENT' });
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(countBeforeReplay);
    expect(
      (
        await managed.client.groundTransitLegExecution.findUniqueOrThrow({
          where: { id: leg.id },
          select: { latestObservation: true },
        })
      ).latestObservation,
    ).toMatchObject({
      __groundTransitRiskDecision: `operational:${leg.id}:0:2030-10-01T09:50:00.000Z`,
    });
    groundProvider.setReplay(false);
    currentNow = new Date('2030-10-01T09:51:00Z');
    const correction = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(correction.statusCode).toBe(200);
    expect(correction.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        state: 'PENDING',
        operational: {
          disposition: 'CONTINUE_CURRENT_PLAN',
          changeKinds: ['SERVICE_RESTORED'],
        },
      },
    });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(2);
    const transitions =
      await managed.client.groundTransitStateTransition.findMany({
        where: { legExecutionId: leg.id },
        orderBy: { occurredAt: 'asc' },
      });
    expect(transitions.map((item) => item.toState)).toEqual([
      'PENDING',
      'NO_LONGER_FEASIBLE',
      'PENDING',
    ]);
    expect(transitions.map((item) => item.occurredAt.toISOString())).toEqual([
      '2030-10-01T09:49:59.000Z',
      '2030-10-01T09:50:00.000Z',
      '2030-10-01T09:51:00.000Z',
    ]);
    const presentations = await managed.client.notificationEvent.findMany({
      where: {
        tripId: trip.id,
        presentationGroupKey: {
          startsWith: `ground-transit-observation:${leg.id}:`,
        },
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      presentations.filter((item) => item.presentationActive),
    ).toHaveLength(1);
    expect(
      presentations.some(
        (item) =>
          Array.isArray(item.changeKinds) &&
          item.changeKinds.includes('SERVICE_RESTORED'),
      ),
    ).toBe(true);
    expect(
      await managed.client.executionRisk.count({
        where: {
          tripId: trip.id,
          sourceTransportEdgeId: leg.transportEdgeId,
          kind: 'PROTECTED_TIME_INFEASIBLE',
          status: 'OPEN',
        },
      }),
    ).toBe(0);
    const oldDecision = await new PrismaExecutionRiskRepository(
      managed.client,
    ).reconcile({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      basisTripVersion: (
        await managed.client.trip.findUniqueOrThrow({
          where: { id: trip.id },
          select: { version: true },
        })
      ).version,
      now: currentNow,
      desiredRisks: [],
      expectedGroundTransitObservation: {
        transportEdgeId: leg.transportEdgeId,
        identity: `operational:${leg.id}:0`,
        fetchedAt: new Date('2030-10-01T09:50:00Z'),
      },
    });
    expect(oldDecision).toEqual({ status: 'OBSERVATION_OBSOLETE' });
  });

  it.each(['PENDING', 'ARRIVED_PENDING_HANDOFF', 'COMPLETED'] as const)(
    'P6C %s service state does not become user progress and absent Provider facts remain unknown',
    async (state) => {
      const { trip, leg } = await adoptedFixedGroundTrip();
      await managed.client.groundTransitLegExecution.update({
        where: { id: leg.id },
        data: { state },
      });
      const response = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}/impact`,
        headers: bearer(userA),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<import('@travel/contracts').TripImpactView>();
      expect(
        body.items.some(
          (i) =>
            i.transportEdgeId === leg.transportEdgeId && i.status === 'UNKNOWN',
        ),
      ).toBe(true);
      expect(body.handoffs[0]?.readiness).toBe('NOT_REQUIRED');
      const evidence = await new InTripReadService(
        new PrismaInTripReadRepository(managed.client),
      ).read(userA.actor, trip.id);
      expect(evidence.execution).toMatchObject({
        state: 'NOT_STARTED',
        recordedAt: null,
      });
      expect(
        await managed.client.executionEvent.count({
          where: { tripId: trip.id },
        }),
      ).toBe(0);
    },
  );

  it('P6C real Ground observation committed during a read fences impact without Trip.version change', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    const versionBefore = (
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } })
    ).version;
    const repo = new PrismaGroundTransitRepository(managed.client);
    const evidence = new InTripReadService(
      new PrismaInTripReadRepository(managed.client),
    );
    const original = tripRepository.findOwnedById.bind(tripRepository);
    let reads = 0;
    let afterCommit: Awaited<ReturnType<typeof repairDurableState>> | undefined;
    const changingTrip = new Proxy(tripRepository, {
      get(target, key) {
        if (key === 'findOwnedById')
          return async (input: Parameters<typeof original>[0]) => {
            if (++reads === 2) {
              await new GroundTransitService(
                repo,
                groundSequence(['RECOVERY']),
                () => currentNow,
              ).refresh(userA.actor, trip.id, leg.transportEdgeId);
              afterCommit = await repairDurableState(trip.id);
            }
            return original(input);
          };
        return Reflect.get(target, key);
      },
    });
    const read = new TripImpactService(
      changingTrip,
      repo,
      new GroundTransitService(
        repo,
        groundSequence(['RECOVERY']),
        () => currentNow,
      ),
      new GroundTransitRouteReevaluationService(
        changingTrip,
        repo,
        new PrismaGroundTransitRouteProgressRepository(managed.client),
        () => currentNow,
      ),
      evidence,
      () => currentNow,
    );
    await expect(read.read(userA.actor, trip.id)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(afterCommit).toBeDefined();
    expect(await repairDurableState(trip.id)).toEqual(afterCommit);
    expect(
      (await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }))
        .version,
    ).toBe(versionBefore);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);
  });
  it('P6C impact retains the exact confirmed suffix origin without altering prefix', async () => {
    const f = await suffixFixture(false, false, false);
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED']),
    );
    const edge = f.suffixEdges.find((e) => e.fromNodeId === f.C.id)!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/trips/${f.first.trip.id}/execution/ground-transit/${edge.id}/refresh`,
          headers: bearer(userA),
        })
      ).statusCode,
    ).toBe(200);
    f.first.trip = (
      await confirmSourceOrigin(f.first.trip, f.A.id, f.B.id)
    ).trip;
    const before = await repairDurableState(f.first.trip.id);
    const response = await app.inject({
      method: 'GET',
      url: `/trips/${f.first.trip.id}/impact`,
      headers: bearer(userA),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json<import('@travel/contracts').TripImpactView>().handoffs,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTransportEdgeId: edge.id,
          readiness: 'READY',
          originBasis: 'CONFIRMED_EXECUTION_NODE',
          query: expect.objectContaining({
            fromNodeId: f.B.id,
            toNodeId: f.D.id,
            basisVersion: f.first.trip.version,
          }),
        }),
      ]),
    );
    expect(await repairDurableState(f.first.trip.id)).toEqual(before);
  });

  it.each(['CANCELLED', 'SHORT_TURN'] as const)(
    'P6C impact explains %s and exposes the same read-only handoff',
    async (scenario) => {
      const { trip, leg } = await adoptedFixedGroundTrip();
      await app.close();
      app = buildTestApi(
        new SyntheticRouteProvider((input) => {
          providerInputs.push(input);
          return providerResult;
        }),
        groundSequence([scenario]),
      );
      const refresh = await app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`,
        headers: bearer(userA),
      });
      expect(refresh.statusCode).toBe(200);
      const footprint = () =>
        Promise.all([
          managed.client.trip.findUnique({ where: { id: trip.id } }),
          managed.client.groundTransitObservation.findMany({
            where: { legExecutionId: leg.id },
          }),
          managed.client.groundTransitStateTransition.findMany({
            where: { legExecutionId: leg.id },
          }),
          managed.client.executionEvent.count({ where: { tripId: trip.id } }),
          managed.client.routeCandidateSnapshot.count({
            where: { tripId: trip.id },
          }),
          managed.client.routePreview.count({ where: { tripId: trip.id } }),
          managed.client.operationReceipt.count({ where: { tripId: trip.id } }),
          managed.client.executionRisk.findMany({ where: { tripId: trip.id } }),
          managed.client.notificationEvent.findMany({
            where: { tripId: trip.id },
          }),
        ]);
      const before = await footprint(),
        providerCalls = providerInputs.length;
      const response = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}/impact`,
        headers: bearer(userA),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<import('@travel/contracts').TripImpactView>();
      expect(body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            transportEdgeId: leg.transportEdgeId,
            status: 'VIOLATED',
            explanation: expect.stringContaining(
              scenario === 'CANCELLED' ? '取消' : '终点',
            ),
          }),
        ]),
      );
      const ownHandoff = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/route-reevaluation`,
        headers: bearer(userA),
      });
      expect(body.handoffs).toContainEqual(ownHandoff.json());
      expect(await footprint()).toEqual(before);
      expect(providerInputs.length).toBe(providerCalls);
      for (const who of [userB, admin])
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/trips/${trip.id}/impact`,
              headers: bearer(who),
            })
          ).statusCode,
        ).toBe(404);
    },
  );

  it('hands off a cancelled active leg to explicit Query, Preview, and Adopt without planning side effects', async () => {
    const { trip, adopted, leg, from } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider((input) => {
        providerInputs.push(input);
        return providerResult;
      }),
      groundSequence(['CANCELLED']),
    );
    const refresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({
      leg: { operational: { requiredAction: 'ROUTE_REEVALUATION_REQUIRED' } },
    });
    const countsBefore = await Promise.all([
      managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
      managed.client.routePreview.count({ where: { tripId: trip.id } }),
      managed.client.operationReceipt.count({ where: { tripId: trip.id } }),
    ]);
    const handoffUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/route-reevaluation`;
    const forbidden = await app.inject({
      method: 'GET',
      url: handoffUrl,
      headers: bearer(userB),
    });
    expect(forbidden.statusCode).toBe(404);
    const handoffResponse = await app.inject({
      method: 'GET',
      url: handoffUrl,
      headers: bearer(userA),
    });
    expect(handoffResponse.statusCode).toBe(200);
    const handoff =
      handoffResponse.json() as GroundTransitRouteReevaluationHandoffView;
    const current = await managed.client.trip.findUniqueOrThrow({
      where: { id: trip.id },
    });
    expect(handoff).toMatchObject({
      adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
      readiness: 'READY',
      query: {
        basisVersion: current.version,
        fromNodeId: from.id,
        toNodeId: adopted.trip.days[0]!.nodes.at(-1)!.id,
        hint: {
          type: 'DEPART_AT',
          instant: currentNow.toISOString(),
          timeZone: 'UTC',
        },
      },
    });
    expect(
      await Promise.all([
        managed.client.routeCandidateSnapshot.count({
          where: { tripId: trip.id },
        }),
        managed.client.routePreview.count({ where: { tripId: trip.id } }),
        managed.client.operationReceipt.count({ where: { tripId: trip.id } }),
      ]),
    ).toEqual(countsBefore);
    expect(providerInputs).toHaveLength(1); // Only the original user query.

    const firstCandidate =
      providerResult.status === 'SUCCESS'
        ? providerResult.candidates[0]!
        : null;
    if (firstCandidate === null) throw new Error('Synthetic candidate missing');
    const originalLeg = firstCandidate.legs[0]!;
    if (
      originalLeg.groundTransit === undefined ||
      originalLeg.groundTransit === null
    )
      throw new Error('Ground transit metadata missing');
    if (handoff.query === null)
      throw new Error('READY handoff must include a query');
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...firstCandidate,
          candidateId: `replacement-${randomUUID()}`,
          providerCandidateRef: `replacement-${randomUUID()}`,
          legs: [
            {
              ...originalLeg,
              providerRef: `replacement-${randomUUID()}`,
              groundTransit: {
                ...originalLeg.groundTransit,
                serviceIdentityKey: 'synthetic:replacement:1',
              },
            },
          ],
        },
      ],
    };
    const queried = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userA),
      payload: handoff.query!,
    });
    expect(queried.statusCode).toBe(200);
    const queryResult = queried.json() as RouteQueryResponse;
    expect(queryResult.candidates).toHaveLength(1);
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(countsBefore[0] + 1);
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: handoff.query!.basisVersion,
        candidateSnapshotId: queryResult.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    expect(preview.adoptable).toBe(true);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    const replacement = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: handoff.query!.basisVersion,
        idempotencyKey: randomUUID(),
      },
    });
    expect(replacement.statusCode).toBe(200);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'REPLACED' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ readiness: 'NOT_REQUIRED', query: null });
  });

  it('stops a recovered plan handoff and rejects an independently progressed origin', async () => {
    const { trip, leg, from } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED', 'RECOVERY']),
    );
    const refreshUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    const handoffUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/route-reevaluation`;
    await app.inject({
      method: 'POST',
      url: refreshUrl,
      headers: bearer(userA),
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ readiness: 'READY' });
    const departureFact = await managed.client.temporalValue.create({
      data: {
        nodeId: from.id,
        layer: 'ACTUAL',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T09:50:30Z'),
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      query: null,
      reasonCodes: expect.arrayContaining(['EXECUTION_ALREADY_PROGRESSING']),
    });
    await managed.client.temporalValue.delete({
      where: { id: departureFact.id },
    });
    currentNow = new Date('2030-10-01T09:51:00Z');
    await app.inject({
      method: 'POST',
      url: refreshUrl,
      headers: bearer(userA),
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ readiness: 'NOT_REQUIRED', query: null });
  });

  it('uses current Trip.version and leaves stale handoff queries to the existing version fence', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED']),
    );
    await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    const handoff = (
      await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/route-reevaluation`,
        headers: bearer(userA),
      })
    ).json() as GroundTransitRouteReevaluationHandoffView;
    expect(handoff.readiness).toBe('READY');
    if (handoff.query === null) throw new Error('READY handoff has no query');
    const owned = await managed.client.trip.findUniqueOrThrow({
      where: { id: trip.id },
    });
    await managed.client.trip.update({
      where: { id: trip.id },
      data: { version: { increment: 1 } },
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userA),
      payload: handoff.query!,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(handoff.query?.basisVersion).toBe(owned.version);
  });

  it('does not rewind independently confirmed destination arrival on a later provider cancellation', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await managed.client.groundTransitLegExecution.update({
      where: { id: leg.id },
      data: { state: 'ARRIVED_PENDING_HANDOFF' },
    });
    await managed.client.groundTransitStateTransition.create({
      data: {
        legExecutionId: leg.id,
        fromState: 'PENDING',
        toState: 'ARRIVED_PENDING_HANDOFF',
        source: 'LOCATION_ASSISTANCE',
        evidenceRef: 'node:destination-arrival',
        occurredAt: currentNow,
      },
    });
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED']),
    );
    const result = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    expect(result.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        state: 'ARRIVED_PENDING_HANDOFF',
        operational: { disposition: 'CONTINUE_CURRENT_PLAN' },
      },
    });
    expect(
      await managed.client.groundTransitStateTransition.count({
        where: { legExecutionId: leg.id, toState: 'NO_LONGER_FEASIBLE' },
      }),
    ).toBe(0);
  });

  it('does not infer user boarding from provider ACTUAL departure during recovery', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED', 'RECOVERY_WITH_SERVICE_DEPARTURE']),
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    expect(
      (
        await app.inject({ method: 'POST', url, headers: bearer(userA) })
      ).json(),
    ).toMatchObject({
      leg: { state: 'NO_LONGER_FEASIBLE' },
    });
    currentNow = new Date('2030-10-01T10:11:00Z');
    const recovered = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(recovered.json()).toMatchObject({
      status: 'APPLIED',
      leg: { state: 'PENDING' },
    });
    expect(
      await managed.client.temporalValue.findFirst({
        where: {
          transportEdgeId: leg.transportEdgeId,
          pointKind: 'DEPARTURE',
          layer: 'ACTUAL',
        },
      }),
    ).toMatchObject({ sourceKind: 'PROVIDER_OBSERVATION' });
  });

  it('restores the independent in-progress execution state after a temporary service failure', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await managed.client.groundTransitLegExecution.update({
      where: { id: leg.id },
      data: { state: 'IN_PROGRESS' },
    });
    await managed.client.groundTransitStateTransition.create({
      data: {
        legExecutionId: leg.id,
        fromState: 'PENDING',
        toState: 'IN_PROGRESS',
        source: 'LOCATION_ASSISTANCE',
        evidenceRef: 'node:boarding-departure',
        occurredAt: currentNow,
      },
    });
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['SHORT_TURN', 'RECOVERY']),
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    expect(
      (
        await app.inject({ method: 'POST', url, headers: bearer(userA) })
      ).json(),
    ).toMatchObject({
      leg: { state: 'NO_LONGER_FEASIBLE' },
    });
    currentNow = new Date('2030-10-01T09:51:00Z');
    expect(
      (
        await app.inject({ method: 'POST', url, headers: bearer(userA) })
      ).json(),
    ).toMatchObject({
      status: 'APPLIED',
      leg: { state: 'IN_PROGRESS' },
    });
    expect(
      (
        await managed.client.groundTransitStateTransition.findFirstOrThrow({
          where: { legExecutionId: leg.id, toState: 'NO_LONGER_FEASIBLE' },
          orderBy: { occurredAt: 'desc' },
        })
      ).fromState,
    ).toBe('IN_PROGRESS');
  });

  it('does not repeat a persistent material-delay presentation or create blank text', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence([
        'DELAY_16',
        'DELAY_16',
        'DELAY_17',
        'DELAY_31',
        'RECOVERY',
      ]),
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    for (const [index, expectedCount] of [1, 1, 1, 2, 2].entries()) {
      currentNow = new Date(Date.UTC(2030, 9, 1, 9, 50 + index));
      const response = await app.inject({
        method: 'POST',
        url,
        headers: bearer(userA),
      });
      expect(response.json()).toMatchObject({ status: 'APPLIED' });
      const presentations = await managed.client.notificationEvent.findMany({
        where: {
          tripId: trip.id,
          presentationGroupKey: {
            startsWith: `ground-transit-observation:${leg.id}:`,
          },
        },
      });
      expect(presentations).toHaveLength(expectedCount);
      expect(
        presentations.filter((item) => item.presentationActive),
      ).toHaveLength(index < 4 ? 1 : 0);
      expect(
        presentations.every(
          (item) =>
            item.body.trim().length > 0 &&
            (item.summary?.trim().length ?? 0) > 0,
        ),
      ).toBe(true);
    }
  });

  it.each([
    {
      name: 'departure platform',
      facts: [
        { departurePlatform: '2' },
        { departurePlatform: '5' },
        { departurePlatform: '5' },
        { departurePlatform: '5' },
      ],
      expectedKind: 'DEPARTURE_PLATFORM_CHANGED',
    },
    {
      name: 'early departure',
      facts: [
        { estimatedDeparture: null },
        { estimatedDeparture: '2030-10-01T11:50:00Z' },
        { estimatedDeparture: '2030-10-01T11:50:00Z' },
        { estimatedDeparture: '2030-10-01T11:50:00Z' },
      ],
      expectedKind: 'EARLY_DEPARTURE',
    },
    {
      name: 'material delay under the near-window policy',
      facts: [
        { estimatedArrival: null },
        { estimatedArrival: '2030-10-01T13:20:00Z' },
        { estimatedArrival: '2030-10-01T13:20:00Z' },
        { estimatedArrival: '2030-10-01T13:20:00Z' },
      ],
      expectedKind: 'MATERIAL_DELAY',
    },
  ])(
    'activates a persistent $name incident once when entering the execution window',
    async ({ facts, expectedKind }) => {
      const { trip, leg } = await adoptedFixedGroundTrip({
        now: '2030-10-01T09:00:00Z',
        departure: '2030-10-01T12:00:00Z',
        arrival: '2030-10-01T13:00:00Z',
      });
      let index = 0;
      const groundProvider: GroundTransitProvider = {
        name: 'SYNTHETIC',
        async fetchObservation({ leg: currentLeg }) {
          const source = await new SyntheticGroundTransitProvider(
            'RECOVERY',
            () => currentNow,
          ).fetchObservation({ leg: currentLeg });
          if (source.status !== 'SUCCESS') return source;
          const fact = facts[Math.min(index, facts.length - 1)]! as {
            departurePlatform?: string;
            estimatedDeparture?: string | null;
            estimatedArrival?: string | null;
          };
          const result = {
            ...source.observation,
            observationIdentity: `attention:${currentLeg.id}:${index++}`,
            departurePlatform: fact.departurePlatform ?? null,
            estimatedDeparture:
              fact.estimatedDeparture === undefined ||
              fact.estimatedDeparture === null
                ? null
                : new Date(fact.estimatedDeparture),
            estimatedArrival:
              fact.estimatedArrival === undefined ||
              fact.estimatedArrival === null
                ? null
                : new Date(fact.estimatedArrival),
            serviceStatus:
              fact.estimatedArrival === undefined ||
              fact.estimatedArrival === null
                ? ('ON_TIME' as const)
                : ('DELAYED' as const),
          };
          return { status: 'SUCCESS', observation: result };
        },
      };
      await app.close();
      app = buildTestApi(
        new SyntheticRouteProvider(() => providerResult),
        groundProvider,
      );
      const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
      const samples = [
        '2030-10-01T09:05:00Z',
        '2030-10-01T09:30:00Z',
        '2030-10-01T11:20:00Z',
        '2030-10-01T11:25:00Z',
      ];
      for (const [sampleIndex, instant] of samples.entries()) {
        currentNow = new Date(instant);
        if (sampleIndex === 3) {
          // A fresh service instance must honor the persisted presentation state.
          await app.close();
          app = buildTestApi(
            new SyntheticRouteProvider(() => providerResult),
            groundProvider,
          );
        }
        const response = await app.inject({
          method: 'POST',
          url,
          headers: bearer(userA),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'APPLIED' });
        const presentations = await managed.client.notificationEvent.findMany({
          where: {
            tripId: trip.id,
            presentationGroupKey: {
              startsWith: `ground-transit-observation:${leg.id}:`,
            },
          },
        });
        expect(presentations).toHaveLength(sampleIndex < 2 ? 0 : 1);
        if (sampleIndex >= 2) {
          expect(presentations[0]).toMatchObject({
            presentationActive: true,
          });
          expect(presentations[0]!.changeKinds).toContain(expectedKind);
          expect(presentations[0]!.summary?.trim().length).toBeGreaterThan(0);
          expect(presentations[0]!.body.trim().length).toBeGreaterThan(0);
          if (expectedKind === 'DEPARTURE_PLATFORM_CHANGED') {
            expect(presentations[0]!.summary).toContain('5');
          }
        }
      }
      const stored = await managed.client.groundTransitObservation.findMany({
        where: { legExecutionId: leg.id },
      });
      expect(stored).toHaveLength(4);
      expect(
        stored.every(
          (item) =>
            !Object.hasOwn(
              item.facts as Record<string, unknown>,
              '__groundTransitAttention',
            ),
        ),
      ).toBe(true);
    },
  );

  it('marks a skipped adopted stop infeasible and refuses to revive an actual missed service', async () => {
    const { trip, leg, adopted, from } = await adoptedFixedGroundTrip();
    const groundProvider = groundSequence([
      'SHORT_TURN',
      'RECOVERY',
      'ACTUAL_MISS',
      'RECOVERY',
    ]);
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundProvider,
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    const shortTurn = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(shortTurn.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: {
          targetServiceability: { alighting: 'NOT_SERVED' },
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
        },
      },
    });
    currentNow = new Date('2030-10-01T09:51:00Z');
    const restored = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(restored.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: { disposition: 'CONTINUE_CURRENT_PLAN' },
      },
    });
    currentNow = new Date('2030-10-01T10:11:00Z');
    const actualArrival = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: adopted.trip.version,
        subject: { type: 'NODE', nodeId: from.id },
        value: {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:10:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(actualArrival.statusCode).toBe(200);
    const missed = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(missed.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: {
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
          irreversibleActualMiss: true,
        },
      },
    });
    currentNow = new Date('2030-10-01T10:12:00Z');
    const impossibleCorrection = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(impossibleCorrection.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: {
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
          irreversibleActualMiss: true,
        },
      },
    });
    expect(
      await managed.client.transportEdge.count({
        where: { id: leg.transportEdgeId },
      }),
    ).toBe(1);
  });

  it('fences an old service recovery after the user adopts a replacement', async () => {
    const { trip, leg, from } = await adoptedFixedGroundTrip();
    const previousTo = trip.days[0]!.nodes[1]!;
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED', 'RECOVERY']),
    );
    const oldUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: oldUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ status: 'APPLIED' });
    const changed = providerResult;
    if (changed.status !== 'SUCCESS')
      throw new Error('synthetic candidate missing');
    providerResult = {
      status: 'SUCCESS',
      candidates: changed.candidates.map((item) => ({
        ...item,
        candidateId: `replacement-${randomUUID()}`,
        legs: item.legs.map((segment) => ({
          ...segment,
          groundTransit:
            segment.groundTransit === null ||
            segment.groundTransit === undefined
              ? null
              : {
                  ...segment.groundTransit,
                  serviceIdentityKey: 'synthetic:replacement:2',
                },
        })),
      })),
    };
    const currentTripResponse = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}`,
      headers: bearer(userA),
    });
    expect(currentTripResponse.statusCode).toBe(200);
    const currentTrip = currentTripResponse.json() as TripView;
    const preview = await createPreview(
      userA,
      currentTrip,
      from.id,
      previousTo.id,
    );
    await adoptSuccessfully(
      userA,
      currentTrip,
      preview.previewId,
      `replacement-${randomUUID()}`,
    );
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: leg.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'REPLACED' });
    const oldRefresh = await app.inject({
      method: 'POST',
      url: oldUrl,
      headers: bearer(userA),
    });
    expect(oldRefresh.statusCode).toBe(404);
    const oldGround =
      await managed.client.groundTransitLegExecution.findUniqueOrThrow({
        where: { id: leg.id },
      });
    expect(oldGround).toMatchObject({
      latestObservationId: `operational:${leg.id}:0`,
      state: 'NO_LONGER_FEASIBLE',
    });
  });

  it('fences a delayed cancellation response after monitoring is paused', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await managed.client.tripAssistanceCapability.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: currentNow,
      },
    });
    const synthetic = new SyntheticGroundTransitProvider(
      'CANCEL_FIXED',
      () => currentNow,
    );
    const repository = new PrismaGroundTransitRepository(managed.client);
    const monitor = new GroundTransitService(
      repository,
      {
        name: 'SYNTHETIC',
        async fetchObservation(input) {
          await managed.client.tripAssistanceCapability.update({
            where: {
              tripId_kind: {
                tripId: trip.id,
                kind: 'GROUND_TRANSIT_MONITORING',
              },
            },
            data: { state: 'PAUSED', revision: 2, pausedAt: currentNow },
          });
          return synthetic.fetchObservation(input);
        },
      },
      () => currentNow,
      new ExecutionRiskService(
        tripRepository,
        new PrismaExecutionRiskRepository(managed.client),
        { now: () => currentNow, groundTransitRepository: repository },
      ),
    );
    await monitor.executeJob(leg.adoptedRouteId, 1);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.executionRisk.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
  });

  it('persists adopted fixed-service ground identity, refreshes owner-only, and retains archived evidence', async () => {
    const trip = await tripWithVisits(userA, ['Ground A', 'Ground B']);
    const [from, to] = trip.days[0]!.nodes;
    const original = candidate(
      '2030-10-01T10:00:00Z',
      '2030-10-01T11:00:00Z',
      'UTC',
      'UTC',
    );
    const firstLeg = original.legs[0]!;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...original,
          candidateId: 'ground-fixed-candidate',
          legs: [
            {
              ...firstLeg,
              mode: 'RAIL',
              groundTransit: {
                serviceClass: 'FIXED_SERVICE',
                serviceIdentityKey: 'synthetic:rail:2030-10-01:1',
                lineRef: 'rail-1',
                lineName: 'Rail 1',
                directionRef: 'east',
                directionLabel: 'East',
                boardingHubRef: 'hub-a',
                alightingHubRef: 'hub-b',
                headwayMinSeconds: null,
                headwayMaxSeconds: null,
                minimumTransferSeconds: 300,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `ground-adopt-${randomUUID()}`,
    );
    const edge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: trip.id, source: 'ADOPTED_ROUTE' },
    });
    const leg =
      await managed.client.groundTransitLegExecution.findUniqueOrThrow({
        where: { transportEdgeId: edge.id },
      });
    expect(leg).toMatchObject({
      serviceClass: 'FIXED_SERVICE',
      serviceIdentityKey: 'synthetic:rail:2030-10-01:1',
    });
    expect((leg.baseline as Record<string, unknown>).schemaVersion).toBe(
      'ground-transit-baseline-v1',
    );
    const otherRead = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userB),
    });
    expect(otherRead.statusCode).toBe(404);
    const otherRefresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userB),
    });
    expect(otherRefresh.statusCode).toBe(404);
    const syntheticGround = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    );
    let cachedResult:
      | Awaited<ReturnType<GroundTransitProvider['fetchObservation']>>
      | undefined;
    await app.close();
    app = buildTestApi(new SyntheticRouteProvider(() => providerResult), {
      name: 'SYNTHETIC',
      async fetchObservation(input) {
        cachedResult ??= await syntheticGround.fetchObservation(input);
        return cachedResult;
      },
    });
    const refresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({
      status: 'APPLIED',
      leg: { serviceClass: 'FIXED_SERVICE', observationCount: 1 },
    });
    const estimated = await managed.client.temporalValue.findFirstOrThrow({
      where: {
        transportEdgeId: edge.id,
        layer: 'ESTIMATED',
        pointKind: 'DEPARTURE',
      },
    });
    expect(estimated).toMatchObject({
      sourceKind: 'PROVIDER_OBSERVATION',
      instant: new Date('2030-10-01T10:10:00Z'),
    });
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: adopted.trip.version + 1 });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);
    const savedObservation =
      await managed.client.groundTransitObservation.findFirstOrThrow({
        where: { legExecutionId: leg.id },
      });
    expect(estimated.sourceRef).toBe(
      `ground-transit-observation:${savedObservation.id}`,
    );
    const replay = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'IDEMPOTENT' });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: adopted.trip.version + 1 });
    expect(
      await managed.client.groundTransitStateTransition.findMany({
        where: { legExecutionId: leg.id },
        orderBy: { occurredAt: 'asc' },
      }),
    ).toMatchObject([
      { fromState: null, toState: 'PENDING', source: 'ROUTE_ADOPT' },
    ]);

    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      new SyntheticGroundTransitProvider('STALE', () => currentNow),
    );
    const stale = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({
      status: 'STALE_IGNORED',
      leg: { observationCount: 1 },
    });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);

    currentNow = new Date('2030-10-01T09:30:00Z');
    await managed.client.tripAssistanceCapability.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: currentNow,
      },
    });
    const monitorProvider = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    );
    const monitor = new GroundTransitService(
      new PrismaGroundTransitRepository(managed.client),
      {
        name: 'SYNTHETIC',
        async fetchObservation(input) {
          const result = await monitorProvider.fetchObservation(input);
          return result.status === 'SUCCESS'
            ? {
                status: 'SUCCESS',
                observation: {
                  ...result.observation,
                  observationIdentity: `background:${result.observation.observationIdentity}`,
                },
              }
            : result;
        },
      },
      () => currentNow,
    );
    await monitor.executeJob(leg.adoptedRouteId, 1);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(2);
    await managed.client.tripAssistanceCapability.update({
      where: {
        tripId_kind: { tripId: trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      },
      data: { state: 'PAUSED', revision: 2, pausedAt: currentNow },
    });
    await monitor.executeJob(leg.adoptedRouteId, 1);
    await managed.client.tripAssistanceCapability.update({
      where: {
        tripId_kind: { tripId: trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      },
      data: { state: 'ENABLED', revision: 3, resumedAt: currentNow },
    });
    await monitor.executeJob(leg.adoptedRouteId, 1);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(2);
    currentNow = new Date('2030-10-01T09:36:00Z');
    await monitor.executeJob(leg.adoptedRouteId, 3);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(3);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: adopted.trip.version + 1 });

    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      new SyntheticGroundTransitProvider('IDENTITY_MISMATCH', () => currentNow),
    );
    const mismatch = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.json()).toMatchObject({ status: 'DIFFERENT_SERVICE' });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(3);

    currentNow = new Date('2030-10-01T10:05:00Z');
    await app.close();
    const actualProvider = new SyntheticGroundTransitProvider(
      'ACTUAL_DEPARTURE',
      () => currentNow,
    );
    app = buildTestApi(new SyntheticRouteProvider(() => providerResult), {
      name: 'SYNTHETIC',
      async fetchObservation(input) {
        const result = await actualProvider.fetchObservation(input);
        return result.status === 'SUCCESS'
          ? {
              status: 'SUCCESS',
              observation: {
                ...result.observation,
                observationIdentity: `actual-test:${result.observation.observationIdentity}`,
              },
            }
          : result;
      },
    });
    const actualRefresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(actualRefresh.statusCode).toBe(200);
    expect(actualRefresh.json()).toMatchObject({ status: 'APPLIED' });
    const actual = await managed.client.temporalValue.findUniqueOrThrow({
      where: {
        transportEdgeId_pointKind_layer: {
          transportEdgeId: edge.id,
          pointKind: 'DEPARTURE',
          layer: 'ACTUAL',
        },
      },
    });
    expect(actual).toMatchObject({
      instant: new Date('2030-10-01T10:00:00Z'),
      sourceKind: 'PROVIDER_OBSERVATION',
    });
    currentNow = new Date('2030-10-01T10:10:00Z');
    await app.close();
    const lateEstimateProvider = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    );
    app = buildTestApi(new SyntheticRouteProvider(() => providerResult), {
      name: 'SYNTHETIC',
      async fetchObservation(input) {
        const result = await lateEstimateProvider.fetchObservation(input);
        return result.status === 'SUCCESS'
          ? {
              status: 'SUCCESS',
              observation: {
                ...result.observation,
                observationIdentity: `late-estimate:${result.observation.observationIdentity}`,
              },
            }
          : result;
      },
    });
    const lateEstimate = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(lateEstimate.statusCode).toBe(200);
    expect(lateEstimate.json()).toMatchObject({ status: 'APPLIED' });
    expect(
      await managed.client.temporalValue.findUniqueOrThrow({
        where: {
          transportEdgeId_pointKind_layer: {
            transportEdgeId: edge.id,
            pointKind: 'DEPARTURE',
            layer: 'ACTUAL',
          },
        },
      }),
    ).toMatchObject({ instant: actual.instant, sourceRef: actual.sourceRef });

    await managed.client.groundTransitLegExecution.delete({
      where: { id: leg.id },
    });
    const legacy = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toMatchObject({
      legs: [
        {
          transportEdgeId: edge.id,
          state: 'UNKNOWN',
          serviceClass: null,
          baseline: null,
          current: true,
        },
      ],
    });
  });

  it('runs the Google Consumer adapter through snapshot, preview, adopt, and undo', async () => {
    currentNow = new Date('2026-09-20T05:00:00.000Z');
    const fetchImplementation = vi.fn(async (_url, init) => {
      const requestedQuery = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify(googleConsumerHokkaidoFixture(requestedQuery)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await app.close();
    app = buildTestApi(
      new GoogleConsumerExperimentalRouteProvider({
        baseUrl: 'http://127.0.0.1:8787',
        token: 'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
        timeoutMs: 1_000,
        fetchImplementation,
      }),
    );

    const trip = await tripWithVisitsOnDate(
      userA,
      ['Hotel Mahoroba', '洞爷湖景乃之风'],
      '2026-09-23',
    );
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    await Promise.all([
      managed.client.place.update({
        where: { id: from!.place!.id },
        data: { latitude: 42.4930624, longitude: 141.1419064 },
      }),
      managed.client.place.update({
        where: { id: to!.place!.id },
        data: { latitude: 42.565637, longitude: 140.8222622 },
      }),
    ]);
    const flightsBefore = await managed.client.flightBinding.count();
    const routeResponse = await query(userA, trip, from!.id, to!.id, {
      type: 'DEPART_AT',
      instant: '2026-09-23T15:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    });

    expect(routeResponse.statusCode).toBe(200);
    const route = routeResponse.json() as RouteQueryResponse;
    expect(route.candidates[0]).toMatchObject({
      provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
      providerCandidateRef: 'sanitized-hokkaido-01',
      fare: { amount: '3910', currency: 'JPY' },
      legs: googleExpectedLegs(),
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const snapshot =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: { id: route.candidates[0]!.candidateSnapshotId },
      });
    expect(snapshot).toMatchObject({
      provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
      providerCandidateRef: 'sanitized-hokkaido-01',
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot.candidatePayload).toMatchObject({
      fare: { amount: '3910', currency: 'JPY' },
      legs: googleExpectedLegs(),
    });
    expect(JSON.stringify(snapshot.candidatePayload)).not.toContain(
      'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
    );
    expect(JSON.stringify(snapshot.candidatePayload)).not.toContain(
      'requestedQuery',
    );

    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.nodesToCreate).toHaveLength(6);
    expect(preview.changeSummary.proposedSegments).toMatchObject(
      googleExpectedLegs(),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `google-consumer-adopt-${randomUUID()}`,
    );
    expect(adopted.trip.version).toBe(trip.version + 1);
    expect(
      adopted.trip.days
        .flatMap((day) => day.nodes)
        .filter((node) => node.source === 'ROUTE_GENERATED'),
    ).toHaveLength(6);
    expect(
      adopted.trip.connections.map((connection) => ({
        mode: connection.transport?.mode,
        fixedService: connection.transport?.fixedService,
        provider: connection.transport?.provider,
        providerRef: connection.transport?.providerRef,
      })),
    ).toEqual(
      googleExpectedLegs().map((leg, index) => ({
        ...leg,
        provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
        providerRef: `sanitized-hokkaido-01:leg:${index}`,
      })),
    );
    const adoptedEdges = await managed.client.transportEdge.findMany({
      where: { tripId: trip.id },
    });
    const adoptedTimes = await managed.client.temporalValue.findMany({
      where: { transportEdgeId: { in: adoptedEdges.map((edge) => edge.id) } },
      orderBy: { instant: 'asc' },
    });
    expect(adoptedTimes).toHaveLength(14);
    expect(adoptedTimes[0]).toMatchObject({
      layer: 'PLANNED',
      sourceKind: 'ADOPTED_TRANSPORT_FACT',
      instant: new Date('2026-09-23T06:00:00.000Z'),
    });
    expect(adoptedTimes.at(-1)).toMatchObject({
      layer: 'PLANNED',
      sourceKind: 'ADOPTED_TRANSPORT_FACT',
      instant: new Date('2026-09-23T08:00:00.000Z'),
    });
    expect(adopted.operationReceipt).toMatchObject({
      operationType: 'ROUTE_ADOPT',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      `google-consumer-undo-${randomUUID()}`,
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
    expect(undone.operationReceipt.operationType).toBe('ROUTE_UNDO');
    expect(
      undone.trip.days
        .flatMap((day) => day.nodes)
        .filter((node) => node.source === 'ROUTE_GENERATED'),
    ).toHaveLength(0);
    expect(undone.trip.connections).toMatchObject([{ state: 'MISSING' }]);
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { id: snapshot.id },
      }),
    ).toBe(1);
    expect(await managed.client.flightBinding.count()).toBe(flightsBefore);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('maps the sidecar unsupported ARRIVE_BY envelope to HTTP 422', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'ERROR',
            error: {
              code: 'UNSUPPORTED_MODE',
              message: 'ARRIVE_BY is not enabled',
            },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await app.close();
    app = buildTestApi(
      new GoogleConsumerExperimentalRouteProvider({
        baseUrl: 'http://127.0.0.1:8787',
        token: 'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
        timeoutMs: 1_000,
        fetchImplementation,
      }),
    );
    const trip = await tripWithVisits(userA, ['Tokyo', 'Shinjuku']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);

    const response = await query(userA, trip, from!.id, to!.id, {
      type: 'ARRIVE_BY',
      instant: '2030-10-01T20:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('runs ARRIVE_BY through the Google adapter, snapshot, preview, adopt, and undo', async () => {
    currentNow = new Date('2026-09-20T05:00:00.000Z');
    const fetchImplementation = vi.fn(async (_url, init) => {
      const requestedQuery = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify(googleConsumerHokkaidoFixture(requestedQuery)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await app.close();
    app = buildTestApi(
      new GoogleConsumerExperimentalRouteProvider({
        baseUrl: 'http://127.0.0.1:8787',
        token: 'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
        timeoutMs: 1_000,
        fetchImplementation,
      }),
    );
    const trip = await tripWithVisitsOnDate(
      userA,
      ['Hotel Mahoroba', '洞爷湖景乃之风'],
      '2026-09-23',
    );
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const response = await query(userA, trip, from!.id, to!.id, {
      type: 'ARRIVE_BY',
      instant: '2026-09-23T17:30:00+09:00',
      timeZone: 'Asia/Tokyo',
    });
    expect(response.statusCode).toBe(200);
    const route = response.json() as RouteQueryResponse;
    expect(route.candidates[0]).toMatchObject({
      provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
      providerCandidateRef: 'sanitized-hokkaido-01',
      fare: { amount: '3910', currency: 'JPY' },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      timeMode: 'ARRIVE_BY',
      date: '2026-09-23',
      time: '17:30',
      timezone: 'Asia/Tokyo',
    });
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    expect(preview.adoptable).toBe(true);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `google-consumer-arrive-by-adopt-${randomUUID()}`,
    );
    expect(adopted.trip.version).toBe(trip.version + 1);
    expect(adopted.operationReceipt.operationType).toBe('ROUTE_ADOPT');
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      `google-consumer-arrive-by-undo-${randomUUID()}`,
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
    expect(undone.operationReceipt.operationType).toBe('ROUTE_UNDO');
    expect(undone.trip.connections).toMatchObject([{ state: 'MISSING' }]);
  });

  it('creates and re-reads an immutable Preview without changing official Trip facts', async () => {
    const trip = await tripWithVisits(userA, ['Tokyo', 'Los Angeles']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const before = await databaseFacts(trip.id);
    const routeResponse = await query(
      userA,
      trip,
      from!.id,
      to!.id,
      departHint(),
    );
    const route = routeResponse.json() as RouteQueryResponse;

    const createResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const preview = createResponse.json() as { previewId: string } & Record<
      string,
      unknown
    >;
    expect(preview).toMatchObject({
      basisVersion: trip.version,
      candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      status: 'ACTIVE',
      adoptable: true,
      currentConnection: { state: 'MISSING', transport: null },
      changeSummary: {
        transportAction: 'CREATE',
        requiresGeneratedNodes: false,
        temporalLayer: 'PLANNED',
        temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
      },
    });
    expect(await databaseFacts(trip.id)).toEqual(before);
    expect(
      await managed.client.routePreview.count({ where: { tripId: trip.id } }),
    ).toBe(1);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/previews/${preview.previewId}`,
      headers: bearer(userA),
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(preview);
    expect(providerInputs).toHaveLength(1);
  });

  it('returns NOT_FOUND across owner boundaries and marks expired Preview non-adoptable', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    const routeResponse = await query(
      userA,
      trip,
      from!.id,
      to!.id,
      departHint(),
    );
    const route = routeResponse.json() as RouteQueryResponse;

    let response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userB),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(response.statusCode).toBe(404);

    response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(response.statusCode).toBe(201);
    const previewId = (response.json() as { previewId: string }).previewId;

    const hiddenPreview = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/previews/${previewId}`,
      headers: bearer(userB),
    });
    expect(hiddenPreview.statusCode).toBe(404);
    currentNow = new Date(NOW.getTime() + 901_000);

    const staleCreate = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(staleCreate.statusCode).toBe(409);
    expect(staleCreate.json()).toMatchObject({
      error: { code: 'PREVIEW_STALE' },
    });

    response = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/previews/${previewId}`,
      headers: bearer(userA),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      previewId,
      status: 'EXPIRED',
      adoptable: false,
    });
  });

  it('does not persist a snapshot when the Trip changes during Provider I/O', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    providerHook = async () => {
      const mutation = await app.inject({
        method: 'PATCH',
        url: `/trips/${trip.id}`,
        headers: bearer(userA),
        payload: {
          baseTripVersion: trip.version,
          name: 'SYNTHETIC changed during provider call',
        },
      });
      expect(mutation.statusCode).toBe(200);
    };

    const response = await query(userA, trip, from!.id, to!.id, departHint());
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
    });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
  });

  it('feeds both P3B2 hard bounds to the provider without copying propagation', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: from!.id,
      pointKind: 'DEPARTURE',
      operator: 'NOT_BEFORE',
      instant: '2030-10-01T18:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: false,
    });
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: to!.id,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T20:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: false,
    });
    providerResult = {
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T10:30:00Z', '2030-10-01T11:30:00Z')],
    };

    const response = await query(userA, trip, from!.id, to!.id, null);
    expect(response.statusCode).toBe(200);
    expect(providerInputs[0]).toMatchObject({
      earliestDeparture: new Date('2030-10-01T10:00:00Z'),
      latestArrival: new Date('2030-10-01T12:00:00Z'),
      preference: { type: 'NONE' },
    });
  });

  it('post-filters provider violations and distinguishes an empty feasible result', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: to!.id,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T20:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    providerResult = {
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T11:30:00Z', '2030-10-01T12:01:00Z')],
    };
    const response = await query(userA, trip, from!.id, to!.id, null);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'NO_MATCHING_CANDIDATE' },
    });
  });

  it('rejects missing time, stale version, non-adjacent nodes, and FreeAction endpoints', async () => {
    let trip = await tripWithVisits(userA, ['A', 'B', 'C']);
    const [a, b, c] = trip.days[0]!.nodes;

    let response = await query(userA, trip, a!.id, b!.id, null);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_QUERY_TIME_REQUIRED' },
    });

    response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version - 1,
        fromNodeId: a!.id,
        toNodeId: b!.id,
        hint: departHint(),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
    });

    response = await query(userA, trip, a!.id, c!.id, departHint());
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
    });

    trip = await command(userA, trip, {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
      },
      position: 1,
      note: 'SYNTHETIC',
    });
    response = await query(
      userA,
      trip,
      trip.days[0]!.nodes[0]!.id,
      trip.days[0]!.nodes[1]!.id,
      departHint(),
    );
    expect(response.statusCode).toBe(422);
    expect(providerInputs).toHaveLength(0);
  });

  it('hides owner resources from another user and ADMIN', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    for (const identity of [userB, admin]) {
      const response = await query(
        identity,
        trip,
        from!.id,
        to!.id,
        departHint(),
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(providerInputs).toHaveLength(0);
  });

  it('uses DayOccurrence sequence for a local-date rollback adjacency', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'Tokyo', '2030-01-10');
    trip = await addVisit(userA, trip, 'Los Angeles', '2030-01-09');
    const [tokyo, losAngeles] = trip.days.flatMap((day) => day.nodes);
    const response = await query(
      userA,
      trip,
      tokyo!.id,
      losAngeles!.id,
      departHint(),
    );

    expect(response.statusCode).toBe(200);
    expect(trip.days.map((day) => day.localDate)).toEqual([
      '2030-01-10',
      '2030-01-09',
    ]);
    expect(providerInputs[0]).toMatchObject({
      origin: { name: 'Tokyo' },
      destination: { name: 'Los Angeles' },
    });
  });

  it('shows a 15-minute-lookback candidate, adopts one MIN_DWELL adjustment, and restores it on Undo', async () => {
    let trip = await tripWithVisits(userA, ['Current place', 'Next place']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const temporal = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(temporal.statusCode).toBe(200);
    trip = temporal.json() as TripView;
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3_000,
      locked: false,
    });
    const suggested = await tripRepository.setSystemDwellSuggestion({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      nodeId: from!.id,
      durationSeconds: 3_600,
    });
    expect(suggested.status).toBe('SUCCESS');
    if (suggested.status !== 'SUCCESS') throw new Error('suggestion failed');
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);

    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:34:59Z', '2030-10-01T11:34:59Z', 'UTC', 'UTC'),
        candidate('2030-10-01T10:45:00Z', '2030-10-01T11:45:00Z', 'UTC', 'UTC'),
      ],
    };
    const routeResponse = await query(userA, trip, from!.id, to!.id, null);
    expect(routeResponse.statusCode).toBe(200);
    const route = routeResponse.json() as RouteQueryResponse;
    expect(providerInputs[0]?.earliestDeparture?.toISOString()).toBe(
      '2030-10-01T10:35:00.000Z',
    );
    expect(route.candidates[0]?.planningAssessment).toMatchObject({
      effectiveTotalTimeSeconds: 3_300,
      requiresUserAdjustment: true,
      requiredUserAdjustments: [
        {
          nodeId: from!.id,
          fromDurationSeconds: 3_000,
          toDurationSeconds: 2_700,
        },
      ],
    });
    expect(route.candidates).toHaveLength(1);

    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toHaveLength(1);

    const unconfirmed = await adopt(
      userA,
      trip,
      preview.previewId,
      `p5c-unconfirmed-${randomUUID()}`,
    );
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({
      error: { code: 'USER_ADJUSTMENT_REQUIRED' },
    });

    const adjustmentAdoptKey = `p5c-adopt-${randomUUID()}`;
    const adoptedResponse = await adopt(
      userA,
      trip,
      preview.previewId,
      adjustmentAdoptKey,
      adjustments,
    );
    expect(adoptedResponse.statusCode).toBe(200);
    const adopted = adoptedResponse.json() as {
      operationReceipt: { id: string; delta: { schemaVersion: string } };
      trip: TripView;
    };
    expect(adopted.operationReceipt.delta.schemaVersion).toBe(
      'route-adopt-delta-v3',
    );
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { tripId: trip.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 2_700 });

    const replay = await adopt(
      userA,
      trip,
      preview.previewId,
      adjustmentAdoptKey,
      adjustments,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: adopted.operationReceipt.id },
      trip: { version: adopted.trip.version },
    });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id, operationType: 'ROUTE_ADOPT' },
      }),
    ).toBe(1);
    const conflictingReplay = await adopt(
      userA,
      trip,
      preview.previewId,
      adjustmentAdoptKey,
      adjustments.map((adjustment) => ({
        ...adjustment,
        toDurationSeconds: adjustment.toDurationSeconds - 1,
      })),
    );
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      `p5c-undo-${randomUUID()}`,
    );
    expect(undone.operationReceipt.delta).toMatchObject({
      schemaVersion: 'route-undo-delta-v2',
    });
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { tripId: trip.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 3_000 });

    const restoredSuggestion = await command(userA, undone.trip, {
      type: 'REMOVE_MIN_DWELL',
      nodeId: from!.id,
    });
    expect(
      restoredSuggestion.days
        .flatMap((day) => day.nodes)
        .find((node) => node.id === from!.id),
    ).toMatchObject({
      systemDwellSuggestion: { durationSeconds: 3_600 },
      timeIntents: [],
    });
  });

  it('keeps one owner-scoped system dwell suggestion independent from user MIN_DWELL and cascades it safely', async () => {
    let trip = await tripWithVisits(userA, ['Suggestion target', 'Next']);
    const node = trip.days[0]!.nodes[0]!;
    const first = await tripRepository.setSystemDwellSuggestion({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      nodeId: node.id,
      durationSeconds: 3_600,
    });
    expect(first.status).toBe('SUCCESS');
    if (first.status !== 'SUCCESS') throw new Error('suggestion failed');
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);
    const second = await tripRepository.setSystemDwellSuggestion({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      nodeId: node.id,
      durationSeconds: 4_200,
    });
    expect(second.status).toBe('SUCCESS');
    if (second.status !== 'SUCCESS')
      throw new Error('suggestion update failed');
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);
    expect(
      await managed.client.systemDwellSuggestion.findMany({
        where: { nodeId: node.id },
      }),
    ).toEqual([
      expect.objectContaining({
        tripId: trip.id,
        durationSeconds: 4_200,
        source: 'SYSTEM_SUGGESTION',
      }),
    ]);

    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: node.id,
      durationSeconds: 3_000,
      locked: false,
    });
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: node.id,
      durationSeconds: 2_400,
      locked: true,
    });
    trip = await command(userA, trip, {
      type: 'REMOVE_MIN_DWELL',
      nodeId: node.id,
    });
    expect(
      await managed.client.systemDwellSuggestion.findUnique({
        where: { nodeId: node.id },
      }),
    ).toMatchObject({ durationSeconds: 4_200 });
    const evaluation = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/schedule/evaluate`,
      headers: bearer(userA),
      payload: { basisVersion: trip.version },
    });
    expect(evaluation.statusCode).toBe(200);
    expect(
      (
        evaluation.json() as { nodes: { nodeId: string; departure: unknown }[] }
      ).nodes.find((value) => value.nodeId === node.id),
    ).toMatchObject({
      departure: {
        requirementWindow: { status: 'UNBOUNDED' },
      },
    });
    expect(evaluation.json()).toMatchObject({ conflicts: [] });

    const foreignTrip = await tripWithVisits(userB, ['Foreign', 'Next']);
    const foreignNode = foreignTrip.days[0]!.nodes[0]!;
    expect(
      await tripRepository.setSystemDwellSuggestion({
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        baseTripVersion: trip.version,
        nodeId: foreignNode.id,
        durationSeconds: 1_800,
      }),
    ).toMatchObject({ status: 'NOT_FOUND' });
    expect(
      await managed.client.systemDwellSuggestion.count({
        where: { nodeId: foreignNode.id },
      }),
    ).toBe(0);

    trip = await command(userA, trip, {
      type: 'DELETE_NODE',
      nodeId: node.id,
    });
    expect(
      await managed.client.systemDwellSuggestion.count({
        where: { nodeId: node.id },
      }),
    ).toBe(0);

    const cascadeNode = trip.days[0]!.nodes[0]!;
    expect(
      await tripRepository.setSystemDwellSuggestion({
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        baseTripVersion: trip.version,
        nodeId: cascadeNode.id,
        durationSeconds: 900,
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    await managed.client.trip.delete({ where: { id: trip.id } });
    expect(
      await managed.client.systemDwellSuggestion.count({
        where: { nodeId: cascadeNode.id },
      }),
    ).toBe(0);
  });

  it('rolls back an accepted dwell adjustment when route persistence fails', async () => {
    const scenario = await adjustableAdoption(userA, 'route-write-failure');
    await managed.client.$executeRawUnsafe(`
      CREATE FUNCTION p5c_fail_adopted_edge() RETURNS trigger AS $$
      BEGIN
        IF NEW."source" = 'ADOPTED_ROUTE' THEN
          RAISE EXCEPTION 'SYNTHETIC_P5C_EDGE_FAILURE';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await managed.client.$executeRawUnsafe(`
      CREATE TRIGGER p5c_fail_adopted_edge_trigger
      BEFORE INSERT ON "TransportEdge"
      FOR EACH ROW EXECUTE FUNCTION p5c_fail_adopted_edge()
    `);
    try {
      const response = await adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-route-write-failure-${randomUUID()}`,
        scenario.adjustments,
      );
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
      await expectAdjustmentRollback(scenario.trip, scenario.intentId, 3_000);
    } finally {
      await managed.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS p5c_fail_adopted_edge_trigger ON "TransportEdge"',
      );
      await managed.client.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS p5c_fail_adopted_edge()',
      );
    }
  });

  it('rolls back route and dwell writes when ROUTE_ADOPTED outbox persistence fails', async () => {
    const scenario = await adjustableAdoption(userA, 'outbox-failure');
    await managed.client.$executeRawUnsafe(`
      CREATE FUNCTION p5c_fail_adopt_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW."type" = 'ROUTE_ADOPTED' THEN
          RAISE EXCEPTION 'SYNTHETIC_P5C_OUTBOX_FAILURE';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await managed.client.$executeRawUnsafe(`
      CREATE TRIGGER p5c_fail_adopt_outbox_trigger
      BEFORE INSERT ON "OutboxEvent"
      FOR EACH ROW EXECUTE FUNCTION p5c_fail_adopt_outbox()
    `);
    try {
      const response = await adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-outbox-failure-${randomUUID()}`,
        scenario.adjustments,
      );
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
      await expectAdjustmentRollback(scenario.trip, scenario.intentId, 3_000);
    } finally {
      await managed.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS p5c_fail_adopt_outbox_trigger ON "OutboxEvent"',
      );
      await managed.client.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS p5c_fail_adopt_outbox()',
      );
    }
  });

  it('rejects stale or tampered dwell adjustments without any write', async () => {
    const scenario = await adjustableAdoption(userA, 'tampered-adjustment');
    const expected = scenario.adjustments[0]!;
    for (const adjustment of [
      { ...expected, intentId: randomUUID() },
      { ...expected, nodeId: randomUUID() },
      { ...expected, fromDurationSeconds: 2_999 },
    ]) {
      const response = await adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-invalid-adjustment-${randomUUID()}`,
        [adjustment],
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'USER_ADJUSTMENT_REQUIRED' },
      });
    }
    await expectAdjustmentRollback(scenario.trip, scenario.intentId, 3_000);
  });

  it('does not let Undo overwrite a later user MIN_DWELL change, removal, or lock decision', async () => {
    for (const mutation of ['CHANGE', 'REMOVE', 'LOCK'] as const) {
      const scenario = await adjustableAdoption(userA, `undo-${mutation}`);
      const adopted = await adoptSuccessfully(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-undo-guard-adopt-${mutation}-${randomUUID()}`,
        scenario.adjustments,
      );
      let changed: TripView;
      if (mutation === 'REMOVE') {
        changed = await command(userA, adopted.trip, {
          type: 'REMOVE_MIN_DWELL',
          nodeId: scenario.adjustments[0]!.nodeId,
        });
      } else {
        changed = await command(userA, adopted.trip, {
          type: 'SET_MIN_DWELL',
          nodeId: scenario.adjustments[0]!.nodeId,
          durationSeconds: mutation === 'CHANGE' ? 2_400 : 2_700,
          locked: mutation === 'LOCK',
        });
      }
      const response = await undo(
        userA,
        changed,
        adopted.operationReceipt.id,
        `p5c-undo-guard-${mutation}-${randomUUID()}`,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'UNDO_CONFLICT' },
      });
      const intent = await managed.client.userTimeIntent.findUnique({
        where: { id: scenario.intentId },
      });
      if (mutation === 'REMOVE') {
        expect(intent).toBeNull();
      } else {
        expect(intent).toMatchObject({
          durationSeconds: mutation === 'CHANGE' ? 2_400 : 2_700,
          locked: mutation === 'LOCK',
        });
      }
      expect(
        await managed.client.operationReceipt.count({
          where: { tripId: scenario.trip.id, operationType: 'ROUTE_UNDO' },
        }),
      ).toBe(0);
      await managed.client.trip.delete({ where: { id: scenario.trip.id } });
    }
  });

  it('serializes two adjusted adoptions at one Trip version', async () => {
    const scenario = await adjustableAdoption(userA, 'concurrent-adjustment');
    const [from, to] = scenario.trip.days[0]!.nodes;
    const secondPreview = await createPreview(
      userA,
      scenario.trip,
      from!.id,
      to!.id,
    );
    const responses = await Promise.all([
      adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-concurrent-adjustment-a-${randomUUID()}`,
        scenario.adjustments,
      ),
      adopt(
        userA,
        scenario.trip,
        secondPreview.previewId,
        `p5c-concurrent-adjustment-b-${randomUUID()}`,
        secondPreview.changeSummary.requiredUserAdjustments ?? [],
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: scenario.trip.id, operationType: 'ROUTE_ADOPT' },
      }),
    ).toBe(1);
    expect(
      await managed.client.userTimeIntent.findUniqueOrThrow({
        where: { id: scenario.intentId },
      }),
    ).toMatchObject({ durationSeconds: 2_700 });
    expect(
      await managed.client.trip.findUniqueOrThrow({
        where: { id: scenario.trip.id },
      }),
    ).toMatchObject({ version: scenario.trip.version + 1 });
  });

  it('canonically adopts, replays, and undoes two dwell adjustments whose UUID order opposes preview generation', async () => {
    let trip = await tripWithVisits(userA, [
      'Canonical from',
      'Canonical downstream',
      'Canonical final',
    ]);
    const [from, downstream, final] = trip.days[0]!.nodes;
    const arrivalResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(arrivalResponse.statusCode).toBe(200);
    trip = arrivalResponse.json() as TripView;
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3_000,
      locked: false,
    });
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: downstream!.id,
      durationSeconds: 2_400,
      locked: false,
    });
    const generatedOrder = [
      trip.days[0]!.nodes[0]!.timeIntents.find(
        (intent) => intent.kind === 'MIN_DWELL',
      )!.id,
      trip.days[0]!.nodes[1]!.timeIntents.find(
        (intent) => intent.kind === 'MIN_DWELL',
      )!.id,
    ];
    const highIntentId = 'f0000000-0000-4000-8000-000000000018';
    const lowIntentId = '10000000-0000-4000-8000-000000000019';
    await managed.client.$transaction([
      managed.client.userTimeIntent.update({
        where: { id: generatedOrder[0]! },
        data: { id: highIntentId },
      }),
      managed.client.userTimeIntent.update({
        where: { id: generatedOrder[1]! },
        data: { id: lowIntentId },
      }),
    ]);
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);
    trip = await command(userA, trip, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: downstream!.id,
      toNodeId: final!.id,
      mode: 'TAXI',
      fixedService: false,
      serviceLabel: 'SYNTHETIC selected downstream transport',
    });
    const selectedEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: {
        tripId: trip.id,
        fromNodeId: downstream!.id,
        toNodeId: final!.id,
      },
    });
    const departureResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'TRANSPORT', transportEdgeId: selectedEdge.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'DEPARTURE',
          instant: '2030-10-01T12:30:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(departureResponse.statusCode).toBe(200);
    trip = departureResponse.json() as TripView;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:45:00Z', '2030-10-01T12:00:00Z', 'UTC', 'UTC'),
      ],
    };

    const preview = await createPreview(userA, trip, from!.id, downstream!.id);
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toEqual([
      {
        intentId: lowIntentId,
        nodeId: downstream!.id,
        fromDurationSeconds: 2_400,
        toDurationSeconds: 1_800,
      },
      {
        intentId: highIntentId,
        nodeId: from!.id,
        fromDurationSeconds: 3_000,
        toDurationSeconds: 2_700,
      },
    ]);

    const adoptKey = `p5c-two-adjustments-${randomUUID()}`;
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      adoptKey,
      adjustments,
    );
    const replay = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      adoptKey,
      adjustments,
    );
    expect(replay.operationReceipt.id).toBe(adopted.operationReceipt.id);
    expect(replay.trip.version).toBe(adopted.trip.version);

    const undoKey = `p5c-two-adjustments-undo-${randomUUID()}`;
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      undoKey,
    );
    const undoReplay = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      undoKey,
    );
    expect(undoReplay.operationReceipt.id).toBe(undone.operationReceipt.id);
    expect(undoReplay.trip.version).toBe(undone.trip.version);
    expect(
      await managed.client.userTimeIntent.findMany({
        where: { id: { in: [lowIntentId, highIntentId] } },
        orderBy: { id: 'asc' },
        select: { id: true, durationSeconds: true },
      }),
    ).toEqual([
      { id: lowIntentId, durationSeconds: 2_400 },
      { id: highIntentId, durationSeconds: 3_000 },
    ]);
  });

  it('adopts a single leg atomically, archives the old transport, and replays one receipt', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: from!.id,
      toNodeId: to!.id,
      mode: 'TAXI',
      fixedService: false,
      serviceLabel: 'SYNTHETIC old taxi',
    });
    const oldEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: trip.id },
    });
    await managed.client.temporalValue.create({
      data: {
        transportEdgeId: oldEdge.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T09:30:00Z'),
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    });
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const beforeVersion = trip.version;
    const first = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-key-0001',
    );

    expect(first.statusCode).toBe(200);
    const adopted = first.json() as {
      operationReceipt: {
        id: string;
        resultingTripVersion: number;
        adoptedRouteId: string;
      };
      trip: TripView;
    };
    expect(adopted.operationReceipt.resultingTripVersion).toBe(
      beforeVersion + 1,
    );
    expect(adopted.trip.version).toBe(beforeVersion + 1);
    expect(adopted.trip.connections[0]).toMatchObject({
      state: 'ACTIVE',
      transport: {
        source: 'ADOPTED_ROUTE',
        provider: 'SYNTHETIC',
        adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
      },
    });

    const [
      edges,
      values,
      nodeValues,
      history,
      historyValues,
      receipts,
      outbox,
    ] = await Promise.all([
      managed.client.transportEdge.findMany({ where: { tripId: trip.id } }),
      managed.client.temporalValue.findMany({
        where: { transportEdge: { tripId: trip.id } },
        orderBy: { pointKind: 'asc' },
      }),
      managed.client.temporalValue.count({
        where: { node: { tripId: trip.id } },
      }),
      managed.client.transportEdgeHistory.findMany({
        where: { tripId: trip.id },
      }),
      managed.client.transportEdgeHistoryTimeValue.findMany({
        where: { history: { tripId: trip.id } },
      }),
      managed.client.operationReceipt.findMany({
        where: { tripId: trip.id },
      }),
      managed.client.outboxEvent.findMany({ where: { tripId: trip.id } }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: 'ADOPTED_ROUTE',
      adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
      provider: 'SYNTHETIC',
    });
    expect(values).toHaveLength(2);
    expect(values.every((value) => value.layer === 'PLANNED')).toBe(true);
    expect(
      values.every((value) => value.sourceKind === 'ADOPTED_TRANSPORT_FACT'),
    ).toBe(true);
    expect(values.some((value) => value.layer === 'ACTUAL')).toBe(false);
    expect(nodeValues).toBe(0);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      originalTransportEdgeId: oldEdge.id,
      invalidationReason: 'USER_REPLACED',
      source: 'MANUAL',
    });
    expect(historyValues).toHaveLength(1);
    expect(historyValues[0]).toMatchObject({
      layer: 'PLANNED',
      pointKind: 'DEPARTURE',
      sourceKind: 'USER_VALUE',
    });
    expect(receipts).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'ROUTE_ADOPTED',
      operationReceiptId: adopted.operationReceipt.id,
    });

    const replay = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-key-0001',
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: adopted.operationReceipt.id },
      trip: { version: beforeVersion + 1 },
    });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({ where: { tripId: trip.id } }),
    ).toBe(1);

    const conflict = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: beforeVersion + 1,
        idempotencyKey: 'synthetic-key-0001',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('replaces a single-leg adopted route and keeps idempotent replay lifecycle-neutral', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-single-route-1',
    );
    const route1Id = first.operationReceipt.adoptedRouteId;

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('single-route-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(
      secondPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(route1Id);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-single-route-2',
    );
    const route2Id = second.operationReceipt.adoptedRouteId;

    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: route1Id },
      }),
    ).toMatchObject({ status: 'REPLACED', replacedAt: currentNow });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: route2Id },
      }),
    ).toMatchObject({ status: 'ACTIVE', replacedAt: null });
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    expect(
      await managed.client.transportEdgeHistory.findMany({
        where: { tripId: initial.id, adoptedRouteId: route1Id },
      }),
    ).toEqual([
      expect.objectContaining({ invalidationReason: 'USER_REPLACED' }),
    ]);

    const replay = await adopt(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-single-route-2',
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: second.operationReceipt.id },
      trip: { version: second.trip.version },
    });
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('replaces a single-leg route with a multi-leg route and re-queries the new corridor', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-single-multi-1',
    );

    providerResult = transferCandidate();
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(
      secondPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(first.operationReceipt.adoptedRouteId);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-single-multi-2',
    );

    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: first.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'REPLACED' });
    expect(
      second.trip.days
        .flatMap((day) => day.nodes)
        .filter((node) => node.source === 'ROUTE_GENERATED'),
    ).toHaveLength(1);
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);

    const requery = await query(
      userA,
      second.trip,
      from!.id,
      to!.id,
      departHint(),
    );
    expect(requery.statusCode).toBe(200);
  });

  it('keeps one ACTIVE route through multi-leg to repeated single-leg replacements', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    providerResult = transferCandidate();
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-multi-single-1',
    );

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('multi-single-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(
      secondPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(first.operationReceipt.adoptedRouteId);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-multi-single-2',
    );

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('multi-single-3')],
    };
    const thirdPreview = await createPreview(
      userA,
      second.trip,
      from!.id,
      to!.id,
    );
    expect(
      thirdPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(second.operationReceipt.adoptedRouteId);
    const third = await adoptSuccessfully(
      userA,
      second.trip,
      thirdPreview.previewId,
      'synthetic-multi-single-3',
    );

    const routes = await managed.client.adoptedRoute.findMany({
      where: { tripId: initial.id },
    });
    expect(routes).toHaveLength(3);
    expect(routes.filter((route) => route.status === 'ACTIVE')).toEqual([
      expect.objectContaining({ id: third.operationReceipt.adoptedRouteId }),
    ]);
    expect(
      routes
        .filter((route) => route.status === 'REPLACED')
        .map((route) => route.id)
        .sort(),
    ).toEqual(
      [
        first.operationReceipt.adoptedRouteId,
        second.operationReceipt.adoptedRouteId,
      ].sort(),
    );
    expect(
      await managed.client.transportEdgeHistory.count({
        where: {
          tripId: initial.id,
          invalidationReason: 'USER_REPLACED',
          adoptedRouteId: {
            in: [
              first.operationReceipt.adoptedRouteId,
              second.operationReceipt.adoptedRouteId,
            ],
          },
        },
      }),
    ).toBe(3);
  });

  it('undoes an adoption as a new versioned transaction and replays one receipt', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: from!.id,
      toNodeId: to!.id,
      mode: 'TAXI',
      fixedService: false,
      serviceLabel: 'SYNTHETIC pre-adoption taxi',
    });
    const oldEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: trip.id },
    });
    await managed.client.temporalValue.create({
      data: {
        transportEdgeId: oldEdge.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T09:30:00Z'),
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    });
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-undo-adopt-01',
    );
    const adoptReceipt =
      await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.id },
      });
    expect(adoptReceipt).toMatchObject({
      operationType: 'ROUTE_ADOPT',
      targetOperationReceiptId: null,
      undoExpiresAt: new Date(NOW.getTime() + 600_000),
      delta: expect.objectContaining({ schemaVersion: 'route-adopt-delta-v3' }),
    });

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adoptReceipt.id,
      'synthetic-undo-request-01',
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
    expect(undone.trip.connections[0]).toMatchObject({
      state: 'ACTIVE',
      transport: {
        id: oldEdge.id,
        source: 'MANUAL',
        serviceLabel: 'SYNTHETIC pre-adoption taxi',
      },
    });
    expect(undone.operationReceipt).toMatchObject({
      operationType: 'ROUTE_UNDO',
      targetOperationReceiptId: adoptReceipt.id,
      baseTripVersion: adopted.trip.version,
      resultingTripVersion: adopted.trip.version + 1,
      delta: expect.objectContaining({ schemaVersion: 'route-undo-delta-v2' }),
    });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'UNDONE', undoneAt: currentNow });
    expect(
      await managed.client.temporalValue.findMany({
        where: { transportEdgeId: oldEdge.id },
      }),
    ).toEqual([
      expect.objectContaining({
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        sourceKind: 'USER_VALUE',
      }),
    ]);
    expect(
      await managed.client.transportEdgeHistory.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.operationReceipt.findMany({
        where: { tripId: trip.id },
        orderBy: { createdAt: 'asc' },
      }),
    ).toHaveLength(2);
    expect(
      await managed.client.outboxEvent.findMany({
        where: { tripId: trip.id },
        orderBy: { type: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({ type: 'ROUTE_ADOPTED' }),
      expect.objectContaining({ type: 'ROUTE_UNDONE' }),
    ]);

    const replay = await undo(
      userA,
      adopted.trip,
      adoptReceipt.id,
      'synthetic-undo-request-01',
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: undone.operationReceipt.id },
      trip: { version: adopted.trip.version + 1 },
    });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({
        where: { tripId: trip.id, type: 'ROUTE_UNDONE' },
      }),
    ).toBe(1);
  });

  it('restores a missing connection and rejects reuse of an Undo idempotency key', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-empty-adopt',
    );
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      'synthetic-empty-undo',
    );
    expect(undone.trip.connections[0]).toMatchObject({
      state: 'MISSING',
      transport: null,
    });

    const conflict = await undo(
      userA,
      { ...adopted.trip, version: adopted.trip.version + 1 },
      adopted.operationReceipt.id,
      'synthetic-empty-undo',
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('undoes single-to-single and single-to-multi replacements with one active route', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-undo-lifecycle-1',
    );
    const originalEdgeId = first.trip.connections[0]!.transport!.id;

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('undo-lifecycle-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-undo-lifecycle-2',
    );
    const staleFirstUndo = await undo(
      userA,
      second.trip,
      first.operationReceipt.id,
      'synthetic-undo-stale-first',
    );
    expect(staleFirstUndo.statusCode).toBe(409);
    expect(staleFirstUndo.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    const restoredSingle = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-undo-lifecycle-2-request',
    );
    expect(restoredSingle.trip.connections[0]!.transport!.id).toBe(
      originalEdgeId,
    );
    const adoptedRoutes = await managed.client.adoptedRoute.findMany({
      where: { tripId: initial.id },
    });
    expect(adoptedRoutes).toHaveLength(2);
    expect(adoptedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.operationReceipt.adoptedRouteId,
          status: 'ACTIVE',
          replacedAt: null,
        }),
        expect.objectContaining({
          id: second.operationReceipt.adoptedRouteId,
          status: 'UNDONE',
        }),
      ]),
    );

    providerResult = transferCandidate();
    const multiPreview = await createPreview(
      userA,
      restoredSingle.trip,
      from!.id,
      to!.id,
    );
    const multi = await adoptSuccessfully(
      userA,
      restoredSingle.trip,
      multiPreview.previewId,
      'synthetic-undo-lifecycle-3',
    );
    const generated = multi.trip.days
      .flatMap((day) => day.nodes)
      .find((node) => node.source === 'ROUTE_GENERATED')!;
    const generatedPlaceId = generated.place!.id;
    const restoredAgain = await undoSuccessfully(
      userA,
      multi.trip,
      multi.operationReceipt.id,
      'synthetic-undo-lifecycle-3-request',
    );
    expect(
      restoredAgain.trip.days
        .flatMap((day) => day.nodes)
        .some((node) => node.id === generated.id),
    ).toBe(false);
    expect(
      await managed.client.place.findUnique({
        where: { id: generatedPlaceId },
      }),
    ).toBeNull();
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('restores a multi-leg corridor with original generated identity after single-leg replacement', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    providerResult = transferCandidate();
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-undo-multi-1',
    );
    const generatedBefore = await managed.client.itineraryNode.findFirstOrThrow(
      {
        where: { tripId: initial.id, source: 'ROUTE_GENERATED' },
      },
    );

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('undo-multi-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-undo-multi-2',
    );
    expect(
      await managed.client.itineraryNode.findUnique({
        where: { id: generatedBefore.id },
      }),
    ).toBeNull();

    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-undo-multi-2-request',
    );
    const generatedAfter = await managed.client.itineraryNode.findUniqueOrThrow(
      {
        where: { id: generatedBefore.id },
      },
    );
    expect(generatedAfter).toMatchObject({
      id: generatedBefore.id,
      dayOccurrenceId: generatedBefore.dayOccurrenceId,
      position: generatedBefore.position,
      adoptedRouteId: first.operationReceipt.adoptedRouteId,
      sourceOperationId: generatedBefore.sourceOperationId,
      providerPlaceRef: generatedBefore.providerPlaceRef,
    });
    expect(undone.trip.connections).toHaveLength(2);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: first.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE', replacedAt: null });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: second.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'UNDONE' });
  });

  it('restores a reused generated node route identity after another multi-leg adoption', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    providerResult = transferCandidate();
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-undo-reuse-1',
    );
    const generatedBefore = await managed.client.itineraryNode.findFirstOrThrow(
      {
        where: { tripId: initial.id, source: 'ROUTE_GENERATED' },
      },
    );

    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(secondPreview.changeSummary.nodesToReuse).toEqual([
      expect.objectContaining({ nodeId: generatedBefore.id, action: 'REUSE' }),
    ]);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-undo-reuse-2',
    );
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: generatedBefore.id },
      }),
    ).toMatchObject({
      adoptedRouteId: second.operationReceipt.adoptedRouteId,
      sourceOperationId: second.operationReceipt.id,
    });

    await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-undo-reuse-request',
    );
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: generatedBefore.id },
      }),
    ).toMatchObject({
      id: generatedBefore.id,
      dayOccurrenceId: generatedBefore.dayOccurrenceId,
      position: generatedBefore.position,
      adoptedRouteId: generatedBefore.adoptedRouteId,
      sourceOperationId: generatedBefore.sourceOperationId,
      providerPlaceRef: generatedBefore.providerPlaceRef,
    });
  });

  it('restores repeated-date occurrence sequence, ownership, and effective range exactly', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'First occurrence', '2030-10-01');
    trip = await command(userA, trip, {
      type: 'ADD_PLACE_VISIT',
      targetDay: { type: 'NEW', localDate: '2030-10-01', sequence: 1 },
      position: 0,
      place: {
        type: 'CUSTOM',
        name: 'Repeated occurrence',
        latitude: 34.0522,
        longitude: -118.2437,
      },
    });
    const beforeDays = trip.days.map((day) => ({
      id: day.dayOccurrenceId,
      localDate: day.localDate,
      sequence: day.sequence,
    }));
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    providerResult = dateRollbackTransferCandidate();
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-undo-occurrence-adopt',
    );
    expect(adopted.trip.days.map((day) => day.localDate)).toEqual([
      '2030-10-01',
      '2030-10-02',
      '2030-10-01',
    ]);
    expect(
      await managed.client.dateOwnership.findMany({
        where: { tripId: trip.id },
      }),
    ).toHaveLength(2);

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      'synthetic-undo-occurrence-request',
    );
    expect(
      undone.trip.days.map((day) => ({
        id: day.dayOccurrenceId,
        localDate: day.localDate,
        sequence: day.sequence,
      })),
    ).toEqual(beforeDays);
    expect(
      await managed.client.dateOwnership.findMany({
        where: { tripId: trip.id },
      }),
    ).toEqual([
      expect.objectContaining({ localDate: new Date('2030-10-01T00:00:00Z') }),
    ]);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({
      effectiveStartDate: new Date('2030-10-01T00:00:00Z'),
      effectiveEndDate: new Date('2030-10-01T00:00:00Z'),
    });
  });

  it('protects target-created generated nodes with ACTUAL or new user content', async () => {
    const actualTrip = await tripWithVisits(userA, [
      'Actual From',
      'Actual To',
    ]);
    const [actualFrom, actualTo] = actualTrip.days[0]!.nodes;
    providerResult = transferCandidate();
    const actualPreview = await createPreview(
      userA,
      actualTrip,
      actualFrom!.id,
      actualTo!.id,
    );
    const actualAdopt = await adoptSuccessfully(
      userA,
      actualTrip,
      actualPreview.previewId,
      'synthetic-node-actual-adopt',
    );
    const actualNode = await managed.client.itineraryNode.findFirstOrThrow({
      where: { tripId: actualTrip.id, source: 'ROUTE_GENERATED' },
    });
    await managed.client.temporalValue.create({
      data: {
        nodeId: actualNode.id,
        layer: 'ACTUAL',
        pointKind: 'ARRIVAL',
        instant: new Date('2030-10-01T10:30:00Z'),
        timeZone: 'UTC',
        sourceKind: 'PROVIDER_OBSERVATION',
      },
    });
    const actualRejected = await undo(
      userA,
      actualAdopt.trip,
      actualAdopt.operationReceipt.id,
      'synthetic-node-actual-undo',
    );
    expect(actualRejected.statusCode).toBe(409);
    expect(actualRejected.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.itineraryNode.findUnique({
        where: { id: actualNode.id },
      }),
    ).not.toBeNull();

    const noteTrip = await tripWithVisits(userB, ['Note From', 'Note To']);
    const [noteFrom, noteTo] = noteTrip.days[0]!.nodes;
    const notePreview = await createPreview(
      userB,
      noteTrip,
      noteFrom!.id,
      noteTo!.id,
    );
    const noteAdopt = await adoptSuccessfully(
      userB,
      noteTrip,
      notePreview.previewId,
      'synthetic-node-note-adopt',
    );
    const noteNode = await managed.client.itineraryNode.findFirstOrThrow({
      where: { tripId: noteTrip.id, source: 'ROUTE_GENERATED' },
    });
    await managed.client.itineraryNode.update({
      where: { id: noteNode.id },
      data: { note: 'User-kept fact', userModifiedAt: currentNow },
    });
    const noteRejected = await undo(
      userB,
      noteAdopt.trip,
      noteAdopt.operationReceipt.id,
      'synthetic-node-note-undo',
    );
    expect(noteRejected.statusCode).toBe(409);
    expect(noteRejected.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: noteNode.id },
      }),
    ).toMatchObject({ note: 'User-kept fact' });
  });

  it('rejects unsafe, expired, legacy, and post-version Undo attempts without partial changes', async () => {
    const actualTrip = await tripWithVisits(userA, [
      'Actual From',
      'Actual To',
    ]);
    const [actualFrom, actualTo] = actualTrip.days[0]!.nodes;
    const actualPreview = await createPreview(
      userA,
      actualTrip,
      actualFrom!.id,
      actualTo!.id,
    );
    const actualAdopt = await adoptSuccessfully(
      userA,
      actualTrip,
      actualPreview.previewId,
      'synthetic-unsafe-adopt',
    );
    const activeEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: actualTrip.id },
    });
    await managed.client.temporalValue.create({
      data: {
        transportEdgeId: activeEdge.id,
        layer: 'ACTUAL',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T10:01:00Z'),
        timeZone: 'UTC',
        sourceKind: 'PROVIDER_OBSERVATION',
      },
    });
    const actualRejected = await undo(
      userA,
      actualAdopt.trip,
      actualAdopt.operationReceipt.id,
      'synthetic-unsafe-undo',
    );
    expect(actualRejected.statusCode).toBe(409);
    expect(actualRejected.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: actualAdopt.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: actualTrip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(0);

    const expiredTrip = await tripWithVisitsOnDate(
      userA,
      ['Expired From', 'Expired To'],
      '2030-10-02',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-02')],
    };
    const [expiredFrom, expiredTo] = expiredTrip.days[0]!.nodes;
    const expiredPreview = await createPreview(
      userA,
      expiredTrip,
      expiredFrom!.id,
      expiredTo!.id,
    );
    const expiredAdopt = await adoptSuccessfully(
      userA,
      expiredTrip,
      expiredPreview.previewId,
      'synthetic-expired-adopt',
    );
    currentNow = new Date(NOW.getTime() + 600_000);
    const expired = await undo(
      userA,
      expiredAdopt.trip,
      expiredAdopt.operationReceipt.id,
      'synthetic-expired-undo',
    );
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({ error: { code: 'UNDO_EXPIRED' } });

    currentNow = NOW;
    const legacyTrip = await tripWithVisitsOnDate(
      userA,
      ['Legacy From', 'Legacy To'],
      '2030-10-03',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-03')],
    };
    const [legacyFrom, legacyTo] = legacyTrip.days[0]!.nodes;
    const legacyPreview = await createPreview(
      userA,
      legacyTrip,
      legacyFrom!.id,
      legacyTo!.id,
    );
    const legacyAdopt = await adoptSuccessfully(
      userA,
      legacyTrip,
      legacyPreview.previewId,
      'synthetic-legacy-adopt',
    );
    await managed.client.operationReceipt.update({
      where: { id: legacyAdopt.operationReceipt.id },
      data: { undoExpiresAt: null },
    });
    const legacy = await undo(
      userA,
      legacyAdopt.trip,
      legacyAdopt.operationReceipt.id,
      'synthetic-legacy-undo',
    );
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({
      error: { code: 'UNDO_UNAVAILABLE' },
    });

    const changedTrip = await tripWithVisitsOnDate(
      userA,
      ['Changed From', 'Changed To'],
      '2030-10-04',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-04')],
    };
    const [changedFrom, changedTo] = changedTrip.days[0]!.nodes;
    const changedPreview = await createPreview(
      userA,
      changedTrip,
      changedFrom!.id,
      changedTo!.id,
    );
    const changedAdopt = await adoptSuccessfully(
      userA,
      changedTrip,
      changedPreview.previewId,
      'synthetic-changed-adopt',
    );
    await managed.client.trip.update({
      where: { id: changedTrip.id },
      data: { version: { increment: 1 } },
    });
    const changed = await undo(
      userA,
      changedAdopt.trip,
      changedAdopt.operationReceipt.id,
      'synthetic-changed-undo',
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
  });

  it('serializes concurrent Undo and rolls back when a prior owned date is no longer available', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const preview = await createPreview(userA, initial, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      initial,
      preview.previewId,
      'synthetic-concurrent-undo-adopt',
    );
    const concurrent = await Promise.all([
      undo(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        'synthetic-concurrent-undo-a',
      ),
      undo(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        'synthetic-concurrent-undo-b',
      ),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: initial.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({
        where: { tripId: initial.id, type: 'ROUTE_UNDONE' },
      }),
    ).toBe(1);

    const conflictTrip = await tripWithVisitsOnDate(
      userA,
      ['Conflict From', 'Conflict To'],
      '2030-10-02',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-02')],
    };
    const [conflictFrom, conflictTo] = conflictTrip.days[0]!.nodes;
    const conflictPreview = await createPreview(
      userA,
      conflictTrip,
      conflictFrom!.id,
      conflictTo!.id,
    );
    const conflictAdopt = await adoptSuccessfully(
      userA,
      conflictTrip,
      conflictPreview.previewId,
      'synthetic-date-conflict-adopt',
    );
    const otherTrip = await createTrip(userA);
    await managed.client.dateOwnership.deleteMany({
      where: { tripId: conflictTrip.id },
    });
    await managed.client.dateOwnership.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: otherTrip.id,
        localDate: new Date('2030-10-02T00:00:00.000Z'),
      },
    });
    const routeBefore = await managed.client.adoptedRoute.findUniqueOrThrow({
      where: { id: conflictAdopt.operationReceipt.adoptedRouteId },
    });
    const edgeBefore = await managed.client.transportEdge.findMany({
      where: { tripId: conflictTrip.id },
    });
    const conflict = await undo(
      userA,
      conflictAdopt.trip,
      conflictAdopt.operationReceipt.id,
      'synthetic-date-conflict-undo',
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: conflictAdopt.operationReceipt.adoptedRouteId },
      }),
    ).toEqual(routeBefore);
    expect(
      await managed.client.transportEdge.findMany({
        where: { tripId: conflictTrip.id },
      }),
    ).toEqual(edgeBefore);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: conflictTrip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(0);
  });

  it('rolls back prior route lifecycle when a later adoption fails mid-transaction', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-adopt-rollback-1',
    );

    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    const stored = await managed.client.routePreview.findUniqueOrThrow({
      where: { id: secondPreview.previewId },
    });
    const originalPayload =
      stored.previewPayload as unknown as StoredRoutePreviewPayload;
    const invalidPayload: StoredRoutePreviewPayload = {
      ...originalPayload,
      changeSummary: {
        ...originalPayload.changeSummary,
        proposedSegments: originalPayload.changeSummary.proposedSegments.map(
          (segment, index) =>
            index === 0 ? { ...segment, fromRef: 'UNKNOWN_REF' } : segment,
        ),
      },
    };
    await managed.client.routePreview.update({
      where: { id: secondPreview.previewId },
      data: {
        previewPayload: invalidPayload as never,
        previewHash: hashRoutePreviewPayload(invalidPayload),
      },
    });
    const rejected = await adopt(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-adopt-rollback-2',
    );
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { code: 'PREVIEW_STALE' },
    });
    expect(
      await managed.client.adoptedRoute.findMany({
        where: { tripId: initial.id },
      }),
    ).toEqual([
      expect.objectContaining({
        id: first.operationReceipt.adoptedRouteId,
        status: 'ACTIVE',
        replacedAt: null,
      }),
    ]);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: initial.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({ where: { tripId: initial.id } }),
    ).toBe(1);
    expect(
      await managed.client.itineraryNode.count({
        where: { tripId: initial.id, source: 'ROUTE_GENERATED' },
      }),
    ).toBe(0);
    expect(
      await managed.client.trip.findUniqueOrThrow({
        where: { id: initial.id },
      }),
    ).toMatchObject({ version: first.trip.version });
  });

  it('allows only one concurrent adoption for two previews at the same Trip version', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    const [left, right] = await Promise.all([
      createPreview(userA, trip, from!.id, to!.id),
      createPreview(userA, trip, from!.id, to!.id),
    ]);

    const responses = await Promise.all([
      adopt(userA, trip, left.previewId, 'synthetic-concurrent-a'),
      adopt(userA, trip, right.previewId, 'synthetic-concurrent-b'),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)!.json(),
    ).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.adoptedRoute.count({ where: { tripId: trip.id } }),
    ).toBe(1);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: trip.version + 1 });
  });

  it('creates one generated transfer node for a multi-leg route and keeps ordinary walking formal', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    providerResult = transferCandidate();
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    expect(preview).toMatchObject({
      policyVersion: 'route-adoption-preview-v3',
      status: 'ACTIVE',
      adoptable: true,
      changeSummary: {
        nodesToCreate: [{ providerPlaceRef: 'transfer-station' }],
        proposedSegments: [{ mode: 'RAIL' }, { mode: 'WALKING' }],
      },
    });

    const response = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-transfer-01',
    );
    expect(response.statusCode).toBe(200);
    const adopted = response.json() as { trip: TripView };
    const generated = adopted.trip.days
      .flatMap((day) => day.nodes)
      .filter((node) => node.source === 'ROUTE_GENERATED');
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      provider: 'SYNTHETIC',
      providerPlaceRef: 'transfer-station',
      autoReplaceable: true,
    });
    expect(adopted.trip.connections).toHaveLength(2);
    expect(
      adopted.trip.connections.map((connection) => connection.transport?.mode),
    ).toEqual(['RAIL', 'WALKING']);
    expect(
      await managed.client.transportEdge.count({ where: { tripId: trip.id } }),
    ).toBe(2);
    const requery = await query(
      userA,
      adopted.trip,
      from!.id,
      to!.id,
      departHint(),
    );
    expect(requery.statusCode).toBe(200);
  });

  it('projects one cross-day edge across START/OCCUPIED/END and rejects ordinary content in the occupied day', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'Day 1', '2030-10-01');
    trip = await addVisit(userA, trip, 'Day 3', '2030-10-03');
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T20:00:00Z', '2030-10-03T08:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const response = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-cross-day',
    );
    expect(response.statusCode).toBe(200);
    const adopted = response.json() as { trip: TripView };
    const projections = adopted.trip.days.map((day) => ({
      localDate: day.localDate,
      projections: day.transportProjections,
    }));
    expect(projections.map((item) => item.localDate)).toEqual([
      '2030-10-01',
      '2030-10-02',
      '2030-10-03',
    ]);
    expect(projections.map((item) => item.projections[0]?.role)).toEqual([
      'START',
      'OCCUPIED',
      'END',
    ]);
    expect(
      new Set(
        projections.flatMap((item) =>
          item.projections.map((projection) => projection.transportEdgeId),
        ),
      ).size,
    ).toBe(1);

    let editableTrip = await command(userA, adopted.trip, {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: adopted.trip.days[0]!.dayOccurrenceId,
      },
      position: 0,
      note: 'SYNTHETIC start-day content',
    });
    editableTrip = await command(userA, editableTrip, {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: editableTrip.days[2]!.dayOccurrenceId,
      },
      position: 1,
      note: 'SYNTHETIC end-day content',
    });
    const occupied = editableTrip.days[1]!;
    const rejected = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/commands`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: editableTrip.version,
        command: {
          type: 'ADD_FREE_ACTION',
          targetDay: {
            type: 'EXISTING',
            dayOccurrenceId: occupied.dayOccurrenceId,
          },
          position: 0,
          note: 'SYNTHETIC overlap attempt',
        },
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { code: 'TRANSPORT_OCCUPIED_DAY' },
    });
    expect(
      await managed.client.dateOwnership.count({ where: { tripId: trip.id } }),
    ).toBe(3);
  });

  async function adjustableAdoption(
    identity: SyntheticIdentity,
    label: string,
  ): Promise<{
    trip: TripView;
    preview: RoutePreviewView;
    intentId: string;
    adjustments: NonNullable<
      RoutePreviewView['changeSummary']['requiredUserAdjustments']
    >;
  }> {
    let trip = await tripWithVisits(identity, [
      `SYNTHETIC ${label} from`,
      `SYNTHETIC ${label} to`,
    ]);
    const [from, to] = trip.days[0]!.nodes;
    const temporal = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(identity),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(temporal.statusCode).toBe(200);
    trip = temporal.json() as TripView;
    trip = await command(identity, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3_000,
      locked: false,
    });
    const intentId = trip.days[0]!.nodes[0]!.timeIntents.find(
      (intent) => intent.kind === 'MIN_DWELL',
    )!.id;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:45:00Z', '2030-10-01T11:45:00Z', 'UTC', 'UTC'),
      ],
    };
    const preview = await createPreview(identity, trip, from!.id, to!.id);
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toEqual([
      expect.objectContaining({
        intentId,
        nodeId: from!.id,
        fromDurationSeconds: 3_000,
        toDurationSeconds: 2_700,
      }),
    ]);
    return { trip, preview, intentId, adjustments };
  }

  async function expectAdjustmentRollback(
    trip: TripView,
    intentId: string,
    durationSeconds: number,
  ): Promise<void> {
    expect(
      await managed.client.userTimeIntent.findUniqueOrThrow({
        where: { id: intentId },
      }),
    ).toMatchObject({ durationSeconds });
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: trip.version });
    expect(
      await managed.client.adoptedRoute.count({ where: { tripId: trip.id } }),
    ).toBe(0);
    expect(
      await managed.client.transportEdge.count({ where: { tripId: trip.id } }),
    ).toBe(0);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.outboxEvent.count({ where: { tripId: trip.id } }),
    ).toBe(0);
  }

  async function createTrip(identity: SyntheticIdentity): Promise<TripView> {
    const response = await app.inject({
      method: 'POST',
      url: '/trips',
      headers: bearer(identity),
      payload: {
        name: `SYNTHETIC P4A1 ${randomUUID()}`,
        planningAnchorDate: '2030-10-01',
        defaultPeopleCount: 1,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as TripView;
  }

  for (const mode of ['RAIL', 'BUS'] as const) {
    for (const layer of ['ESTIMATED', 'ACTUAL'] as const) {
      it(`P6A-1 second review R3: ${mode} ${layer} retains exact saved-leg identity and current provider facts`, async () => {
        const f = await adoptedFixedGroundTrip(
          {
            now: '2030-10-01T13:50:00Z',
            departure: '2030-10-01T14:00:00Z',
            arrival: '2030-10-01T15:00:00Z',
          },
          mode,
        );
        const route = await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: f.adopted.operationReceipt.adoptedRouteId },
        });
        const oldPreview = await managed.client.routePreview.findUniqueOrThrow({
          where: { id: route.sourcePreviewId },
        });
        const oldSnapshot =
          await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
            where: { id: route.candidateSnapshotId },
          });
        const beforeCounts = await Promise.all([
          managed.client.routeCandidateSnapshot.count({
            where: { tripId: f.trip.id },
          }),
          managed.client.routePreview.count({ where: { tripId: f.trip.id } }),
          managed.client.operationReceipt.count({
            where: { tripId: f.trip.id },
          }),
          managed.client.executionEvent.count({ where: { tripId: f.trip.id } }),
        ]);
        currentNow = new Date('2030-10-01T14:25:00Z');
        await app.close();
        const base = new SyntheticGroundTransitProvider(
          'FIXED_DELAY',
          () => currentNow,
        );
        app = buildTestApi(
          new SyntheticRouteProvider(async () => {
            throw new Error('reading selected transport must not query routes');
          }),
          {
            name: 'SYNTHETIC',
            async fetchObservation(input) {
              const result = await base.fetchObservation(input);
              if (result.status !== 'SUCCESS') return result;
              return {
                ...result,
                observation: {
                  ...result.observation,
                  estimatedDeparture:
                    layer === 'ESTIMATED'
                      ? new Date('2030-10-01T14:20:00Z')
                      : null,
                  actualDeparture:
                    layer === 'ACTUAL'
                      ? new Date('2030-10-01T14:20:00Z')
                      : null,
                },
              };
            },
          },
        );
        const refreshed = await app.inject({
          method: 'POST',
          url: `/trips/${f.trip.id}/execution/ground-transit/${f.leg.transportEdgeId}/refresh`,
          headers: bearer(userA),
        });
        expect(refreshed.statusCode, refreshed.body).toBe(200);
        const reopened = await app.inject({
          method: 'GET',
          url: `/trips/${f.trip.id}`,
          headers: bearer(userA),
        });
        expect(reopened.statusCode).toBe(200);
        const view = reopened.json<TripView>();
        expect(view.savedRoutes?.[0]).toMatchObject({
          legTransportEdges: [
            { legIndex: 0, transportEdgeId: f.leg.transportEdgeId },
          ],
        });
        expect(view.savedRoutes?.[0]?.legs[0]?.departure?.instant).toBe(
          '2030-10-01T14:00:00.000Z',
        );
        expect(view.connections[0]?.transport?.timeValues).toContainEqual(
          expect.objectContaining({
            layer,
            pointKind: 'DEPARTURE',
            sourceKind: 'PROVIDER_OBSERVATION',
            instant: '2030-10-01T14:20:00.000Z',
          }),
        );
        expect(
          await managed.client.routePreview.findUniqueOrThrow({
            where: { id: route.sourcePreviewId },
          }),
        ).toEqual(oldPreview);
        expect(
          await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
            where: { id: route.candidateSnapshotId },
          }),
        ).toEqual(oldSnapshot);
        expect(
          await Promise.all([
            managed.client.routeCandidateSnapshot.count({
              where: { tripId: f.trip.id },
            }),
            managed.client.routePreview.count({ where: { tripId: f.trip.id } }),
            managed.client.operationReceipt.count({
              where: { tripId: f.trip.id },
            }),
            managed.client.executionEvent.count({
              where: { tripId: f.trip.id },
            }),
          ]),
        ).toEqual(beforeCounts);
        // Lost adoption provenance cannot be reconstructed by edge order/name/time.
        await managed.client.temporalValue.updateMany({
          where: { transportEdgeId: f.leg.transportEdgeId, layer: 'PLANNED' },
          data: { sourceRef: 'SYNTHETIC:unmatched' },
        });
        const unmatched = await app.inject({
          method: 'GET',
          url: `/trips/${f.trip.id}`,
          headers: bearer(userA),
        });
        expect(unmatched.json().savedRoutes[0].legTransportEdges).toEqual([]);
        expect(unmatched.json().savedRoutes[0].legs).toEqual(
          view.savedRoutes![0]!.legs,
        );
      });
    }
  }

  it('P6A-1 repair: old 15:00 selected service is not an independent departure constraint', async () => {
    let trip = await tripWithVisits(userA, [
      'SYNTHETIC Hotel',
      'SYNTHETIC Destination',
    ]);
    const [from, to] = trip.days[0]!.nodes;
    const arrival = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T13:00:00Z',
          timeZone: 'UTC',
        },
      },
    });
    expect(arrival.statusCode).toBe(200);
    trip = arrival.json();
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3600,
      locked: true,
    });
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T15:00:00Z', '2030-10-01T16:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const firstPreview = await createPreview(userA, trip, from!.id, to!.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T15:00:00Z',
      timeZone: 'UTC',
    });
    const first = await adoptSuccessfully(
      userA,
      trip,
      firstPreview.previewId,
      `p6a-old-${randomUUID()}`,
    );
    trip = first.trip;
    const projection = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/schedule/evaluate`,
      headers: bearer(userA),
      payload: { basisVersion: trip.version },
    });
    const origin = projection
      .json()
      .nodes.find((n: { nodeId: string }) => n.nodeId === from!.id);
    expect(origin.departure.effective.value.instant).toBe(
      '2030-10-01T15:00:00.000Z',
    );
    expect(origin.departure.requirementWindow.earliest).toBe(
      '2030-10-01T15:00:00.000Z',
    );
    expect(
      origin.departure.requirementWindow.earliestBasis.some(
        (b: { ruleId: string }) => b.ruleId === 'FIXED_TRANSPORT_PLANNED',
      ),
    ).toBe(true);
    const queryTime = async (time: string) => {
      providerResult = {
        status: 'SUCCESS',
        candidates: [
          candidate(
            `2030-10-01T${time}:00Z`,
            '2030-10-01T16:00:00Z',
            'UTC',
            'UTC',
          ),
        ],
      };
      return query(userA, trip, from!.id, to!.id, {
        type: 'DEPART_AT',
        instant: `2030-10-01T${time}:00Z`,
        timeZone: 'UTC',
      });
    };
    const beforeCount = await managed.client.routeCandidateSnapshot.count({
      where: { tripId: trip.id },
    });
    const impossible = await queryTime('10:45');
    expect(impossible.json()).toMatchObject({
      error: { code: 'NO_MATCHING_CANDIDATE' },
    });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(beforeCount);
    const tooShort = await queryTime('13:45');
    expect(tooShort.statusCode).toBe(200);
    const shortPreview = await previewFromSnapshot(
      userA,
      trip,
      tooShort.json().candidates[0].candidateSnapshotId,
    );
    expect(
      (
        await adopt(
          userA,
          trip,
          shortPreview.previewId,
          `p6a-shorten-${randomUUID()}`,
        )
      ).json(),
    ).toMatchObject({ error: { code: 'USER_ADJUSTMENT_REQUIRED' } });
    const earlier = await queryTime('14:15');
    expect(earlier.statusCode).toBe(200);
    expect(earlier.json().timeCondition.hardEarliestDeparture).not.toBe(
      '2030-10-01T15:00:00.000Z',
    );
    const replacement = await previewFromSnapshot(
      userA,
      trip,
      earlier.json().candidates[0].candidateSnapshotId,
    );
    expect(replacement.adoptable).toBe(true);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      replacement.previewId,
      `p6a-earlier-${randomUUID()}`,
    );
    expect(
      adopted.trip.connections[0]!.transport!.timeValues.find(
        (v) => v.pointKind === 'DEPARTURE',
      )!.instant,
    ).toBe('2030-10-01T14:15:00.000Z');
    expect(adopted.trip.savedRoutes?.[0]?.legs[0]?.from).toEqual(
      replacement.candidate.legs[0]!.from,
    );
    const callsBeforeRead = providerInputs.length;
    const reopened = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}`,
      headers: bearer(userA),
    });
    expect(reopened.json().savedRoutes[0].legs).toEqual(
      replacement.candidate.legs,
    );
    expect(providerInputs).toHaveLength(callsBeforeRead);
  });
  for (const operator of ['NOT_BEFORE', 'EXACT'] as const) {
    it(`P6A-1 repair: independent protected ${operator} 15:00 still prevents 14:15`, async () => {
      let trip = await tripWithVisits(userA, ['SYNTHETIC A', 'SYNTHETIC D']);
      const [from, to] = trip.days[0]!.nodes;
      trip = await command(userA, trip, {
        type: 'SET_TIME_INTENT',
        nodeId: from!.id,
        pointKind: 'DEPARTURE',
        operator,
        instant: '2030-10-01T15:00:00Z',
        timeZone: 'UTC',
        locked: true,
      });
      providerResult = {
        status: 'SUCCESS',
        candidates: [
          candidate(
            '2030-10-01T14:15:00Z',
            '2030-10-01T16:00:00Z',
            'UTC',
            'UTC',
          ),
        ],
      };
      const before = await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      });
      const result = await query(userA, trip, from!.id, to!.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T14:15:00Z',
        timeZone: 'UTC',
      });
      expect(result.json()).toMatchObject({
        error: { code: 'NO_MATCHING_CANDIDATE' },
      });
      expect(
        await managed.client.routeCandidateSnapshot.count({
          where: { tripId: trip.id },
        }),
      ).toBe(before);
    });
  }
  it('P6A-1: hotel arrival and dwell fence impossible routes, protected dwell adoption and edited versions', async () => {
    let trip = await tripWithVisits(userA, [
      'SYNTHETIC Hotel',
      'SYNTHETIC Station',
    ]);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const temporal = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T13:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(temporal.statusCode).toBe(200);
    trip = temporal.json() as TripView;
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3600,
      locked: true,
    });
    const count = await managed.client.routeCandidateSnapshot.count({
      where: { tripId: trip.id },
    });
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:45:00Z', '2030-10-01T12:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const impossible = await query(userA, trip, from!.id, to!.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:45:00Z',
      timeZone: 'UTC',
    });
    expect(impossible.json()).toMatchObject({
      error: { code: 'NO_MATCHING_CANDIDATE' },
    });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(count);
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T13:45:00Z', '2030-10-01T15:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const shortened = await query(userA, trip, from!.id, to!.id, null);
    expect(shortened.statusCode).toBe(200);
    const shortenedPreview = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: shortened.json().candidates[0].candidateSnapshotId,
      },
    });
    expect(shortenedPreview.statusCode).toBe(201);
    const unaccepted = await adopt(
      userA,
      trip,
      shortenedPreview.json().previewId,
      `p6a-dwell-${randomUUID()}`,
    );
    expect(unaccepted.json()).toMatchObject({
      error: { code: 'USER_ADJUSTMENT_REQUIRED' },
    });
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T14:00:00Z', '2030-10-01T15:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const valid = await query(userA, trip, from!.id, to!.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T14:00:00Z',
      timeZone: 'UTC',
    });
    expect(valid.statusCode).toBe(200);
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: valid.json().candidates[0].candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const oldVersion = trip.version;
    trip = await command(userA, trip, {
      type: 'SET_NODE_NOTE',
      nodeId: from!.id,
      note: 'SYNTHETIC persisted front-end note',
    });
    expect(trip.version).toBe(oldVersion + 1);
    expect(
      (
        await managed.client.itineraryNode.findUniqueOrThrow({
          where: { id: from!.id },
        })
      ).note,
    ).toBe('SYNTHETIC persisted front-end note');
    const reread = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}`,
      headers: bearer(userA),
    });
    expect(reread.json().days[0].nodes[0].note).toBe(
      'SYNTHETIC persisted front-end note',
    );
    const stale = await adopt(
      userA,
      { ...trip, version: oldVersion },
      previewResponse.json().previewId,
      `p6a-stale-${randomUUID()}`,
    );
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    const foreign = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/commands`,
      headers: bearer(userB),
      payload: {
        baseTripVersion: trip.version,
        command: { type: 'SET_NODE_NOTE', nodeId: from!.id, note: 'foreign' },
      },
    });
    expect(foreign.statusCode).toBe(404);
    expect(
      await managed.client.adoptedRoute.count({ where: { tripId: trip.id } }),
    ).toBe(0);
  });

  it.each(['CYCLING', 'TRANSIT'] as const)(
    'provider bootstrap %s survives Query, immutable snapshot, Preview and adopted PostgreSQL facts',
    async (mode) => {
      const trip = await tripWithVisits(userA, [
        'SYNTHETIC origin',
        'SYNTHETIC destination',
      ]);
      const [from, to] = trip.days.flatMap((d) => d.nodes);
      if (providerResult.status !== 'SUCCESS')
        throw new Error('Synthetic provider missing');
      const c = providerResult.candidates[0]!;
      providerResult = {
        status: 'SUCCESS',
        candidates: [
          {
            ...c,
            legs: c.legs.map((leg) => ({
              ...leg,
              mode,
              fixedService: false,
              serviceLabel: null,
            })),
          },
        ],
      };
      const before = await footprint(managed, trip.id);
      const queried = await app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/routes/query`,
        headers: bearer(userA),
        payload: {
          basisVersion: trip.version,
          fromNodeId: from!.id,
          toNodeId: to!.id,
          travelMode: mode,
          hint: {
            type: 'DEPART_AT',
            instant: '2030-10-01T10:00:00Z',
            timeZone: 'Asia/Tokyo',
          },
        },
      });
      expect(queried.statusCode, queried.body).toBe(200);
      expect(providerInputs[0]!.travelMode).toBe(mode);
      onlyWrites(before, await footprint(managed, trip.id), ['snapshots']);
      const route = queried.json<RouteQueryResponse>();
      expect(route.candidates[0]!.legs[0]!.mode).toBe(mode);
      const preview = await previewFromSnapshot(
        userA,
        trip,
        route.candidates[0]!.candidateSnapshotId,
      );
      expect(preview.adoptable).toBe(true);
      const adopted = await adoptSuccessfully(
        userA,
        trip,
        preview.previewId,
        `SYNTHETIC_PROVIDER_MODE_${mode}`,
      );
      const edges = await managed.client.transportEdge.findMany({
        where: { tripId: trip.id, source: 'ADOPTED_ROUTE' },
      });
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every((edge) => edge.mode === mode)).toBe(true);
      expect(adopted.trip.version).toBe(trip.version + 1);
      const foreign = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}`,
        headers: bearer(userB),
      });
      expect(foreign.statusCode).toBe(404);
    },
  );

  it('regional route intent reaches Japan Transit slot without ordinary fallback; only snapshots are written', async () => {
    const trip = await tripWithVisits(userA, [
      'SYNTHETIC origin',
      'SYNTHETIC destination',
    ]);
    const nodes = trip.days.flatMap((d) => d.nodes),
      calls: RouteProviderQueryInput[] = [];
    await app.close();
    app = buildTestApi(
      new RegionalRouteProvider({
        japanTransit: {
          async queryRoutes(input) {
            calls.push(input);
            return providerResult;
          },
        },
        googleRoute: {
          async queryRoutes() {
            throw new Error('ordinary fallback forbidden');
          },
        },
      }),
    );
    const before = await footprint(managed, trip.id);
    const r = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        fromNodeId: nodes[0]!.id,
        toNodeId: nodes[1]!.id,
        travelMode: 'TRANSIT',
        hint: {
          type: 'DEPART_AT',
          instant: '2030-10-01T10:00:00Z',
          timeZone: 'Asia/Tokyo',
        },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.travelMode).toBe('TRANSIT');
    onlyWrites(before, await footprint(managed, trip.id), ['snapshots']);
    const bad = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userB),
      payload: {
        basisVersion: trip.version,
        fromNodeId: nodes[0]!.id,
        toNodeId: nodes[1]!.id,
        travelMode: 'TRANSIT',
      },
    });
    expect(bad.statusCode).toBe(404);
    expect(calls).toHaveLength(1);
  });
  it('regional unconfigured slot and unsupported intent fail with zero planning writes', async () => {
    const trip = await tripWithVisits(userA, [
        'SYNTHETIC origin',
        'SYNTHETIC destination',
      ]),
      nodes = trip.days.flatMap((d) => d.nodes);
    await app.close();
    app = buildTestApi(new RegionalRouteProvider({}));
    const before = await footprint(managed, trip.id);
    for (const [travelMode, status, code] of [
      ['TRANSIT', 503, 'ROUTE_PROVIDER_UNCONFIGURED'],
      ['FLIGHT', 400, 'VALIDATION_ERROR'],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/routes/query`,
        headers: bearer(userA),
        payload: {
          basisVersion: trip.version,
          fromNodeId: nodes[0]!.id,
          toNodeId: nodes[1]!.id,
          travelMode,
          hint: {
            type: 'DEPART_AT',
            instant: '2030-10-01T10:00:00Z',
            timeZone: 'Asia/Tokyo',
          },
        },
      });
      expect(r.statusCode, r.body).toBe(status);
      expect(r.json().error.code).toBe(code);
    }
    onlyWrites(before, await footprint(managed, trip.id), []);
  });

  it.each([
    ['google', 'valid'],
    ['baidu', 'valid'],
    ['google', 'collapse'],
    ['baidu', 'collapse'],
    ['baidu', 'transit-1002'],
    ['baidu', 'transit-1003'],
  ] as const)(
    'SYNTHETIC regional %s / %s preserves evidence or fails without planning writes',
    async (name, fault) => {
      let trip = await tripWithVisits(userA, [
        'SYNTHETIC origin',
        'SYNTHETIC destination',
      ]);
      const nodes = trip.days.flatMap((d) => d.nodes),
        from =
          name === 'google' ? nodes[0]!.place! : baiduToWgs84(39.915, 116.404),
        to =
          name === 'google'
            ? {
                ...nodes[1]!.place!,
                latitude: nodes[0]!.place!.latitude! + 0.0009,
              }
            : fault === 'collapse'
              ? baiduToWgs84(39.9154, 116.404)
              : baiduToWgs84(39.916, 116.405);
      for (const [node, point] of [
        [nodes[0]!, from],
        [nodes[1]!, to],
      ] as const)
        await managed.client.place.update({
          where: { id: node.place!.id },
          data: { latitude: point.latitude, longitude: point.longitude },
        });
      const zone = name === 'google' ? 'Asia/Tokyo' : 'Asia/Shanghai';
      for (const [node, pointKind, instant] of [
        [nodes[0]!, 'DEPARTURE', '2030-10-01T10:00:00Z'],
        [nodes[1]!, 'ARRIVAL', '2030-10-01T10:30:00Z'],
      ] as const)
        trip = await command(userA, trip, {
          type: 'SET_TIME_INTENT',
          nodeId: node.id,
          pointKind,
          operator: 'EXACT',
          instant,
          timeZone: zone,
          locked: true,
        });
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              name === 'google'
                ? {
                    routes: [
                      {
                        duration: '600s',
                        legs: [
                          {
                            startLocation: {
                              latLng: {
                                latitude:
                                  fault === 'collapse'
                                    ? (from.latitude! + to.latitude!) / 2
                                    : from.latitude,
                                longitude: from.longitude,
                              },
                            },
                            endLocation: {
                              latLng:
                                fault === 'collapse'
                                  ? {
                                      latitude:
                                        (from.latitude! + to.latitude!) / 2,
                                      longitude: from.longitude,
                                    }
                                  : {
                                      latitude: to.latitude,
                                      longitude: to.longitude,
                                    },
                            },
                          },
                        ],
                      },
                    ],
                  }
                : fault.startsWith('transit-')
                  ? {
                      status: fault === 'transit-1002' ? 1002 : 1003,
                      result: null,
                    }
                  : {
                      status: 0,
                      result: {
                        origin: {
                          originPt: {
                            lat: fault === 'collapse' ? 39.9152 : 39.915,
                            lng: 116.404,
                          },
                        },
                        destination: {
                          destinationPt:
                            fault === 'collapse'
                              ? { lat: 39.9152, lng: 116.404 }
                              : { lat: 39.916, lng: 116.405 },
                        },
                        routes: [{ duration: 600 }],
                      },
                    },
            ),
          ),
      );
      await app.close();
      app = buildTestApi(
        new RegionalRouteProvider(
          name === 'google'
            ? {
                googleRoute: new GoogleOrdinaryRouteProvider(
                  'SYNTHETIC',
                  fetcher,
                  () => NOW,
                ),
              }
            : {
                baiduRoute: new BaiduOrdinaryRouteProvider(
                  'SYNTHETIC',
                  fetcher,
                  () => NOW,
                ),
              },
        ),
      );
      const before = await footprint(managed, trip.id);
      const response = await app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/routes/query`,
        headers: bearer(userA),
        payload: {
          basisVersion: trip.version,
          fromNodeId: nodes[0]!.id,
          toNodeId: nodes[1]!.id,
          travelMode: fault.startsWith('transit-') ? 'TRANSIT' : 'WALKING',
          hint: {
            type: 'DEPART_AT',
            instant: '2030-10-01T10:00:00Z',
            timeZone: zone,
          },
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      if (fault !== 'valid') {
        expect(response.statusCode, response.body).toBe(
          fault === 'transit-1002' ? 422 : 503,
        );
        expect(response.json().error.code).toBe(
          fault === 'transit-1002'
            ? 'ROUTE_QUERY_UNSUPPORTED'
            : 'PROVIDER_UNAVAILABLE',
        );
        onlyWrites(before, await footprint(managed, trip.id), []);
        return;
      }
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json() as RouteQueryResponse;
      expect(result.candidates[0]?.provider).toBe(name);
      expect(result.candidates[0]?.overall.departure.timeZone).toBe(zone);
      onlyWrites(before, await footprint(managed, trip.id), ['snapshots']);
      const snapshot =
        await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
          where: { id: result.candidates[0]!.candidateSnapshotId },
        });
      expect(snapshot.provider).toBe(name);
      const persisted = snapshot.candidatePayload as {
        legs: {
          providerRef: string;
          from: { latitude: number; longitude: number };
        }[];
      };
      expect(persisted.legs[0]!.providerRef).toBe(
        result.candidates[0]!.legs[0]!.providerRef,
      );
      expect(persisted.legs[0]!.providerRef).toMatch(/^endpoint-evidence:v1:/);
      expect(persisted.legs[0]!.from).toMatchObject({
        latitude: from.latitude,
        longitude: from.longitude,
      });
    },
  );
  async function tripWithVisits(
    identity: SyntheticIdentity,
    names: readonly string[],
  ): Promise<TripView> {
    return tripWithVisitsOnDate(identity, names, '2030-10-01');
  }

  async function tripWithVisitsOnDate(
    identity: SyntheticIdentity,
    names: readonly string[],
    localDate: string,
  ): Promise<TripView> {
    let trip = await createTrip(identity);
    for (const name of names)
      trip = await addVisit(identity, trip, name, localDate);
    return trip;
  }

  async function addVisit(
    identity: SyntheticIdentity,
    trip: TripView,
    name: string,
    localDate: string,
  ): Promise<TripView> {
    return command(identity, trip, {
      type: 'ADD_PLACE_VISIT',
      targetDay:
        trip.days.length === 0
          ? { type: 'NEW', localDate, sequence: 0 }
          : trip.days.some((day) => day.localDate === localDate)
            ? {
                type: 'EXISTING',
                dayOccurrenceId: trip.days.find(
                  (day) => day.localDate === localDate,
                )!.dayOccurrenceId,
              }
            : { type: 'NEW', localDate, sequence: trip.days.length },
      position:
        trip.days.find((day) => day.localDate === localDate)?.nodes.length ?? 0,
      place: {
        type: 'CUSTOM',
        name,
        latitude: 35.6762,
        longitude: 139.6503,
      },
    });
  }

  async function command(
    identity: SyntheticIdentity,
    trip: TripView,
    commandInput: Record<string, unknown>,
  ): Promise<TripView> {
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/commands`,
      headers: bearer(identity),
      payload: { baseTripVersion: trip.version, command: commandInput },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
  }

  function query(
    identity: SyntheticIdentity,
    trip: TripView,
    fromNodeId: string,
    toNodeId: string,
    hint: Record<string, unknown> | null,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(identity),
      payload: { basisVersion: trip.version, fromNodeId, toNodeId, hint },
    });
  }

  async function suffixFixture(
    actual = true,
    originDwell = false,
    confirmed = true,
  ) {
    const initial = await tripWithVisits(userA, ['SYNTHETIC A', 'SYNTHETIC D']);
    const [a, d] = initial.days[0]!.nodes;
    providerResult = suffixFoundationCandidate(false);
    if (originDwell) {
      const source = providerResult.candidates[0]!;
      // Flexible synthetic source services avoid a contradictory fixed departure
      // while exercising the existing lookback/dwell policy at an ACTUAL origin.
      providerResult = {
        status: 'SUCCESS',
        candidates: [
          {
            ...source,
            legs: source.legs.map((leg) => ({
              ...leg,
              fixedService: false,
              groundTransit: {
                ...leg.groundTransit!,
                serviceClass: 'HIGH_FREQUENCY',
                headwayMinSeconds: 300,
                headwayMaxSeconds: 600,
              },
            })),
          },
        ],
      };
    }
    const preview = await createPreview(userA, initial, a!.id, d!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      preview.previewId,
      'synthetic-suffix-source',
    );
    const [A, B, C, D] = first.trip.days.flatMap((day) => day.nodes);
    const edges = await managed.client.transportEdge.findMany({
      where: { tripId: initial.id },
      orderBy: { createdAt: 'asc' },
    });
    const prefix = edges.find((edge) => edge.fromNodeId === A!.id)!;
    const full = await query(userA, first.trip, A!.id, D!.id, departHint());
    expect(full.statusCode).toBe(200);
    if (actual) {
      await managed.client.temporalValue.createMany({
        data: [
          {
            transportEdgeId: prefix.id,
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: new Date('2030-10-01T10:20:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
          {
            transportEdgeId: prefix.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
            instant: new Date('2030-10-01T10:00:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
        ],
      });
    }
    const originArrival = confirmed
      ? await confirmSourceOrigin(first.trip, A!.id, B!.id)
      : null;
    if (originArrival !== null) first.trip = originArrival.trip;
    providerResult = suffixFoundationCandidate(true);
    return {
      first,
      originArrivalEventId: originArrival?.eventId ?? null,
      A: A!,
      B: B!,
      C: C!,
      D: D!,
      prefix,
      suffixEdges: edges.filter((edge) => edge.id !== prefix.id),
    };
  }

  it.each([
    'none',
    'provider-only',
    'gps-only',
    'bare-node-actual',
    'departed',
    'later-event',
    'inconsistent',
  ] as const)(
    'P5E2 4B: direct suffix Query rejects %s without snapshots or route/monitor writes',
    async (kind) => {
      const f = await suffixFixture(
        false,
        false,
        !['none', 'provider-only', 'gps-only', 'bare-node-actual'].includes(
          kind,
        ),
      );
      if (kind === 'provider-only') {
        await managed.client.temporalValue.createMany({
          data: ['ARRIVAL', 'DEPARTURE'].map((pointKind) => ({
            transportEdgeId: f.prefix.id,
            layer: 'ACTUAL' as const,
            pointKind: pointKind as 'ARRIVAL' | 'DEPARTURE',
            instant: new Date('2030-10-01T10:20:00Z'),
            timeZone: 'UTC',
            sourceKind: 'PROVIDER_OBSERVATION' as const,
          })),
        });
      }
      if (kind === 'gps-only') {
        await managed.client.executionLocationState.create({
          data: {
            tripId: f.first.trip.id,
            currentNodeId: f.B.id,
            targetNodeId: f.C.id,
            lastObservedAt: NOW,
            outsideTargetConsecutiveCount: 0,
            locationStatus: 'RELIABLE',
          },
        });
      }
      if (kind === 'bare-node-actual') {
        f.first.trip = (
          await manualExecution(
            f.first.trip,
            f.A.id,
            'MANUAL_ARRIVAL',
            '2030-10-01T10:00:00Z',
          )
        ).trip;
        f.first.trip = (
          await manualExecution(
            f.first.trip,
            f.A.id,
            'MANUAL_DEPARTURE',
            '2030-10-01T10:00:00Z',
          )
        ).trip;
        await managed.client.temporalValue.create({
          data: {
            nodeId: f.B.id,
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: new Date('2030-10-01T10:20:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
        });
      }
      if (kind === 'departed')
        f.first.trip = (
          await manualExecution(
            f.first.trip,
            f.B.id,
            'MANUAL_DEPARTURE',
            '2030-10-01T10:20:00Z',
          )
        ).trip;
      if (kind === 'later-event') {
        const event = await managed.client.executionEvent.create({
          data: {
            ownerUserId: userA.actor.userId,
            tripId: f.first.trip.id,
            nodeId: f.C.id,
            type: 'DEPARTURE',
            source: 'MANUAL',
            occurredAt: new Date('2030-10-01T10:40:00Z'),
          },
        });
        await managed.client.temporalValue.create({
          data: {
            nodeId: f.C.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
            instant: event.occurredAt,
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
            sourceRef: `execution-event:${event.id}`,
          },
        });
      }
      if (kind === 'inconsistent')
        await managed.client.temporalValue.deleteMany({
          where: { nodeId: f.A.id, pointKind: 'DEPARTURE', layer: 'ACTUAL' },
        });
      await managed.client.tripAssistanceCapability.create({
        data: {
          ownerUserId: userA.actor.userId,
          tripId: f.first.trip.id,
          kind: 'GROUND_TRANSIT_MONITORING',
          state: 'ENABLED',
          revision: 1,
          enabledAt: NOW,
        },
      });
      await managed.client.job.create({
        data: {
          type: 'GROUND_TRANSIT_MONITOR',
          runAt: NOW,
          uniqueKey: `SYNTHETIC_4B_MONITOR_${kind}`,
          payloadRef: f.first.operationReceipt.adoptedRouteId,
          capabilityRevision: 1,
          maxAttempts: 3,
        },
      });
      const count = await managed.client.routeCandidateSnapshot.count({
        where: { tripId: f.first.trip.id },
      });
      const before = await repairDurableState(f.first.trip.id);
      const jobs = await managed.client.job.findMany({
        orderBy: { id: 'asc' },
      });
      const providerCalls = providerInputs.length;
      const response = await query(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
      });
      expect(providerInputs).toHaveLength(providerCalls);
      expect(
        await managed.client.routeCandidateSnapshot.count({
          where: { tripId: f.first.trip.id },
        }),
      ).toBe(count);
      expect(await repairDurableState(f.first.trip.id)).toEqual(before);
      expect(
        await managed.client.job.findMany({ orderBy: { id: 'asc' } }),
      ).toEqual(jobs);
      expect(before.adoptedRoutes).toEqual([
        expect.objectContaining({ status: 'ACTIVE' }),
      ]);
    },
  );

  it('P5E2 4B: only a durable execution event linked to ACTUAL enables direct suffix Query', async () => {
    const f = await suffixFixture(false);
    const event = await managed.client.executionEvent.findUniqueOrThrow({
      where: { id: f.originArrivalEventId! },
    });
    expect(event).toMatchObject({
      type: 'ARRIVAL',
      source: 'MANUAL',
      nodeId: f.B.id,
      undoneAt: null,
    });
    expect(
      await managed.client.temporalValue.findFirstOrThrow({
        where: { nodeId: f.B.id, layer: 'ACTUAL', pointKind: 'ARRIVAL' },
      }),
    ).toMatchObject({ sourceRef: `execution-event:${event.id}` });
    const response = await query(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    expect(response.statusCode).toBe(200);
    const snapshot =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: {
          id: response.json<RouteQueryResponse>().candidates[0]!
            .candidateSnapshotId,
        },
      });
    expect(snapshot).toMatchObject({
      fromNodeId: f.B.id,
      toNodeId: f.D.id,
      basisVersion: f.first.trip.version,
    });
  });

  it.each([false, true])(
    'P5E2 4B: reliable location authorizes only after durable ARRIVAL (autoRecord=%s)',
    async (autoRecord) => {
      const f = await suffixFixture(false, false, false);
      f.first.trip = (
        await manualExecution(
          f.first.trip,
          f.A.id,
          'MANUAL_ARRIVAL',
          '2030-10-01T10:00:00Z',
        )
      ).trip;
      f.first.trip = (
        await manualExecution(
          f.first.trip,
          f.A.id,
          'MANUAL_DEPARTURE',
          '2030-10-01T10:00:00Z',
        )
      ).trip;
      await managed.client.tripAssistanceCapability.createMany({
        data: [
          {
            ownerUserId: userA.actor.userId,
            tripId: f.first.trip.id,
            kind: 'LOCATION_ASSISTANCE',
            state: 'ENABLED',
            revision: 1,
            enabledAt: NOW,
          },
          ...(autoRecord
            ? [
                {
                  ownerUserId: userA.actor.userId,
                  tripId: f.first.trip.id,
                  kind: 'AUTO_RECORD' as const,
                  state: 'ENABLED' as const,
                  revision: 1,
                  enabledAt: NOW,
                },
              ]
            : []),
        ],
      });
      currentNow = new Date('2030-10-01T10:20:00Z');
      const observed = await app.inject({
        method: 'POST',
        url: `/trips/${f.first.trip.id}/execution/location`,
        headers: bearer(userA),
        payload: {
          latitude: 35.68,
          longitude: 139.66,
          accuracyMeters: 10,
          observedAt: currentNow.toISOString(),
        },
      });
      expect(observed.statusCode, observed.body).toBe(200);
      expect(observed.json()).toMatchObject({
        status: autoRecord ? 'CONFIRMED_ARRIVAL' : 'ARRIVAL_DETECTED',
      });
      f.first.trip = (
        await app.inject({
          method: 'GET',
          url: `/trips/${f.first.trip.id}`,
          headers: bearer(userA),
        })
      ).json<TripView>();
      const before = await managed.client.routeCandidateSnapshot.count({
        where: { tripId: f.first.trip.id },
      });
      const response = await query(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      if (autoRecord) {
        expect(response.statusCode, response.body).toBe(200);
        expect(
          await managed.client.executionEvent.findFirstOrThrow({
            where: { nodeId: f.B.id, type: 'ARRIVAL', undoneAt: null },
          }),
        ).toMatchObject({
          source: 'LOCATION',
          evidenceReliability: 'SUFFICIENT',
        });
      } else {
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
        });
        expect(
          await managed.client.routeCandidateSnapshot.count({
            where: { tripId: f.first.trip.id },
          }),
        ).toBe(before);
        expect(
          await managed.client.executionEvent.count({
            where: { nodeId: f.B.id },
          }),
        ).toBe(0);
      }
    },
  );

  it('P5E2 4B: provider-return race cannot save suffix snapshots after user departure', async () => {
    const f = await suffixFixture(false);
    const count = await managed.client.routeCandidateSnapshot.count({
      where: { tripId: f.first.trip.id },
    });
    providerHook = async () => {
      f.first.trip = (
        await manualExecution(
          f.first.trip,
          f.B.id,
          'MANUAL_DEPARTURE',
          '2030-10-01T10:20:00Z',
        )
      ).trip;
    };
    const response = await query(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
    });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: f.first.trip.id },
      }),
    ).toBe(count);
  });

  it.each(['save-snapshots', 'adopt'] as const)(
    'P5E2 4B: locked %s rechecks departure proof independently of Trip.version',
    async (action) => {
      const f = await suffixFixture(false);
      const preview =
        action === 'adopt'
          ? await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
              type: 'DEPART_AT',
              instant: '2030-10-01T10:30:00Z',
              timeZone: 'UTC',
            })
          : null;
      // Deliberately leave version unchanged to isolate the lock-protected proof
      // read. Normal Execution API writes are covered by the departure race.
      const changeProof = async () => {
        const event = await managed.client.executionEvent.create({
          data: {
            ownerUserId: userA.actor.userId,
            tripId: f.first.trip.id,
            nodeId: f.B.id,
            type: 'DEPARTURE',
            source: 'MANUAL',
            occurredAt: new Date('2030-10-01T10:20:00Z'),
          },
        });
        await managed.client.temporalValue.create({
          data: {
            nodeId: f.B.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
            instant: event.occurredAt,
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
            sourceRef: `execution-event:${event.id}`,
          },
        });
      };
      if (action === 'save-snapshots') {
        const count = await managed.client.routeCandidateSnapshot.count({
          where: { tripId: f.first.trip.id },
        });
        providerHook = changeProof;
        const response = await query(userA, f.first.trip, f.B.id, f.D.id, {
          type: 'DEPART_AT',
          instant: '2030-10-01T10:30:00Z',
          timeZone: 'UTC',
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: { code: 'VERSION_CONFLICT' },
        });
        expect(
          await managed.client.routeCandidateSnapshot.count({
            where: { tripId: f.first.trip.id },
          }),
        ).toBe(count);
      } else {
        await changeProof();
        const before = await repairDurableState(f.first.trip.id);
        const response = await adopt(
          userA,
          f.first.trip,
          preview!.previewId,
          'synthetic-4b-locked-proof',
        );
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: { code: 'PREVIEW_STALE' },
        });
        expect(await repairDurableState(f.first.trip.id)).toEqual(before);
      }
      expect(
        (
          await managed.client.trip.findUniqueOrThrow({
            where: { id: f.first.trip.id },
          })
        ).version,
      ).toBe(f.first.trip.version);
      expect(
        (
          await managed.client.adoptedRoute.findUniqueOrThrow({
            where: { id: f.first.operationReceipt.adoptedRouteId },
          })
        ).status,
      ).toBe('ACTIVE');
    },
  );

  it.each(['adopt', 'depart'] as const)(
    'P5E2 4B: read-only Handoff follows confirmed origin and fences %s',
    async (action) => {
      const f = await suffixFixture(false, false, false);
      await app.close();
      app = buildTestApi(
        new SyntheticRouteProvider(() => providerResult),
        groundSequence(['CANCELLED']),
      );
      const downstreamEdge = f.suffixEdges.find(
        (edge) => edge.fromNodeId === f.C.id,
      )!;
      const baseUrl = `/trips/${f.first.trip.id}/execution/ground-transit/${downstreamEdge.id}`;
      const refreshed = await app.inject({
        method: 'POST',
        url: `${baseUrl}/refresh`,
        headers: bearer(userA),
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      const planned = await app.inject({
        method: 'GET',
        url: `${baseUrl}/route-reevaluation`,
        headers: bearer(userA),
      });
      expect(planned.json()).toMatchObject({
        readiness: 'READY',
        originBasis: 'PLANNED_ROUTE_ORIGIN',
        query: { fromNodeId: f.A.id, toNodeId: f.D.id },
      });
      f.first.trip = (
        await confirmSourceOrigin(f.first.trip, f.A.id, f.B.id)
      ).trip;
      const before = await repairDurableState(f.first.trip.id);
      const handoffResponse = await app.inject({
        method: 'GET',
        url: `${baseUrl}/route-reevaluation`,
        headers: bearer(userA),
      });
      const handoff =
        handoffResponse.json<GroundTransitRouteReevaluationHandoffView>();
      expect(handoff).toMatchObject({
        readiness: 'READY',
        originBasis: 'CONFIRMED_EXECUTION_NODE',
        query: {
          basisVersion: f.first.trip.version,
          fromNodeId: f.B.id,
          toNodeId: f.D.id,
          hint: { timeZone: 'UTC' },
        },
      });
      expect(await repairDurableState(f.first.trip.id)).toEqual(before);
      const queried = await app.inject({
        method: 'POST',
        url: `/trips/${f.first.trip.id}/routes/query`,
        headers: bearer(userA),
        payload: handoff.query!,
      });
      expect(queried.statusCode, queried.body).toBe(200);
      const preview = await previewFromSnapshot(
        userA,
        f.first.trip,
        queried.json<RouteQueryResponse>().candidates[0]!.candidateSnapshotId,
      );
      expect(preview.adoptable).toBe(true);
      if (action === 'depart') {
        const departed = await manualExecution(
          f.first.trip,
          f.B.id,
          'MANUAL_DEPARTURE',
          '2030-10-01T10:20:00Z',
        );
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${baseUrl}/route-reevaluation`,
              headers: bearer(userA),
            })
          ).json(),
        ).toMatchObject({
          readiness: 'ORIGIN_UNRESOLVED',
          originBasis: null,
          query: null,
        });
        const beforeRejected = await repairDurableState(f.first.trip.id);
        const rejected = await adopt(
          userA,
          f.first.trip,
          preview.previewId,
          'synthetic-4b-departure-race',
        );
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toMatchObject({
          error: { code: 'VERSION_CONFLICT' },
        });
        expect(await repairDurableState(f.first.trip.id)).toEqual(
          beforeRejected,
        );
        const count = await managed.client.routeCandidateSnapshot.count({
          where: { tripId: f.first.trip.id },
        });
        expect(
          (
            await query(userA, departed.trip, f.B.id, f.D.id, {
              ...handoff.query!.hint!,
            })
          ).json(),
        ).toMatchObject({ error: { code: 'ROUTE_QUERY_UNSUPPORTED' } });
        expect(
          await managed.client.routeCandidateSnapshot.count({
            where: { tripId: f.first.trip.id },
          }),
        ).toBe(count);
      } else {
        const adopted = await adoptSuccessfully(
          userA,
          f.first.trip,
          preview.previewId,
          'synthetic-4b-confirmed-adopt',
        );
        expect(
          await managed.client.adoptedRoute.findUniqueOrThrow({
            where: { id: f.first.operationReceipt.adoptedRouteId },
          }),
        ).toMatchObject({ status: 'REPLACED' });
        expect(
          await managed.client.adoptedRoute.findUniqueOrThrow({
            where: { id: adopted.operationReceipt.adoptedRouteId },
          }),
        ).toMatchObject({
          status: 'ACTIVE',
          anchorFromNodeId: f.B.id,
          anchorToNodeId: f.D.id,
        });
        expect(
          await managed.client.transportEdge.findUniqueOrThrow({
            where: { id: f.prefix.id },
          }),
        ).toMatchObject({
          adoptedRouteId: f.first.operationReceipt.adoptedRouteId,
        });
        const undone = await undoSuccessfully(
          userA,
          adopted.trip,
          adopted.operationReceipt.id,
          'synthetic-4b-confirmed-undo',
        );
        expect(
          undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
        ).toEqual([f.A.id, f.B.id, f.C.id, f.D.id]);
      }
    },
  );

  async function manualExecution(
    trip: TripView,
    nodeId: string,
    type: 'MANUAL_ARRIVAL' | 'MANUAL_DEPARTURE',
    instant: string,
  ) {
    if (currentNow < new Date(instant)) currentNow = new Date(instant);
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/events`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        idempotencyKey: randomUUID(),
        type,
        nodeId,
        occurredAt: instant,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const read = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}`,
      headers: bearer(userA),
    });
    expect(read.statusCode).toBe(200);
    return {
      trip: read.json() as TripView,
      eventId: (response.json() as { event: { id: string } }).event.id,
    };
  }

  async function confirmSourceOrigin(
    trip: TripView,
    fromNodeId: string,
    originNodeId: string,
    departure = '2030-10-01T10:00:00Z',
    arrival = '2030-10-01T10:20:00Z',
  ) {
    const arrived = await manualExecution(
      trip,
      fromNodeId,
      'MANUAL_ARRIVAL',
      departure,
    );
    const departed = await manualExecution(
      arrived.trip,
      fromNodeId,
      'MANUAL_DEPARTURE',
      departure,
    );
    return manualExecution(
      departed.trip,
      originNodeId,
      'MANUAL_ARRIVAL',
      arrival,
    );
  }

  async function undoExecution(trip: TripView, eventId: string) {
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/events/${eventId}/undo`,
      headers: bearer(userA),
      payload: { baseTripVersion: trip.version, idempotencyKey: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const read = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}`,
      headers: bearer(userA),
    });
    expect(read.statusCode).toBe(200);
    return read.json() as TripView;
  }

  async function repairRestoredFixture(origin: 'B' | 'C' = 'B') {
    const f = await suffixFixture(false);
    let arrivalEventId = f.originArrivalEventId!;
    let departureEventId: string | null = null;
    if (origin === 'C') {
      const departed = await manualExecution(
        f.first.trip,
        f.B.id,
        'MANUAL_DEPARTURE',
        '2030-10-01T10:20:00Z',
      );
      departureEventId = departed.eventId;
      const arrived = await manualExecution(
        departed.trip,
        f.C.id,
        'MANUAL_ARRIVAL',
        '2030-10-01T10:40:00Z',
      );
      arrivalEventId = arrived.eventId;
      f.first.trip = arrived.trip;
      providerResult = {
        status: 'SUCCESS',
        candidates: [
          candidate(
            '2030-10-01T10:45:00Z',
            '2030-10-01T11:00:00Z',
            'UTC',
            'UTC',
          ),
        ],
      };
    }
    const suffix = await createPreview(
      userA,
      f.first.trip,
      f[origin].id,
      f.D.id,
      {
        type: 'DEPART_AT',
        instant:
          origin === 'B' ? '2030-10-01T10:30:00Z' : '2030-10-01T10:45:00Z',
        timeZone: 'UTC',
      },
    );
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      suffix.previewId,
      'repair-suffix',
    );
    const restored = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'repair-undo',
    );
    restored.trip = await undoExecution(restored.trip, arrivalEventId);
    if (departureEventId !== null)
      restored.trip = await undoExecution(restored.trip, departureEventId);
    return { ...f, second, restored };
  }

  async function repairDurableState(tripId: string) {
    return managed.client.trip.findUniqueOrThrow({
      where: { id: tripId },
      include: {
        dayOccurrences: {
          orderBy: { id: 'asc' },
          include: {
            nodes: {
              orderBy: { id: 'asc' },
              include: {
                place: true,
                temporalValues: { orderBy: { id: 'asc' } },
                timeIntents: true,
                systemDwellSuggestion: true,
              },
            },
            transportProjections: { orderBy: { transportEdgeId: 'asc' } },
          },
        },
        executionEvents: { orderBy: { id: 'asc' } },
        executionLocationState: true,
        adoptedRoutes: { orderBy: { id: 'asc' } },
        routeCandidateSnapshots: { orderBy: { id: 'asc' } },
        routePreviews: { orderBy: { id: 'asc' } },
        transportEdges: {
          orderBy: { id: 'asc' },
          include: { temporalValues: { orderBy: { id: 'asc' } } },
        },
        transportHistory: {
          orderBy: { id: 'asc' },
          include: { temporalValues: { orderBy: { id: 'asc' } } },
        },
        operationReceipts: { orderBy: { id: 'asc' } },
        outboxEvents: { orderBy: { id: 'asc' } },
        groundTransitLegs: {
          orderBy: { id: 'asc' },
          include: {
            observations: { orderBy: { id: 'asc' } },
            stateTransitions: { orderBy: { id: 'asc' } },
          },
        },
      },
    });
  }

  it.each(['B', 'C'] as const)(
    'P5E2 repair A/B: suffix Undo at %s protects deletion by full/earlier suffix replacement',
    async (origin) => {
      const f = await repairRestoredFixture(origin);
      // Historical correction after the Trip period; original route/fact clocks remain intact.
      currentNow = new Date('2030-10-02T00:00:00Z');
      providerResult = suffixFoundationCandidate(
        true,
        origin === 'B' ? '2030-10-01T10:00:00Z' : '2030-10-01T10:30:00Z',
        '2030-10-01T11:00:00Z',
      );
      const preview = await createPreview(
        userA,
        f.restored.trip,
        origin === 'B' ? f.A.id : f.B.id,
        f.D.id,
        origin === 'B'
          ? departHint()
          : {
              type: 'DEPART_AT',
              instant: '2030-10-01T10:30:00Z',
              timeZone: 'UTC',
            },
      );
      expect(preview).toMatchObject({
        adoptable: false,
        status: 'BLOCKED',
      });
      expect(preview.changeSummary.routeCorridor?.replacementScope).toBe(
        origin === 'B' ? 'FULL_CORRIDOR' : 'SUFFIX',
      );
      expect(preview.changeSummary.protectedBlockingNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: f[origin].id,
            protectionReasons: expect.arrayContaining([
              'REFERENCED_BY_ADOPTED_ROUTE',
            ]),
          }),
        ]),
      );
      const before = await repairDurableState(f.restored.trip.id);
      const response = await adopt(
        userA,
        f.restored.trip,
        preview.previewId,
        'repair-blocked',
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'PREVIEW_BLOCKED' },
      });
      expect(await repairDurableState(f.restored.trip.id)).toEqual(before);
      expect(before.adoptedRoutes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: f.first.operationReceipt.adoptedRouteId,
            status: 'ACTIVE',
          }),
          expect.objectContaining({
            id: f.second.operationReceipt.adoptedRouteId,
            status: 'UNDONE',
            anchorFromNodeId: f[origin].id,
          }),
        ]),
      );
      expect(before.operationReceipts).toHaveLength(3);
    },
  );

  it('P5E2 repair C: referenced generated anchor can be reused with its original ID', async () => {
    const f = await repairRestoredFixture();
    // Historical correction after the Trip period; original route/fact clocks remain intact.
    currentNow = new Date('2030-10-02T00:00:00Z');
    const source = suffixFoundationCandidate(false).candidates[0]!;
    const first = source.legs[0]!;
    const last = source.legs.at(-1)!;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...source,
          legs: [
            first,
            {
              ...last,
              from: first.to,
              departure: first.arrival,
              durationSeconds: 2400,
              groundTransit: {
                ...last.groundTransit!,
                boardingHubRef:
                  first.to.providerHubRef ?? first.to.providerPlaceRef,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, f.restored.trip, f.A.id, f.D.id);
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.nodesToReuse).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: f.B.id })]),
    );
    expect(
      preview.changeSummary.nodesToRemove?.map((node) => node.nodeId),
    ).toEqual([f.C.id]);
    const adopted = await adoptSuccessfully(
      userA,
      f.restored.trip,
      preview.previewId,
      'repair-reuse',
    );
    expect(
      adopted.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
    ).toEqual([f.A.id, f.B.id, f.D.id]);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: f.second.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'UNDONE', anchorFromNodeId: f.B.id });
  });

  it('P5E2 repair D: unadopted suffix Query/Preview does not permanently protect nodes', async () => {
    const f = await suffixFixture(false);
    // Create both temporary and replacement evidence in one historical-edit window.
    // The temporary Preview stays unexpired, preserving the original protection test.
    currentNow = new Date('2030-10-02T00:00:00Z');
    const temporary = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    f.first.trip = await undoExecution(f.first.trip, f.originArrivalEventId!);
    providerResult = suffixFoundationCandidate(
      true,
      '2030-10-01T10:00:00Z',
      '2030-10-01T11:00:00Z',
    );
    const full = await createPreview(userA, f.first.trip, f.A.id, f.D.id);
    expect(full.adoptable).toBe(true);
    await adoptSuccessfully(
      userA,
      f.first.trip,
      full.previewId,
      'repair-temporary',
    );
    expect(
      await managed.client.itineraryNode.findUnique({ where: { id: f.B.id } }),
    ).toBeNull();
    expect(
      await managed.client.routePreview.findUnique({
        where: { id: temporary.previewId },
      }),
    ).toBeNull();
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: f.first.trip.id },
      }),
    ).toBe(2);
  });

  it.each(['anchorFrom', 'anchorTo', 'snapshot', 'receipt'] as const)(
    'P5E2 repair E: locked Adopt rechecks new persistent %s reference after Preview',
    async (reference) => {
      const f = await suffixFixture(false);
      // Create both temporary and replacement evidence in one historical-edit window.
      // The temporary Preview stays unexpired, preserving the original protection test.
      currentNow = new Date('2030-10-02T00:00:00Z');
      const temporary = await createPreview(
        userA,
        f.first.trip,
        f.B.id,
        f.D.id,
        { type: 'DEPART_AT', instant: '2030-10-01T10:30:00Z', timeZone: 'UTC' },
      );
      const evidence = await managed.client.routePreview.findUniqueOrThrow({
        where: { id: temporary.previewId },
      });
      f.first.trip = await undoExecution(f.first.trip, f.originArrivalEventId!);
      providerResult = suffixFoundationCandidate(
        true,
        '2030-10-01T10:00:00Z',
        '2030-10-01T11:00:00Z',
      );
      const full = await createPreview(userA, f.first.trip, f.A.id, f.D.id);
      expect(full.adoptable).toBe(true);
      const sourceRoute = await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: f.first.operationReceipt.adoptedRouteId },
      });
      if (reference === 'receipt') {
        const receipt = await managed.client.operationReceipt.findUniqueOrThrow(
          { where: { id: f.first.operationReceipt.id } },
        );
        await managed.client.operationReceipt.create({
          data: {
            ...receipt,
            id: randomUUID(),
            idempotencyKey: 'repair-retained-evidence',
            delta: { synthetic: true },
            previewId: evidence.id,
          },
        });
      } else {
        // Persistence-only fixture keeps Trip.version unchanged to isolate the
        // locked reference recheck from the ordinary version fence.
        await managed.client.adoptedRoute.create({
          data: {
            ...cloneNodeRoute(sourceRoute),
            id: randomUUID(),
            status: reference === 'anchorTo' ? 'REPLACED' : 'UNDONE',
            sourcePreviewId: evidence.id,
            candidateSnapshotId: evidence.candidateSnapshotId,
            anchorFromNodeId: reference === 'anchorFrom' ? f.B.id : f.A.id,
            anchorToNodeId: reference === 'anchorTo' ? f.C.id : f.D.id,
          },
        });
      }
      const before = await repairDurableState(f.first.trip.id);
      const repository = new PrismaRoutePlanningRepository(managed.client);
      expect(
        await repository.adoptPreview({
          ownerUserId: userA.actor.userId,
          tripId: f.first.trip.id,
          previewId: full.previewId,
          baseTripVersion: f.first.trip.version,
          idempotencyKey: 'repair-lock-recheck',
          requestHash: 'a'.repeat(64),
          acceptedUserAdjustments: [],
          now: NOW,
          undoExpiresAt: new Date(NOW.getTime() + 600_000),
        }),
      ).toEqual({ status: 'PREVIEW_BLOCKED' });
      expect(await repairDurableState(f.first.trip.id)).toEqual(before);
      const refreshed = await createPreview(
        userA,
        f.first.trip,
        f.A.id,
        f.D.id,
      );
      expect(refreshed.adoptable).toBe(false);
      expect(refreshed.changeSummary.protectedBlockingNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: reference === 'anchorTo' ? f.C.id : f.B.id,
            protectionReasons: expect.arrayContaining([
              reference.startsWith('anchor')
                ? 'REFERENCED_BY_ADOPTED_ROUTE'
                : 'REFERENCED_BY_RETAINED_PLANNING_DATA',
            ]),
          }),
        ]),
      );
      await managed.client.trip.update({
        where: { id: f.first.trip.id },
        data: { version: { increment: 1 } },
      });
      expect(
        (
          await adopt(userA, f.first.trip, full.previewId, 'repair-version')
        ).json(),
      ).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    },
  );

  it.each([false, true])(
    'P5E2 4A: suffix Query/Preview/Adopt/Undo preserves prefix identity and facts (prefix ACTUAL=%s; confirmed execution origin)',
    async (actual) => {
      const f = await suffixFixture(actual);
      const route1 = f.first.operationReceipt.adoptedRouteId;
      const beforeNodes = await managed.client.itineraryNode.findMany({
        where: { tripId: f.first.trip.id },
        orderBy: { position: 'asc' },
      });
      const beforePrefix = await managed.client.transportEdge.findUniqueOrThrow(
        {
          where: { id: f.prefix.id },
          include: {
            temporalValues: { orderBy: { id: 'asc' } },
            dayProjections: true,
          },
        },
      );
      const sourceLegs =
        await managed.client.groundTransitLegExecution.findMany({
          where: { adoptedRouteId: route1 },
          orderBy: { legIndex: 'asc' },
        });
      expect(sourceLegs).toHaveLength(3);
      await managed.client.groundTransitObservation.create({
        data: {
          legExecutionId: sourceLegs[1]!.id,
          observationIdentity: 'SYNTHETIC_4A_HISTORY',
          fetchedAt: NOW,
          factsHash: 'a'.repeat(64),
          facts: { synthetic: true },
        },
      });
      await managed.client.groundTransitStateTransition.create({
        data: {
          legExecutionId: sourceLegs[1]!.id,
          fromState: 'PENDING',
          toState: 'UNKNOWN',
          source: 'SYNTHETIC_TEST',
          evidenceRef: 'SYNTHETIC_4A',
          occurredAt: NOW,
        },
      });
      const beforeLegs =
        await managed.client.groundTransitLegExecution.findMany({
          where: { adoptedRouteId: route1 },
          include: { observations: true, stateTransitions: true },
          orderBy: { legIndex: 'asc' },
        });
      const unsupported = await query(
        userA,
        f.first.trip,
        f.B.id,
        f.C.id,
        departHint(),
      );
      expect(unsupported.json()).toMatchObject({
        error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
      });
      const queried = await query(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(queried.statusCode).toBe(200);
      const snapshotId = (queried.json() as RouteQueryResponse).candidates[0]!
        .candidateSnapshotId;
      expect(
        await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
          where: { id: snapshotId },
        }),
      ).toMatchObject({ fromNodeId: f.B.id, toNodeId: f.D.id });
      const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(preview.adoptable).toBe(true);
      expect(preview.changeSummary.routeCorridor).toMatchObject({
        replacementScope: 'SUFFIX',
        sourceAdoptedRouteId: route1,
        sourceRouteAnchorFromNodeId: f.A.id,
        sourceRouteAnchorToNodeId: f.D.id,
        replacementAnchorFromNodeId: f.B.id,
        replacementAnchorToNodeId: f.D.id,
      });
      expect(
        preview.changeSummary.willReplaceTransportEdgeIds?.slice().sort(),
      ).toEqual(f.suffixEdges.map((edge) => edge.id).sort());
      expect(
        preview.changeSummary.nodesToRemove?.map((node) => node.nodeId),
      ).toEqual([f.C.id]);
      const second = await adoptSuccessfully(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-suffix-adopt',
      );
      const route2 = second.operationReceipt.adoptedRouteId;
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route1 },
        }),
      ).toMatchObject({ status: 'REPLACED' });
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route2 },
        }),
      ).toMatchObject({
        status: 'ACTIVE',
        anchorFromNodeId: f.B.id,
        anchorToNodeId: f.D.id,
      });
      expect(
        await managed.client.transportEdge.findUniqueOrThrow({
          where: { id: f.prefix.id },
          include: {
            temporalValues: { orderBy: { id: 'asc' } },
            dayProjections: true,
          },
        }),
      ).toEqual(beforePrefix);
      const receipt = await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: second.operationReceipt.id },
      });
      expect(receipt.delta).toMatchObject({
        schemaVersion: 'route-adopt-delta-v4',
        replacementScope: 'SUFFIX',
        previousActiveAdoptedRouteId: route1,
        preservedPrefixTransportEdgeIds: [f.prefix.id],
      });
      expect(
        await managed.client.transportEdgeHistory.findMany({
          where: { tripId: f.first.trip.id },
        }),
      ).toEqual(
        expect.arrayContaining(
          f.suffixEdges.map((edge) =>
            expect.objectContaining({
              originalTransportEdgeId: edge.id,
              adoptedRouteId: route1,
            }),
          ),
        ),
      );
      expect(
        await managed.client.groundTransitLegExecution.findMany({
          where: { adoptedRouteId: route1 },
          include: { observations: true, stateTransitions: true },
          orderBy: { legIndex: 'asc' },
        }),
      ).toEqual(beforeLegs);
      expect(
        await managed.client.groundTransitLegExecution.count({
          where: { adoptedRouteId: route2 },
        }),
      ).toBe(2);
      expect(
        second.trip.connections.every(
          (connection) => connection.state === 'ACTIVE',
        ),
      ).toBe(true);
      const replay = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-suffix-adopt',
      );
      expect(replay.json()).toMatchObject({
        operationReceipt: { id: receipt.id },
        trip: { version: second.trip.version },
      });
      const undone = await undoSuccessfully(
        userA,
        second.trip,
        receipt.id,
        'synthetic-suffix-undo',
      );
      expect(undone.trip.version).toBe(second.trip.version + 1);
      expect(
        undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
      ).toEqual([f.A.id, f.B.id, f.C.id, f.D.id]);
      expect(
        undone.trip.connections
          .map((connection) => connection.transport!.id)
          .sort(),
      ).toEqual([f.prefix.id, ...f.suffixEdges.map((edge) => edge.id)].sort());
      expect(
        await managed.client.transportEdge.findUniqueOrThrow({
          where: { id: f.prefix.id },
          include: {
            temporalValues: { orderBy: { id: 'asc' } },
            dayProjections: true,
          },
        }),
      ).toEqual(beforePrefix);
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route1 },
        }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route2 },
        }),
      ).toMatchObject({ status: 'UNDONE' });
      expect(
        await managed.client.transportEdgeHistory.count({
          where: { tripId: f.first.trip.id },
        }),
      ).toBe(0);
      const restoredNodes = await managed.client.itineraryNode.findMany({
        where: { tripId: f.first.trip.id },
        orderBy: { position: 'asc' },
      });
      expect(
        restoredNodes.map((node) => [
          node.id,
          node.dayOccurrenceId,
          node.position,
          node.adoptedRouteId,
        ]),
      ).toEqual(
        beforeNodes.map((node) => [
          node.id,
          node.dayOccurrenceId,
          node.position,
          node.adoptedRouteId,
        ]),
      );
      const undoReplay = await undoSuccessfully(
        userA,
        second.trip,
        receipt.id,
        'synthetic-suffix-undo',
      );
      expect(undoReplay.operationReceipt.id).toBe(undone.operationReceipt.id);
    },
  );

  it('P5E2 4A: later suffix C→D preserves both prefix edges across Adopt/Undo', async () => {
    const f = await suffixFixture();
    const departedB = await manualExecution(
      f.first.trip,
      f.B.id,
      'MANUAL_DEPARTURE',
      '2030-10-01T10:20:00Z',
    );
    f.first.trip = (
      await manualExecution(
        departedB.trip,
        f.C.id,
        'MANUAL_ARRIVAL',
        '2030-10-01T10:40:00Z',
      )
    ).trip;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:45:00Z', '2030-10-01T11:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const preservedIds = [
      f.prefix.id,
      f.suffixEdges.find((edge) => edge.fromNodeId === f.B.id)!.id,
    ];
    const beforePrefix = await managed.client.transportEdge.findMany({
      where: { id: { in: preservedIds } },
      include: { temporalValues: true, dayProjections: true },
      orderBy: { id: 'asc' },
    });
    const preview = await createPreview(userA, f.first.trip, f.C.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:45:00Z',
      timeZone: 'UTC',
    });
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.routeCorridor).toMatchObject({
      replacementScope: 'SUFFIX',
      preservedPrefixNodeIds: [f.A.id, f.B.id, f.C.id],
      preservedPrefixTransportEdgeIds: preservedIds,
    });
    expect(preview.changeSummary.nodesToRemove).toEqual([]);
    expect(preview.changeSummary.willReplaceTransportEdgeIds).toEqual([
      f.suffixEdges.find((edge) => edge.fromNodeId === f.C.id)!.id,
    ]);
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-later-suffix',
    );
    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-later-suffix-undo',
    );
    expect(
      undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
    ).toEqual([f.A.id, f.B.id, f.C.id, f.D.id]);
    expect(
      await managed.client.transportEdge.findMany({
        where: { id: { in: preservedIds } },
        include: { temporalValues: true, dayProjections: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(beforePrefix);
  });

  it.each(['node', 'edge', 'prefix'])(
    'P5E2 4A: locked Adopt rechecks ACTUAL after Preview (%s)',
    async (kind) => {
      const f = await suffixFixture();
      const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(preview.adoptable).toBe(true);
      const fact =
        kind === 'prefix'
          ? await managed.client.temporalValue.update({
              where: {
                id: (
                  await managed.client.temporalValue.findFirstOrThrow({
                    where: {
                      transportEdgeId: f.prefix.id,
                      layer: 'ACTUAL',
                      pointKind: 'DEPARTURE',
                    },
                  })
                ).id,
              },
              data: { instant: new Date('2030-10-01T10:01:00Z') },
            })
          : await managed.client.temporalValue.create({
              data: {
                ...(kind === 'node'
                  ? { nodeId: f.C.id }
                  : { transportEdgeId: f.suffixEdges[0]!.id }),
                layer: 'ACTUAL',
                pointKind: 'DEPARTURE',
                instant: new Date('2030-10-01T10:30:00Z'),
                timeZone: 'UTC',
                sourceKind: 'USER_VALUE',
              },
            });
      const response = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-suffix-actual-race',
      );
      expect(response.statusCode).toBe(kind === 'prefix' ? 200 : 409);
      if (kind !== 'prefix')
        expect(response.json()).toMatchObject({
          error: { code: 'FACT_PROTECTED' },
        });
      expect(
        await managed.client.temporalValue.findUniqueOrThrow({
          where: { id: fact.id },
        }),
      ).toEqual(fact);
    },
  );

  it('P5E2 4A: concurrent suffix Adopts admit one transaction and preserve the prefix', async () => {
    const f = await suffixFixture();
    const hint = {
      type: 'DEPART_AT' as const,
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    };
    const [left, right] = await Promise.all([
      createPreview(userA, f.first.trip, f.B.id, f.D.id, hint),
      createPreview(userA, f.first.trip, f.B.id, f.D.id, hint),
    ]);
    const responses = await Promise.all([
      adopt(
        userA,
        f.first.trip,
        left.previewId,
        'synthetic-suffix-concurrent-a',
      ),
      adopt(
        userA,
        f.first.trip,
        right.previewId,
        'synthetic-suffix-concurrent-b',
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)!.json(),
    ).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: f.first.trip.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    expect(
      await managed.client.transportEdge.findUniqueOrThrow({
        where: { id: f.prefix.id },
      }),
    ).toEqual(f.prefix);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: f.first.trip.id, operationType: 'ROUTE_ADOPT' },
      }),
    ).toBe(2);
  });

  it('P5E2 4A: suffix V4 Undo restores accepted origin dwell adjustment', async () => {
    const f = await suffixFixture(true, true);
    const trip = await command(userA, f.first.trip, {
      type: 'SET_MIN_DWELL',
      nodeId: f.B.id,
      durationSeconds: 1200,
      locked: false,
    });
    const queried = await query(userA, trip, f.B.id, f.D.id, null);
    expect(queried.statusCode, JSON.stringify(queried.json())).toBe(200);
    const route = queried.json() as RouteQueryResponse;
    expect(route.candidates).toHaveLength(1);
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(response.statusCode).toBe(201);
    const preview = response.json() as RoutePreviewView;
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toEqual([
      expect.objectContaining({
        nodeId: f.B.id,
        fromDurationSeconds: 1200,
        toDurationSeconds: 600,
      }),
    ]);
    expect(preview.adoptable).toBe(true);
    const second = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-suffix-dwell',
      adjustments,
    );
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { nodeId: f.B.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 600 });
    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-suffix-dwell-undo',
    );
    expect(undone.trip.version).toBe(second.trip.version + 1);
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { nodeId: f.B.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 1200 });
    expect(
      await managed.client.temporalValue.findMany({
        where: { nodeId: f.B.id, layer: 'ACTUAL' },
      }),
    ).toEqual([
      expect.objectContaining({ instant: new Date('2030-10-01T10:20:00Z') }),
    ]);
  });

  it('P5E2 4A: suffix Undo restores cross-day projections and node placement', async () => {
    let initial = await createTrip(userA);
    initial = await addVisit(userA, initial, 'SYNTHETIC A', '2030-10-01');
    initial = await addVisit(userA, initial, 'SYNTHETIC D', '2030-10-03');
    const [a, d] = initial.days.flatMap((day) => day.nodes);
    providerResult = suffixFoundationCandidate(
      false,
      '2030-10-01T20:00:00Z',
      '2030-10-03T08:00:00Z',
    );
    const firstPreview = await createPreview(userA, initial, a!.id, d!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-cross-day-source',
    );
    const b = first.trip.days.flatMap((day) => day.nodes)[1]!;
    first.trip = (
      await confirmSourceOrigin(
        first.trip,
        a!.id,
        b.id,
        '2030-10-01T20:00:00Z',
        '2030-10-02T08:00:00Z',
      )
    ).trip;
    const beforeNodes = await managed.client.itineraryNode.findMany({
      where: { tripId: initial.id },
      orderBy: { id: 'asc' },
    });
    const beforeProjections =
      await managed.client.transportDayProjection.findMany({
        where: { tripId: initial.id },
        select: { transportEdgeId: true, dayOccurrenceId: true, role: true },
        orderBy: [
          { transportEdgeId: 'asc' },
          { dayOccurrenceId: 'asc' },
          { role: 'asc' },
        ],
      });
    expect(beforeProjections.map((projection) => projection.role)).toEqual(
      expect.arrayContaining(['START', 'END', 'SAME_DAY']),
    );
    providerResult = suffixFoundationCandidate(
      true,
      '2030-10-02T08:30:00Z',
      '2030-10-03T08:00:00Z',
    );
    const preview = await createPreview(userA, first.trip, b.id, d!.id, {
      type: 'DEPART_AT',
      instant: '2030-10-02T08:30:00Z',
      timeZone: 'UTC',
    });
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.routeCorridor?.replacementScope).toBe(
      'SUFFIX',
    );
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      preview.previewId,
      'synthetic-cross-day-suffix',
    );
    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-cross-day-suffix-undo',
    );
    expect(
      undone.trip.days.map((day) => [day.dayOccurrenceId, day.localDate]),
    ).toEqual(
      first.trip.days.map((day) => [day.dayOccurrenceId, day.localDate]),
    );
    const restoredNodes = await managed.client.itineraryNode.findMany({
      where: { tripId: initial.id },
      orderBy: { id: 'asc' },
    });
    expect(
      restoredNodes.map((node) => [
        node.id,
        node.dayOccurrenceId,
        node.position,
      ]),
    ).toEqual(
      beforeNodes.map((node) => [node.id, node.dayOccurrenceId, node.position]),
    );
    expect(
      await managed.client.transportDayProjection.findMany({
        where: { tripId: initial.id },
        select: { transportEdgeId: true, dayOccurrenceId: true, role: true },
        orderBy: [
          { transportEdgeId: 'asc' },
          { dayOccurrenceId: 'asc' },
          { role: 'asc' },
        ],
      }),
    ).toEqual(beforeProjections);
  });

  it.each(['route-adopt-delta-v2', 'route-adopt-delta-v3'])(
    'P5E2 4A: reads legacy full Preview JSON and %s Undo delta',
    async (schemaVersion) => {
      const initial = await tripWithVisits(userA, [
        'SYNTHETIC Legacy A',
        'SYNTHETIC Legacy D',
      ]);
      const [a, d] = initial.days[0]!.nodes;
      const preview = await createPreview(userA, initial, a!.id, d!.id);
      const stored = await managed.client.routePreview.findUniqueOrThrow({
        where: { id: preview.previewId },
      });
      const payload =
        stored.previewPayload as unknown as StoredRoutePreviewPayload;
      const corridor = payload.changeSummary.routeCorridor!;
      const legacyPayload: StoredRoutePreviewPayload = {
        ...payload,
        changeSummary: {
          ...payload.changeSummary,
          routeCorridor: {
            anchorFromNodeId: corridor.anchorFromNodeId,
            anchorToNodeId: corridor.anchorToNodeId,
            currentNodeIds: corridor.currentNodeIds,
            currentAdoptedRouteId: corridor.currentAdoptedRouteId,
          },
        },
      };
      await managed.client.routePreview.update({
        where: { id: preview.previewId },
        data: {
          previewPayload: legacyPayload as never,
          previewHash: hashRoutePreviewPayload(legacyPayload),
        },
      });
      const first = await adoptSuccessfully(
        userA,
        initial,
        preview.previewId,
        `synthetic-legacy-${schemaVersion}`,
      );
      const receipt = await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: first.operationReceipt.id },
      });
      await managed.client.operationReceipt.update({
        where: { id: receipt.id },
        data: {
          delta: {
            ...(receipt.delta as Record<string, unknown>),
            schemaVersion,
          } as never,
        },
      });
      const undone = await undoSuccessfully(
        userA,
        first.trip,
        receipt.id,
        `synthetic-legacy-undo-${schemaVersion}`,
      );
      expect(
        undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
      ).toEqual([a!.id, d!.id]);
      expect(undone.trip.version).toBe(first.trip.version + 1);
    },
  );

  it.each(['node', 'edge'])(
    'P5E2 4A: protects ACTUAL inside mutable suffix (%s)',
    async (kind) => {
      const f = await suffixFixture();
      const queried = await query(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(queried.statusCode).toBe(200);
      const snapshotId = (queried.json() as RouteQueryResponse).candidates[0]!
        .candidateSnapshotId;
      await managed.client.temporalValue.create({
        data: {
          ...(kind === 'node'
            ? { nodeId: f.C.id }
            : { transportEdgeId: f.suffixEdges[0]!.id }),
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: new Date('2030-10-01T10:40:00Z'),
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      });
      const preview = await previewFromSnapshot(
        userA,
        f.first.trip,
        snapshotId,
      );
      expect(preview.adoptable).toBe(false);
      const response = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-protected-suffix',
      );
      expect(['PREVIEW_BLOCKED', 'FACT_PROTECTED']).toContain(
        response.json().error.code,
      );
      expect(
        await managed.client.adoptedRoute.count({
          where: { tripId: f.first.trip.id },
        }),
      ).toBe(1);
      expect(
        await managed.client.transportEdge.count({
          where: { tripId: f.first.trip.id },
        }),
      ).toBe(3);
    },
  );

  it('P5E2 4A: uses existing monitoring cancellation and scheduler across suffix Adopt/Undo', async () => {
    const f = await suffixFixture();
    const r1 = f.first.operationReceipt.adoptedRouteId;
    await managed.client.tripAssistanceCapability.create({
      data: {
        tripId: f.first.trip.id,
        ownerUserId: userA.actor.userId,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: NOW,
      },
    });
    const queued = await managed.client.job.create({
      data: {
        type: 'GROUND_TRANSIT_MONITOR',
        runAt: NOW,
        uniqueKey: 'SYNTHETIC_4A_QUEUED',
        payloadRef: r1,
        capabilityRevision: 1,
        maxAttempts: 3,
      },
    });
    const running = await managed.client.job.create({
      data: {
        type: 'GROUND_TRANSIT_MONITOR',
        runAt: NOW,
        uniqueKey: 'SYNTHETIC_4A_RUNNING',
        payloadRef: r1,
        capabilityRevision: 1,
        maxAttempts: 3,
        status: 'RUNNING',
        leaseOwner: 'SYNTHETIC_WORKER',
        leaseUntil: new Date(NOW.getTime() + 30000),
      },
    });
    const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-suffix-monitor',
    );
    expect(
      await managed.client.job.findUniqueOrThrow({ where: { id: queued.id } }),
    ).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    expect(
      await managed.client.job.findUniqueOrThrow({ where: { id: running.id } }),
    ).toMatchObject({ status: 'RUNNING', cancelRequested: true });
    const repository = new PrismaGroundTransitRepository(managed.client);
    expect(
      await repository.ensureEligibleMonitoring(
        new Date('2030-10-01T10:25:00Z'),
      ),
    ).toBe(1);
    expect(
      await repository.listJobLegs({
        adoptedRouteId: r1,
        capabilityRevision: 1,
        now: new Date('2030-10-01T10:25:00Z'),
      }),
    ).toEqual([]);
    expect(
      await managed.client.job.findFirstOrThrow({
        where: {
          payloadRef: second.operationReceipt.adoptedRouteId,
          type: 'GROUND_TRANSIT_MONITOR',
        },
      }),
    ).toMatchObject({ status: 'QUEUED', cancelRequested: false });
    await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-suffix-monitor-undo',
    );
    expect(
      await managed.client.job.findFirstOrThrow({
        where: {
          payloadRef: second.operationReceipt.adoptedRouteId,
          type: 'GROUND_TRANSIT_MONITOR',
        },
      }),
    ).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    expect(
      await managed.client.tripAssistanceCapability.findFirstOrThrow({
        where: { tripId: f.first.trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      }),
    ).toMatchObject({ state: 'ENABLED', revision: 1 });
  });

  it.each([
    'new-actual',
    'prefix-facts',
    'prefix-topology',
    'delta-prefix',
    'delta-histories',
  ])('P5E2 4A: Undo fences %s without overwriting facts', async (mutation) => {
    const f = await suffixFixture();
    const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-suffix-conflict',
    );
    if (mutation === 'new-actual' || mutation === 'prefix-facts') {
      const edge =
        mutation === 'prefix-facts'
          ? f.prefix
          : await managed.client.transportEdge.findFirstOrThrow({
              where: { adoptedRouteId: second.operationReceipt.adoptedRouteId },
            });
      if (mutation === 'prefix-facts') {
        await managed.client.temporalValue.updateMany({
          where: {
            transportEdgeId: edge.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
          },
          data: { instant: new Date('2030-10-01T10:01:00Z') },
        });
      } else {
        await managed.client.temporalValue.create({
          data: {
            transportEdgeId: edge.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
            instant: new Date('2030-10-01T10:30:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
        });
      }
    } else if (mutation === 'prefix-topology') {
      await managed.client.transportEdge.update({
        where: { id: f.prefix.id },
        data: { adoptedRouteId: second.operationReceipt.adoptedRouteId },
      });
    } else {
      const receipt = await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: second.operationReceipt.id },
      });
      const delta = receipt.delta as Record<string, unknown>;
      await managed.client.operationReceipt.update({
        where: { id: receipt.id },
        data: {
          delta: {
            ...delta,
            ...(mutation === 'delta-prefix'
              ? { preservedPrefixTransportEdgeIds: [f.suffixEdges[0]!.id] }
              : { archivedTransportEdgeIds: [f.prefix.id] }),
          } as never,
        },
      });
    }
    const response = await undo(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-suffix-conflict-undo',
    );
    expect(response.json()).toMatchObject({ error: { code: 'UNDO_CONFLICT' } });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: second.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: f.first.trip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(0);
  });

  it.each(['version', 'route', 'origin', 'topology'])(
    'P5E2 4A: Preview/Adopt fence stale %s',
    async (mutation) => {
      const f = await suffixFixture();
      const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      if (mutation === 'version')
        await managed.client.trip.update({
          where: { id: f.first.trip.id },
          data: { version: { increment: 1 } },
        });
      if (mutation === 'route')
        await managed.client.adoptedRoute.update({
          where: { id: f.first.operationReceipt.adoptedRouteId },
          data: { status: 'REPLACED' },
        });
      if (mutation === 'origin')
        await managed.client.itineraryNode.update({
          where: { id: f.B.id },
          data: { source: 'USER_PLANNED', adoptedRouteId: null },
        });
      if (mutation === 'topology')
        await managed.client.transportEdge.delete({
          where: { id: f.suffixEdges[0]!.id },
        });
      const freshPreview = await app.inject({
        method: 'POST',
        url: `/trips/${f.first.trip.id}/previews`,
        headers: bearer(userA),
        payload: {
          basisVersion: f.first.trip.version,
          candidateSnapshotId: preview.candidateSnapshotId,
        },
      });
      expect(['VERSION_CONFLICT', 'PREVIEW_STALE']).toContain(
        freshPreview.json().error.code,
      );
      const response = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-stale-suffix',
      );
      expect(['VERSION_CONFLICT', 'PREVIEW_STALE']).toContain(
        response.json().error.code,
      );
    },
  );

  it('P5E2 4A: suffix remains owner scoped across Query/Preview/Adopt/Undo', async () => {
    const f = await suffixFixture();
    const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    for (const other of [userB, admin]) {
      expect(
        (
          await query(other, f.first.trip, f.B.id, f.D.id, {
            type: 'DEPART_AT',
            instant: '2030-10-01T10:30:00Z',
            timeZone: 'UTC',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/trips/${f.first.trip.id}/previews/${preview.previewId}`,
            headers: bearer(other),
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/trips/${f.first.trip.id}/previews`,
            headers: bearer(other),
            payload: {
              basisVersion: f.first.trip.version,
              candidateSnapshotId: preview.candidateSnapshotId,
            },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await adopt(
            other,
            f.first.trip,
            preview.previewId,
            'synthetic-private-suffix',
          )
        ).statusCode,
      ).toBe(404);
    }
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-private-suffix-owner',
    );
    for (const other of [userB, admin])
      expect(
        (
          await undo(
            other,
            second.trip,
            second.operationReceipt.id,
            'synthetic-private-undo',
          )
        ).statusCode,
      ).toBe(404);
  });

  async function controlledFormalState(tripId: string) {
    const s = await previewFormalState(tripId);
    const { routeCandidateSnapshots: _snapshots, ...planning } =
      s.footprint.planning;
    void _snapshots;
    return { ...s, footprint: { ...s.footprint, planning } };
  }
  async function controlledCancelledFixture() {
    const f = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(async (input) => {
        providerInputs.push(input);
        await providerHook?.();
        return providerResult;
      }),
      groundSequence(['CANCELLED', 'RECOVERY']),
    );
    const base = `/trips/${f.trip.id}/execution/ground-transit/${f.leg.transportEdgeId}`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/refresh`,
          headers: bearer(userA),
        })
      ).statusCode,
    ).toBe(200);
    const h = await app.inject({
      method: 'GET',
      url: `${base}/route-reevaluation`,
      headers: bearer(userA),
    });
    expect(h.json().readiness).toBe('READY');
    const owned = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    return {
      ...f,
      base,
      owned,
      handoff: h.json<GroundTransitRouteReevaluationHandoffView>(),
    };
  }
  function controlledSearch(
    tripId: string,
    handoff: GroundTransitRouteReevaluationHandoffView,
    who = userA,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${tripId}/alternatives/query`,
      headers: bearer(who),
      payload: { handoff },
    });
  }
  it('SYNTHETIC Japan Region Impact reads stay quiet; explicit TRANSIT search completes Snapshot Preview Adopt Undo', async () => {
    const f = await controlledCancelledFixture();
    await app.close();
    const dispatched: RouteProviderQueryInput[] = [];
    const ordinary = vi.fn(async () => {
      throw new Error('ordinary fallback forbidden');
    });
    app = buildTestApi(
      new RegionalRouteProvider({
        japanTransit: new SyntheticRouteProvider(async (input) => {
          dispatched.push(input);
          return providerResult;
        }),
        googleRoute: new SyntheticRouteProvider(ordinary),
        baiduRoute: new SyntheticRouteProvider(ordinary),
      }),
      groundSequence(['CANCELLED', 'RECOVERY']),
    );
    const formal = await controlledFormalState(f.trip.id);
    const impact = await app.inject({
      method: 'GET',
      url: `/trips/${f.trip.id}/impact`,
      headers: bearer(userA),
    });
    expect(impact.statusCode, impact.body).toBe(200);
    const handoff = await app.inject({
      method: 'GET',
      url: `${f.base}/route-reevaluation`,
      headers: bearer(userA),
    });
    expect(handoff.json().readiness).toBe('READY');
    expect(dispatched).toHaveLength(0);
    expect(await controlledFormalState(f.trip.id)).toEqual(formal);
    const searched = await controlledSearch(
      f.trip.id,
      handoff.json<GroundTransitRouteReevaluationHandoffView>(),
    );
    expect(searched.statusCode, searched.body).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.travelMode).toBe('TRANSIT');
    const c =
      searched.json<
        import('@travel/contracts').ControlledAlternativeSearchResponse
      >().result.candidates[0]!;
    expect(c.candidateSnapshotId).toBeTruthy();
    expect(await controlledFormalState(f.trip.id)).toEqual(formal);
    const preview = await previewFromSnapshot(
      userA,
      f.owned,
      c.candidateSnapshotId,
    );
    expect(preview.adoptable).toBe(true);
    expect(await controlledFormalState(f.trip.id)).toEqual(formal);
    const adopted = await adoptSuccessfully(
      userA,
      f.owned,
      preview.previewId,
      randomUUID(),
    );
    expect(adopted.trip.version).toBe(f.owned.version + 1);
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      randomUUID(),
    );
    expect(undone.trip.days.flatMap((d) => d.nodes).map((n) => n.id)).toEqual(
      f.owned.days.flatMap((d) => d.nodes).map((n) => n.id),
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
    expect(dispatched).toHaveLength(1);
    expect(ordinary).not.toHaveBeenCalled();
  });
  it('P6C-2 controlled FULL search writes only evidence, then explicit Preview Adopt replay and Undo', async () => {
    const f = await controlledCancelledFixture();
    const formal = await controlledFormalState(f.trip.id);
    const searched = await controlledSearch(f.trip.id, f.handoff);
    expect(searched.statusCode, searched.body).toBe(200);
    const c =
      searched.json<
        import('@travel/contracts').ControlledAlternativeSearchResponse
      >().result.candidates[0]!;
    expect(c).toBeDefined();
    // Evidence is excluded deliberately: Query cannot change any formal or execution facts.
    const afterQuery = await controlledFormalState(f.trip.id);
    expect(afterQuery).toEqual(formal);
    const p = await previewFromSnapshot(userA, f.owned, c.candidateSnapshotId);
    expect(p.changeSummary.routeCorridor?.replacementScope).toBe(
      'FULL_CORRIDOR',
    );
    expect(await controlledFormalState(f.trip.id)).toEqual(formal);
    const key = randomUUID();
    const adopted = await adoptSuccessfully(userA, f.owned, p.previewId, key);
    const replay = await adopt(userA, f.owned, p.previewId, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().operationReceipt.id).toBe(adopted.operationReceipt.id);
    expect(adopted.trip.version).toBe(f.owned.version + 1);
    const impact = await app.inject({
      method: 'GET',
      url: `/trips/${f.trip.id}/impact`,
      headers: bearer(userA),
    });
    expect(impact.json().basisVersion).toBe(adopted.trip.version);
    const today = await app.inject({
      method: 'GET',
      url: `/trips/${f.trip.id}/in-trip`,
      headers: bearer(userA),
    });
    expect(today.statusCode).toBe(200);
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      randomUUID(),
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
  });
  it('P6C-2 controlled external search retains E and only explicit Adopt materializes it', async () => {
    const f = await confirmedExternalQueryFixture();
    const h = (
      await app.inject({
        method: 'GET',
        url: `${f.base}/route-reevaluation`,
        headers: bearer(userA),
      })
    ).json<GroundTransitRouteReevaluationHandoffView>();
    expect(h.originBasis).toBe('CONFIRMED_EXTERNAL_EXECUTION_ORIGIN');
    const formal = await controlledFormalState(f.trip.id);
    const searched = await controlledSearch(f.trip.id, h);
    expect(searched.statusCode, searched.body).toBe(200);
    expect(await controlledFormalState(f.trip.id)).toEqual(formal);
    const owned = (
      await app.inject({
        method: 'GET',
        url: `/trips/${f.trip.id}`,
        headers: bearer(userA),
      })
    ).json<TripView>();
    const p = await previewFromSnapshot(
      userA,
      owned,
      searched.json().result.candidates[0].candidateSnapshotId,
    );
    expect(p.changeSummary.externalOriginReplacement?.externalOriginId).toBe(
      f.result.origin.id,
    );
    expect(p.adoptable).toBe(true);
    const adopted = await adoptSuccessfully(
      userA,
      owned,
      p.previewId,
      randomUUID(),
    );
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      randomUUID(),
    );
    expect(undone.trip.days.flatMap((d) => d.nodes).map((n) => n.id)).toEqual(
      owned.days.flatMap((d) => d.nodes).map((n) => n.id),
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${f.base}/route-reevaluation`,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      readiness: 'READY',
      externalQuery: { basisVersion: undone.trip.version },
    });
  });
  it.each([
    'version',
    'recovery',
    'origin',
    'foreign',
    'admin',
    'provider',
    'evidence',
  ] as const)(
    'P6C-2 controlled search fences %s without formal writes',
    async (kind) => {
      const f = await controlledCancelledFixture();
      if (kind === 'version')
        await managed.client.trip.update({
          where: { id: f.trip.id },
          data: { version: { increment: 1 } },
        });
      if (kind === 'recovery') {
        currentNow = new Date(currentNow.getTime() + 60000);
        await app.inject({
          method: 'POST',
          url: `${f.base}/refresh`,
          headers: bearer(userA),
        });
      }
      if (kind === 'evidence') {
        await managed.client.groundTransitLegExecution.update({
          where: { id: f.leg.id },
          data: { latestFetchedAt: new Date(currentNow.getTime() + 1000) },
        });
        expect(await readVersion(f.trip.id)).toBe(f.owned.version);
      }
      if (kind === 'provider')
        providerResult = {
          status: 'PROVIDER_UNAVAILABLE',
          reason: 'UPSTREAM_UNAVAILABLE',
        };
      const h =
        kind === 'origin'
          ? {
              ...f.handoff,
              query: { ...f.handoff.query!, fromNodeId: randomUUID() },
            }
          : f.handoff;
      const before = await controlledFormalState(f.trip.id),
        calls = providerInputs.length;
      const response = await controlledSearch(
        f.trip.id,
        h,
        kind === 'foreign' ? userB : kind === 'admin' ? admin : userA,
      );
      expect(response.statusCode, response.body).toBe(
        kind === 'foreign' || kind === 'admin'
          ? 404
          : kind === 'provider'
            ? 503
            : 409,
      );
      expect(await controlledFormalState(f.trip.id)).toEqual(before);
      expect(providerInputs.length).toBe(calls + (kind === 'provider' ? 1 : 0));
    },
  );
  it('P6C-2 provider-return version race is rejected by existing snapshot fence', async () => {
    const f = await controlledCancelledFixture();
    const count = await managed.client.routeCandidateSnapshot.count({
      where: { tripId: f.trip.id },
    });
    providerHook = async () => {
      await managed.client.trip.update({
        where: { id: f.trip.id },
        data: { version: { increment: 1 } },
      });
    };
    const result = await controlledSearch(f.trip.id, f.handoff);
    expect(result.statusCode, result.body).toBe(409);
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: f.trip.id },
      }),
    ).toBe(count);
  });
  it('P6C-2 confirmed suffix search retains prefix and authoritative suffix Preview', async () => {
    const f = await suffixFixture(false, false, false);
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED']),
    );
    const source = f.suffixEdges.find((e) => e.fromNodeId === f.C.id)!;
    const base = `/trips/${f.first.trip.id}/execution/ground-transit/${source.id}`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/refresh`,
          headers: bearer(userA),
        })
      ).statusCode,
    ).toBe(200);
    const owned = (await confirmSourceOrigin(f.first.trip, f.A.id, f.B.id))
      .trip;
    const h = (
      await app.inject({
        method: 'GET',
        url: `${base}/route-reevaluation`,
        headers: bearer(userA),
      })
    ).json<GroundTransitRouteReevaluationHandoffView>();
    expect(h).toMatchObject({
      readiness: 'READY',
      originBasis: 'CONFIRMED_EXECUTION_NODE',
      query: { fromNodeId: f.B.id, toNodeId: f.D.id },
    });
    const before = await controlledFormalState(owned.id);
    const searched = await controlledSearch(owned.id, h);
    expect(searched.statusCode, searched.body).toBe(200);
    expect(await controlledFormalState(owned.id)).toEqual(before);
    const p = await previewFromSnapshot(
      userA,
      owned,
      searched.json().result.candidates[0].candidateSnapshotId,
    );
    expect(p.changeSummary.routeCorridor).toMatchObject({
      replacementScope: 'SUFFIX',
      preservedPrefixNodeIds: [f.A.id, f.B.id],
      preservedPrefixTransportEdgeIds: [f.prefix.id],
    });
    const adopted = await adoptSuccessfully(
      userA,
      owned,
      p.previewId,
      randomUUID(),
    );
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      randomUUID(),
    );
    expect(undone.trip.days.flatMap((d) => d.nodes).map((n) => n.id)).toEqual(
      owned.days.flatMap((d) => d.nodes).map((n) => n.id),
    );
  });
  it('P6C-2 integrated Impact/adjustment GET, Query and Preview have exact C row footprints', async () => {
    const f = await controlledCancelledFixture();
    const before = await footprint(managed, f.trip.id);
    const providerBefore = providerInputs.length;
    const impact = await app.inject({
      method: 'GET',
      url: `/trips/${f.trip.id}/impact`,
      headers: bearer(userA),
    });
    const handoff = await app.inject({
      method: 'GET',
      url: `${f.base}/route-reevaluation`,
      headers: bearer(userA),
    });
    expect(impact.statusCode).toBe(200);
    expect(handoff.statusCode).toBe(200);
    expect(providerInputs.length).toBe(providerBefore);
    onlyWrites(before, await footprint(managed, f.trip.id));
    const result = await controlledSearch(f.trip.id, f.handoff);
    expect(result.statusCode, result.body).toBe(200);
    const queried = await footprint(managed, f.trip.id);
    onlyWrites(before, queried, ['snapshots']);
    const p = await previewFromSnapshot(
      userA,
      f.owned,
      result.json().result.candidates[0].candidateSnapshotId,
    );
    const previewed = await footprint(managed, f.trip.id);
    onlyWrites(queried, previewed, ['previews']);
    expect(p.adoptable).toBe(true);
    expect(previewed.previews.length).toBe(queried.previews.length + 1);
  });

  it('P6C-2 integrated Query failure and stale Preview/Adopt preserve C full-row footprint and Backup', async () => {
    const f = await controlledCancelledFixture();
    const generated = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/backup`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: f.owned.version,
        idempotencyKey: randomUUID(),
      },
    });
    expect(generated.statusCode, generated.body).toBe(200);
    const goodResult = providerResult;
    providerResult = {
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'UPSTREAM_UNAVAILABLE',
    };
    const before = await footprint(managed, f.trip.id);
    const failed = await controlledSearch(f.trip.id, f.handoff);
    expect(failed.statusCode, failed.body).toBe(503);
    onlyWrites(before, await footprint(managed, f.trip.id));
    providerResult = goodResult;
    const result = await controlledSearch(f.trip.id, f.handoff);
    expect(result.statusCode, result.body).toBe(200);
    const candidateId = result.json().result.candidates[0].candidateSnapshotId;
    const p = await previewFromSnapshot(userA, f.owned, candidateId);
    await managed.client.trip.update({
      where: { id: f.trip.id },
      data: { version: { increment: 1 } },
    });
    const advanced = await footprint(managed, f.trip.id);
    const stalePreview = await app.inject({
      method: 'POST',
      url: `/trips/${f.trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: f.owned.version,
        candidateSnapshotId: candidateId,
      },
    });
    const staleAdopt = await adopt(userA, f.owned, p.previewId, randomUUID());
    expect(stalePreview.statusCode).toBe(409);
    expect(staleAdopt.statusCode).toBe(409);
    onlyWrites(advanced, await footprint(managed, f.trip.id));
    expect(advanced.backups).toEqual(before.backups);
  });

  async function createPreview(
    identity: SyntheticIdentity,
    trip: TripView,
    fromNodeId: string,
    toNodeId: string,
    hint: Record<string, unknown> = departHint(),
  ): Promise<RoutePreviewView> {
    const routeResponse = await query(
      identity,
      trip,
      fromNodeId,
      toNodeId,
      hint,
    );
    expect(routeResponse.statusCode).toBe(200);
    const route = routeResponse.json() as RouteQueryResponse;
    return previewFromSnapshot(
      identity,
      trip,
      route.candidates[0]!.candidateSnapshotId,
    );
  }

  async function previewFromSnapshot(
    identity: SyntheticIdentity,
    trip: TripView,
    snapshotId: string,
  ): Promise<RoutePreviewView> {
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(identity),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: snapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    return previewResponse.json() as RoutePreviewView;
  }

  function adopt(
    identity: SyntheticIdentity,
    trip: TripView,
    previewId: string,
    idempotencyKey: string,
    acceptedUserAdjustments?: readonly {
      readonly intentId: string;
      readonly nodeId: string;
      readonly fromDurationSeconds: number;
      readonly toDurationSeconds: number;
    }[],
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews/${previewId}/adopt`,
      headers: bearer(identity),
      payload: {
        baseTripVersion: trip.version,
        idempotencyKey,
        ...(acceptedUserAdjustments === undefined
          ? {}
          : { acceptedUserAdjustments }),
      },
    });
  }

  async function adoptSuccessfully(
    identity: SyntheticIdentity,
    trip: TripView,
    previewId: string,
    idempotencyKey: string,
    acceptedUserAdjustments?: readonly {
      readonly intentId: string;
      readonly nodeId: string;
      readonly fromDurationSeconds: number;
      readonly toDurationSeconds: number;
    }[],
  ): Promise<{
    operationReceipt: {
      id: string;
      operationType: 'ROUTE_ADOPT';
      adoptedRouteId: string;
      resultingTripVersion: number;
    };
    trip: TripView;
  }> {
    const response = await adopt(
      identity,
      trip,
      previewId,
      idempotencyKey,
      acceptedUserAdjustments,
    );
    expect(response.statusCode).toBe(200);
    return response.json() as {
      operationReceipt: {
        id: string;
        operationType: 'ROUTE_ADOPT';
        adoptedRouteId: string;
        resultingTripVersion: number;
      };
      trip: TripView;
    };
  }

  function undo(
    identity: SyntheticIdentity,
    trip: TripView,
    operationReceiptId: string,
    idempotencyKey: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/operations/${operationReceiptId}/undo`,
      headers: bearer(identity),
      payload: {
        baseTripVersion: trip.version,
        idempotencyKey,
      },
    });
  }

  async function undoSuccessfully(
    identity: SyntheticIdentity,
    trip: TripView,
    operationReceiptId: string,
    idempotencyKey: string,
  ): Promise<{
    operationReceipt: {
      id: string;
      operationType: 'ROUTE_UNDO';
      targetOperationReceiptId: string;
      baseTripVersion: number;
      resultingTripVersion: number;
      delta: Record<string, unknown>;
    };
    trip: TripView;
  }> {
    const response = await undo(
      identity,
      trip,
      operationReceiptId,
      idempotencyKey,
    );
    expect(response.statusCode).toBe(200);
    return response.json() as {
      operationReceipt: {
        id: string;
        operationType: 'ROUTE_UNDO';
        targetOperationReceiptId: string;
        baseTripVersion: number;
        resultingTripVersion: number;
        delta: Record<string, unknown>;
      };
      trip: TripView;
    };
  }

  async function databaseFacts(tripId: string) {
    const [trip, timeValues, intents, transports] = await Promise.all([
      managed.client.trip.findUniqueOrThrow({ where: { id: tripId } }),
      managed.client.temporalValue.count(),
      managed.client.userTimeIntent.count({ where: { tripId } }),
      managed.client.transportEdge.count({ where: { tripId } }),
    ]);
    return { version: trip.version, timeValues, intents, transports };
  }
});

interface SyntheticIdentity {
  readonly credential: string;
  readonly actor: Actor;
}

function departHint() {
  return {
    type: 'DEPART_AT',
    instant: '2030-10-01T19:00:00+09:00',
    timeZone: 'Asia/Tokyo',
  };
}

function googleExpectedLegs() {
  return [
    { mode: 'WALKING', fixedService: false },
    { mode: 'BUS', fixedService: true },
    { mode: 'WALKING', fixedService: false },
    { mode: 'RAIL', fixedService: true },
    { mode: 'WALKING', fixedService: false },
    { mode: 'BUS', fixedService: true },
    { mode: 'WALKING', fixedService: false },
  ] as const;
}

function googleConsumerHokkaidoFixture(
  requestedQuery: Record<string, unknown>,
) {
  const stops = [
    ['Hotel Mahoroba', 42.4930624, 141.1419064],
    ['登别温泉中央', 42.495, 141.143],
    ['登别站前', 42.45, 141.18],
    ['登别站', 42.452, 141.181],
    ['洞爷站', 42.55, 140.764],
    ['洞爷站前', 42.551, 140.765],
    ['洞爷湖温泉', 42.566, 140.82],
    ['洞爷湖景乃之风', 42.565637, 140.8222622],
  ] as const;
  const legs = [
    googleSidecarLeg('WALK', 0, 1, '15:00', '15:05', null),
    googleSidecarLeg('BUS', 1, 2, '15:05', '15:25', '道南巴士 1'),
    googleSidecarLeg('WALK', 2, 3, '15:25', '15:30', null),
    googleSidecarLeg('TRAIN', 3, 4, '15:30', '16:15', '北斗 16号'),
    googleSidecarLeg('WALK', 4, 5, '16:15', '16:20', null),
    googleSidecarLeg('BUS', 5, 6, '16:20', '16:50', '洞爷湖线'),
    googleSidecarLeg('WALK', 6, 7, '16:50', '17:00', null),
  ].map((leg) => ({
    ...leg,
    from: googleSidecarStop(stops[leg.fromIndex]!),
    to: googleSidecarStop(stops[leg.toIndex]!),
    fromIndex: undefined,
    toIndex: undefined,
  }));
  return {
    status: 'OK',
    requestId: 'sanitized-request-id',
    provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
    requestedQuery,
    queryVerified: true,
    fetchedAt: '2026-09-20T05:01:00.000Z',
    elapsedMs: 7_336,
    candidateCount: 1,
    candidates: [
      {
        id: 'sanitized-hokkaido-01',
        sourceIndex: 0,
        departureTime: googleSidecarTime('15:00'),
        arrivalTime: googleSidecarTime('17:00'),
        durationSeconds: 7_200,
        fare: { currency: 'JPY', amount: 3_910, displayText: 'JPY 3,910' },
        legs,
        warnings: [],
      },
    ],
    warnings: [],
    cacheHit: false,
    timing: {
      browserStartupMs: 0,
      contextCreationMs: 0,
      navigationMs: 100,
      directionsResponseMs: 7_200,
      parseMs: 20,
      sentinelMs: 16,
      totalMs: 7_336,
    },
  };
}

function googleSidecarLeg(
  mode: string,
  fromIndex: number,
  toIndex: number,
  departure: string,
  arrival: string,
  serviceName: string | null,
) {
  const durationSeconds =
    (Date.parse(`2026-09-23T${arrival}:00+09:00`) -
      Date.parse(`2026-09-23T${departure}:00+09:00`)) /
    1_000;
  return {
    mode,
    fromIndex,
    toIndex,
    departureTime: googleSidecarTime(departure),
    arrivalTime: googleSidecarTime(arrival),
    durationSeconds,
    serviceName,
    lineName: serviceName,
  };
}

function googleSidecarTime(time: string) {
  return {
    localDateTime: `2026-09-23T${time}:00`,
    timezone: 'Asia/Tokyo',
    utc: new Date(`2026-09-23T${time}:00+09:00`).toISOString(),
  };
}

function googleSidecarStop(stop: readonly [string, number, number]) {
  return { name: stop[0], latitude: stop[1], longitude: stop[2] };
}

function candidate(
  departure: string,
  arrival: string,
  departureTimeZone = 'Asia/Tokyo',
  arrivalTimeZone = 'America/Los_Angeles',
): Extract<RouteProviderResult, { status: 'SUCCESS' }>['candidates'][number] {
  const durationSeconds =
    (new Date(arrival).getTime() - new Date(departure).getTime()) / 1_000;
  const origin = {
    name: 'Origin',
    latitude: 35.6762,
    longitude: 139.6503,
    providerPlaceRef: 'origin',
  };
  const destination = {
    name: 'Destination',
    latitude: 34.0522,
    longitude: -118.2437,
    providerPlaceRef: 'destination',
  };
  return {
    candidateId: `candidate-${departure}-${arrival}`,
    provider: 'SYNTHETIC',
    providerCandidateRef: 'SYNTHETIC_REF',
    observedAt: NOW,
    validUntil: null,
    departure: { instant: new Date(departure), timeZone: departureTimeZone },
    arrival: { instant: new Date(arrival), timeZone: arrivalTimeZone },
    durationSeconds,
    legs: [
      {
        mode: 'FLIGHT',
        from: origin,
        to: destination,
        departure: {
          instant: new Date(departure),
          timeZone: departureTimeZone,
        },
        arrival: {
          instant: new Date(arrival),
          timeZone: arrivalTimeZone,
        },
        durationSeconds,
        fixedService: true,
        serviceLabel: 'SYNTHETIC-1',
        providerRef: 'SYNTHETIC_LEG',
      },
    ],
    fare: null,
  };
}

function replacementSingleCandidate(
  suffix: string,
): Extract<RouteProviderResult, { status: 'SUCCESS' }>['candidates'][number] {
  const replacement = candidate('2030-10-01T10:00:00Z', '2030-10-01T11:00:00Z');
  const [leg] = replacement.legs;
  if (leg === undefined) {
    throw new Error('Synthetic replacement candidate must contain one leg.');
  }

  return {
    ...replacement,
    candidateId: `candidate-${suffix}`,
    providerCandidateRef: `SYNTHETIC_REF_${suffix}`,
    legs: [
      {
        ...leg,
        serviceLabel: `SYNTHETIC-${suffix}`,
        providerRef: `SYNTHETIC_LEG_${suffix}`,
      },
    ],
  };
}

function singleCandidateForLocalDate(
  localDate: string,
): Extract<RouteProviderResult, { status: 'SUCCESS' }>['candidates'][number] {
  return candidate(
    `${localDate}T10:00:00Z`,
    `${localDate}T11:00:00Z`,
    'UTC',
    'UTC',
  );
}

function transferCandidate(): Extract<
  RouteProviderResult,
  { status: 'SUCCESS' }
> {
  const origin = {
    name: 'Origin',
    latitude: 35.6762,
    longitude: 139.6503,
    providerPlaceRef: 'origin',
    providerHubRef: null,
  };
  const transfer = {
    name: 'Transfer Station',
    latitude: 35.68,
    longitude: 139.66,
    providerPlaceRef: 'transfer-station',
    providerHubRef: 'hub-transfer',
  };
  const destination = {
    name: 'Destination',
    latitude: 35.69,
    longitude: 139.67,
    providerPlaceRef: 'destination',
    providerHubRef: null,
  };
  const departure = new Date('2030-10-01T10:00:00Z');
  const transferAt = new Date('2030-10-01T10:30:00Z');
  const arrival = new Date('2030-10-01T11:00:00Z');
  return {
    status: 'SUCCESS',
    candidates: [
      {
        candidateId: 'candidate-transfer',
        provider: 'SYNTHETIC',
        providerCandidateRef: 'SYNTHETIC_TRANSFER',
        observedAt: NOW,
        validUntil: null,
        departure: { instant: departure, timeZone: 'UTC' },
        arrival: { instant: arrival, timeZone: 'UTC' },
        durationSeconds: 3600,
        legs: [
          {
            mode: 'RAIL',
            from: origin,
            to: transfer,
            departure: { instant: departure, timeZone: 'UTC' },
            arrival: { instant: transferAt, timeZone: 'UTC' },
            durationSeconds: 1800,
            fixedService: true,
            serviceLabel: 'SYNTHETIC-R1',
            providerRef: 'SYNTHETIC-R1',
          },
          {
            mode: 'WALKING',
            from: transfer,
            to: destination,
            departure: { instant: transferAt, timeZone: 'UTC' },
            arrival: { instant: arrival, timeZone: 'UTC' },
            durationSeconds: 1800,
            fixedService: false,
            serviceLabel: null,
            providerRef: 'SYNTHETIC-W1',
          },
        ],
        fare: null,
      },
    ],
  };
}

function suffixFoundationCandidate(
  suffix: boolean,
  departureInstant?: string,
  arrivalInstant?: string,
): Extract<RouteProviderResult, { status: 'SUCCESS' }> {
  const base = transferCandidate().candidates[0]!;
  const b = base.legs[0]!.to;
  const c = {
    ...b,
    name: suffix ? 'SYNTHETIC X' : 'SYNTHETIC C',
    providerPlaceRef: suffix ? 'synthetic-x' : 'synthetic-c',
    providerHubRef: suffix ? 'hub-x' : 'hub-c',
    latitude: 35.685,
    longitude: 139.665,
  };
  const locations = suffix
    ? [b, c, base.legs[1]!.to]
    : [base.legs[0]!.from, b, c, base.legs[1]!.to];
  const start = new Date(
    departureInstant ??
      (suffix ? '2030-10-01T10:30:00Z' : '2030-10-01T10:00:00Z'),
  );
  const duration =
    arrivalInstant === undefined
      ? suffix
        ? 900
        : 1200
      : (new Date(arrivalInstant).getTime() - start.getTime()) /
        1000 /
        (locations.length - 1);
  const legs = locations.slice(0, -1).map((from, index) => ({
    ...base.legs[0]!,
    from,
    to: locations[index + 1]!,
    departure: {
      instant: new Date(start.getTime() + index * duration * 1000),
      timeZone: 'UTC',
    },
    arrival: {
      instant: new Date(start.getTime() + (index + 1) * duration * 1000),
      timeZone: 'UTC',
    },
    durationSeconds: duration,
    serviceLabel: `SYNTHETIC_4A_${index}`,
    providerRef: `SYNTHETIC_4A_${index}`,
    groundTransit: {
      serviceClass: 'FIXED_SERVICE' as const,
      serviceIdentityKey: `synthetic:4a:${suffix}:${index}`,
      lineRef: 'synthetic-rail',
      lineName: 'SYNTHETIC Rail',
      directionRef: 'east',
      directionLabel: 'SYNTHETIC East',
      boardingHubRef: from.providerHubRef ?? from.providerPlaceRef,
      alightingHubRef:
        locations[index + 1]!.providerHubRef ??
        locations[index + 1]!.providerPlaceRef,
      headwayMinSeconds: null,
      headwayMaxSeconds: null,
      minimumTransferSeconds: 0,
      boardingAccessMinimumSeconds: 0,
    },
  }));
  return {
    status: 'SUCCESS',
    candidates: [
      {
        ...base,
        candidateId: suffix ? 'synthetic-suffix' : 'synthetic-source',
        legs,
        departure: legs[0]!.departure,
        arrival: legs.at(-1)!.arrival,
        durationSeconds: duration * legs.length,
      },
    ],
  };
}

function dateRollbackTransferCandidate(): Extract<
  RouteProviderResult,
  { status: 'SUCCESS' }
> {
  const result = transferCandidate();
  const candidate = result.candidates[0]!;
  const first = candidate.legs[0]!;
  const second = candidate.legs[1]!;
  const departure = new Date('2030-10-01T10:00:00Z');
  const transferAt = new Date('2030-10-01T16:00:00Z');
  const arrival = new Date('2030-10-01T18:00:00Z');
  return {
    status: 'SUCCESS',
    candidates: [
      {
        ...candidate,
        candidateId: 'candidate-date-rollback-transfer',
        departure: { instant: departure, timeZone: 'Asia/Tokyo' },
        arrival: { instant: arrival, timeZone: 'America/Los_Angeles' },
        durationSeconds: 28_800,
        legs: [
          {
            ...first,
            departure: { instant: departure, timeZone: 'Asia/Tokyo' },
            arrival: {
              instant: transferAt,
              timeZone: 'Pacific/Kiritimati',
            },
            durationSeconds: 21_600,
          },
          {
            ...second,
            departure: {
              instant: transferAt,
              timeZone: 'Pacific/Kiritimati',
            },
            arrival: {
              instant: arrival,
              timeZone: 'America/Los_Angeles',
            },
            durationSeconds: 7_200,
          },
        ],
      },
    ],
  };
}

async function createIdentity(
  managed: ManagedPrismaClient,
  email: string,
  role: 'ADMIN' | 'USER',
): Promise<SyntheticIdentity> {
  const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
  const user = await managed.client.user.create({
    data: {
      email,
      normalizedEmail: email,
      role,
      preference: { create: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' } },
      sessions: {
        create: {
          tokenDigest: digestOpaqueToken(credential),
          expiresAt: new Date(NOW.getTime() + 86_400_000),
        },
      },
    },
  });
  return {
    credential,
    actor: { userId: user.id, email: user.email, role, status: 'ACTIVE' },
  };
}

function bearer(identity: SyntheticIdentity) {
  return { authorization: `Bearer ${identity.credential}` };
}

function authConfig() {
  return {
    magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
    magicLinkTtlSeconds: 600,
    sessionTtlSeconds: 86_400,
    invitationTtlSeconds: 86_400,
    rateLimitWindowSeconds: 300,
    rateLimitMaxRequests: 50,
    defaultBaseCurrency: 'CNY',
    defaultUiLanguage: 'zh-CN',
    jobMaxAttempts: 5,
  };
}

async function resetSyntheticData(managed: ManagedPrismaClient): Promise<void> {
  await managed.client.outboxEvent.deleteMany();
  await managed.client.operationReceipt.deleteMany();
  await managed.client.userTimeIntent.deleteMany();
  await managed.client.transportEdgeHistoryTimeValue.deleteMany();
  await managed.client.transportEdgeHistory.deleteMany();
  await managed.client.temporalValue.deleteMany();
  await managed.client.transportDayProjection.deleteMany();
  await managed.client.transportEdge.deleteMany();
  // Synthetic-only cleanup: suffix anchors can be route-generated, forming
  // a route/node FK cycle. Detach metadata atomically before deleting routes.
  await managed.client.itineraryNode.updateMany({
    where: { source: 'ROUTE_GENERATED' },
    data: { source: 'USER_PLANNED', adoptedRouteId: null },
  });
  await managed.client.adoptedRoute.deleteMany();
  await managed.client.itineraryNode.deleteMany();
  await managed.client.dayOccurrence.deleteMany();
  await managed.client.dateOwnership.deleteMany();
  await managed.client.trip.deleteMany();
  await managed.client.place.deleteMany();
  await managed.client.notificationEvent.deleteMany();
  await managed.client.storedObject.deleteMany();
  await managed.client.magicLinkRequestBucket.deleteMany();
  await managed.client.job.deleteMany();
  await managed.client.session.deleteMany();
  await managed.client.magicLinkToken.deleteMany();
  await managed.client.magicLinkDeliveryRequest.deleteMany();
  await managed.client.userPreference.deleteMany();
  await managed.client.invitation.deleteMany();
  await managed.client.user.deleteMany();
}
