import { test, expect, type Page } from '@playwright/test';
import {
  fixtureTrip,
  fixtureSchedule,
  fromId,
  toId,
  tripId,
} from './fixture.js';
import { inTripFixture } from './in-trip-fixture.js';
import {
  regionalCapabilityFixture,
  boundaryCoordinate,
} from './regional-map-fixture.js';
import type { TripView } from '@travel/contracts';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
let trip: TripView,
  calls: string[],
  sdkCalls: string[],
  capabilityFailure: number,
  hold: boolean,
  releases: (() => void)[],
  sdkState: 'ready' | 'failure' | 'hang';
const googleFixture = (
  callback: string,
) => `// SYNTHETIC SDK contract stub; no real tiles or roads.
window.__SYNTHETIC_SDK_MARKERS=[];
window.google={maps:{Map:class{constructor(host,o){this.zoom=o.zoom;this.host=host;host.innerHTML='<p>SYNTHETIC SDK loader fixture</p><svg width="12" height="12" fill="red"><circle cx="6" cy="6" r="5" /></svg>';}fitBounds(){}setCenter(){}setZoom(v){this.zoom=v;}getZoom(){return this.zoom;}},Marker:class{constructor(o){window.__SYNTHETIC_SDK_MARKERS.push(o.position);}setMap(){}},LatLngBounds:class{extend(){}},event:{clearInstanceListeners(){}}}};window[${JSON.stringify(callback)}]();`;
test.beforeEach(async ({ page }) => {
  trip = fixtureTrip();
  calls = [];
  sdkCalls = [];
  capabilityFailure = 0;
  hold = false;
  releases = [];
  sdkState = 'ready';
  await page.addInitScript(() => {
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_REGIONAL_MAP_ONLY');
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: () => {
          throw new Error('SYNTHETIC map must not request geolocation');
        },
        watchPosition: () => {
          throw new Error('SYNTHETIC map must not request geolocation');
        },
      },
    });
  });
  await page
    .context()
    .route('https://maps.googleapis.com/**', async (route) => {
      const url = new URL(route.request().url());
      sdkCalls.push(url.href);
      if (sdkState === 'failure') return route.abort('failed');
      if (sdkState === 'hang') return new Promise<void>(() => undefined);
      return route.fulfill({
        contentType: 'application/javascript',
        body: googleFixture(url.searchParams.get('callback')!),
      });
    });
  await page.context().route('https://api.map.baidu.com/api**', (route) => {
    sdkCalls.push(route.request().url());
    return route.abort('failed');
  });
  await page
    .context()
    .route('https://www.google.com/maps/**', (route) =>
      route.fulfill({ body: 'SYNTHETIC Google external handoff' }),
    );
  await page
    .context()
    .route('https://api.map.baidu.com/marker**', (route) =>
      route.fulfill({ body: 'SYNTHETIC Baidu external handoff' }),
    );
  await page.route('http://127.0.0.1:5174/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api', '');
    calls.push(`${req.method()} ${path}`);
    const send = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (path === '/me') return send({ id: 'SYNTHETIC_OWNER_A' });
    if (path === '/trips') return send({ trips: [trip] });
    if (path === `/trips/${tripId}`) return send(trip);
    if (path.endsWith('/schedule/evaluate')) return send(fixtureSchedule(trip));
    if (path.endsWith('/provider-capability')) {
      const cap = regionalCapabilityFixture(trip, path);
      if (hold) await new Promise<void>((r) => releases.push(r));
      if (capabilityFailure)
        return send(
          { error: { code: 'PROVIDER_UNAVAILABLE' } },
          capabilityFailure,
        );
      return cap ? send(cap) : send({ error: { code: 'NOT_FOUND' } }, 404);
    }
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
});
function setPlace(latitude: number, longitude: number, index = 0) {
  trip = {
    ...trip,
    days: trip.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n, i) =>
        i === index
          ? {
              ...n,
              place: {
                ...n.place!,
                latitude,
                longitude,
                name: `SYNTHETIC saved Place ${index}`,
              },
            }
          : n,
      ),
    })),
  };
}
async function enter(
  page: Page,
  harness = 'SYNTHETIC_REGIONAL',
  state = 'ready',
) {
  await page.goto(harness ? `/?mapHarness=${harness}&mapState=${state}` : '/');
  await page.locator('[data-trip]').click();
  await expect(page.locator('.timeline')).toBeVisible();
}
async function open(page: Page) {
  await page.locator(`[data-node="${fromId}"]`).click();
}
function readonly() {
  expect(
    calls.filter(
      (c) => c.startsWith('POST') && !c.endsWith('/schedule/evaluate'),
    ),
  ).toEqual([]);
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
async function noOverflow(page: Page) {
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
}
for (const [name, latitude, longitude, provider] of [
  ['Mainland', 39.9042, 116.4074, 'BAIDU'],
  ['Japan', 35.6812, 139.7671, 'GOOGLE'],
  ['Global', 48.8566, 2.3522, 'GOOGLE'],
  ['Hong Kong', 22.3193, 114.1694, 'GOOGLE'],
  ['Macau', 22.1987, 113.5439, 'GOOGLE'],
  ['Taiwan', 25.033, 121.5654, 'GOOGLE'],
] as const)
  test(`${name}: owned A capability selects ${provider}, never language/timezone`, async ({
    page,
  }) => {
    setPlace(latitude, longitude);
    await enter(page);
    await open(page);
    await expect(page.locator('.mini-map')).toHaveAttribute(
      'data-map-provider',
      provider,
    );
    await expect(page.locator('.mini-map-controls')).toBeVisible();
    expect(
      calls.some((c) => c.endsWith(`/places/${fromId}/provider-capability`)),
    ).toBe(true);
    expect(sdkCalls).toEqual([]);
    const view = page.getByRole('link', { name: '在地图中查看', exact: true }),
      url = new URL((await view.getAttribute('href'))!);
    expect(url.hostname).toBe(
      provider === 'BAIDU' ? 'api.map.baidu.com' : 'www.google.com',
    );
    if (provider === 'BAIDU') {
      expect(url.searchParams.get('coord_type')).toBe('wgs84');
      await expect(
        page
          .locator('.mini-map-actions')
          .getByRole('link', { name: '导航到这里' }),
      ).toHaveCount(0);
    }
    const popup = page.waitForEvent('popup');
    await view.click();
    await (await popup).waitForLoadState();
    readonly();
    if (name === 'Japan') {
      await capture(page, 'mobile-place-map');
      await page.getByRole('button', { name: '放大地图' }).click();
      await expect(page.locator('.mini-map-viewport')).toHaveAttribute(
        'data-map-scale',
        '1.3',
      );
      await capture(page, 'mobile-place-map-zoom');
    }
    if (name === 'Mainland') await capture(page, 'mobile-mainland-place');
  });
test('uncertain boundary has no provider, SDK, legacy Google/Apple or navigation fallback', async ({
  page,
}) => {
  setPlace(boundaryCoordinate[1]!, boundaryCoordinate[0]!);
  await enter(page);
  await open(page);
  await expect(page.locator('.mini-map-status')).toContainText(
    '地图区域能力暂不可用',
  );
  await expect(page.locator('.mini-map-actions a')).toHaveCount(0);
  await expect(page.locator('#note-edit')).toBeVisible();
  expect(sdkCalls).toEqual([]);
  readonly();
});
for (const status of [401, 403, 404, 503])
  test(`capability ${status} fails closed locally and preserves note draft`, async ({
    page,
  }) => {
    capabilityFailure = status;
    await enter(page);
    await open(page);
    await expect(page.locator('.mini-map-status')).toContainText(
      '地图区域能力暂不可用',
    );
    await page.locator('#note-edit textarea').fill('SYNTHETIC retained note');
    await expect(page.locator('.timeline')).toBeVisible();
    await expect(page.locator('.mini-map-actions a')).toHaveCount(0);
    expect(sdkCalls).toEqual([]);
    readonly();
  });
test('pending capability completion never resets note dirty state or drawer guard', async ({
  page,
}) => {
  hold = true;
  await enter(page);
  await open(page);
  await expect(page.locator('.mini-map-status')).toContainText('正在核验');
  await page
    .locator('#note-edit textarea')
    .fill('SYNTHETIC before async capability');
  let prompts = 0;
  page.on('dialog', async (d) => {
    prompts++;
    await d.dismiss();
  });
  await page.getByRole('button', { name: '关闭详情' }).click();
  expect(prompts).toBe(1);
  hold = false;
  releases.forEach((r) => r());
  await expect(page.locator('.mini-map-controls')).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  expect(prompts).toBe(2);
  await expect(page.locator('#note-edit textarea')).toHaveValue(
    'SYNTHETIC before async capability',
  );
  readonly();
});
test('default missing browser key is UNCONFIGURED, with safe regional external actions', async ({
  page,
}) => {
  await enter(page, '');
  await open(page);
  await expect(page.locator('.mini-map-status')).toContainText('地图尚未配置');
  await expect(page.locator('.mini-map-viewport')).toBeHidden();
  await expect(page.locator('.mini-map-synthetic')).toHaveCount(0);
  await expect(page.locator('.mini-map-actions a')).toHaveCount(2);
  expect(sdkCalls).toEqual([]);
  readonly();
});
test('real Google adapter and SDK loader run against SYNTHETIC script, preserving WGS84 and close cleanup', async ({
  page,
}) => {
  await enter(page, 'SYNTHETIC_SDK');
  await open(page);
  await expect(page.locator('.mini-map-controls')).toBeVisible();
  expect(sdkCalls).toHaveLength(1);
  expect(
    await page.locator('.mini-map-viewport svg').evaluate((el) => ({
      width: getComputedStyle(el).width,
      fill: getComputedStyle(el).fill,
      stroke: getComputedStyle(el).stroke,
    })),
  ).toEqual({ width: '12px', fill: 'rgb(255, 0, 0)', stroke: 'none' });
  expect(new URL(sdkCalls[0]!).searchParams.get('key')).toBe(
    'SYNTHETIC_BROWSER_SDK_KEY',
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __SYNTHETIC_SDK_MARKERS: unknown[] })
          .__SYNTHETIC_SDK_MARKERS,
    ),
  ).toEqual([{ lat: 35.6812, lng: 139.7671 }]);
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.locator('.mini-map-viewport')).toBeEmpty();
  readonly();
});
test('Google SDK load failure is local, preserves external actions and text, no paid call', async ({
  page,
}) => {
  sdkState = 'failure';
  await enter(page, 'SYNTHETIC_SDK');
  await open(page);
  await expect(page.locator('.mini-map-status')).toHaveText('地图暂时无法加载');
  await expect(page.locator('.address')).toContainText('SYNTHETIC');
  await expect(page.locator('#note-edit')).toBeVisible();
  await expect(page.locator('.mini-map-actions a')).toHaveCount(2);
  expect(sdkCalls).toHaveLength(1);
  readonly();
  await capture(page, 'mobile-sdk-load-failure');
});
test('regional synthetic map failure preserves details and approved external URLs', async ({
  page,
}) => {
  await enter(page, 'SYNTHETIC_REGIONAL', 'failure');
  await open(page);
  await expect(page.locator('.mini-map-status')).toHaveText('地图暂时无法加载');
  await expect(page.locator('.mini-map-actions a')).toHaveCount(2);
  await expect(page.locator('#note-edit')).toBeVisible();
  await capture(page, 'mobile-place-map-failure');
  readonly();
});
test('core offline after map failure removes all online map actions while retaining unsaved note', async ({
  page,
}) => {
  await enter(page, 'SYNTHETIC_REGIONAL', 'failure');
  await open(page);
  await expect(page.locator('.mini-map-status')).toHaveText('地图暂时无法加载');
  await page
    .locator('#note-edit textarea')
    .fill('SYNTHETIC retained offline note');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.locator('.mini-map-status')).toContainText(
    '行程或账户已变化',
  );
  await expect(page.locator('#note-edit textarea')).toHaveValue(
    'SYNTHETIC retained offline note',
  );
  await expect(page.locator('.mini-map-actions a')).toHaveCount(0);
  readonly();
});
test('transport same-region capability keeps selected boarding navigation and no invented geometry', async ({
  page,
}) => {
  trip = inTripFixture().trip;
  await enter(page);
  await page.locator('.connection').first().click();
  await expect(page.locator('.mini-map-controls')).toBeVisible();
  await expect(page.locator('.mini-map')).toHaveAttribute(
    'data-map-provider',
    'GOOGLE',
  );
  await expect(page.locator('.mini-map svg polyline')).toHaveCount(0);
  const nav = page
    .locator('.mini-map-actions')
    .getByRole('link', { name: '导航到上车地点' });
  expect(
    new URL((await nav.getAttribute('href'))!).searchParams.get('destination'),
  ).toBe('35.7138,139.7773');
  await page.locator('.mini-map').scrollIntoViewIfNeeded();
  await capture(page, 'mobile-transport-map');
  readonly();
});
test('same-coordinate transport still reads both nodes and rejects one missing endpoint', async ({
  page,
}) => {
  setPlace(35.6812, 139.7671, 1);
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/provider-capability')) seen.push(r.url());
  });
  await page.route(`**/places/${toId}/provider-capability`, (r) =>
    r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND' } }),
    }),
  );
  await enter(page);
  await page.locator('.connection').click();
  await expect(page.locator('.mini-map-status')).toContainText(
    '地图区域能力暂不可用',
  );
  expect(seen.some((p) => p.includes(fromId))).toBe(true);
  expect(seen.some((p) => p.includes(toId))).toBe(true);
  await expect(page.locator('.mini-map-actions a')).toHaveCount(0);
  readonly();
});
for (const [latitude, longitude] of [
  [48.8566, 2.3522],
  [39.9042, 116.4074],
])
  test(`transport incompatible ${latitude},${longitude} never stitches or falls back`, async ({
    page,
  }) => {
    setPlace(latitude!, longitude!, 1);
    await enter(page);
    await page.locator('.connection').click();
    await expect(page.locator('.mini-map-status')).toContainText(
      '地图区域能力暂不可用',
    );
    await expect(page.locator('.mini-map-actions a')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '搜索路线' })).toBeVisible();
    expect(sdkCalls).toEqual([]);
    readonly();
  });
for (const width of [320, 375, 390, 430])
  test(`regional mobile ${width}: map gestures, handle-only dismiss and overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await enter(page);
    await open(page);
    await expect(page.locator('.mini-map-controls')).toBeVisible();
    await noOverflow(page);
    const viewport = page.locator('.mini-map-viewport');
    await viewport.scrollIntoViewIfNeeded();
    const b = (await viewport.boundingBox())!;
    await page.mouse.move(b.x + 50, b.y + 30);
    await page.mouse.down();
    await page.mouse.move(b.x + 50, b.y + 150, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#detail')).toBeVisible();
    for (const [type, pointerId, clientX] of [
      ['pointerdown', 10, 80],
      ['pointerdown', 11, 160],
      ['pointermove', 11, 240],
      ['pointerup', 10, 80],
      ['pointercancel', 11, 240],
    ] as const)
      await viewport.dispatchEvent(type, {
        pointerId,
        clientX,
        clientY: 100,
        pointerType: 'touch',
        button: 0,
        bubbles: true,
      });
    expect(
      await page.locator('#detail').evaluate((e) => e.style.transform),
    ).toBe('');
    if (width === 320 || width === 390) await capture(page, `mobile-${width}`);
    const handle = page.locator('[data-drag]'),
      h = (await handle.boundingBox())!;
    expect(h.height).toBeGreaterThanOrEqual(44);
    await page.mouse.move(h.x + h.width / 2, h.y + 10);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, h.y + 160, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#detail')).toBeHidden();
    readonly();
  });
test('regional no-geometry, enlarged text and desktop keep endpoints/actions readable', async ({
  page,
}) => {
  await enter(page);
  await page.locator('.connection').click();
  await expect(page.locator('.mini-map-controls')).toBeVisible();
  await page.locator('.mini-map').scrollIntoViewIfNeeded();
  await capture(page, 'mobile-transport-no-geometry');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.evaluate(() => (document.documentElement.style.fontSize = '24px'));
  await open(page);
  await expect(page.locator('.mini-map-controls')).toBeVisible();
  await noOverflow(page);
  await page.locator('.mini-map-controls').scrollIntoViewIfNeeded();
  await capture(page, 'mobile-enlarged');
  await page.locator('#note-edit button').scrollIntoViewIfNeeded();
  await expect(page.locator('#note-edit button')).toBeInViewport();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.setViewportSize({ width: 1280, height: 960 });
  await open(page);
  await expect(page.locator('.mini-map-controls')).toBeVisible();
  await noOverflow(page);
  await page.locator('.mini-map').scrollIntoViewIfNeeded();
  await capture(page, 'desktop-place');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.locator('.connection').click();
  await expect(page.locator('.mini-map-controls')).toBeVisible();
  await page.locator('.mini-map').scrollIntoViewIfNeeded();
  await capture(page, 'desktop-transport');
  readonly();
});
