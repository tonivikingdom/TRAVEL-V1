/** Task-owned synthetic PostgreSQL/browser acceptance; never connects to a production database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import {
  AuthService,
  digestOpaqueToken,
  TripService,
  RouteQueryService,
  RoutePreviewService,
  RouteAdoptionService,
  RouteUndoService,
} from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaTripRepository,
  PrismaRoutePlanningRepository,
} from '../packages/persistence/src/index.js';
import { createDevelopmentSyntheticRouteProvider } from '../packages/providers/src/index.js';
import { buildApi } from '../apps/api/src/app.js';
const databaseUrl = process.env.DATABASE_URL;
assert(
  databaseUrl && ['development', 'test'].includes(process.env.APP_ENV ?? ''),
  'dev/test DATABASE_URL is required',
);
const url = new URL(databaseUrl);
assert(
  ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    /^\/travel_p6a1_browser_[a-z0-9_]+$/u.test(url.pathname),
  'Requires a separately created, task-owned local database',
);
const managed = createPrismaClient(databaseUrl);
const repo = new PrismaTripRepository(managed.client);
const planning = new PrismaRoutePlanningRepository(managed.client);
const service = new TripService(repo);
const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
const user = await managed.client.user.create({
  data: {
    email: `synthetic-p6a1-${randomUUID()}@synthetic.example.test`,
    normalizedEmail: `synthetic-p6a1-${randomUUID()}@synthetic.example.test`,
    role: 'USER',
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
  email: user.email,
  role: 'USER' as const,
  status: 'ACTIVE' as const,
};
let trip = await service.createTrip(actor, {
  name: '东京慢旅行 · SYNTHETIC / PostgreSQL',
  planningAnchorDate: '2030-10-01',
  defaultPeopleCount: 1,
});
for (const [index, name, lat, lng] of [
  [0, '丸の内酒店 · SYNTHETIC', 35.6812, 139.7671],
  [1, '上野公园 · SYNTHETIC', 35.7138, 139.7773],
] as const) {
  trip = await service.executeCommand(actor, trip.id, trip.version, {
    type: 'ADD_PLACE_VISIT',
    targetDay:
      index === 0
        ? { type: 'NEW', localDate: '2030-10-01', sequence: 0 }
        : { type: 'EXISTING', dayOccurrenceId: trip.days[0]!.dayOccurrenceId },
    position: index,
    place: {
      type: 'CUSTOM',
      name,
      latitude: lat,
      longitude: lng,
      address: '東京都 · SYNTHETIC 验收数据',
    },
  });
}
const origin = trip.days[0]!.nodes[0]!;
for (const [pointKind, instant] of [
  ['ARRIVAL', '2030-10-01T04:00:00Z'],
  ['DEPARTURE', '2030-10-01T05:00:00Z'],
] as const) {
  trip = await service.setUserResolvedTemporalValue(
    actor,
    trip.id,
    trip.version,
    { type: 'NODE', nodeId: origin.id },
    { layer: 'PLANNED', pointKind, instant, timeZone: 'Asia/Tokyo' },
  );
}
trip = await service.executeCommand(actor, trip.id, trip.version, {
  type: 'SET_MIN_DWELL',
  nodeId: origin.id,
  durationSeconds: 3600,
  locked: true,
});
const auth = new AuthService(new PrismaAuthRepository(managed.client), {
  magicLinkLandingUrl: 'http://127.0.0.1:5175/login/magic',
  magicLinkTtlSeconds: 600,
  sessionTtlSeconds: 3600,
  invitationTtlSeconds: 3600,
  rateLimitWindowSeconds: 300,
  rateLimitMaxRequests: 50,
  defaultBaseCurrency: 'JPY',
  defaultUiLanguage: 'zh-CN',
  jobMaxAttempts: 5,
});
const app = buildApi({
  readinessProbe: {
    async check() {
      return { name: 'postgresql', status: 'READY' };
    },
  },
  authService: auth,
  tripService: service,
  routeQueryService: new RouteQueryService(
    repo,
    createDevelopmentSyntheticRouteProvider(),
    planning,
    { candidateSnapshotTtlSeconds: 900 },
  ),
  routePreviewService: new RoutePreviewService(repo, planning, {
    previewTtlSeconds: 600,
  }),
  routeAdoptionService: new RouteAdoptionService(planning, service, {
    undoWindowSeconds: 600,
  }),
  routeUndoService: new RouteUndoService(planning, service),
});
await app.listen({ host: '127.0.0.1', port: 43150 });
const web = spawn(
  'pnpm',
  ['--filter', '@travel/web', 'dev', '--port', '5175'],
  {
    env: { ...process.env, WEB_API_ORIGIN: 'http://127.0.0.1:43150' },
    stdio: 'ignore',
    detached: true,
  },
);
const browser = await chromium.launch({
  ...(process.env.WEB_TEST_CHROMIUM_PATH
    ? { executablePath: process.env.WEB_TEST_CHROMIUM_PATH }
    : {}),
  args: ['--no-sandbox'],
});
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      ready = (await fetch('http://127.0.0.1:5175')).ok;
      if (ready) break;
    } catch {
      /* server startup */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(ready, 'Web startup failed');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(
    (value) => sessionStorage.setItem('travel.web.session', value),
    credential,
  );
  await page.goto('http://127.0.0.1:5175');
  await page.locator('[data-trip]').click();
  await expect(page.locator('.times').first()).toContainText('13:00');
  await expect(page.locator('.times').first()).toContainText('14:00');
  await page.screenshot({
    path: 'docs/status/assets/p6a-1/postgres-mobile-day.png',
    fullPage: true,
  });
  await page.locator('[data-node]').first().click();
  await page.locator('textarea').fill('SYNTHETIC 通过真实 Web/API 保存的备注');
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已保存到服务器');
  assert.equal(
    (
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: origin.id },
      })
    ).note,
    'SYNTHETIC 通过真实 Web/API 保存的备注',
  );
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.reload();
  await page.locator('[data-trip]').click();
  await page.locator('[data-node]').first().click();
  await expect(page.locator('textarea')).toHaveValue(
    'SYNTHETIC 通过真实 Web/API 保存的备注',
  );
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.locator('.connection').click();
  await expect(page.locator('input[name=when]')).toHaveValue(
    '2030-10-01T14:00',
  );
  await page.getByRole('button', { name: '搜索路线' }).click();
  await expect(page.locator('.candidate')).toBeVisible();
  const before = await managed.client.trip.findUniqueOrThrow({
    where: { id: trip.id },
  });
  assert.equal(
    await managed.client.adoptedRoute.count({ where: { tripId: trip.id } }),
    0,
  );
  await page.locator('.candidate').click();
  await expect(page.locator('.choice')).toBeVisible();
  assert.equal(
    (await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }))
      .version,
    before.version,
  );
  await page.getByRole('button', { name: '使用这条路线' }).click();
  await expect(page.locator('.undo')).toBeVisible();
  assert.equal(
    await managed.client.adoptedRoute.count({
      where: { tripId: trip.id, status: 'ACTIVE' },
    }),
    1,
  );
  await page.screenshot({
    path: 'docs/status/assets/p6a-1/postgres-mobile-adopted.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '撤销刚才的路线修改' }).click();
  await expect(page.locator('.message')).toContainText('已撤销');
  assert.equal(
    await managed.client.adoptedRoute.count({
      where: { tripId: trip.id, status: 'UNDONE' },
    }),
    1,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: 'docs/status/assets/p6a-1/postgres-desktop-day.png',
    fullPage: true,
  });
  const after = await managed.client.trip.findUniqueOrThrow({
    where: { id: trip.id },
  });
  assert.equal(after.version, before.version + 2);
  console.log(
    JSON.stringify({
      status: 'PASS',
      source: 'real PostgreSQL 17 + HTTP + Chromium',
      provider: 'SYNTHETIC',
      noteReload: 'PASS',
      queryPreviewReadOnly: 'PASS',
      explicitAdoptUndo: 'PASS',
      tripId: trip.id,
      adoptVersionIncrement: 1,
      undoVersionIncrement: 1,
    }),
  );
} finally {
  await browser.close();
  if (web.pid) process.kill(-web.pid, 'SIGTERM');
  await app.close();
  await managed.close();
}
