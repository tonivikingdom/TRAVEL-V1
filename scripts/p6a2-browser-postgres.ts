/** Isolated SYNTHETIC PostgreSQL + real HTTP + browser authoring acceptance. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import {
  AuthService,
  TripService,
  digestOpaqueToken,
} from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaTripRepository,
} from '../packages/persistence/src/index.js';
import { buildApi } from '../apps/api/src/app.js';
const databaseUrl = process.env.DATABASE_URL;
assert(
  databaseUrl && ['development', 'test'].includes(process.env.APP_ENV ?? ''),
);
const url = new URL(databaseUrl);
assert(
  ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    /^\/travel_p6a2_browser_[a-z0-9_]+$/u.test(url.pathname),
  'Dedicated local synthetic DB required',
);
const db = createPrismaClient(databaseUrl),
  service = new TripService(new PrismaTripRepository(db.client));
const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
const user = await db.client.user.create({
  data: {
    email: `p6a2-${randomUUID()}@synthetic.example.test`,
    normalizedEmail: `p6a2-${randomUUID()}@synthetic.example.test`,
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
let catalog = await service.createTrip(actor, {
  name: 'SYNTHETIC 已保存地点',
  planningAnchorDate: '2032-09-01',
  defaultPeopleCount: 1,
});
catalog = await service.executeCommand(actor, catalog.id, catalog.version, {
  type: 'ADD_PLACE_VISIT',
  targetDay: { type: 'NEW', localDate: '2032-09-01', sequence: 0 },
  position: 0,
  place: {
    type: 'CUSTOM',
    name: 'SYNTHETIC 很长的酒店名称用于窄屏与大字体验收',
    latitude: 35.6812,
    longitude: 139.7671,
    address: 'SYNTHETIC 测试地址',
  },
});
const auth = new AuthService(new PrismaAuthRepository(db.client), {
  magicLinkLandingUrl: 'http://127.0.0.1:5176/login/magic',
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
      return { name: 'postgresql', status: 'READY' as const };
    },
  },
  authService: auth,
  tripService: service,
});
await app.listen({ host: '127.0.0.1', port: 43151 });
const web = spawn(
  'pnpm',
  ['--filter', '@travel/web', 'dev', '--port', '5176'],
  {
    env: { ...process.env, WEB_API_ORIGIN: 'http://127.0.0.1:43151' },
    stdio: 'ignore',
    detached: true,
  },
);
const browser = await chromium.launch({
  executablePath: process.env.WEB_TEST_CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const assets = 'docs/status/assets/p6a-2';
await mkdir(assets, { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      ready = (await fetch('http://127.0.0.1:5176')).ok;
      if (ready) break;
    } catch {
      /* Vite is still starting. */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(ready);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(
    (token) => sessionStorage.setItem('travel.web.session', token),
    credential,
  );
  const screen = async (name: string) =>
    page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
  await page.goto('http://127.0.0.1:5176');
  await page.locator('[data-action=create-trip]').click();
  await page.locator('[name=name]').fill('SYNTHETIC 从头安排的旅行');
  await page.locator('[name=date]').fill('2032-10-01');
  await page.getByRole('button', { name: '创建旅行', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  const trip = await db.client.trip.findFirstOrThrow({
    where: { ownerUserId: user.id, name: 'SYNTHETIC 从头安排的旅行' },
  });
  assert.equal(
    await db.client.dateOwnership.count({ where: { tripId: trip.id } }),
    0,
  );
  await page.locator('[data-action=add-arrangement]').click();
  await screen('mobile-add-choice');
  await page.getByRole('button', { name: '自由行动', exact: true }).click();
  await page.locator('[name=title]').fill('SYNTHETIC 附近散步');
  await screen('mobile-add-activity');
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  assert.equal(
    await db.client.dateOwnership.count({ where: { tripId: trip.id } }),
    1,
  );
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '地点', exact: true }).click();
  await page
    .locator('[name=place]')
    .selectOption(catalog.days[0]!.nodes[0]!.place!.id);
  await page.locator('[name=note]').fill('SYNTHETIC 已保存可靠地点');
  await screen('mobile-add-place');
  await page.getByRole('button', { name: '添加地点', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  await page.locator('[data-authoring-move]').last().click();
  await page.locator('[name=position]').selectOption('0');
  await screen('mobile-order-date');
  await page.getByRole('button', { name: '保存位置', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  await screen('mobile-day-places');
  await page.locator('[data-node]').first().click();
  await screen('mobile-place-detail');
  await page.locator('[data-close]').click();
  await page.reload();
  await page.locator(`[data-trip="${trip.id}"]`).click();
  await expect(page.locator('.place-card').first()).toContainText('酒店名称');
  let current = await service.getTrip(actor, trip.id);
  assert.equal(current.days[0]!.nodes[0]!.kind, 'PLACE_VISIT');
  assert.equal(current.days[0]!.nodes[1]!.kind, 'FREE_ACTION');
  await page.locator('[data-action=next-day]').click();
  await expect(page.locator('.temporary-day-note')).toBeVisible();
  assert.equal(
    await db.client.dayOccurrence.count({ where: { tripId: trip.id } }),
    1,
  );
  await page.reload();
  await page.locator(`[data-trip="${trip.id}"]`).click();
  await expect(page.locator('.temporary-day-note')).toHaveCount(0);
  await page.locator('[data-action=next-day]').click();
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '自由行动', exact: true }).click();
  await page.locator('[name=title]').fill('SYNTHETIC 第二天休息');
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  assert.equal(
    await db.client.dateOwnership.count({ where: { tripId: trip.id } }),
    2,
  );
  current = await service.getTrip(actor, trip.id);
  await page
    .locator(`[data-day="${current.days[0]!.dayOccurrenceId}"]`)
    .click();
  await page.locator('[data-authoring-move]').last().click();
  await page
    .locator('[name=day]')
    .selectOption(current.days[1]!.dayOccurrenceId);
  await page.locator('[name=position]').selectOption('1');
  await page.getByRole('button', { name: '保存位置', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  current = await service.getTrip(actor, trip.id);
  assert.equal(current.days[1]!.nodes.length, 2);
  assert.equal(current.days[1]!.nodes[1]!.note, 'SYNTHETIC 附近散步');
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await screen(`mobile-day-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 960 });
  await screen('desktop-day');
  await page.setViewportSize({ width: 390, height: 844 });
  // Real optimistic conflict while the same account retains its activity draft.
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '自由行动', exact: true }).click();
  await page.locator('[name=title]').fill('SYNTHETIC 版本冲突保留草稿');
  current = await service.executeAuthoring(actor, trip.id, {
    baseTripVersion: current.version,
    idempotencyKey: randomUUID(),
    command: {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: current.days[1]!.dayOccurrenceId,
      },
      position: 2,
      note: 'SYNTHETIC 另一设备更新',
    },
  });
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('[data-authoring-recover]')).toBeVisible();
  await expect(page.locator('[name=title]')).toHaveValue(
    'SYNTHETIC 版本冲突保留草稿',
  );
  await screen('mobile-version-conflict');
  await page.locator('[data-authoring-recover]').click();
  await page.locator('[data-authoring-ack]').click();
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  // Another device moves the last contents off the draft's original day.
  current = await service.getTrip(actor, trip.id);
  const removedDay = current.days[1]!;
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '自由行动', exact: true }).click();
  await page.locator('[name=title]').fill('SYNTHETIC 原日期移走后的草稿');
  for (const node of removedDay.nodes) {
    const res = await fetch(
      `http://127.0.0.1:43151/trips/${trip.id}/authoring`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          baseTripVersion: current.version,
          idempotencyKey: randomUUID(),
          command: {
            type: 'MOVE_NODE',
            nodeId: node.id,
            targetDay: {
              type: 'EXISTING',
              dayOccurrenceId: current.days[0]!.dayOccurrenceId,
            },
            position: current.days[0]!.nodes.length,
          },
        }),
      },
    );
    assert.equal(res.status, 200);
    current = (await res.json()) as typeof current;
  }
  assert.equal(current.days.length, 1);
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await page.locator('[data-authoring-recover]').click();
  await expect(page.locator('#authoring-retarget')).toBeVisible();
  await expect(page.locator('[name=title]')).toHaveValue(
    'SYNTHETIC 原日期移走后的草稿',
  );
  await page
    .locator('#authoring-retarget')
    .selectOption(current.days[0]!.dayOccurrenceId);
  await screen('mobile-removed-date-recovery');
  await page.locator('[data-authoring-ack]').click();
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.locator('[data-close]').click();
  current = await service.getTrip(actor, trip.id);
  assert.equal(
    current.days[0]!.nodes.at(-1)!.note,
    'SYNTHETIC 原日期移走后的草稿',
  );
  // Another Trip owns tomorrow: no occurrence, receipt, version or data is partially changed.
  const occupied = await service.createTrip(actor, {
    name: 'SYNTHETIC 日期占用',
    planningAnchorDate: '2032-10-02',
    defaultPeopleCount: 1,
  });
  await service.executeAuthoring(actor, occupied.id, {
    baseTripVersion: occupied.version,
    idempotencyKey: randomUUID(),
    command: {
      type: 'ADD_FREE_ACTION',
      targetDay: { type: 'NEW', localDate: '2032-10-02', sequence: 0 },
      position: 0,
      note: 'SYNTHETIC 另一旅行',
    },
  });
  await page.locator('[data-action=next-day]').click();
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '自由行动', exact: true }).click();
  await page.locator('[name=title]').fill('SYNTHETIC 日期冲突草稿');
  const before = await service.getTrip(actor, trip.id);
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('另一趟行程');
  await expect(page.locator('[name=title]')).toHaveValue(
    'SYNTHETIC 日期冲突草稿',
  );
  assert.deepEqual(await service.getTrip(actor, trip.id), before);
  await screen('mobile-date-conflict');
  console.log(
    JSON.stringify({
      synthetic: true,
      postgresHttpBrowser: 'PASS',
      tripId: trip.id,
      range: before.effectiveStartDate + '..' + before.effectiveEndDate,
      version: before.version,
      temporaryBlankWrites: 0,
      dateConflictWrites: 0,
      knownPlaceNoLookup: true,
    }),
  );
} finally {
  await browser.close();
  if (web.pid) process.kill(-web.pid, 'SIGTERM');
  await app.close();
  await db.close();
}
