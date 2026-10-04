import { randomUUID } from 'node:crypto';
import {
  AuthService,
  digestOpaqueToken,
  ExecutionLocationService,
  ExecutionRiskService,
  GroundTransitRouteReevaluationService,
  GroundTransitService,
  InTripReadService,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  RouteUndoService,
  StaticBackupService,
  TripImpactService,
  TripService,
  type FlightMonitoringService,
  type RouteProviderQueryInput,
  type RouteProviderResult,
} from '@travel/application';
import type {
  AdoptRoutePreviewResponse,
  RoutePreviewView,
  RouteQueryResponse,
  TripView,
} from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaExecutionLocationRepository,
  PrismaExecutionRiskRepository,
  PrismaGroundTransitRepository,
  PrismaGroundTransitRouteProgressRepository,
  PrismaInTripReadRepository,
  PrismaRoutePlanningRepository,
  PrismaStaticBackupRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import {
  SyntheticGroundTransitProvider,
  SyntheticRouteProvider,
} from '@travel/providers';
import { expect } from 'vitest';
import { buildApi } from '../../src/app.js';

// Gates, not sleeps: a caller knows exactly when a synthetic request has arrived.
export function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

export async function waitForOwnerLock(
  managed: ManagedPrismaClient,
  requests: number,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await managed.client.$queryRaw<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND position('pg_advisory_xact_lock' in query) > 0 AND pid <> pg_backend_pid()
    `;
    if (rows[0]!.count >= requests) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('SYNTHETIC request never reached owner lock');
}
export interface SyntheticOwner {
  id: string;
  credential: string;
}
export function bearer(owner: SyntheticOwner) {
  return { authorization: `Bearer ${owner.credential}` };
}

export function replanningHarness(databaseUrl: string) {
  const managed = createPrismaClient(databaseUrl);
  const client = managed.client;
  let now = new Date('2030-09-01T00:00:00Z');
  const owners: SyntheticOwner[] = [];
  const inputs: RouteProviderQueryInput[] = [];
  let providerHook: (() => Promise<void>) | undefined;
  let result: RouteProviderResult | undefined;
  const provider = new SyntheticRouteProvider(async (input) => {
    inputs.push(input);
    await providerHook?.();
    return result ?? syntheticCandidate(input, now);
  });
  const tripRepository = new PrismaTripRepository(client);
  const trips = new TripService(tripRepository);
  const planning = new PrismaRoutePlanningRepository(client, {
    now: () => now,
  });
  const groundRepository = new PrismaGroundTransitRepository(client);
  const ground = new GroundTransitService(
    groundRepository,
    new SyntheticGroundTransitProvider('FIXED_DELAY', () => now),
    () => now,
  );
  const inTrip = new InTripReadService(new PrismaInTripReadRepository(client));
  const handoff = new GroundTransitRouteReevaluationService(
    tripRepository,
    groundRepository,
    new PrismaGroundTransitRouteProgressRepository(client),
    () => now,
  );
  const risks = new ExecutionRiskService(
    tripRepository,
    new PrismaExecutionRiskRepository(client),
    { now: () => now, groundTransitRepository: groundRepository },
  );
  const app = buildApi({
    readinessProbe: {
      check: async () => ({ name: 'postgresql', status: 'READY' }),
    },
    authService: new AuthService(new PrismaAuthRepository(client), {
      magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
      magicLinkTtlSeconds: 600,
      sessionTtlSeconds: 86400,
      invitationTtlSeconds: 86400,
      rateLimitWindowSeconds: 300,
      rateLimitMaxRequests: 50,
      defaultBaseCurrency: 'CNY',
      defaultUiLanguage: 'zh-CN',
      jobMaxAttempts: 5,
    }),
    tripService: trips,
    routeQueryService: new RouteQueryService(
      tripRepository,
      provider,
      planning,
      { candidateSnapshotTtlSeconds: 900, clock: { now: () => now } },
    ),
    routePreviewService: new RoutePreviewService(tripRepository, planning, {
      previewTtlSeconds: 600,
      clock: { now: () => now },
    }),
    routeAdoptionService: new RouteAdoptionService(planning, trips, {
      undoWindowSeconds: 600,
      clock: { now: () => now },
    }),
    routeUndoService: new RouteUndoService(planning, trips, { now: () => now }),
    staticBackupService: new StaticBackupService(
      new PrismaStaticBackupRepository(client),
    ),
    inTripReadService: inTrip,
    groundTransitService: ground,
    groundTransitRouteReevaluationService: handoff,
    tripImpactService: new TripImpactService(
      tripRepository,
      groundRepository,
      ground,
      handoff,
      inTrip,
      () => now,
    ),
    executionRiskService: risks,
    executionLocationService: new ExecutionLocationService(
      new PrismaExecutionLocationRepository(client),
      risks,
      {
        trigger: async () => {
          throw new Error('SYNTHETIC harness must never call flight Provider');
        },
      } as unknown as FlightMonitoringService,
      { now: () => now },
    ),
  });
  const post = (owner: SyntheticOwner, url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: bearer(owner), payload });
  const get = (owner: SyntheticOwner, url: string) =>
    app.inject({ method: 'GET', url, headers: bearer(owner) });
  async function identity(role: 'USER' | 'ADMIN' = 'USER') {
    const credential = `SYNTHETIC_${randomUUID()}`;
    const email = `${randomUUID()}@synthetic.example.test`;
    const user = await client.user.create({
      data: {
        email,
        normalizedEmail: email,
        role,
        preference: { create: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' } },
        sessions: {
          create: {
            tokenDigest: digestOpaqueToken(credential),
            expiresAt: new Date('2031-01-01T00:00:00Z'),
          },
        },
      },
    });
    const owner = { id: user.id, credential };
    owners.push(owner);
    return owner;
  }
  async function seed(owner: SyntheticOwner) {
    const created = await post(owner, '/trips', {
      name: 'SYNTHETIC P6C2 acceptance',
      planningAnchorDate: '2030-10-01',
      defaultPeopleCount: 1,
    });
    expect(created.statusCode).toBe(201);
    let trip = created.json<TripView>();
    for (let index = 0; index < 2; index++) {
      const response = await post(owner, `/trips/${trip.id}/commands`, {
        baseTripVersion: trip.version,
        command: {
          type: 'ADD_PLACE_VISIT',
          position: index,
          targetDay:
            index === 0
              ? { type: 'NEW', localDate: '2030-10-01', sequence: 0 }
              : {
                  type: 'EXISTING',
                  dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
                },
          place: {
            type: 'CUSTOM',
            name: `SYNTHETIC ${index === 0 ? 'Origin' : 'Destination'}`,
            latitude: 35.6762 + index * 0.01,
            longitude: 139.6503 + index * 0.01,
          },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      trip = response.json<TripView>();
    }
    return trip;
  }
  const query = (owner: SyntheticOwner, trip: TripView) =>
    post(owner, `/trips/${trip.id}/routes/query`, {
      basisVersion: trip.version,
      fromNodeId: trip.days[0]!.nodes[0]!.id,
      toNodeId: trip.days[0]!.nodes[1]!.id,
      hint: {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:00:00Z',
        timeZone: 'UTC',
      },
    });
  async function candidate(owner: SyntheticOwner, trip: TripView) {
    const response = await query(owner, trip);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RouteQueryResponse>().candidates[0]!
      .candidateSnapshotId;
  }
  const preview = (
    owner: SyntheticOwner,
    trip: TripView,
    candidateSnapshotId: string,
  ) =>
    post(owner, `/trips/${trip.id}/previews`, {
      basisVersion: trip.version,
      candidateSnapshotId,
    });
  async function prepared(owner: SyntheticOwner, trip: TripView) {
    const response = await preview(owner, trip, await candidate(owner, trip));
    expect(response.statusCode, response.body).toBe(201);
    const view = response.json<RoutePreviewView>();
    expect(view.adoptable).toBe(true);
    return view;
  }
  const adopt = (
    owner: SyntheticOwner,
    trip: TripView,
    view: RoutePreviewView,
    key = randomUUID(),
  ) =>
    post(owner, `/trips/${trip.id}/previews/${view.previewId}/adopt`, {
      baseTripVersion: trip.version,
      idempotencyKey: key,
    });
  const undo = (
    owner: SyntheticOwner,
    result: AdoptRoutePreviewResponse,
    key = randomUUID(),
  ) =>
    post(
      owner,
      `/trips/${result.trip.id}/operations/${result.operationReceipt.id}/undo`,
      { baseTripVersion: result.trip.version, idempotencyKey: key },
    );
  async function note(owner: SyntheticOwner, trip: TripView) {
    const response = await post(owner, `/trips/${trip.id}/commands`, {
      baseTripVersion: trip.version,
      command: {
        type: 'SET_NODE_NOTE',
        nodeId: trip.days[0]!.nodes[0]!.id,
        note: 'SYNTHETIC other device',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TripView>();
  }
  async function close() {
    await app.close();
    // Scoped cleanup, including the route/node FK cycle. No global reset.
    const ownerUserId = { in: owners.map((owner) => owner.id) };
    const tripIds = (
      await client.trip.findMany({
        where: { ownerUserId },
        select: { id: true },
      })
    ).map((t) => t.id);
    const tripId = { in: tripIds };
    await client.operationReceipt.deleteMany({ where: { ownerUserId } });
    await client.transportEdge.deleteMany({ where: { tripId } });
    await client.itineraryNode.updateMany({
      where: { tripId, source: 'ROUTE_GENERATED' },
      data: { source: 'USER_PLANNED', adoptedRouteId: null },
    });
    await client.adoptedRoute.deleteMany({ where: { tripId } });
    await client.trip.deleteMany({ where: { ownerUserId } });
    await client.user.deleteMany({ where: { id: ownerUserId } });
    await managed.close();
  }
  return {
    managed,
    client,
    app,
    identity,
    seed,
    post,
    get,
    query,
    candidate,
    preview,
    prepared,
    adopt,
    undo,
    note,
    close,
    inputs,
    setResult: (next: RouteProviderResult | undefined) => {
      result = next;
    },
    setProviderHook: (hook: (() => Promise<void>) | undefined) => {
      providerHook = hook;
    },
    setNow: (next: Date) => {
      now = next;
    },
  };
}

function syntheticCandidate(
  input: RouteProviderQueryInput,
  now: Date,
): RouteProviderResult {
  const departure = {
    instant: new Date('2030-10-01T10:00:00Z'),
    timeZone: 'UTC',
  };
  const arrival = {
    instant: new Date('2030-10-01T11:00:00Z'),
    timeZone: 'UTC',
  };
  const location = (p: RouteProviderQueryInput['origin']) => ({
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    providerPlaceRef: `SYNTHETIC:${p.placeId}`,
  });
  return {
    status: 'SUCCESS',
    candidates: [
      {
        candidateId: 'SYNTHETIC_P6C2',
        provider: 'SYNTHETIC',
        providerCandidateRef: 'SYNTHETIC_P6C2',
        observedAt: now,
        validUntil: null,
        departure,
        arrival,
        durationSeconds: 3600,
        fare: null,
        legs: [
          {
            mode: 'RAIL',
            from: location(input.origin),
            to: location(input.destination),
            departure,
            arrival,
            durationSeconds: 3600,
            fixedService: true,
            serviceLabel: 'SYNTHETIC Rail',
            providerRef: 'SYNTHETIC Rail',
          },
        ],
      },
    ],
  };
}

// Read row contents (not merely counts) at one consistent PostgreSQL snapshot.
type Rows<Model extends keyof ManagedPrismaClient['client']> =
  ManagedPrismaClient['client'][Model] extends {
    findMany: (...args: never[]) => infer Result;
  }
    ? Awaited<Result>
    : never;
export interface WriteFootprint {
  trip: Awaited<
    ReturnType<ManagedPrismaClient['client']['trip']['findUniqueOrThrow']>
  >;
  nodes: Rows<'itineraryNode'>;
  edges: Rows<'transportEdge'>;
  routes: Rows<'adoptedRoute'>;
  snapshots: Rows<'routeCandidateSnapshot'>;
  previews: Rows<'routePreview'>;
  receipts: Rows<'operationReceipt'>;
  outbox: Rows<'outboxEvent'>;
  execution: Rows<'executionEvent'>;
  backups: Rows<'tripStaticBackup'>;
  authoring: Rows<'tripAuthoringReceipt'>;
  days: Rows<'dayOccurrence'>;
  ownership: Rows<'dateOwnership'>;
  times: Rows<'temporalValue'>;
  intents: Rows<'userTimeIntent'>;
}
export function footprint(
  managed: ManagedPrismaClient,
  tripId: string,
): Promise<WriteFootprint> {
  return managed.client.$transaction(
    async (tx) => ({
      trip: await tx.trip.findUniqueOrThrow({ where: { id: tripId } }),
      nodes: await tx.itineraryNode.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      edges: await tx.transportEdge.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      routes: await tx.adoptedRoute.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      snapshots: await tx.routeCandidateSnapshot.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      previews: await tx.routePreview.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      receipts: await tx.operationReceipt.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      outbox: await tx.outboxEvent.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      execution: await tx.executionEvent.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      backups: await tx.tripStaticBackup.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      authoring: await tx.tripAuthoringReceipt.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      days: await tx.dayOccurrence.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      ownership: await tx.dateOwnership.findMany({
        where: { tripId },
        orderBy: { localDate: 'asc' },
      }),
      times: await tx.temporalValue.findMany({
        where: { OR: [{ node: { tripId } }, { transportEdge: { tripId } }] },
        orderBy: { id: 'asc' },
      }),
      intents: await tx.userTimeIntent.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
    }),
    { isolationLevel: 'RepeatableRead' },
  );
}
export function onlyWrites(
  before: WriteFootprint,
  after: WriteFootprint,
  allowed: readonly (keyof WriteFootprint)[] = [],
) {
  for (const key of Object.keys(before) as (keyof WriteFootprint)[]) {
    if (!allowed.includes(key))
      expect(after[key], `unauthorized write to ${key}`).toEqual(before[key]);
  }
}
