import { mkdir, writeFile } from 'node:fs/promises';
import {
  AuthService,
  hashRouteCandidateSnapshot,
  hashExternalRouteCandidateSnapshot,
  type RouteCandidatePayload,
  RouteAdoptionService,
  TripService,
} from '@travel/application';
import type { ExternalRouteOriginSnapshot } from '@travel/contracts';
import {
  PrismaAuthRepository,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import { buildApi } from '../../src/app.js';
import { footprint, type WriteFootprint } from './replanning-acceptance.js';

export interface AdoptionFootprint extends WriteFootprint {
  readonly places: readonly unknown[];
  readonly nodeExecution: readonly unknown[];
  readonly executionLocation: readonly unknown[];
  readonly executionWatermarks: readonly unknown[];
  readonly arrivalSuppressions: readonly unknown[];
  readonly dwellSuggestions: readonly unknown[];
  readonly history: readonly unknown[];
  readonly projections: readonly unknown[];
  readonly ground: readonly unknown[];
  readonly origins: readonly unknown[];
  readonly originReceipts: readonly unknown[];
  readonly jobs: readonly unknown[];
}

// Keep payload, hash and Provider TTL consistent before constructing a Preview.
// Changing only database TTL columns would exercise evidence tampering instead.
export async function setSyntheticSnapshotExpiry(
  managed: ManagedPrismaClient,
  snapshotId: string,
  expiresAt: Date,
  providerValidUntil: Date | null,
) {
  const row = await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
  });
  const candidatePayload: RouteCandidatePayload = {
    ...(row.candidatePayload as unknown as RouteCandidatePayload),
    validUntil: providerValidUntil?.toISOString() ?? null,
  };
  const basis = {
    tripId: row.tripId,
    basisVersion: row.basisVersion,
    toNodeId: row.toNodeId,
    provider: row.provider,
    observedAt: row.observedAt.toISOString(),
    candidatePayload,
  };
  const candidateHash =
    row.originKind === 'ITINERARY_NODE'
      ? hashRouteCandidateSnapshot({ ...basis, fromNodeId: row.fromNodeId! })
      : hashExternalRouteCandidateSnapshot({
          ...basis,
          externalOriginSnapshot:
            row.externalOriginSnapshot as unknown as ExternalRouteOriginSnapshot,
        });
  await managed.client.routeCandidateSnapshot.update({
    where: { id: row.id },
    data: {
      expiresAt,
      providerValidUntil,
      candidateHash,
      candidatePayload: candidatePayload as unknown as NonNullable<
        Parameters<
          ManagedPrismaClient['client']['routeCandidateSnapshot']['update']
        >[0]['data']['candidatePayload']
      >,
    },
  });
}

// SYNTHETIC only. Observe real PostgreSQL lock state, not a sleep or wall clock.
export async function waitForAdoptionLock(
  managed: ManagedPrismaClient,
  holderPid: number,
) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rows = await managed.client.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND ${holderPid}::integer=ANY(pg_blocking_pids(pid))
          AND pid<>pg_backend_pid()
      ) AS waiting`;
    if (rows[0]!.waiting) return;
  }
  throw new Error('SYNTHETIC Adopt never reached the held lock');
}

// Include row contents, including tables written by external materialization,
// archiving and ground-transit initialization, not only row counts.
export async function adoptionFootprint(
  managed: ManagedPrismaClient,
  tripId: string,
  ownerUserId: string,
): Promise<AdoptionFootprint> {
  const core = await footprint(managed, tripId);
  const related = await managed.client.$transaction(
    async (tx) => ({
      places: await tx.place.findMany({
        where: { ownerUserId },
        orderBy: { id: 'asc' },
      }),
      nodeExecution: await tx.nodeExecutionState.findMany({
        where: { tripId },
        orderBy: { nodeId: 'asc' },
      }),
      executionLocation: await tx.executionLocationState.findMany({
        where: { tripId },
        orderBy: { tripId: 'asc' },
      }),
      executionWatermarks: await tx.executionObservationWatermark.findMany({
        where: { tripId },
        orderBy: { tripId: 'asc' },
      }),
      arrivalSuppressions: await tx.executionArrivalSuppression.findMany({
        where: { tripId },
        orderBy: { nodeId: 'asc' },
      }),
      dwellSuggestions: await tx.systemDwellSuggestion.findMany({
        where: { tripId },
        orderBy: { nodeId: 'asc' },
      }),
      history: await tx.transportEdgeHistory.findMany({
        where: { tripId },
        include: { temporalValues: { orderBy: { id: 'asc' } } },
        orderBy: { id: 'asc' },
      }),
      projections: await tx.transportDayProjection.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      ground: await tx.groundTransitLegExecution.findMany({
        where: { tripId },
        include: {
          observations: { orderBy: { id: 'asc' } },
          stateTransitions: { orderBy: { id: 'asc' } },
        },
        orderBy: { id: 'asc' },
      }),
      origins: await tx.externalExecutionOrigin.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      originReceipts: await tx.externalExecutionOriginReceipt.findMany({
        where: { tripId },
        orderBy: { id: 'asc' },
      }),
      jobs: await tx.job.findMany({ orderBy: { id: 'asc' } }),
    }),
    { isolationLevel: 'RepeatableRead' },
  );
  return { ...core, ...related };
}

/** Real API/auth/repository transaction; the hook fires AFTER the final Outbox
 * insert succeeds inside that transaction. It never writes outside it. */
export function ttlAdoptionApi(
  managed: ManagedPrismaClient,
  now: () => Date,
  afterWrites?: () => void,
) {
  const client = managed.client.$extends({
    query: {
      outboxEvent: {
        async create({ args, query }) {
          const row = await query(args);
          if (args.data.type === 'ROUTE_ADOPTED') afterWrites?.();
          return row;
        },
      },
    },
  }) as unknown as ManagedPrismaClient['client'];
  const trips = new TripService(new PrismaTripRepository(managed.client));
  return buildApi({
    readinessProbe: {
      check: async () => ({ name: 'postgresql', status: 'READY' }),
    },
    authService: new AuthService(new PrismaAuthRepository(managed.client), {
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
    routeAdoptionService: new RouteAdoptionService(
      new PrismaRoutePlanningRepository(client, { now }),
      trips,
      { undoWindowSeconds: 600, clock: { now } },
    ),
  });
}

export async function ttlEvidence(
  name: string,
  before: Awaited<ReturnType<typeof adoptionFootprint>>,
  after: typeof before,
  facts: object,
) {
  const phase = process.env.I59_EVIDENCE_PHASE ?? 'after';
  if (!['before', 'after'].includes(phase))
    throw new Error('Invalid evidence phase');
  const root = new URL(
    `../../../../docs/status/assets/i59-01/${phase}/`,
    import.meta.url,
  );
  await mkdir(root, { recursive: true });
  const summarize = (rows: typeof before) => ({
    tripVersion: rows.trip.version,
    ...Object.fromEntries(
      Object.entries(rows)
        .filter(([key]) => key !== 'trip')
        .map(([key, values]) => [
          key,
          Array.isArray(values) ? values.length : null,
        ]),
    ),
  });
  await writeFile(
    new URL(`${name}.json`, root),
    JSON.stringify(
      {
        synthetic: true,
        ...facts,
        before: summarize(before),
        after: summarize(after),
        fullRowFootprintUnchanged:
          JSON.stringify(before) === JSON.stringify(after),
      },
      null,
      2,
    ) + '\n',
  );
}
