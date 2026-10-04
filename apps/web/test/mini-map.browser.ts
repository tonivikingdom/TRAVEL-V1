import { test, expect, type Page } from '@playwright/test';
import {
  fixtureTrip,
  fixtureSchedule,
  fromId,
  toId,
  tripId,
} from './fixture.js';
import { inTripFixture } from './in-trip-fixture.js';
import type { TripView } from '@travel/contracts';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
let trip: TripView;
let calls: string[];
let externalCalls: string[];
test.beforeEach(async ({ page }) => {
  trip = fixtureTrip();
  calls = [];
  externalCalls = [];
  await page.addInitScript(() => {
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_MAP_ONLY');
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: () => {
          throw new Error('Map requested forbidden geolocation');
        },
        watchPosition: () => {
          throw new Error('Map requested forbidden geolocation');
        },
      },
    });
  });
  await page
    .context()
    .route('https://synthetic-map.invalid/**', async (route) => {
      externalCalls.push(route.request().url());
      await route.fulfill({ body: 'SYNTHETIC external map, no Provider call' });
    });
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api', '');
    calls.push(`${req.method()} ${path}`);
    const send = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (path === '/me') return send({ id: tripId });
    if (path === '/trips') return send({ trips: [trip] });
    if (path === `/trips/${tripId}`) return send(trip);
    if (path.endsWith('/schedule/evaluate')) return send(fixtureSchedule(trip));
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
});
async function enter(page: Page, state = 'ready', synthetic = true) {
  await page.goto(synthetic ? `/?mapHarness=SYNTHETIC&mapState=${state}` : '/');
  await page.locator('[data-trip]').click();
  await expect(page.locator('.timeline')).toBeVisible();
}
async function place(page: Page) {
  await page.locator(`[data-node="${fromId}"]`).click();
}
async function ready(page: Page) {
  await expect(page.locator('.mini-map-controls')).toBeVisible();
}
function zeroWrites() {
  expect(
    calls.filter(
      (c) => c.startsWith('POST') && !c.endsWith('/schedule/evaluate'),
    ),
  ).toEqual([]);
  expect(
    calls.some((c) =>
      /query|preview|adopt|undo|authoring|execution\/events/.test(c),
    ),
  ).toBe(false);
  expect(trip.version).toBe(1);
}
async function capture(page: Page, name: string) {
  if (
    process.env.MINI_MAP_SCREENSHOTS === 'true' &&
    test.info().project.name === 'chromium'
  )
    await page.screenshot({
      path: `docs/status/assets/v1-mini-map/${name}.png`,
    });
}
async function drag(page: Page, selector: string, amount = 140) {
  const el = page.locator(selector);
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + amount, {
    steps: 8,
  });
  await page.mouse.up();
}
async function layout(page: Page) {
  await expect(page.locator('#detail')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('#detail')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const bounds = (await page.locator('.mini-map').boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.locator('#note-edit button').scrollIntoViewIfNeeded();
  await expect(page.locator('#note-edit button')).toBeInViewport();
}

test('place saved Pin loads; external view/navigation use adapter with zero Trip writes', async ({
  page,
}) => {
  await enter(page);
  await place(page);
  await ready(page);
  await expect(page.locator('.mini-map svg [data-map-layer] > g')).toHaveCount(
    1,
  );
  await expect(page.locator('.address')).toContainText('SYNTHETIC');
  const view = page
    .locator('.mini-map-actions')
    .getByRole('link', { name: '在地图中查看' });
  expect(
    new URL((await view.getAttribute('href'))!).searchParams.get('points'),
  ).toBe('35.6812,139.7671');
  const popup = page.waitForEvent('popup');
  await view.click();
  await (await popup).waitForLoadState();
  const nav = page
    .locator('.mini-map-actions')
    .getByRole('link', { name: '导航到这里' });
  expect(
    new URL((await nav.getAttribute('href'))!).searchParams.get('destination'),
  ).toBe('35.6812,139.7671');
  const nextPopup = page.waitForEvent('popup');
  await nav.click();
  await (await nextPopup).waitForLoadState();
  expect(externalCalls).toHaveLength(2);
  zeroWrites();
  await capture(page, 'mobile-place-map');
});
test('missing place coordinates preserves address/note; no SDK or guessed external links', async ({
  page,
}) => {
  trip = {
    ...trip,
    days: trip.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n) => ({
        ...n,
        place: null,
      })),
    })),
  };
  await enter(page);
  await place(page);
  await expect(page.locator('.mini-map-status')).toHaveText('地图位置暂不可用');
  await expect(page.locator('.mini-map svg')).toHaveCount(0);
  await expect(page.locator('.mini-map-actions a')).toHaveCount(0);
  await expect(page.locator('#note-edit textarea')).toBeVisible();
  zeroWrites();
});
test('place SDK failure is local and safe external navigation stays available', async ({
  page,
}) => {
  await enter(page, 'failure');
  await place(page);
  await expect(page.locator('.mini-map-status')).toHaveText('地图暂时无法加载');
  await expect(page.locator('.mini-map-actions a')).toHaveCount(2);
  await expect(page.locator('#note-edit')).toBeVisible();
  await capture(page, 'mobile-place-map-failure');
  zeroWrites();
});
test('unconfigured production composition never substitutes a synthetic/real SDK', async ({
  page,
}) => {
  await enter(page, 'ready', false);
  await place(page);
  await expect(page.locator('.mini-map-status')).toHaveText('内嵌地图尚未接入');
  await expect(page.locator('.mini-map-synthetic')).toHaveCount(0);
  await expect(page.locator('.mini-map-viewport')).toBeHidden();
  zeroWrites();
});
test('zoom controls and keyboard pan/reset are accessible and read only', async ({
  page,
}) => {
  await enter(page);
  await place(page);
  await ready(page);
  await page.getByRole('button', { name: '放大地图' }).click();
  await expect(page.locator('.mini-map-viewport')).toHaveAttribute(
    'data-map-scale',
    '1.3',
  );
  await capture(page, 'mobile-place-map-zoom');
  await page.locator('.mini-map-viewport').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.mini-map-viewport')).toHaveAttribute(
    'data-map-pan',
    '-20,0',
  );
  await page.getByRole('button', { name: '重置视图' }).click();
  await expect(page.locator('.mini-map-viewport')).toHaveAttribute(
    'data-map-pan',
    '0,0',
  );
  zeroWrites();
});
test('map downward pan cannot dismiss; 44px handle still closes', async ({
  page,
}) => {
  await enter(page);
  await place(page);
  await ready(page);
  await drag(page, '.mini-map-viewport');
  await expect(page.locator('#detail')).toBeVisible();
  expect(
    await page.locator('.mini-map-viewport').getAttribute('data-map-pan'),
  ).not.toBe('0,0');
  expect(
    await page.locator('#detail').evaluate((el) => el.style.transform),
  ).toBe('');
  expect(
    (await page.locator('[data-drag]').boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await drag(page, '[data-drag]');
  await expect(page.locator('#detail')).toBeHidden();
  zeroWrites();
});
test('two-pointer pinch/cancel belongs to map and never transforms drawer', async ({
  page,
}) => {
  await enter(page);
  await place(page);
  await ready(page);
  const viewport = page.locator('.mini-map-viewport');
  for (const [type, pointerId, clientX] of [
    ['pointerdown', 50, 80],
    ['pointerdown', 51, 160],
    ['pointermove', 51, 240],
    ['pointercancel', 50, 80],
    ['pointerup', 51, 240],
  ] as const)
    await viewport.dispatchEvent(type, {
      pointerId,
      clientX,
      clientY: 100,
      pointerType: 'touch',
      isPrimary: pointerId === 50,
      button: 0,
      bubbles: true,
    });
  await expect(viewport).toHaveAttribute('data-map-scale', '2');
  await expect(page.locator('#detail')).toBeVisible();
  expect(
    await page.locator('#detail').evaluate((el) => el.style.transform),
  ).toBe('');
  zeroWrites();
});
test('dirty note survives map pan, handle drag, close and detail replacement', async ({
  page,
}) => {
  await enter(page);
  await place(page);
  await ready(page);
  await page.locator('#note-edit textarea').fill('SYNTHETIC unsaved note');
  let prompts = 0;
  page.on('dialog', async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await drag(page, '.mini-map-viewport');
  expect(prompts).toBe(0);
  await drag(page, '[data-drag]');
  await expect(page.locator('#note-edit textarea')).toHaveValue(
    'SYNTHETIC unsaved note',
  );
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.evaluate(
    (id) =>
      document.querySelector<HTMLButtonElement>(`[data-node="${id}"]`)!.click(),
    toId,
  );
  expect(prompts).toBe(3);
  await expect(page.locator('#note-edit textarea')).toHaveValue(
    'SYNTHETIC unsaved note',
  );
  zeroWrites();
});
test('slow mount exposes loading and cannot repopulate a replacement/closed drawer', async ({
  page,
}) => {
  await enter(page, 'slow');
  await place(page);
  await expect(page.locator('.mini-map-status')).toHaveText('正在加载地图…');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.locator(`[data-node="${toId}"]`).click();
  await ready(page);
  await expect(page.locator('.mini-map-points')).toContainText('上野');
  await expect(page.locator('.mini-map-viewport svg')).toHaveCount(1);
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.locator('.mini-map-viewport svg')).toHaveCount(0);
  zeroWrites();
});
for (const state of ['ready', 'failure'])
  test(`transport ${state}: saved endpoints, boarding navigation and no invented geometry`, async ({
    page,
  }) => {
    trip = inTripFixture().trip;
    await enter(page, state);
    await page.locator('.connection').first().click();
    if (state === 'ready') await ready(page);
    else
      await expect(page.locator('.mini-map-status')).toHaveText(
        '地图暂时无法加载',
      );
    await page.locator('.mini-map').scrollIntoViewIfNeeded();
    await expect(page.locator('.mini-map-points')).toContainText('起点');
    await expect(page.locator('.mini-map-points')).toContainText('终点');
    await expect(page.locator('.mini-map svg polyline')).toHaveCount(0);
    await expect(page.locator('.mini-map-note')).toContainText(
      '未保存可靠路线轨迹',
    );
    await expect(
      page
        .locator('.saved-legs')
        .getByRole('link', { name: '步行到上车点' })
        .first(),
    ).toHaveAttribute('href', /destination=/);
    const view = page
      .locator('.mini-map-actions')
      .getByRole('link', { name: '查看起终点' });
    expect(
      new URL((await view.getAttribute('href'))!).searchParams
        .get('points')
        ?.split(';'),
    ).toHaveLength(2);
    const nav = page
      .locator('.mini-map-actions')
      .getByRole('link', { name: '导航到上车地点' });
    const boarding = inTripFixture().trip.savedRoutes![0]!.legs[1]!.from;
    expect(
      new URL((await nav.getAttribute('href'))!).searchParams.get(
        'destination',
      ),
    ).toBe(`${boarding.latitude},${boarding.longitude}`);
    zeroWrites();
    if (state === 'ready') {
      await capture(page, 'mobile-transport-map');
    }
  });
test('transport missing origin never navigates to substituted destination', async ({
  page,
}) => {
  trip = {
    ...trip,
    days: trip.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.id === fromId ? { ...n, place: null } : n)),
    })),
  };
  await enter(page);
  await page.locator('.connection').click();
  await expect(page.locator('.mini-map-status')).toHaveText('地图位置暂不可用');
  await expect(page.locator('.mini-map-actions a')).toHaveCount(0);
  zeroWrites();
});
for (const width of [320, 375, 390, 430])
  test(`mobile ${width}: place and transport fit without overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await enter(page);
    await place(page);
    await ready(page);
    await layout(page);
    await page.locator('.mini-map').scrollIntoViewIfNeeded();
    if (width === 320 || width === 390) await capture(page, `mobile-${width}`);
    await page.getByRole('button', { name: '关闭详情' }).click();
    await page.locator('.connection').click();
    await ready(page);
    if (width === 390) {
      await page.locator('.mini-map').scrollIntoViewIfNeeded();
      await capture(page, 'mobile-transport-no-geometry');
    }
    expect(
      await page
        .locator('#detail')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    zeroWrites();
  });
test('large text and long place/address keep controls reachable', async ({
  page,
}) => {
  trip = {
    ...trip,
    days: trip.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n) => ({
        ...n,
        place: n.place
          ? {
              ...n.place,
              name: 'SYNTHETIC 非常长的地点名称'.repeat(4),
              address: 'SYNTHETIC LongAddressWithoutSpaces'.repeat(5),
            }
          : null,
      })),
    })),
  };
  await enter(page);
  await page.evaluate(() => (document.documentElement.style.fontSize = '24px'));
  await place(page);
  await ready(page);
  await layout(page);
  await page.locator('.mini-map-controls').scrollIntoViewIfNeeded();
  await capture(page, 'mobile-enlarged');
  zeroWrites();
});
test('desktop place/transport preserve drawer proportions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await enter(page);
  await place(page);
  await ready(page);
  await layout(page);
  await page.locator('.mini-map').scrollIntoViewIfNeeded();
  await capture(page, 'desktop-place');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.locator('.connection').click();
  await ready(page);
  await page.locator('.mini-map').scrollIntoViewIfNeeded();
  await capture(page, 'desktop-transport');
  zeroWrites();
});

test('hung SDK has bounded local fallback, with external actions and notes preserved', async ({
  page,
}) => {
  await page.clock.install();
  await enter(page, 'hang');
  await place(page);
  await expect(page.locator('.mini-map-status')).toHaveText('正在加载地图…');
  await page.clock.fastForward(13000);
  await expect(page.locator('.mini-map-status')).toHaveText('地图暂时无法加载');
  await expect(page.locator('.mini-map-actions a')).toHaveCount(2);
  await expect(page.locator('#note-edit textarea')).toBeVisible();
  zeroWrites();
});

test('transport missing destination keeps a known origin action without inventing an endpoint', async ({
  page,
}) => {
  trip = {
    ...trip,
    days: trip.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.id === toId ? { ...n, place: null } : n)),
    })),
  };
  await enter(page);
  await page.locator('.connection').click();
  await expect(page.locator('.mini-map-status')).toHaveText('地图位置暂不可用');
  await expect(page.locator('.mini-map-viewport')).toBeHidden();
  await expect(
    page.locator('.mini-map-actions').getByRole('link', { name: '查看起终点' }),
  ).toHaveCount(0);
  const nav = page
    .locator('.mini-map-actions')
    .getByRole('link', { name: '导航到起点' });
  expect(
    new URL((await nav.getAttribute('href'))!).searchParams.get('destination'),
  ).toBe('35.6812,139.7671');
  zeroWrites();
});
