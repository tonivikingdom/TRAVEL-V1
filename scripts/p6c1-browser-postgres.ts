/** SYNTHETIC browser → authenticated HTTP → real PostgreSQL. No Provider refresh. */
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
} from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaTripRepository,
  PrismaGroundTransitRepository,
  PrismaGroundTransitRouteProgressRepository,
  PrismaInTripReadRepository,
} from '../packages/persistence/src/index.js';
import { UnconfiguredGroundTransitProvider } from '../packages/providers/src/index.js';
import { buildApi } from '../apps/api/src/app.js';
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
  service = new TripService(trips),
  ground = new PrismaGroundTransitRepository(db.client),
  inTrip = new InTripReadService(new PrismaInTripReadRepository(db.client));
const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`,
  email = `synthetic-p6c-browser-${randomUUID()}@synthetic.example.test`;
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
let t = await service.createTrip(actor, {
  name: 'SYNTHETIC 后续影响 HTTP 验收',
  planningAnchorDate: '2030-10-01',
  defaultPeopleCount: 1,
});
for (const i of [0, 1])
  t = await service.executeCommand(actor, t.id, t.version, {
    type: 'ADD_PLACE_VISIT',
    position: i,
    targetDay:
      i === 0
        ? { type: 'NEW', localDate: '2030-10-01', sequence: 0 }
        : { type: 'EXISTING', dayOccurrenceId: t.days[0]!.dayOccurrenceId },
    place: {
      type: 'CUSTOM',
      name: `SYNTHETIC ${i === 0 ? '酒店' : '下午活动'}`,
      latitude: 35 + i,
      longitude: 139,
    },
  });
const a = t.days[0]!.nodes[0]!,
  b = t.days[0]!.nodes[1]!;
t = await service.executeCommand(actor, t.id, t.version, {
  type: 'SET_MANUAL_TRANSPORT',
  fromNodeId: a.id,
  toNodeId: b.id,
  mode: 'RAIL',
  fixedService: true,
  serviceLabel: 'SYNTHETIC 15:00 交通',
});
const edge = t.connections[0]!.transport!;
for (const [nodeId, transportEdgeId, pointKind, hour] of [
  [a.id, null, 'ARRIVAL', '04'],
  [null, edge.id, 'DEPARTURE', '06'],
  [null, edge.id, 'ARRIVAL', '07'],
  [b.id, null, 'DEPARTURE', '08'],
] as const)
  await db.client.temporalValue.create({
    data: {
      nodeId,
      transportEdgeId,
      layer: 'PLANNED',
      pointKind,
      instant: new Date(`2030-10-01T${hour}:00:00Z`),
      timeZone: 'Asia/Tokyo',
      sourceKind: transportEdgeId ? 'ADOPTED_TRANSPORT_FACT' : 'USER_VALUE',
    },
  });
await db.client.userTimeIntent.create({
  data: {
    tripId: t.id,
    nodeId: a.id,
    kind: 'MIN_DWELL',
    operator: 'MINIMUM',
    durationSeconds: 3600,
    locked: true,
  },
});
const estimated = await db.client.temporalValue.create({
  data: {
    nodeId: a.id,
    layer: 'ESTIMATED',
    pointKind: 'ARRIVAL',
    instant: new Date('2030-10-01T04:35:00Z'),
    timeZone: 'Asia/Tokyo',
    sourceKind: 'USER_VALUE',
  },
});
const impact = new TripImpactService(
  trips,
  ground,
  new GroundTransitService(ground, new UnconfiguredGroundTransitProvider()),
  new GroundTransitRouteReevaluationService(
    trips,
    ground,
    new PrismaGroundTransitRouteProgressRepository(db.client),
  ),
  inTrip,
);
const app = buildApi({
  readinessProbe: {
    async check() {
      return { name: 'postgresql', status: 'READY' };
    },
  },
  tripService: service,
  tripImpactService: impact,
  inTripReadService: inTrip,
  groundTransitService: new GroundTransitService(
    ground,
    new UnconfiguredGroundTransitProvider(),
  ),
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
      // The owned development server may still be starting.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(ready);
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Tokyo',
  });
  await page.clock.install({ time: new Date('2030-10-01T04:40:00Z') });
  await page.addInitScript(
    (v) => sessionStorage.setItem('travel.web.session', v),
    credential,
  );
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && !r.url().endsWith('/schedule/evaluate'))
      writes.push(r.url());
  });
  const counts = () =>
    Promise.all([
      db.client.trip.findUnique({ where: { id: t.id } }),
      db.client.executionEvent.count({ where: { tripId: t.id } }),
      db.client.executionRisk.count({ where: { tripId: t.id } }),
      db.client.notificationEvent.count({ where: { tripId: t.id } }),
      db.client.routeCandidateSnapshot.count({ where: { tripId: t.id } }),
      db.client.routePreview.count({ where: { tripId: t.id } }),
      db.client.operationReceipt.count({ where: { tripId: t.id } }),
      db.client.tripStaticBackup.count({ where: { tripId: t.id } }),
    ]);
  const before = await counts();
  await page.goto('http://127.0.0.1:5179');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await expect(page.locator('.trip-impact strong')).toHaveText(
    '时间或交通有变化',
  );
  await page.getByRole('button', { name: '查看影响', exact: true }).click();
  await expect(page.locator('.impact-detail')).toContainText(
    '预计停留时间缩短 35 分钟',
  );
  assert.deepEqual(await counts(), before);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  // Explicit isolated fixture update is separate from the read-only experience.
  await db.client.temporalValue.update({
    where: { id: estimated.id },
    data: { instant: new Date('2030-10-01T06:20:00Z') },
  });
  await db.client.trip.update({
    where: { id: t.id },
    data: { version: { increment: 1 } },
  });
  const afterFixture = await counts();
  await page.getByRole('button', { name: '重新载入', exact: true }).click();
  await expect(page.locator('.trip-impact strong')).toHaveText(
    '后续安排需要调整',
  );
  await page.getByRole('button', { name: '查看影响', exact: true }).click();
  await expect(page.locator('.impact-detail')).toContainText(
    '当前可靠到达时间已经晚于固定班次出发时间',
  );
  assert.deepEqual(await counts(), afterFixture);
  assert.deepEqual(writes, []);
  console.log(
    JSON.stringify({
      synthetic: true,
      postgresHttpBrowser: 'PASS',
      attention35Minutes: true,
      minimumPreserved: true,
      missedServiceExplained: true,
      readSideWrites: 0,
      queryPreviewAdopt: 0,
    }),
  );
} finally {
  await browser.close();
  if (web.pid) process.kill(-web.pid, 'SIGTERM');
  await app.close();
  await db.client.user.delete({ where: { id: user.id } });
  await db.close();
}
