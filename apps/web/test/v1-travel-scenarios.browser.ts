import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { dragHandle, noOverflow } from './helpers/replanning-acceptance.js';
import { departure, travelHarness } from './v1-travel-fixture.js';

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  timezoneId: 'Asia/Shanghai',
});
async function evidence(
  page: Page,
  name: string,
  project: string,
  data?: unknown,
) {
  const root = `${process.env.V1_SCENARIO_EVIDENCE_ROOT ?? 'docs/status/assets/v1-travel-scenarios'}/${project}`;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: `${root}/${name}.png`, fullPage: false });
  if (data)
    await writeFile(
      `${root}/${name}.json`,
      JSON.stringify(data, null, 2) + '\n',
    );
}
test('future Shanghai 18:00 Web request retains Oct10 absolute date, never Oct8/NOW', async ({
  page,
}, info) => {
  const h = await travelHarness(page);
  await h.enter();
  await h.open();
  await expect(page.locator('#route-search input[name=when]')).toHaveValue(
    '2026-10-10T18:00',
  );
  await page.getByRole('button', { name: '搜索路线', exact: true }).tap();
  await expect(page.locator('.candidate')).toBeVisible();
  await page.locator('.candidate').scrollIntoViewIfNeeded();
  expect(h.queries()[0]!.body!.hint).toEqual({
    type: 'DEPART_AT',
    instant: departure,
    timeZone: 'Asia/Shanghai',
  });
  await expect(page.locator('.candidate')).not.toContainText(
    /等车\s*\d|打车等待/,
  );
  expect(h.writes()).toEqual([]);
  await evidence(
    page,
    'future-departure-request',
    info.project.name,
    h.queries(),
  );
});
for (const mode of ['DRIVING', 'TRANSIT'] as const) {
  test(`ordinary ${mode} search passes mode to the regional Provider (acceptance regression)`, async ({
    page,
  }, info) => {
    const h = await travelHarness(page, mode, true);
    await h.enter();
    await h.open();
    await page.getByRole('button', { name: '搜索路线', exact: true }).tap();
    await expect(
      page.getByRole('button', { name: '搜索路线', exact: true }),
    ).toBeEnabled();
    await page.locator('#save-status').scrollIntoViewIfNeeded();
    await evidence(
      page,
      `missing-mode-${mode.toLowerCase()}`,
      info.project.name,
      h.queries(),
    );
    expect(
      h.queries()[0]!.body!.travelMode,
      'The existing selected mode must reach the region router',
    ).toBe(mode);
    await expect(page.locator('.candidate')).toBeVisible();
    expect(h.writes()).toEqual([]);
  });
}
test('duration-only TRANSIT candidate visibly qualifies calculated clock times as estimates', async ({
  page,
}, info) => {
  const h = await travelHarness(page, 'TRANSIT');
  await h.enter();
  await h.open();
  await page.getByRole('button', { name: '搜索路线', exact: true }).tap();
  await expect(page.locator('.candidate')).toBeVisible();
  await page.locator('.candidate').scrollIntoViewIfNeeded();
  await evidence(
    page,
    'aggregate-transit-clock',
    info.project.name,
    h.candidate,
  );
  expect(h.candidate.legs[0]).toMatchObject({
    fixedService: false,
    serviceLabel: null,
  });
  await expect(page.locator('.candidate')).toContainText(/预计|估算|聚合/);
});
test('18:00 origin constraint disables an already-departed 17:55 candidate without Preview or writes', async ({
  page,
}, info) => {
  const h = await travelHarness(page, 'TRANSIT');
  h.state.staleCandidate = true;
  await h.enter();
  await h.open();
  await page.getByRole('button', { name: '搜索路线', exact: true }).tap();
  await expect(page.locator('.candidate')).toBeDisabled();
  await expect(page.locator('.candidate')).toContainText(
    '出发早于当前可出发时间',
  );
  expect(h.calls.filter((c) => c.path.endsWith('/previews'))).toEqual([]);
  expect(h.writes()).toEqual([]);
  await evidence(page, 'already-departed-blocked', info.project.name);
});
test('already-departed 18:00 option is disabled at 18:05 while still at origin (acceptance regression)', async ({
  page,
}, info) => {
  const h = await travelHarness(page, 'TRANSIT');
  h.state.fixedBus = true;
  h.state.confirmedOrigin = true;
  await page.clock.setFixedTime(new Date('2026-10-10T10:05:00Z'));
  await h.enter();
  await h.open();
  await page.getByRole('button', { name: '搜索路线', exact: true }).tap();
  await expect(page.locator('.candidate')).toBeVisible();
  await page.locator('.candidate').scrollIntoViewIfNeeded();
  await evidence(page, 'already-departed-now-enabled', info.project.name, {
    synthetic: true,
    clock: '2026-10-10T10:05:00Z',
    departure: h.candidate.overall.departure,
    candidateDisabled: await page.locator('.candidate').isDisabled(),
  });
  await expect(page.locator('.candidate')).toBeDisabled();
});
test('internal scrolling leaves sheet open; short handle drag rebounds and long drag closes without writes', async ({
  page,
}, info) => {
  const h = await travelHarness(page);
  await h.enter();
  await page.locator('[data-node]').first().tap();
  const dialog = page.locator('#detail');
  const b = (await dialog.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 80);
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => dialog.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await expect(dialog).toHaveCSS('transform', 'none');
  await expect(dialog).toBeVisible();
  await evidence(page, 'sheet-internal-scroll', info.project.name);
  await dragHandle(page, 70);
  await expect(dialog).toHaveCSS('transform', 'none');
  await expect(dialog).toBeVisible();
  await dragHandle(page, 140);
  await expect(dialog).not.toBeVisible();
  expect(h.writes()).toEqual([]);
});
test('Today/Next keeps one next-step, omits full timeline and is zero-write', async ({
  page,
}, info) => {
  const h = await travelHarness(page);
  h.state.failure = true;
  await page.clock.setFixedTime(new Date('2026-10-10T09:50:00Z'));
  await h.enter();
  await page.locator('[data-view=today]').first().tap();
  await expect(page.locator('.in-trip')).toBeVisible();
  await expect(page.locator('.next-step')).toHaveCount(1);
  await expect(page.locator('.timeline')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '查看影响', exact: true }),
  ).toBeVisible();
  expect(h.queries()).toEqual([]);
  expect(h.writes()).toEqual([]);
  await evidence(page, 'today-next-structure', info.project.name);
});
test('Today/Next important conflict remains discoverable in the first viewport with long notes (acceptance regression)', async ({
  page,
}, info) => {
  const h = await travelHarness(page);
  h.state.failure = true;
  await page.clock.setFixedTime(new Date('2026-10-10T09:50:00Z'));
  await h.enter();
  await page.locator('[data-view=today]').first().tap();
  const impact = page.getByRole('button', { name: '查看影响', exact: true });
  await expect(impact).toBeVisible();
  const geometry = await impact.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      synthetic: true,
      viewportHeight: innerHeight,
      control: { top: rect.top, bottom: rect.bottom },
      scrollY,
    };
  });
  await evidence(page, 'today-next-exception', info.project.name, geometry);
  expect(h.queries()).toEqual([]);
  expect(h.writes()).toEqual([]);
  expect(geometry.control.top).toBeGreaterThanOrEqual(0);
  expect(geometry.control.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
});
for (const width of [320, 375, 390, 430]) {
  test(`${width}px long names, enlarged font, keyboard simulation, scroll and dirty handle guard`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const h = await travelHarness(page);
    await h.enter();
    await page.addStyleTag({ content: 'html { font-size:24px !important; }' });
    await page.locator('[data-node]').first().tap();
    await noOverflow(page);
    await expect(page.locator('#detail .times')).toContainText('到达');
    await expect(page.locator('#detail .times')).toContainText('出发');
    await expect(page.locator('#detail .times')).toContainText('停留');
    await expect(page.locator('[data-drag]')).toHaveCSS('height', '44px');
    const note = page.locator('textarea[name=note]');
    await note.fill('SYNTHETIC 未保存备注');
    await note.focus();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, 'height', {
        configurable: true,
        value: 380,
      });
      Object.defineProperty(visualViewport!, 'offsetTop', {
        configurable: true,
        value: 20,
      });
      visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect
      .poll(async () => {
        const b = (await page.locator('#detail').boundingBox())!;
        return b.y + b.height;
      })
      .toBeLessThanOrEqual(401);
    await evidence(
      page,
      `mobile-${width}-keyboard-before-visibility-check`,
      info.project.name,
      await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height };
        };
        return {
          synthetic: true,
          viewport: {
            width: innerWidth,
            height: visualViewport!.height,
            offsetTop: visualViewport!.offsetTop,
          },
          detail: box('#detail'),
          header: box('.sheet-head'),
          body: box('.sheet-body'),
          focusedInput: box('textarea[name=note]'),
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
        };
      }),
    );
    await expect
      .poll(async () => {
        const b = (await note.boundingBox())!;
        return b.y + b.height;
      })
      .toBeLessThanOrEqual(401);
    await page
      .getByRole('button', { name: '保存备注', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole('button', { name: '保存备注', exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await evidence(
      page,
      `mobile-${width}-keyboard-large-text`,
      info.project.name,
    );
    await page.evaluate(() => {
      delete (visualViewport as unknown as { height?: number }).height;
      delete (visualViewport as unknown as { offsetTop?: number }).offsetTop;
      visualViewport!.dispatchEvent(new Event('resize'));
    });
    // Content owns vertical scroll; it must not acquire handle dismissal state.
    await page.locator('#detail').evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
    await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
    await expect(page.locator('#detail')).toBeVisible();
    let confirms = 0;
    page.on('dialog', async (d) => {
      confirms++;
      await d.dismiss();
    });
    await dragHandle(page);
    expect(confirms).toBe(1);
    await expect(note).toHaveValue('SYNTHETIC 未保存备注');
    expect(h.writes()).toEqual([]);
    await evidence(page, `mobile-${width}-dirty-guard`, info.project.name);
  });
}
test('map capability failure is local: note/time controls and route search remain available', async ({
  page,
}, info) => {
  const h = await travelHarness(page);
  await page.route('**/provider-capability', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE' } }),
    }),
  );
  await h.enter();
  await page.locator('[data-node]').first().tap();
  await expect(page.locator('.mini-map')).toContainText('地图区域能力暂不可用');
  await expect(
    page.getByRole('button', { name: '保存备注', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('#detail .times')).toContainText('停留');
  await page.locator('.mini-map').scrollIntoViewIfNeeded();
  await evidence(page, 'map-failure-local', info.project.name);
  await page.locator('[data-close]').tap();
  await h.open();
  await expect(
    page.getByRole('button', { name: '搜索路线', exact: true }),
  ).toBeEnabled();
  expect(h.writes()).toEqual([]);
});
