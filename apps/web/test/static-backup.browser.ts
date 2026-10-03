import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { StaticBackupView } from '@travel/contracts';
import { fixtureSchedule, tripId } from './fixture.js';
import { inTripFixture } from './in-trip-fixture.js';
import { liveEssentials } from '../src/essentials.js';

let fixture = inTripFixture();
let backup: StaticBackupView | null = null;
let calls: string[] = [];
let unavailable = false;
let meUnavailable = false;
let conflict = false;
let lostResponse = false;
let otherOwner = false;
let sentBodies: { baseTripVersion: number; idempotencyKey: string }[] = [];
test.use({ viewport: { width: 390, height: 844 } });
test.beforeEach(async ({ page }) => {
  fixture = inTripFixture();
  backup = null;
  calls = [];
  unavailable = false;
  meUnavailable = false;
  conflict = false;
  lostResponse = false;
  otherOwner = false;
  sentBodies = [];
  const d = fixture.trip.days[0]!;
  fixture.trip = {
    ...fixture.trip,
    days: [
      {
        ...d,
        nodes: d.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                note: 'SYNTHETIC 用户备注：从东侧入口进入。',
                place: {
                  ...n.place!,
                  name: 'SYNTHETIC 很长的旅行地点名称 · 海边艺术交流文化展览中心与公共休息空间',
                  address:
                    'SYNTHETIC 地址：旅行测试市海边大道公共艺术文化交流中心东侧入口长地址用于窄屏换行验收',
                },
              }
            : n,
        ),
      },
    ],
  };
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_BACKUP_SESSION'),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace('/api', '');
    calls.push(`${request.method()} ${path}`);
    const send = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    if (path === '/me')
      return meUnavailable
        ? send({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503)
        : send({
            id: otherOwner ? '20000000-0000-4000-8000-000000000001' : tripId,
          });
    if (path === '/trips')
      return unavailable
        ? send({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503)
        : send({ trips: [fixture.trip] });
    if (path === `/trips/${tripId}`)
      return unavailable
        ? send({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503)
        : send(fixture.trip);
    if (path.endsWith('/schedule/evaluate'))
      return send(fixtureSchedule(fixture.trip));
    if (path.endsWith('/in-trip')) return send(fixture.evidence);
    if (path.endsWith('/execution/ground-transit')) return send(fixture.ground);
    if (path.endsWith('/backup')) {
      if (unavailable)
        return send({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
      if (request.method() === 'GET') return send({ backup });
      sentBodies.push(request.postDataJSON());
      if (conflict) return send({ error: { code: 'VERSION_CONFLICT' } }, 409);
      backup ??= {
        ...liveEssentials(fixture.trip, fixture.evidence),
        schema: 'travel-static-backup-v1',
        tripId: fixture.trip.id,
        tripVersion: fixture.trip.version,
        id: '30000000-0000-4000-8000-000000000001',
        generatedAt: '2030-10-01T04:30:00Z',
      };
      if (lostResponse) {
        lostResponse = false;
        return route.abort('failed');
      }
      return send(backup);
    }
    if (path === '/auth/logout') return send({});
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
});
async function enter(page: Page) {
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await expect(page.locator('[data-action=essentials]')).toBeVisible();
}
async function materials(page: Page) {
  await enter(page);
  const previousReads = calls.filter((c) => c.endsWith('/backup')).length;
  await page.locator('[data-action=essentials]').click();
  await expect(page.locator('[data-action=generate-backup]')).toBeVisible();
  await expect
    .poll(() => calls.filter((c) => c.endsWith('/backup')).length)
    .toBe(previousReads + 1);
}
async function generate(page: Page) {
  await materials(page);
  await page.locator('[data-action=generate-backup]').click();
  await expect(page.locator('.backup-label')).toHaveText('正在查看备份');
}
async function capture(page: Page, name: string) {
  if (process.env.WEB_TEST_SCREENSHOTS === 'true')
    await page.screenshot({
      path: `docs/status/assets/p6b-2/${name}.png`,
      fullPage: true,
    });
}
function noPlanning() {
  expect(
    calls.filter((c) =>
      /commands|authoring|query|preview|adopt|undo|execution|refresh/u.test(c),
    ),
  ).toEqual([]);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator('.essentials').last().scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  expect(
    await page.evaluate(
      () => scrollY + innerHeight >= document.documentElement.scrollHeight - 2,
    ),
  ).toBe(true);
}
test('live stays default; essentials is secondary and read-only; explicit backup preserves routes and notes', async ({
  page,
}) => {
  await materials(page);
  await expect(page.locator('h1')).toHaveText('旅行资料 / 备份');
  await expect(page.locator('.essentials')).toContainText('SYNTHETIC 用户备注');
  await expect(page.locator('.backup-label')).toHaveCount(0);
  expect(
    calls.filter(
      (c) => c.startsWith('POST') && !c.endsWith('/schedule/evaluate'),
    ),
  ).toEqual([]);
  await capture(page, 'mobile-essentials');
  await page.locator('[data-action=generate-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
  await expect(page.locator('.backup-stamp')).toContainText(
    '2030-10-01 04:30:00 UTC',
  );
  await expect(page.locator('.backup-warning')).toContainText(
    '此内容不会自动更新',
  );
  expect(backup!.routes[0]!.legs).toHaveLength(4);
  await capture(page, 'mobile-backup-current');
  const before = calls.length;
  await page.locator('summary').first().click();
  await expect(page.locator('.essential-leg').first()).toContainText(
    '上车 / 起点',
  );
  expect(calls.length).toBe(before);
  noPlanning();
});
test('old artifact stays immutable after live version changes, then default returns to live', async ({
  page,
}) => {
  await generate(page);
  const old = JSON.stringify(backup);
  await page.locator('[data-action=close-materials]').click();
  fixture.trip = {
    ...fixture.trip,
    version: 2,
    name: 'SYNTHETIC 修改后的旅行',
  };
  fixture.evidence = { ...fixture.evidence, tripVersion: 2 };
  await page.locator('[data-action=reload]').click();
  await page.locator('[data-action=essentials]').click();
  await expect(page.locator('.essentials h2')).toHaveText(
    'SYNTHETIC 修改后的旅行',
  );
  await page.locator('[data-action=view-backup]').click();
  await expect(page.locator('.backup-warning')).toContainText(
    '在线行程已修改为版本 2',
  );
  expect(JSON.stringify(backup)).toBe(old);
  await capture(page, 'mobile-backup-stale');
  await page.locator('[data-action=close-materials]').click();
  await expect(page.locator('.workspace')).toBeVisible();
  noPlanning();
});
test('live unavailable offers last explicit backup and never shows it as live', async ({
  page,
}) => {
  await generate(page);
  await page.locator('[data-action=close-materials]').click();
  unavailable = true;
  await page.locator('[data-action=reload]').click();
  await expect(page.locator('.message')).toContainText('核心服务暂时不可用');
  await expect(page.locator('.workspace')).toHaveCount(0);
  await page.locator('[data-local-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
  await expect(page.locator('.backup-warning')).toContainText(
    '无法核验在线版本',
  );
  await capture(page, 'mobile-live-unavailable-backup');
  noPlanning();
});
test('live unavailable with no backup says none, never blank', async ({
  page,
}) => {
  await enter(page);
  unavailable = true;
  await page.locator('[data-action=reload]').click();
  await expect(page.locator('.backup-fallback')).toContainText('暂无可用备份');
  await capture(page, 'mobile-no-backup');
});
test('browser offline and same-session reload retain only the explicit backup', async ({
  page,
  context,
}) => {
  await generate(page);
  await page.locator('[data-action=close-materials]').click();
  await context.setOffline(true);
  await expect(page.locator('[data-local-backup]')).toBeVisible();
  await page.locator('[data-local-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
  noPlanning();
  await context.setOffline(false);
  meUnavailable = true;
  unavailable = true;
  await page.reload();
  await expect(page.locator('[data-local-backup]')).toBeVisible();
  await page.locator('[data-local-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
});
test('unknown write result retries identical key/version and does not auto-generate on opening', async ({
  page,
}) => {
  await materials(page);
  lostResponse = true;
  await page.locator('[data-action=generate-backup]').click();
  await expect(page.locator('.message')).toContainText('连接中断');
  await expect(page.locator('.essentials')).toHaveCount(0);
  await page.locator('[data-action=reload]').click();
  await page.locator('[data-trip]').click();
  await page.locator('[data-action=essentials]').click();
  await page.locator('[data-action=generate-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
  expect(sentBodies).toHaveLength(2);
  expect(sentBodies[0]).toEqual(sentBodies[1]);
});
test('generation VERSION_CONFLICT preserves old backup and requires reload', async ({
  page,
}) => {
  await generate(page);
  await page.locator('[data-action=live-essentials]').click();
  conflict = true;
  await page.locator('[data-action=generate-backup]').click();
  await expect(page.locator('[role=status]')).toContainText('行程或方案已变化');
  await page.locator('[data-action=view-backup]').click();
  await expect(page.locator('.backup-stamp')).toContainText('Trip version 1');
});
test('owner switch and logout clear local owner artifacts', async ({
  page,
}) => {
  await generate(page);
  await page.locator('[data-action=close-materials]').click();
  otherOwner = true;
  await page.reload();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith('travel.static-backup.v1:'),
      ),
    ),
  ).toEqual([]);
  otherOwner = false;
  await generate(page);
  await page.locator('[data-action=close-materials]').click();
  await page.locator('[data-action=trips]').click();
  await page.locator('[data-action=logout]').click();
  await expect(page.locator('#login')).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith('travel.static-backup.v1:'),
      ),
    ),
  ).toEqual([]);
});
test('downloaded standalone HTML is escaped, readable and makes zero network requests', async ({
  page,
  browser,
}) => {
  const d = fixture.trip.days[0]!;
  fixture.trip = {
    ...fixture.trip,
    days: [
      {
        ...d,
        nodes: d.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                note: 'SYNTHETIC <script>alert(1)</script> https://private.test/token',
              }
            : n,
        ),
      },
    ],
  };
  await generate(page);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('[data-action=download-backup]').click();
  const download = await downloadEvent,
    file = await download.path();
  const html = await readFile(file!, 'utf8');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('SYNTHETIC_BACKUP_SESSION');
  expect(html).toContain('&lt;script&gt;');
  const standalone = await browser.newPage();
  const network: string[] = [];
  standalone.on('request', (req) => network.push(req.url()));
  await standalone.setContent(html);
  await expect(standalone.locator('h1')).toHaveText('正在查看备份');
  await standalone.locator('summary').first().click();
  await expect(standalone.locator('.essential-leg').first()).toBeVisible();
  expect(network).toEqual([]);
  await standalone.close();
});
for (const width of [320, 375, 390, 430])
  test(`backup wraps long names/addresses at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await generate(page);
    await noOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(page, `mobile-${width}`);
    noPlanning();
  });
test('backup enlarged text remains readable and scrolls to last content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await generate(page);
  await page.addStyleTag({ content: 'html{font-size:24px !important}' });
  expect(
    await page
      .locator('.backup-stamp')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(26);
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, 'mobile-enlarged');
});
test('desktop essentials and backup are readable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await generate(page);
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, 'desktop');
});

test('saved Flight selected/saved times are historical, with no Provider requests', async ({
  page,
}) => {
  const movement: import('@travel/contracts').FlightMovementView = {
    airportName: 'SYNTHETIC 机场',
    airportIata: 'SYN',
    airportIcao: null,
    timeZone: 'Asia/Tokyo',
    scheduledLocal: null,
    scheduledUtc: '2030-10-01T05:00:00Z',
    revisedLocal: null,
    revisedUtc: null,
    predictedLocal: null,
    predictedUtc: null,
    runwayLocal: null,
    runwayUtc: null,
    terminal: 'SYNTHETIC T1',
    gate: 'SYNTHETIC G2',
    checkInDesk: null,
    baggageBelt: null,
  };
  const selected: import('@travel/contracts').FlightSnapshotView = {
    provider: 'aerodatabox',
    candidateId: 'SYNTHETIC',
    canonicalFlightNumber: 'SY123',
    displayFlightNumber: 'SY 123 SYNTHETIC',
    serviceDate: '2030-10-01',
    status: 'SCHEDULED',
    rawStatus: null,
    airline: { name: 'SYNTHETIC', iata: null, icao: null },
    departure: movement,
    arrival: { ...movement, scheduledUtc: '2030-10-01T07:00:00Z' },
    aircraft: null,
    departureDelayMinutes: null,
    arrivalDelayMinutes: null,
    departureDelayBasis: null,
    arrivalDelayBasis: null,
    fetchedAt: '2030-10-01T04:00:00Z',
  };
  fixture.trip = {
    ...fixture.trip,
    connections: fixture.trip.connections.map((c, i) =>
      i === 0 ? { ...c, transport: { ...c.transport!, mode: 'FLIGHT' } } : c,
    ),
  };
  fixture.evidence = {
    ...fixture.evidence,
    flights: [
      {
        transportEdgeId: fixture.trip.connections[0]!.transport!.id,
        selectedSnapshot: selected,
        latestSnapshot: {
          ...selected,
          departure: { ...movement, revisedUtc: '2030-10-01T05:20:00Z' },
        },
        providerUnavailable: true,
      },
    ],
  };
  await generate(page);
  await page
    .getByText('选定航班快照 · SY 123 SYNTHETIC', { exact: true })
    .click();
  await page
    .getByText('保存的航班信息 · SY 123 SYNTHETIC', { exact: true })
    .click();
  await expect(page.locator('.essentials')).toContainText('原计划');
  await expect(page.locator('.essentials')).toContainText('保存时预计');
  await expect(page.locator('.essentials')).toContainText('14:20');
  expect(
    calls.filter((c) => /flights|refresh|query|execution/u.test(c)),
  ).toEqual([]);
});
test('unknown address, route position and plan times are not invented; damaged local artifact is ignored', async ({
  page,
}) => {
  const d = fixture.trip.days[0]!;
  fixture.trip = {
    ...fixture.trip,
    days: [
      {
        ...d,
        nodes: d.nodes.map((n) => ({
          ...n,
          place: n.place ? { ...n.place, address: null } : null,
          timeValues: [],
        })),
      },
    ],
    savedRoutes: fixture.trip.savedRoutes!.map((r) => ({
      ...r,
      legs: r.legs.map((l) => ({
        ...l,
        from: { ...l.from, latitude: null, longitude: null },
        departure: null,
        arrival: null,
      })),
    })),
  };
  await generate(page);
  expect(backup!.days[0]!.nodes[0]!.place!.address).toBeNull();
  expect(backup!.routes[0]!.legs[0]!.from.latitude).toBeNull();
  await expect(page.locator('.essentials')).toContainText('地址未提供');
  await page.locator('summary').first().click();
  await expect(page.locator('.essential-leg').first()).toContainText(
    '起点坐标 未知',
  );
  await page.locator('[data-action=close-materials]').click();
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        `travel.static-backup.v1:${id}:${id}`,
        JSON.stringify({
          schema: 'travel-static-backup-v1',
          tripId: id,
          days: [],
          routes: [],
          transports: [],
          flights: [],
          generatedAt: 77,
        }),
      ),
    tripId,
  );
  unavailable = true;
  await page.locator('[data-action=reload]').click();
  await expect(page.locator('.backup-fallback')).toContainText('暂无可用备份');
});

test('Today clock ticks never rerender the static reader or collapse saved legs', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2030-10-01T05:11:00Z') });
  await enter(page);
  await page.locator('[data-view=today]').click();
  await expect(page.locator('.in-trip')).toBeVisible();
  await page.locator('[data-action=essentials]').click();
  await page.locator('[data-action=generate-backup]').click();
  await expect(page.locator('.backup-label')).toBeVisible();
  await page.locator('summary').first().click();
  await expect(page.locator('.essential-leg').first()).toBeVisible();
  const before = [...calls];
  await page.clock.fastForward(90000);
  await expect(page.locator('.essential-leg').first()).toBeVisible();
  expect(calls).toEqual(before);
});
