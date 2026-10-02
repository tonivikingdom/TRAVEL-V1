/** Task-owned synthetic PostgreSQL/browser acceptance; run with the dedicated source-alias tsconfig.
 * API and injected services share the same ApplicationError source identity.
 * Never connects to a production database. */
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
  type RouteProviderQueryInput,
} from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaTripRepository,
  PrismaRoutePlanningRepository,
} from '../packages/persistence/src/index.js';
import {
  createDevelopmentSyntheticRouteProvider,
  SyntheticRouteProvider,
} from '../packages/providers/src/index.js';
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
let providerCalls = 0;
const synthetic = createDevelopmentSyntheticRouteProvider();
const provider = new SyntheticRouteProvider(
  async (input: RouteProviderQueryInput) => {
    providerCalls++;
    const result = await synthetic.queryRoutes(input);
    if (result.status !== 'SUCCESS') return result;
    return {
      ...result,
      candidates: result.candidates.map((c) => ({
        ...c,
        legs: c.legs.map((l) => ({
          ...l,
          mode: 'BUS',
          fixedService: true,
          serviceLabel: 'SYNTHETIC saved bus',
        })),
      })),
    };
  },
);
const app = buildApi({
  readinessProbe: {
    async check() {
      return { name: 'postgresql', status: 'READY' };
    },
  },
  authService: auth,
  tripService: service,
  routeQueryService: new RouteQueryService(repo, provider, planning, {
    candidateSnapshotTtlSeconds: 900,
  }),
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
  await page.addInitScript((value) => {
    if (!sessionStorage.getItem('travel.web.session'))
      sessionStorage.setItem('travel.web.session', value);
  }, credential);
  await page.goto('http://127.0.0.1:5175');
  await page.locator('[data-trip]').click();
  await expect(page.locator('.times').first()).toContainText('13:00');
  await expect(page.locator('.times').first()).toContainText('14:00');
  await page.screenshot({
    path: 'docs/status/assets/p6a-1/postgres-mobile-day.png',
    fullPage: true,
  });
  await page.locator('[data-node]').first().click();

  for (const [form, field, submitted, edited, button] of [
    [
      'note-edit',
      'note',
      '  SYNTHETIC submitted A  ',
      'SYNTHETIC later B',
      '保存备注',
    ],
    [
      'time-edit',
      'when',
      '2030-10-01T16:00',
      '2030-10-01T17:00',
      '保存时间要求',
    ],
    ['dwell-edit', 'minutes', '60', '90', '保存停留要求'],
  ] as const) {
    await page.locator('.edit').evaluate((el) => el.setAttribute('open', ''));
    await page.locator(`#${form} [name=${field}]`).fill(submitted);
    let release: (() => void) | undefined;
    await page.route('**/api/**/commands', async (route) => {
      const response = await route.fetch(); // actual HTTP/transaction already accepted A
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    await page.locator(`#${form} [name=${field}]`).fill(edited);
    release!();
    await expect(page.locator('#save-status')).toContainText('未保存');
    await expect(page.locator(`#${form} [name=${field}]`)).toHaveValue(edited);
    const persisted = await managed.client.itineraryNode.findUniqueOrThrow({
      where: { id: origin.id },
      include: { timeIntents: true },
    });
    if (form === 'note-edit') assert.equal(persisted.note, submitted.trim());
    if (form === 'time-edit')
      assert.equal(
        persisted.timeIntents
          .find((i) => i.kind === 'POINT_TIME')!
          .instant!.toISOString(),
        '2030-10-01T07:00:00.000Z',
      );
    if (form === 'dwell-edit')
      assert.equal(
        persisted.timeIntents.find((i) => i.kind === 'MIN_DWELL')!
          .durationSeconds,
        3600,
      );
    await page.unroute('**/api/**/commands');
    // Explicitly discard this test's later edit; never silently acknowledge it.
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '关闭详情' }).click();
    await page.locator('[data-node]').first().click();
  }
  // Remove the saved arrival deadline through the real command path for the
  // independent old-route result scenario. No direct DB fact mutation.
  let current = await service.getTrip(actor, trip.id);
  current = await service.executeCommand(actor, trip.id, current.version, {
    type: 'REMOVE_TIME_INTENT',
    nodeId: origin.id,
    pointKind: 'ARRIVAL',
    operator: 'NOT_AFTER',
  });
  await page.evaluate(() => dispatchEvent(new Event('offline')));
  await page.getByRole('button', { name: '重新读取并核对草稿' }).click();
  await page.getByRole('button', { name: '已核对，保留草稿继续编辑' }).click();
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

  await page.locator('textarea').fill('SYNTHETIC version conflict draft');
  current = await service.getTrip(actor, trip.id);
  await service.executeCommand(actor, trip.id, current.version, {
    type: 'SET_NODE_NOTE',
    nodeId: origin.id,
    note: 'SYNTHETIC concurrent server note',
  });
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已变化');
  await page.getByRole('button', { name: '重新读取并核对草稿' }).click();
  await expect(page.locator('#draft-recovery')).toContainText(
    'SYNTHETIC concurrent server note',
  );
  await expect(page.locator('textarea')).toHaveValue(
    'SYNTHETIC version conflict draft',
  );
  await page.screenshot({
    path: 'docs/status/assets/p6a-1/postgres-mobile-draft-recovery.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '已核对，保留草稿继续编辑' }).click();
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  assert.equal(
    (
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: origin.id },
      })
    ).note,
    'SYNTHETIC version conflict draft',
  );
  await page.locator('textarea').fill('SYNTHETIC reauthenticated draft');
  await managed.client.session.updateMany({
    where: { userId: user.id },
    data: { revokedAt: new Date() },
  });
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('登录已失效');
  const linkToken =
    randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  await managed.client.magicLinkToken.create({
    data: {
      userId: user.id,
      tokenDigest: digestOpaqueToken(linkToken),
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  await page
    .locator('#recovery-consume input')
    .fill(`http://127.0.0.1:5175/login/magic#token=${linkToken}`);
  await page.getByRole('button', { name: '恢复登录并读取草稿' }).click();
  await expect(page.locator('#draft-recovery')).toContainText(
    'SYNTHETIC version conflict draft',
  );
  await expect(page.locator('textarea')).toHaveValue(
    'SYNTHETIC reauthenticated draft',
  );
  await page.getByRole('button', { name: '已核对，保留草稿继续编辑' }).click();
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  assert.equal(
    (
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: origin.id },
      })
    ).note,
    'SYNTHETIC reauthenticated draft',
  );

  await page
    .locator('textarea')
    .fill('SYNTHETIC recovered actual network draft');
  await page.context().setOffline(true);
  await expect(page.getByRole('dialog').locator('.times')).toBeHidden();
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('无法保存');
  await page.context().setOffline(false);
  await page.getByRole('button', { name: '重新读取并核对草稿' }).click();
  await expect(page.locator('textarea')).toHaveValue(
    'SYNTHETIC recovered actual network draft',
  );
  await page.getByRole('button', { name: '已核对，保留草稿继续编辑' }).click();
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  assert.equal(
    (
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: origin.id },
      })
    ).note,
    'SYNTHETIC recovered actual network draft',
  );
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.locator('.connection').click();
  await expect(page.locator('input[name=when]')).toHaveValue(
    '2030-10-01T14:00',
  );
  await page.locator('#route-search input[name=when]').fill('2030-10-01T15:00');
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

  const plansBeforeNavigation =
    await managed.client.routeCandidateSnapshot.count({
      where: { tripId: trip.id },
    });
  const previewsBeforeNavigation = await managed.client.routePreview.count({
    where: { tripId: trip.id },
  });
  const callsBeforeNavigation = providerCalls;
  await page.reload();
  await page.locator('[data-trip]').click();
  await page.locator('.connection').click();
  await expect(
    page.locator('.saved-legs').getByRole('link', { name: '步行到上车点' }),
  ).toBeVisible();
  assert.equal(providerCalls, callsBeforeNavigation);
  assert.equal(
    await managed.client.routeCandidateSnapshot.count({
      where: { tripId: trip.id },
    }),
    plansBeforeNavigation,
  );
  assert.equal(
    await managed.client.routePreview.count({ where: { tripId: trip.id } }),
    previewsBeforeNavigation,
  );
  await page.screenshot({
    path: 'docs/status/assets/p6a-1/postgres-mobile-saved-transport.png',
    fullPage: true,
  });
  await page.locator('#route-search input[name=when]').fill('2030-10-01T14:15');
  await page.getByRole('button', { name: '搜索路线' }).click();
  await expect(page.locator('.candidate')).toBeVisible();
  await expect(page.locator('.candidate')).toBeEnabled();
  await page.locator('.candidate').click();
  await page.getByRole('button', { name: '使用这条路线' }).click();
  await expect(page.locator('.undo')).toBeVisible();
  const replacement = await managed.client.transportEdge.findFirstOrThrow({
    where: { tripId: trip.id },
    include: { temporalValues: true },
  });
  assert.equal(
    replacement.temporalValues
      .find((v) => v.pointKind === 'DEPARTURE')!
      .instant.toISOString(),
    '2030-10-01T05:15:00.000Z',
  );
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
  assert.equal(after.version, before.version + 3);
  console.log(
    JSON.stringify({
      status: 'PASS',
      source: 'real PostgreSQL 17 + HTTP + Chromium',
      provider: 'SYNTHETIC',
      noteReload: 'PASS',
      queryPreviewReadOnly: 'PASS',
      explicitAdoptUndo: 'PASS',
      delayedNoteTimeDwellWrites: 'PASS',
      recoveryRealServerVersion: 'PASS',
      concurrentNoteRecovery: 'PASS',
      revokedSessionMagicLinkRecovery: 'PASS',
      offlineTransportRecovery: 'PASS',
      savedNavigationNoPlanningCalls: 'PASS',
      old15Replacement1415: 'PASS',
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
