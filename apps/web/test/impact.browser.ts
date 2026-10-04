import { test, expect } from '@playwright/test';
import type { TripImpactView } from '@travel/contracts';
import { fixtureSchedule } from './fixture.js';
import { inTripFixture } from './in-trip-fixture.js';
test.use({ timezoneId: 'Asia/Tokyo', viewport: { width: 390, height: 844 } });
let fixture = inTripFixture(),
  calls: string[] = [],
  impact: { -readonly [K in keyof TripImpactView]: TripImpactView[K] },
  fail = false,
  late = false,
  release: () => void;
test.beforeEach(async ({ page }) => {
  fixture = inTripFixture();
  calls = [];
  fail = false;
  late = false;
  impact = {
    tripId: fixture.trip.id,
    basisVersion: fixture.trip.version,
    evaluatedAt: '2030-10-01T05:11:00Z',
    items: [],
    handoffs: [],
  };
  await page.clock.install({ time: new Date('2030-10-01T05:11:00Z') });
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_IMPACT_ONLY'),
  );
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api', '');
    calls.push(`${req.method()} ${path}`);
    const send = (v: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(v),
      });
    if (path === '/me') return send({ id: fixture.trip.id });
    if (path === '/trips') return send({ trips: [fixture.trip] });
    if (path === `/trips/${fixture.trip.id}`) return send(fixture.trip);
    if (path.endsWith('/schedule/evaluate'))
      return send(fixtureSchedule(fixture.trip));
    if (path.endsWith('/in-trip')) return send(fixture.evidence);
    if (path.endsWith('/execution/ground-transit')) return send(fixture.ground);
    if (path.endsWith('/impact')) {
      if (late)
        await new Promise<void>((r) => {
          release = r;
        });
      return fail
        ? send({ error: { code: 'PROVIDER_UNAVAILABLE' } }, 503)
        : send(impact);
    }
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
});
async function enter(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await expect(page.locator('.trip-impact')).toBeVisible();
}
function readOnly() {
  expect(
    calls.filter(
      (c) => c.startsWith('POST') && !c.endsWith('/schedule/evaluate'),
    ),
  ).toEqual([]);
  expect(
    calls.some((c) =>
      /routes\/query|previews|\/adopt|\/refresh|execution\/events/u.test(c),
    ),
  ).toBe(false);
}
async function capture(page: import('@playwright/test').Page, name: string) {
  if (process.env.WEB_TEST_SCREENSHOTS === 'true')
    await page.screenshot({
      path: `docs/status/assets/p6c-1/${name}.png`,
      fullPage: true,
    });
}
for (const [name, status, changed, title, text] of [
  [
    'mobile-no-impact',
    'SATISFIED',
    false,
    '当前已核对安排可继续',
    '当前时间要求仍满足。',
  ],
  [
    'mobile-attention',
    'SATISFIED',
    true,
    '时间或交通有变化',
    '到达时间有变化；预计停留时间缩短 35 分钟，当前后续安排仍可继续。',
  ],
  [
    'mobile-replan-needed',
    'VIOLATED',
    false,
    '后续安排需要调整',
    '当前预计到达晚于下一交通出发，无法满足最低停留。',
  ],
  [
    'mobile-unknown',
    'UNKNOWN',
    false,
    '暂时无法判断后续影响',
    '交通来源不可用，当前无法核验预计时间。',
  ],
] as const)
  test(name, async ({ page }) => {
    impact.items = [
      {
        nodeId: fixture.trip.days[0]!.nodes[0]!.id,
        transportEdgeId: null,
        status,
        changed,
        title: '时间变化与后续安排',
        explanation: text,
      },
    ];
    await enter(page);
    await expect(page.locator('.trip-impact strong')).toHaveText(title);
    await capture(page, name);
    await page.getByRole('button', { name: '查看影响', exact: true }).click();
    await expect(page.locator('.impact-detail')).toContainText(
      changed || status !== 'SATISFIED' ? text : '已有事实与时间要求暂未显示',
    );
    if (name !== 'mobile-no-impact') await capture(page, `${name}-detail`);
    readOnly();
  });
for (const [name, readiness, basis] of [
  ['mobile-origin-unresolved', 'ORIGIN_UNRESOLVED', null],
  ['mobile-ready', 'READY', 'PLANNED_ROUTE_ORIGIN'],
  ['mobile-suffix', 'READY', 'CONFIRMED_EXECUTION_NODE'],
] as const)
  test(name, async ({ page }) => {
    impact.items = [
      {
        nodeId: null,
        transportEdgeId: 'edge-1',
        status: readiness === 'READY' ? 'VIOLATED' : 'UNKNOWN',
        changed: true,
        title:
          readiness === 'READY' ? '当前交通需要重新规划' : '当前进度需要核对',
        explanation:
          readiness === 'READY'
            ? 'SYNTHETIC 服务终点有变化，原路线需要重新评估。'
            : 'SYNTHETIC 缺少可靠的用户执行起点，暂时无法判断后续影响。',
      },
    ];
    impact.handoffs = [
      {
        tripId: fixture.trip.id,
        sourceTransportEdgeId: 'edge-1',
        adoptedRouteId: fixture.trip.id,
        readiness,
        originBasis: basis,
        reasonCodes: [],
        query:
          readiness === 'READY'
            ? {
                basisVersion: 1,
                fromNodeId: fixture.trip.days[0]!.nodes[2]!.id,
                toNodeId: fixture.trip.days[0]!.nodes.at(-1)!.id,
              }
            : null,
      },
    ];
    await enter(page);
    await page.getByRole('button', { name: '查看影响', exact: true }).click();
    await expect(page.locator('.handoff')).toContainText(
      readiness === 'READY'
        ? basis === 'CONFIRMED_EXECUTION_NODE'
          ? '前面的已确认部分保持不变'
          : '当前仍可从'
        : '需要先确认当前位置',
    );
    if (readiness === 'READY') {
      await page.getByRole('button', { name: '查看调整方案' }).click();
      await expect(page.locator('.alternative-search')).toContainText(
        '搜索和查看方案不会改变当前行程',
      );
    } else await expect(page.locator('[data-impact-handoff]')).toHaveCount(0);
    await capture(page, name);
    readOnly();
  });
test('NOT_REQUIRED never exposes a replan button', async ({ page }) => {
  impact.handoffs = [
    {
      tripId: fixture.trip.id,
      sourceTransportEdgeId: 'edge-1',
      adoptedRouteId: fixture.trip.id,
      readiness: 'NOT_REQUIRED',
      reasonCodes: [],
      query: null,
    },
  ];
  await enter(page);
  await page.getByRole('button', { name: '查看影响', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看调整方案' })).toHaveCount(
    0,
  );
  readOnly();
});
test('provider/read unavailable stays local UNKNOWN without destroying Today', async ({
  page,
}) => {
  fail = true;
  await enter(page);
  await expect(page.locator('.trip-impact')).toContainText('暂时无法判断');
  await expect(page.locator('.next-step')).toBeVisible();
  readOnly();
});
test('stale response version cannot display an old impact plan', async ({
  page,
}) => {
  impact.basisVersion = 2;
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await expect(page.locator('#app')).toContainText('行程或方案已变化');
  await expect(page.locator('.trip-impact')).toHaveCount(0);
  readOnly();
});
test('late impact response cannot repaint another navigation', async ({
  page,
}) => {
  late = true;
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await expect.poll(() => !!release).toBe(true);
  await page.locator('[data-view=itinerary]').click();
  release();
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.locator('.trip-impact')).toHaveCount(0);
  readOnly();
});
for (const width of [320, 375, 390, 430, 1280])
  test(`impact layout ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 960 : 844 });
    impact.items = [
      {
        nodeId: fixture.trip.days[0]!.nodes[0]!.id,
        transportEdgeId: null,
        status: 'VIOLATED',
        changed: false,
        title: '后续安排需要调整',
        explanation:
          'SYNTHETIC 当前预计到达晚于下一交通出发；用户要求的最低停留无法满足。',
      },
    ];
    await enter(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture(page, width === 1280 ? 'desktop' : `mobile-${width}`);
    await page.getByRole('button', { name: '查看影响', exact: true }).click();
    expect(
      await page
        .locator('.sheet-body')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    readOnly();
  });
test('enlarged text keeps impact and drawer controls reachable', async ({
  page,
}) => {
  await enter(page);
  await page.addStyleTag({ content: 'html {font-size:24px !important}' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, 'mobile-enlarged');
  await page.getByRole('button', { name: '查看影响', exact: true }).click();
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(page.locator('.trip-impact')).toBeVisible();
  readOnly();
});

test.describe('Impact inherits mobile drawer protection', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [320, 375, 390, 430])
    test(`${width}px impact drawer retains capture reset, keyboard fitting and subsequent Place draft`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      impact.items = [
        {
          nodeId: fixture.trip.days[0]!.nodes[0]!.id,
          transportEdgeId: null,
          status: 'VIOLATED',
          changed: true,
          title: 'SYNTHETIC 后续安排需要调整',
          explanation:
            '当前预计到达晚于下一交通出发；原来的重要时间要求保持。'.repeat(6),
        },
      ];
      await enter(page);
      await page.addStyleTag({ content: 'html {font-size:24px !important}' });
      await page.getByRole('button', { name: '查看影响', exact: true }).tap();
      expect(
        (await page.locator('[data-drag]').boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      expect(
        (await page.locator('[data-close]').boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      const handle = (await page.locator('.handle').boundingBox())!;
      await page.mouse.move(handle.x + 15, handle.y + 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + 15, handle.y + 60, { steps: 4 });
      await page.locator('#detail').evaluate((element) => {
        if (!element.hasPointerCapture(1))
          throw new Error('SYNTHETIC handle must capture pointer');
        element.releasePointerCapture(1);
      });
      await page.mouse.move(handle.x + 15, handle.y + 60);
      await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
      await page.mouse.up();
      await expect(page.locator('.impact-detail')).toBeVisible();
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', {
          configurable: true,
          value: 360,
        });
        Object.defineProperty(window.visualViewport!, 'offsetTop', {
          configurable: true,
          value: 40,
        });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect
        .poll(async () => {
          const box = (await page.locator('#detail').boundingBox())!;
          return box.y + box.height;
        })
        .toBeLessThanOrEqual(401);
      expect(
        await page
          .locator('#detail')
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.evaluate(() => {
        delete (window.visualViewport as unknown as { height?: number }).height;
        delete (window.visualViewport as unknown as { offsetTop?: number })
          .offsetTop;
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await page.getByRole('button', { name: '关闭详情', exact: true }).tap();
      await page
        .getByRole('button', { name: '查看全部日程', exact: true })
        .tap();
      await page.locator('[data-node]').first().tap();
      const note = page.locator('textarea[name=note]');
      await note.fill('SYNTHETIC Impact 后保留的地点草稿');
      await page.locator('#detail').evaluate((e) => (e.scrollTop = 0));
      const dirtyHandle = (await page.locator('.handle').boundingBox())!;
      let prompts = 0;
      page.once('dialog', async (d) => {
        prompts++;
        await d.dismiss();
      });
      await page.mouse.move(dirtyHandle.x + 15, dirtyHandle.y + 2);
      await page.mouse.down();
      await page.mouse.move(dirtyHandle.x + 15, dirtyHandle.y + 140, {
        steps: 8,
      });
      await page.mouse.up();
      await expect.poll(() => prompts).toBe(1);
      await expect(note).toHaveValue('SYNTHETIC Impact 后保留的地点草稿');
      await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
      readOnly();
    });
});
