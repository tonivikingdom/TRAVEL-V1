/** SYNTHETIC browser → authenticated HTTP → PostgreSQL planning/write chain. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import {
  AuthService,
  digestOpaqueToken,
  TripService,
  TripImpactService,
  GroundTransitService,
  GroundTransitRouteReevaluationService,
  InTripReadService,
  RouteQueryService,
  RoutePreviewService,
  RouteAdoptionService,
  RouteUndoService,
} from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaTripRepository,
  PrismaGroundTransitRepository,
  PrismaGroundTransitRouteProgressRepository,
  PrismaInTripReadRepository,
  PrismaRoutePlanningRepository,
} from '../packages/persistence/src/index.js';
import {
  createDevelopmentSyntheticGroundTransitRouteProvider,
  createDevelopmentSyntheticRouteProvider,
  SyntheticGroundTransitProvider,
  SyntheticRouteProvider,
} from '../packages/providers/src/index.js';
import { buildApi } from '../apps/api/src/app.js';
import { syntheticRouteDay } from './synthetic-route-day.mjs';
const url = process.env.TEST_DATABASE_URL;
assert(url && process.env.APP_ENV === 'test');
const parsed = new URL(url);
assert(
  ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
    parsed.pathname.endsWith('_test'),
  'Isolated synthetic test DB required',
);
const db = createPrismaClient(url),
  trips = new PrismaTripRepository(db.client),
  service = new TripService(trips);
const now = new Date('2030-10-01T00:00:00Z'),
  clock = { now: () => now },
  context = syntheticRouteDay(now);
const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`,
  email = `synthetic-p6c2-${randomUUID()}@synthetic.example.test`;
const user = await db.client.user.create({
  data: {
    email,
    normalizedEmail: email,
    preference: { create: { baseCurrency: 'JPY', uiLanguage: 'zh-CN' } },
    sessions: {
      create: {
        tokenDigest: digestOpaqueToken(credential),
        expiresAt: new Date(Date.now() + 3600000),
      },
    },
  },
});
const actor = {
  userId: user.id,
  email,
  role: 'USER' as const,
  status: 'ACTIVE' as const,
};
const planning = new PrismaRoutePlanningRepository(db.client, clock),
  ground = new PrismaGroundTransitRepository(db.client);
const inTrip = new InTripReadService(new PrismaInTripReadRepository(db.client));
const groundService = new GroundTransitService(
  ground,
  new SyntheticGroundTransitProvider('CANCEL_FIXED', clock.now),
  clock.now,
);
const handoff = new GroundTransitRouteReevaluationService(
  trips,
  ground,
  new PrismaGroundTransitRouteProgressRepository(db.client),
  clock.now,
);
let alternative = false,
  providerCalls = 0;
const provider = new SyntheticRouteProvider(async (input) => {
  providerCalls++;
  return (
    alternative
      ? createDevelopmentSyntheticRouteProvider(clock.now)
      : createDevelopmentSyntheticGroundTransitRouteProvider(clock.now)
  ).queryRoutes(input);
});
const query = new RouteQueryService(trips, provider, planning, {
  candidateSnapshotTtlSeconds: 900,
  clock,
});
const preview = new RoutePreviewService(trips, planning, {
  previewTtlSeconds: 600,
  clock,
});
const adopt = new RouteAdoptionService(planning, service, {
  undoWindowSeconds: 600,
  clock,
});
let t = await service.createTrip(actor, {
  name: 'SYNTHETIC 交通调整 HTTP 验收',
  planningAnchorDate: context.localDate,
  defaultPeopleCount: 1,
});
for (const i of [0, 1])
  t = await service.executeCommand(actor, t.id, t.version, {
    type: 'ADD_PLACE_VISIT',
    position: i,
    targetDay: i
      ? { type: 'EXISTING', dayOccurrenceId: t.days[0]!.dayOccurrenceId }
      : { type: 'NEW', localDate: context.localDate, sequence: 0 },
    place: {
      type: 'CUSTOM',
      name: `SYNTHETIC ${i ? '下午活动' : '酒店'}`,
      latitude: 35.68 + i * 0.01,
      longitude: 139.76,
    },
  });
const a = t.days[0]!.nodes[0]!,
  z = t.days[0]!.nodes[1]!;
const q = await query.queryRoutes(actor, t.id, {
  basisVersion: t.version,
  fromNodeId: a.id,
  toNodeId: z.id,
  hint: {
    type: 'DEPART_AT',
    instant: now.toISOString(),
    timeZone: context.timeZone,
  },
});
const p = await preview.createPreview(actor, t.id, {
  basisVersion: t.version,
  candidateSnapshotId: q.candidates[0]!.candidateSnapshotId,
});
t = (
  await adopt.adoptPreview(actor, t.id, p.previewId, {
    baseTripVersion: t.version,
    idempotencyKey: randomUUID(),
  })
).trip;
const source = await db.client.groundTransitLegExecution.findFirstOrThrow({
  where: { tripId: t.id, serviceClass: 'FIXED_SERVICE' },
});
await groundService.refresh(actor, t.id, source.transportEdgeId);
t = await service.getTrip(actor, t.id);
assert.equal(
  (await handoff.getHandoff(actor, t.id, source.transportEdgeId)).readiness,
  'READY',
);
alternative = true;
const app = buildApi({
  readinessProbe: {
    async check() {
      return { name: 'postgresql', status: 'READY' };
    },
  },
  tripService: service,
  tripImpactService: new TripImpactService(
    trips,
    ground,
    groundService,
    handoff,
    inTrip,
    clock.now,
  ),
  inTripReadService: inTrip,
  groundTransitService: groundService,
  groundTransitRouteReevaluationService: handoff,
  routeQueryService: query,
  routePreviewService: preview,
  routeAdoptionService: adopt,
  routeUndoService: new RouteUndoService(planning, service, clock),
  authService: new AuthService(new PrismaAuthRepository(db.client), {
    magicLinkLandingUrl: 'http://synthetic.example.test/login/magic',
    magicLinkTtlSeconds: 600,
    sessionTtlSeconds: 3600,
    invitationTtlSeconds: 3600,
    rateLimitWindowSeconds: 300,
    rateLimitMaxRequests: 50,
    defaultBaseCurrency: 'JPY',
    defaultUiLanguage: 'zh-CN',
    jobMaxAttempts: 5,
  }),
});
const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
const web = spawn(
  'pnpm',
  ['--filter', '@travel/web', 'dev', '--port', '5179', '--strictPort'],
  {
    env: { ...process.env, WEB_API_ORIGIN: apiOrigin },
    stdio: 'ignore',
    detached: true,
  },
);
const browser = await chromium.launch({
  executablePath: process.env.WEB_TEST_CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch('http://127.0.0.1:5179')).ok;
      if (ready) break;
    } catch {
      /* Owned server starting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(ready);
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: context.timeZone,
  });
  await page.clock.install({ time: now });
  await page.addInitScript(
    (v) => sessionStorage.setItem('travel.web.session', v),
    credential,
  );
  const footprint = async () => ({
    version: (await db.client.trip.findUniqueOrThrow({ where: { id: t.id } }))
      .version,
    nodes: await db.client.itineraryNode.findMany({
      where: { tripId: t.id },
      orderBy: { id: 'asc' },
    }),
    edges: await db.client.transportEdge.findMany({
      where: { tripId: t.id },
      orderBy: { id: 'asc' },
    }),
    events: await db.client.executionEvent.count({ where: { tripId: t.id } }),
    receipts: await db.client.operationReceipt.count({
      where: { tripId: t.id },
    }),
  });
  const before = await footprint(),
    providerBefore = providerCalls;
  await page.goto('http://127.0.0.1:5179');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await page.getByRole('button', { name: '查看影响', exact: true }).click();
  await page.getByRole('button', { name: '查看调整方案', exact: true }).click();
  assert.equal(providerCalls, providerBefore);
  assert.deepEqual(await footprint(), before);
  await page.getByRole('button', { name: '搜索替代方案', exact: true }).click();
  await expect(page.locator('.candidate')).toBeVisible();
  assert.equal(providerCalls, providerBefore + 1);
  assert.deepEqual(await footprint(), before);
  await page.locator('.candidate').click();
  await expect(page.locator('.choice')).toBeVisible();
  assert.deepEqual(await footprint(), before);
  await page.getByRole('button', { name: '采用此调整', exact: true }).click();
  await expect(page.locator('.undo')).toBeVisible();
  assert.equal((await footprint()).version, before.version + 1);
  await page.screenshot({
    path: 'docs/status/assets/p6c-2/postgres-mobile-adopt.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: '撤销刚才的路线修改', exact: true })
    .click();
  await expect(page.locator('.undo')).toHaveCount(0);
  await expect(page.locator('#app')).toContainText('刚才的路线修改已撤销');
  const restored = await footprint();
  assert.equal(restored.version, before.version + 2);
  assert.equal(restored.events, before.events);
  assert.deepEqual(
    restored.edges.map((e) => e.id),
    before.edges.map((e) => e.id),
  );
  assert.deepEqual(
    restored.nodes.map((n) => n.id),
    before.nodes.map((n) => n.id),
  );
  console.log(
    JSON.stringify({
      synthetic: true,
      postgresHttpBrowser: 'PASS',
      entryProviderCalls: 0,
      queryFormalWrites: 0,
      previewFormalWrites: 0,
      adoptVersionIncrement: 1,
      undoVersionIncrement: 1,
      restoredOriginalIds: true,
      executionEventsWritten: 0,
    }),
  );
} finally {
  await browser.close();
  if (web.pid) process.kill(-web.pid, 'SIGTERM');
  await app.close();
  await db.client.user.delete({ where: { id: user.id } });
  await db.close();
}
