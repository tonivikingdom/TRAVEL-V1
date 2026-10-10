import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createPrismaClient } from '../packages/persistence/dist/index.js';
const root = process.env.P7A_UX_EVIDENCE_DIR;
assert(root);
assert(
  new URL(process.env.DATABASE_URL).pathname === '/travel_p7a_ux_round1_test',
);
const db = createPrismaClient(process.env.DATABASE_URL);
const resumeTrip = process.env.P7A_RESUME_TRIP;
let planningDate = '2030-10-10';
if (resumeTrip)
  planningDate = (
    await db.client.trip.findUniqueOrThrow({ where: { id: resumeTrip } })
  ).planningAnchorDate
    .toISOString()
    .slice(0, 10);
while (
  !resumeTrip &&
  (await db.client.dateOwnership.count({
    where: { localDate: new Date(`${planningDate}T00:00:00Z`) },
  }))
) {
  planningDate = new Date(
    new Date(`${planningDate}T00:00:00Z`).getTime() + 86400000,
  )
    .toISOString()
    .slice(0, 10);
}
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  timezoneId: 'Asia/Shanghai',
});
page.setDefaultTimeout(15000);
const result = {
  synthetic: true,
  baseline: '4f6b31a262acdf9ac634f0ad58eab437ca79d4cb',
  checks: {},
  requests: [],
  browserErrors: [],
};
page.on('pageerror', (e) => result.browserErrors.push(e.message));
page.on('response', (response) => {
  if (response.url().includes('/api/'))
    result.requests.push({
      method: response.request().method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
    });
});
const checkpoint = (name, evidence) => {
  result.checks[name] = evidence;
  console.log(`PASS ${name}: ${JSON.stringify(evidence)}`);
};
const snapshot = (name) =>
  page.screenshot({ path: `${root}/${name}.png`, fullPage: true });
let tripId;
try {
  await page.goto('http://127.0.0.1:5175');
  await expect(
    page.getByRole('heading', { name: '把旅行安排好' }),
  ).toBeVisible();
  checkpoint('formalWeb', { url: page.url(), status: 200 });
  const oldMessages = (
    await readFile(`${process.env.MAIL_CAPTURE_FILE}`, 'utf8').catch(() => '')
  )
    .split('\n')
    .filter(Boolean).length;
  await page
    .locator('#login input[name=email]')
    .fill('synthetic-p7a@synthetic.example.test');
  await page.getByRole('button', { name: '发送登录链接', exact: true }).click();
  let message;
  for (let i = 0; i < 40; i++) {
    const lines = (
      await readFile(`${process.env.MAIL_CAPTURE_FILE}`, 'utf8').catch(() => '')
    )
      .split('\n')
      .filter(Boolean);
    if (lines.length > oldMessages) {
      message = JSON.parse(lines.at(-1));
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(message?.kind === 'SYNTHETIC_MAGIC_LINK');
  assert(new URL(message.magicLink).origin === 'http://127.0.0.1:5175');
  await page.goto(message.magicLink);
  await expect(page.locator('[data-action=create-trip]')).toBeVisible();
  checkpoint('magicLinkLoginAndWorkerDelivery', {
    email: message.recipient,
    landingOrigin: new URL(message.magicLink).origin,
  });
  if (!resumeTrip) {
    await page.locator('[data-action=create-trip]').click();
    const name = `SYNTHETIC 本地体验 ${Date.now()}`;
    await page.locator('#authoring-create [name=name]').fill(name);
    await page.locator('#authoring-create [name=date]').fill(planningDate);
    await page.getByRole('button', { name: '创建旅行', exact: true }).click();
    await expect(page.locator('#detail')).not.toBeVisible();
    const tripRecord = await db.client.trip.findFirstOrThrow({
      where: { name },
    });
    tripId = tripRecord.id;
    assert.equal(await db.client.dateOwnership.count({ where: { tripId } }), 0);
    checkpoint('createTrip', { tripId, emptyTripOwnsNoDates: true });
    for (const index of [0, 1]) {
      await page.locator('[data-action=add-arrangement]').click();
      await page
        .locator('[data-place-query]')
        .fill(`SYNTHETIC 地点 ${index + 1}`);
      if (index > 0) await new Promise((r) => setTimeout(r, 2100));
      await page.locator('[data-place-search]').click();
      await expect(page.locator(`[data-candidate="${index}"]`)).toBeVisible();
      await page.locator(`[data-candidate="${index}"]`).click();
      await page
        .locator('#authoring-add [name=note]')
        .fill(`SYNTHETIC 本地测试地点 ${index + 1}`);
      await page.getByRole('button', { name: '添加地点', exact: true }).click();
      await expect(page.locator('#save-status')).toContainText(
        '本次提交已保存',
      );
      await page.locator('[data-close]').first().click();
      await expect(page.locator('#detail')).not.toBeVisible();
    }
    assert.equal(await db.client.itineraryNode.count({ where: { tripId } }), 2);
    checkpoint('addPlaces', {
      persistedNodes: 2,
      source: 'SyntheticPlaceSearchProvider',
    });
  } else {
    tripId = resumeTrip;
    await page.locator(`[data-trip="${tripId}"]`).click();
    checkpoint('createTrip', { tripId, createdViaBrowserInPriorAttempt: true });
    assert.equal(await db.client.itineraryNode.count({ where: { tripId } }), 2);
    checkpoint('addPlaces', {
      persistedNodes: 2,
      addedViaBrowserInPriorAttempt: true,
      source: 'SyntheticPlaceSearchProvider',
    });
  }
  await page.locator('[data-node]').first().click();
  await page.locator('.edit > summary').click();
  await page
    .locator('#time-edit [name=requirement]')
    .selectOption('DEPARTURE:NOT_BEFORE');
  await page.locator('#time-edit .date-trigger').click();
  await page.locator('.calendar [aria-label=年份]').selectOption('2030');
  await page.locator('.calendar [aria-label=月份]').selectOption('9');
  await page.locator('.calendar [data-date="' + planningDate + '"]').click();
  await page.locator('#time-edit [data-time-part]').fill('10:00');
  const zoneSelect = page.locator('#time-edit [data-zone]');
  await zoneSelect.selectOption('Asia/Tokyo');
  await page.getByRole('button', { name: '保存时间要求', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  const nodes = await db.client.itineraryNode.findMany({
    where: { tripId },
    include: { timeIntents: true },
    orderBy: { position: 'asc' },
  });
  assert(
    nodes[0].timeIntents.some(
      (i) =>
        i.kind === 'POINT_TIME' &&
        i.instant.toISOString() === `${planningDate}T01:00:00.000Z`,
    ),
  );
  checkpoint('editPlaceTime', {
    localTime: `${planningDate} 10:00 Asia/Tokyo`,
    persistedInstant: `${planningDate}T01:00:00.000Z`,
  });
  await page.locator('[data-close]').first().click();
  await page.reload();
  await page.locator(`[data-trip="${tripId}"]`).click();
  await snapshot('desktop-itinerary');
  const before = await db.client.trip.findUniqueOrThrow({
    where: { id: tripId },
  });
  await page.locator('[data-route-from]').first().click();
  await page.locator('[name=travelMode]').selectOption('WALKING');
  await page.locator('#route-search [name=when]').fill(`${planningDate}T10:00`);
  if (!(await page.locator('#route-search [data-zone]').isVisible()))
    await page.locator('#route-search .zone-choice summary').click();
  await page.locator('#route-search [data-zone]').selectOption('Asia/Tokyo');
  await page.getByRole('button', { name: '搜索路线', exact: true }).click();
  await expect(page.locator('.candidate').first()).toBeVisible();
  assert.equal(
    (await db.client.trip.findUniqueOrThrow({ where: { id: tripId } })).version,
    before.version,
  );
  checkpoint('queryReadOnly', {
    version: before.version,
    provider: 'SYNTHETIC',
  });
  await page.locator('.candidate').first().click();
  await expect(page.locator('[data-action=adopt]')).toBeEnabled();
  assert.equal(
    (await db.client.trip.findUniqueOrThrow({ where: { id: tripId } })).version,
    before.version,
  );
  await snapshot('route-preview');
  checkpoint('previewReadOnly', { version: before.version });
  await page.getByRole('button', { name: '使用这条路线', exact: true }).click();
  await expect(page.locator('.undo')).toBeVisible();
  assert.equal(
    (await db.client.trip.findUniqueOrThrow({ where: { id: tripId } })).version,
    before.version + 1,
  );
  assert.equal(await db.client.transportEdge.count({ where: { tripId } }), 1);
  checkpoint('adopt', { versionIncrement: 1, persistedTransportEdges: 1 });
  await snapshot('adopted');
  await page
    .getByRole('button', { name: '撤销刚才的路线修改', exact: true })
    .click();
  await expect(page.locator('.message')).toContainText('已撤销');
  assert.equal(
    (await db.client.trip.findUniqueOrThrow({ where: { id: tripId } })).version,
    before.version + 2,
  );
  assert.equal(await db.client.transportEdge.count({ where: { tripId } }), 0);
  assert.equal(
    await db.client.adoptedRoute.count({ where: { tripId, status: 'UNDONE' } }),
    1,
  );
  checkpoint('undo', {
    versionIncrement: 1,
    persistedTransportEdges: 0,
    undoneRoute: 1,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await snapshot('mobile-viewport');
  assert(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  );
  checkpoint('mobileViewport', {
    width: 390,
    horizontalOverflow: false,
    realPhoneTested: false,
  });
  assert.equal(result.browserErrors.length, 0);
  assert(!result.requests.some((r) => r.status >= 400));
  checkpoint('browserAndApiErrors', { pageErrors: 0, failedApiRequests: 0 });
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.error = error.stack;
  console.error(error);
  await snapshot('failure');
  console.log('See task-owned failure screenshot.');
  process.exitCode = 1;
} finally {
  await writeFile(`${root}/verification.json`, JSON.stringify(result, null, 2));
  await browser.close();
  await db.close();
}
