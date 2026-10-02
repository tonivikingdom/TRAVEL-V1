import { expect, test, type Page } from '@playwright/test';
import {
  fixtureCandidate,
  fixtureSchedule,
  fixtureTrip,
  fromId,
  toId,
  tripId,
} from './fixture.js';
import type { RoutePreviewView, TripView } from '@travel/contracts';
let trip: TripView;
let commands: Record<string, unknown>[];
let calls: string[];
let failSave = false;
let delayQuery = false;
let failQuery = false;
const candidate = fixtureCandidate();
function preview(): RoutePreviewView {
  return {
    previewId: tripId,
    tripId,
    basisVersion: trip.version,
    candidateSnapshotId: candidate.candidateSnapshotId,
    candidateHash: 'synthetic',
    policyVersion: 'route-adoption-preview-v3',
    createdAt: '2030-10-01T04:00:00Z',
    expiresAt: '2030-10-01T06:00:00Z',
    adoptable: true,
    status: 'ACTIVE',
    currentConnection: {
      fromNodeId: fromId,
      toNodeId: toId,
      state: 'MISSING',
      transport: null,
    },
    candidate,
    changeSummary: {
      transportAction: 'CREATE',
      willReplaceTransportEdgeId: null,
      requiresGeneratedNodes: false,
      generatedTransferPoints: [],
      proposedSegments: [],
      temporalLayer: 'PLANNED',
      temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
    },
  };
}
async function enter(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '东京慢旅行' }).click();
  await expect(page.locator('.timeline')).toBeVisible();
}
async function route(page: Page) {
  await page.locator('.connection').click();
  await page.getByRole('button', { name: '搜索路线' }).click();
  await expect(page.locator('.candidate')).toBeVisible();
}
async function screenshot(page: Page, name: string) {
  if (process.env.WEB_TEST_SCREENSHOTS === 'true')
    await page.screenshot({
      path: `docs/status/assets/p6a-1/${name}.png`,
      fullPage: true,
    });
}
test.beforeEach(async ({ page }) => {
  trip = fixtureTrip();
  commands = [];
  calls = [];
  failSave = false;
  delayQuery = false;
  failQuery = false;
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_BROWSER_ONLY'),
  );
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/u, '');
    calls.push(path);
    const send = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    if (path === '/trips') return send({ trips: [trip] });
    if (path === `/trips/${tripId}`) return send(trip);
    if (path.endsWith('/schedule/evaluate')) return send(fixtureSchedule(trip));
    if (path.endsWith('/commands')) {
      const body = req.postDataJSON();
      commands.push(body);
      if (failSave)
        return send(
          { error: { code: 'VERSION_CONFLICT', message: 'stale' } },
          409,
        );
      if (body.command.type === 'SET_NODE_NOTE')
        trip = {
          ...trip,
          version: trip.version + 1,
          days: trip.days.map((d) => ({
            ...d,
            nodes: d.nodes.map((n) =>
              n.id === body.command.nodeId
                ? { ...n, note: body.command.note }
                : n,
            ),
          })),
        };
      return send(trip);
    }
    if (path.endsWith('/routes/query')) {
      if (delayQuery) await new Promise((resolve) => setTimeout(resolve, 600));
      if (failQuery)
        return send(
          {
            error: {
              code: 'PROVIDER_UNAVAILABLE',
              message: '路线服务暂时不可用。',
            },
          },
          503,
        );
      return send({
        tripId,
        basisVersion: trip.version,
        fromNodeId: fromId,
        toNodeId: toId,
        timeCondition: candidate.queryTimeCondition,
        candidates: [candidate],
      });
    }
    if (path.endsWith('/previews')) return send(preview(), 201);
    if (path.endsWith('/adopt')) {
      trip = { ...trip, version: trip.version + 1 };
      return send({
        trip,
        operationReceipt: {
          id: tripId,
          operationType: 'ROUTE_ADOPT',
          resultingTripVersion: trip.version,
        },
      });
    }
    return send(
      { error: { code: 'NOT_FOUND', message: 'unknown fixture' } },
      404,
    );
  });
});
test('three time fields, unknown values, date switch and desktop composition', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enter(page);
  await expect(page.locator('.place-card').first()).toContainText('13:00');
  await expect(page.locator('.place-card').first()).toContainText('14:00');
  await expect(page.locator('.place-card').first()).toContainText('1 小时');
  await expect(page.locator('.place-card').last()).toContainText('待定');
  await screenshot(page, 'desktop-day');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, 'mobile-day');
  await page.getByRole('button', { name: '第 2 天' }).click();
  await expect(page.locator('.empty')).toContainText('还没有安排');
});
test('place detail saves notes via API and rereads after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await page.locator('[data-node]').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').locator('.times')).toContainText(
    '13:00',
  );
  await screenshot(page, 'mobile-place');
  await page.locator('textarea').fill('SYNTHETIC 真正保存');
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  expect(commands[0]).toMatchObject({
    baseTripVersion: 1,
    command: { type: 'SET_NODE_NOTE', note: 'SYNTHETIC 真正保存' },
  });
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.locator(`[data-node="${fromId}"]`)).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: '东京慢旅行' }).click();
  await page.locator('[data-node]').first().click();
  await expect(page.locator('textarea')).toHaveValue('SYNTHETIC 真正保存');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.locator(`[data-node="${fromId}"]`)).toBeFocused();
});
test('dirty failure survives X and Escape, clean close returns focus', async ({
  page,
}) => {
  await enter(page);
  const opener = page.locator('[data-node]').first();
  await opener.click();
  await page.locator('textarea').fill('unsaved');
  failSave = true;
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已变化');
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('textarea')).toHaveValue('unsaved');
  await page.locator('textarea').fill('');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(opener).toBeFocused();
});
test('drag threshold and short bounce; input interaction does not drag', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await page.locator('[data-node]').first().click();
  const handle = page.locator('.handle');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 15, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 15, box.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('textarea').fill('');
  const next = (await handle.boundingBox())!;
  await page.mouse.move(next.x + 15, next.y + 2);
  await page.mouse.down();
  await page.mouse.move(next.x + 15, next.y + 140, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
test('native modal contains focus and background interaction, scrollable body', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await enter(page);
  await page.locator('[data-node]').first().click();
  await page.locator('summary').click();
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(() =>
      document.querySelector('#detail')!.contains(document.activeElement),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(
    'hidden',
  );
  await page.locator('textarea').fill('input remains functional');
  await expect(page.getByRole('dialog')).toBeVisible();
});
test('route condition is hotel departure, pipeline stays internal until explicit use', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await route(page);
  const queryPath = calls.filter((c) => c.endsWith('/routes/query'));
  expect(queryPath).toHaveLength(1);
  expect(calls.some((c) => c.endsWith('/adopt'))).toBe(false);
  await screenshot(page, 'mobile-candidates');
  await page.locator('.candidate').click();
  await expect(page.locator('.choice')).toContainText('这条路线');
  await screenshot(page, 'mobile-route');
  expect(calls.some((c) => c.endsWith('/adopt'))).toBe(false);
  await page.getByRole('button', { name: '使用这条路线' }).click();
  await expect(page.locator('.undo')).toContainText('撤销刚才');
  expect(calls.filter((c) => c.endsWith('/adopt'))).toHaveLength(1);
});
test('query edit invalidates delayed responses and chosen preview', async ({
  page,
}) => {
  await enter(page);
  await page.locator('.connection').click();
  delayQuery = true;
  await page.getByRole('button', { name: '搜索路线' }).click();
  await page.locator('#route-search input[name=when]').fill('2030-10-01T16:00');
  await page.waitForTimeout(800);
  await expect(page.locator('.candidate')).toHaveCount(0);
  await expect(page.locator('[data-action=adopt]')).toHaveCount(0);
});
test('provider failure is distinct from empty routes and preserves external exit', async ({
  page,
}) => {
  await enter(page);
  await page.locator('.connection').click();
  failQuery = true;
  await page.getByRole('button', { name: '搜索路线' }).click();
  await expect(page.locator('#save-status')).toContainText('服务暂时不可用');
  await expect(page.getByRole('link', { name: '在地图中查询' })).toBeVisible();
});
test('map URLs use trusted selected endpoints; click never emits execution facts', async ({
  page,
}) => {
  await enter(page);
  await page.locator('[data-node]').first().click();
  const map = page.getByRole('link', { name: '查看地图', exact: true });
  expect(await map.getAttribute('href')).toContain('35.6812%2C139.7671');
  const before = calls.length;
  await page.route('https://www.google.com/**', (route) =>
    route.fulfill({ body: 'External Maps stub' }),
  );
  await map.click();
  expect(calls.length).toBe(before);
  expect(calls.some((c) => c.includes('/execution'))).toBe(false);
});
test('saved conflict remains visible instead of deleting selected route', async ({
  page,
}) => {
  const n = trip.days[0]!.nodes[0]!;
  trip = {
    ...trip,
    connections: [
      {
        fromNodeId: fromId,
        toNodeId: toId,
        state: 'ACTIVE',
        transport: {
          id: tripId,
          fromNodeId: fromId,
          toNodeId: toId,
          mode: 'RAIL',
          fixedService: true,
          serviceLabel: 'SYNTHETIC 旧路线',
          note: null,
          source: 'MANUAL',
          adoptedRouteId: null,
          provider: null,
          providerRef: null,
          createdAt: '2030-01-01T00:00:00Z',
          updatedAt: '2030-01-01T00:00:00Z',
          timeValues: [
            {
              ...n.timeValues[0]!,
              pointKind: 'DEPARTURE',
              instant: '2030-10-01T01:45:00Z',
            },
          ],
        },
      },
    ],
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await expect(page.locator('.connection')).toContainText('原路线仍保留');
  await screenshot(page, 'mobile-conflict');
  expect(commands).toHaveLength(0);
});
for (const width of [320, 375, 390, 430])
  test(`no overflow at ${width}px, long content and expanded edit`, async ({
    page,
  }) => {
    trip = {
      ...trip,
      days: trip.days.map((d) => ({
        ...d,
        nodes: d.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                place: {
                  ...n.place!,
                  name: 'SYNTHETIC 一个很长的酒店名称与地址用于窄屏适配验证',
                },
              }
            : n,
        ),
      })),
    };
    await page.setViewportSize({ width, height: 844 });
    await enter(page);
    await page.locator('[data-node]').first().click();
    await page.locator('summary').click();
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth > innerWidth,
      dialog:
        document.querySelector('#detail')!.scrollWidth >
        document.querySelector('#detail')!.clientWidth,
    }));
    expect(overflow).toEqual({ page: false, dialog: false });
    if (width === 320) await screenshot(page, 'mobile-narrow');
  });
test('offline hides stale formal itinerary; recovery requires server reload', async ({
  page,
}) => {
  await enter(page);
  await page.locator('[data-node]').first().click();
  await page.locator('textarea').fill('SYNTHETIC preserved offline draft');
  await page.evaluate(() => dispatchEvent(new Event('offline')));
  await expect(page.getByRole('dialog').locator('.times')).toBeHidden();
  await expect(page.getByRole('link', { name: '查看地图' })).toBeHidden();
  await expect(page.locator('textarea')).toHaveValue(
    'SYNTHETIC preserved offline draft',
  );
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('无法保存');
  expect(commands).toHaveLength(0);
  await expect(page.locator('.timeline')).toHaveCount(0);
  await expect(page.locator('.message')).toContainText('无网');
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect(page.locator('.message')).toContainText('重新载入');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.getByRole('button', { name: '东京慢旅行' })).toBeVisible();
});

test('401 allows fresh login without discarding failed modal draft', async ({
  page,
}) => {
  await enter(page);
  await page.locator('[data-node]').first().click();
  await page.locator('textarea').fill('SYNTHETIC unsaved after expiry');
  await page.route('**/api/**/commands', (r) =>
    r.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAUTHENTICATED', message: 'expired' },
      }),
    }),
  );
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('登录已失效');
  await expect(page.locator('textarea')).toHaveValue(
    'SYNTHETIC unsaved after expiry',
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem('travel.web.session')),
  ).toBeNull();
});
test('saving one form does not clear another form dirty protection', async ({
  page,
}) => {
  await enter(page);
  await page.locator('[data-node]').first().click();
  await page.locator('summary').click();
  await page.locator('#time-edit input[name=when]').fill('2030-10-01T18:00');
  await page.locator('textarea').fill('saved note');
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
  page.on('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#time-edit input[name=when]')).toHaveValue(
    '2030-10-01T18:00',
  );
});

test('independent latest-arrival target stays separate from planned time', async ({
  page,
}) => {
  const first = trip.days[0]!.nodes[0]!;
  trip = {
    ...trip,
    days: trip.days.map((d, i) =>
      i === 0
        ? {
            ...d,
            nodes: d.nodes.map((n, j) =>
              j === 0
                ? {
                    ...n,
                    timeValues: n.timeValues.filter(
                      (v) => v.pointKind === 'ARRIVAL',
                    ),
                    timeIntents: [
                      ...n.timeIntents,
                      {
                        id: toId,
                        kind: 'POINT_TIME',
                        pointKind: 'ARRIVAL',
                        operator: 'NOT_AFTER',
                        instant: '2030-10-01T05:00:00Z',
                        timeZone: 'Asia/Tokyo',
                        durationSeconds: null,
                        locked: true,
                        createdAt: first.createdAt,
                        updatedAt: first.updatedAt,
                      },
                    ],
                  }
                : n,
            ),
          }
        : d,
    ),
  };
  await enter(page);
  const card = page.locator('.place-card').first();
  await expect(card.locator('.times')).toContainText('13:00');
  await expect(card.locator('.times')).toContainText('待定');
  await expect(card.locator('.requirement').last()).toContainText(
    '到达不晚于 14:00',
  );
  await page.locator('[data-node]').first().click();
  await expect(page.locator('#time-edit input[name=when]')).toHaveValue(
    '2030-10-01T14:00',
  );
});
test('ARRIVE_BY submits explicit date and timezone without becoming DEPART_AT', async ({
  page,
}) => {
  await enter(page);
  await page.locator('.connection').click();
  await page.locator('#route-search select').selectOption('ARRIVE_BY');
  await page.locator('#route-search input[name=when]').fill('2030-10-02T00:30');
  await page.locator('#route-search input[name=zone]').fill('Asia/Tokyo');
  const request = page.waitForRequest((r) => r.url().endsWith('/routes/query'));
  await page.getByRole('button', { name: '搜索路线' }).click();
  expect((await request).postDataJSON()).toMatchObject({
    basisVersion: 1,
    fromNodeId: fromId,
    toNodeId: toId,
    hint: {
      type: 'ARRIVE_BY',
      instant: '2030-10-01T15:30:00.000Z',
      timeZone: 'Asia/Tokyo',
    },
  });
});
test('landscape and enlarged text remain usable with a scrollable narrow sheet', async ({
  page,
}) => {
  await page.setViewportSize({ width: 740, height: 390 });
  await enter(page);
  await page.locator('[data-node]').first().click();
  await page.locator('summary').click();
  await page.addStyleTag({ content: ':root{font-size:22px}' });
  await page.locator('textarea').fill('SYNTHETIC landscape draft');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.locator('#save-status')).toContainText('已保存');
});

test('core service outage conceals old itinerary without treating Provider failure as a core outage', async ({
  page,
}) => {
  await enter(page);
  await page.route(`**/api/trips/${tripId}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'SYNTHETIC outage' },
      }),
    }),
  );
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.timeline')).toHaveCount(0);
  await expect(page.locator('.message')).toContainText('核心服务暂时不可用');
});
