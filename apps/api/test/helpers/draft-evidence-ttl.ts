import { mkdir, writeFile } from 'node:fs/promises';
import {
  AuthService,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  RouteUndoService,
  TripService,
  type RouteProvider,
} from '@travel/application';
import {
  PrismaAuthRepository,
  PrismaExternalExecutionOriginRepository,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import { buildApi } from '../../src/app.js';
import {
  adoptionFootprint,
  waitForAdoptionLock,
} from './adoption-evidence-ttl.js';
import { gate } from './replanning-acceptance.js';

// Hooks advance only the injected clock AFTER a real PostgreSQL insert, still
// inside the production transaction. They never perform an out-of-band write.
export function draftPlanningApi(
  managed: ManagedPrismaClient,
  now: () => Date,
  provider: RouteProvider,
  options: {
    snapshotTtlSeconds?: number;
    previewTtlSeconds?: number;
    afterSnapshot?: () => void;
    afterPreview?: () => void;
  } = {},
) {
  const client = managed.client.$extends({
    query: {
      routeCandidateSnapshot: {
        async create({ args, query }) {
          const row = await query(args);
          options.afterSnapshot?.();
          return row;
        },
      },
      routePreview: {
        async create({ args, query }) {
          const row = await query(args);
          options.afterPreview?.();
          return row;
        },
      },
    },
  }) as unknown as ManagedPrismaClient['client'];
  const repository = new PrismaTripRepository(managed.client);
  const trips = new TripService(repository);
  const planning = new PrismaRoutePlanningRepository(client, { now });
  const externalOrigins = new PrismaExternalExecutionOriginRepository(
    managed.client,
  );
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
    routeQueryService: new RouteQueryService(repository, provider, planning, {
      candidateSnapshotTtlSeconds: options.snapshotTtlSeconds ?? 900,
      clock: { now },
      externalOrigins,
    }),
    routePreviewService: new RoutePreviewService(repository, planning, {
      previewTtlSeconds: options.previewTtlSeconds ?? 600,
      clock: { now },
      externalOrigins,
    }),
    routeAdoptionService: new RouteAdoptionService(planning, trips, {
      undoWindowSeconds: 600,
      clock: { now },
    }),
    routeUndoService: new RouteUndoService(planning, trips, { now }),
  });
}

export async function withHeldDraftLock<T>(
  managed: ManagedPrismaClient,
  ownerUserId: string,
  tripId: string,
  lock: 'owner' | 'Trip',
  request: () => Promise<T>,
  afterWait: () => void,
): Promise<T> {
  const held = gate();
  const release = gate();
  let pid = 0;
  const holder = managed.client.$transaction(
    async (tx) => {
      pid = (
        await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      )[0]!.pid;
      if (lock === 'owner') {
        await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId},2))`;
      } else {
        await tx.$queryRaw`SELECT id FROM "Trip" WHERE id=${tripId}::uuid FOR UPDATE`;
      }
      held.release();
      await release.pending;
    },
    { timeout: 15000 },
  );
  let pending: Promise<T> | undefined;
  try {
    await held.pending;
    pending = Promise.resolve(request());
    await waitForAdoptionLock(managed, pid);
    afterWait();
    release.release();
    return await pending;
  } finally {
    release.release();
    await holder;
    await pending;
  }
}

export async function draftEvidence(
  name: string,
  before: Awaited<ReturnType<typeof adoptionFootprint>>,
  after: typeof before,
  facts: object,
) {
  const phase = process.env.DRAFT_EVIDENCE_PHASE;
  if (phase === undefined) return;
  if (!['before', 'after'].includes(phase))
    throw new Error('Invalid evidence phase');
  const root = new URL(
    `../../../../docs/status/assets/draft-evidence-ttl/${phase}/`,
    import.meta.url,
  );
  await mkdir(root, { recursive: true });
  const summarize = (state: typeof before) => ({
    tripVersion: state.trip.version,
    ...Object.fromEntries(
      Object.entries(state)
        .filter(([key]) => key !== 'trip')
        .map(([key, value]) => [
          key,
          Array.isArray(value) ? value.length : null,
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
