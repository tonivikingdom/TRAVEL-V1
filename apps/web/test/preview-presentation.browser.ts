import { onConfirmation } from './helpers/confirmation.js';
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { previewCases } from './preview-fixture.js';
import {
  browserHarness,
  chooseFixtureQueryMode,
} from './helpers/replanning-acceptance.js';
const assets = 'docs/status/assets/p6c-2-preview';
test.use({ viewport: { width: 390, height: 844 } });
test('SYNTHETIC search-only draft refuses route/Preview replacement and retains exact draft', async ({
  page,
}, info) => {
  const h = await browserHarness(page);
  await h.enter();
  await page.locator('[data-action=add-arrangement]').click();
  await expect(page.locator('select[name=place] option')).toHaveCount(3);
  await page
    .locator('[data-place-query]')
    .fill('  SYNTHETIC 東京駅 preview draft  ');
  const before = await page
    .locator('#authoring-add')
    .evaluate((form: HTMLFormElement) => [...new FormData(form).entries()]);
  let prompts = 0;
  await onConfirmation(page, async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await page.locator('.connection').evaluate((e: HTMLElement) => e.click());
  await expect(page.locator('[data-place-query]')).toHaveValue(
    '  SYNTHETIC 東京駅 preview draft  ',
  );
  await expect(page.locator('#save-status')).toContainText('还有未保存的修改');
  expect(
    await page
      .locator('#authoring-add')
      .evaluate((form: HTMLFormElement) => [...new FormData(form).entries()]),
  ).toEqual(before);
  await expect(page.locator('.preview-presentation')).toHaveCount(0);
  expect(prompts).toBe(1);
  expect(h.planning()).toEqual([]);
  expect(h.formalWrites()).toEqual([]);
  expect(h.trip.version).toBe(1);
  if (info.project.name === 'chromium') {
    await mkdir(assets, { recursive: true });
    await page.screenshot({
      path: `${assets}/mobile-search-preview-guard.png`,
      fullPage: true,
    });
  }
});

test('SYNTHETIC Preview open/expand/close leaves pristine authoring values and write state unchanged', async ({
  page,
}) => {
  const h = await browserHarness(page);
  await h.enter();
  const add = async () => {
    await page.locator('[data-action=add-arrangement]').click();
    await expect(page.locator('select[name=place] option')).toHaveCount(3);
  };
  await add();
  const snapshot = async () =>
    page
      .locator('#authoring-add')
      .evaluate((form: HTMLFormElement) => [...new FormData(form).entries()]);
  const before = await snapshot();
  let prompts = 0;
  await onConfirmation(page, async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await page.locator('.connection').evaluate((e: HTMLElement) => e.click());
  await h.prepare();
  await expect(page.locator('.preview-presentation')).toBeVisible();
  await page
    .locator('.preview-presentation .preview-details:last-child > summary')
    .click();
  await page.locator('[data-close]').click();
  await expect(page.locator('#detail')).not.toBeVisible();
  await add();
  expect(await snapshot()).toEqual(before);
  await expect(page.locator('[data-place-query]')).toHaveValue('');
  await expect(page.locator('[data-place-language]')).toHaveValue('ja');
  await expect(page.locator('#save-status')).toContainText(
    '当前表单与已提交内容一致',
  );
  expect(prompts).toBe(0);
  expect(h.planning().map((c) => c.path.split('/').at(-1))).toEqual([
    'query',
    'previews',
  ]);
  expect(h.formalWrites()).toEqual([]);
  expect(h.trip.version).toBe(1);
});
for (const kind of previewCases) {
  test(`SYNTHETIC ${kind} preview: standalone, readonly, expandable`, async ({
    page,
  }, info) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api')) calls.push(r.url());
    });
    await page.goto(`/test/preview-harness/index.html?case=${kind}`);
    await expect(
      page.getByRole('region', { name: '路线调整预览' }),
    ).toBeVisible();
    await expect(page.locator('.preview-details').last()).not.toHaveAttribute(
      'open',
      '',
    );
    if (kind === 'protected')
      await expect(
        page.getByRole('region', { name: '不能采用的原因' }),
      ).toContainText('锁定的时间要求');
    if (kind === 'suffix')
      await expect(page.locator('article')).toContainText(
        '前面的已确认部分保持不变',
      );
    if (kind === 'external')
      await expect(page.locator('article')).toContainText('你确认的品川站');
    if (info.project.name === 'chromium') {
      await mkdir(assets, { recursive: true });
      await page.screenshot({
        path: `${assets}/mobile-${kind}.png`,
        fullPage: true,
      });
    }
    await page.getByText('查看交通与换乘详情', { exact: true }).click();
    await expect(page.locator('.preview-details').last()).toHaveAttribute(
      'open',
      '',
    );
    await expect(page.locator('.preview-details').last()).not.toContainText(
      'old-edge',
    );
    const header = await page
      .locator('.preview-presentation header')
      .boundingBox();
    const endpoints = await page
      .locator('.preview-presentation header > p')
      .boundingBox();
    expect(endpoints!.y + endpoints!.height).toBeLessThanOrEqual(
      header!.y + header!.height,
    );
    expect(calls).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
for (const width of [320, 375, 390, 430]) {
  for (const enlarged of [false, true]) {
    test(`SYNTHETIC ${width}px ${enlarged ? 'enlarged' : 'normal'} long Japanese preview`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/test/preview-harness/index.html?case=long');
      if (enlarged)
        await page.addStyleTag({ content: ':root { font-size: 24px; }' });
      await expect(page.locator('.preview-scope')).toBeVisible();
      await page.locator('.preview-details:last-child > summary').click();
      const box = await page
        .locator('.preview-details:last-child > summary')
        .boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.locator('article > p').scrollIntoViewIfNeeded();
      await expect(page.locator('article > p')).toBeInViewport();
      if (info.project.name === 'chromium')
        await page.screenshot({
          path: `${assets}/mobile-${width}${enlarged ? '-enlarged' : ''}.png`,
          fullPage: true,
        });
    });
  }
}
test('SYNTHETIC desktop presentation', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/test/preview-harness/index.html?case=suffix');
  await expect(page.locator('.preview-scope')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (info.project.name === 'chromium')
    await page.screenshot({ path: `${assets}/desktop.png`, fullPage: true });
});

for (const blocked of [false, true]) {
  test(`formal Web Preview ${blocked ? 'blocked reason' : 'consent'} preserves explicit Adopt boundary`, async ({
    page,
  }) => {
    const {
      fixtureTrip,
      fixtureSchedule,
      fixtureCandidate,
      fromId,
      tripId,
      toId,
    } = await import('./fixture.js');
    const { previewFixture } = await import('./preview-fixture.js');
    const trip = fixtureTrip();
    const candidate = fixtureCandidate();
    const base = previewFixture().preview;
    const preview = {
      ...base,
      candidate,
      adoptable: !blocked,
      status: blocked ? 'BLOCKED' : 'ACTIVE',
      changeSummary: {
        ...base.changeSummary,
        proposedSegments: [
          {
            ...base.changeSummary.proposedSegments[0]!,
            mode: 'WALKING',
            fixedService: false,
            serviceLabel: null,
          },
        ],
        ...(blocked
          ? {
              protectedBlockingNodes: [
                {
                  nodeId: fromId,
                  dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
                  protected: true,
                  protectionReasons: ['USER_TIME_INTENT'],
                },
              ],
            }
          : {
              requiredUserAdjustments: [
                {
                  intentId: trip.days[0]!.nodes[0]!.timeIntents[0]!.id,
                  nodeId: fromId,
                  fromDurationSeconds: 3600,
                  toDurationSeconds: 1800,
                },
              ],
            }),
      },
    };
    let adopts = 0;
    let body: unknown;
    await page.addInitScript(() =>
      sessionStorage.setItem('travel.web.session', 'SYNTHETIC_PREVIEW_ONLY'),
    );
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api', '');
      const send = (data: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      if (path === '/me') return send({ id: tripId });
      if (path === '/trips') return send({ trips: [trip] });
      if (path === `/trips/${tripId}`) return send(trip);
      if (path.endsWith('/schedule/evaluate'))
        return send(fixtureSchedule(trip));
      if (path.endsWith('/routes/query'))
        return send({
          tripId,
          basisVersion: 1,
          fromNodeId: fromId,
          toNodeId: toId,
          timeCondition: candidate.queryTimeCondition,
          candidates: [candidate],
        });
      if (path.endsWith('/previews')) return send(preview, 201);
      if (path.endsWith('/adopt')) {
        adopts++;
        body = route.request().postDataJSON();
        return send({ error: { code: 'VERSION_CONFLICT' } }, 409);
      }
      return send({ error: { code: 'NOT_FOUND' } }, 404);
    });
    await page.goto('/');
    await page.locator('[data-trip]').click();
    await page.locator('.connection').click();
    await chooseFixtureQueryMode(page);
    await page.getByRole('button', { name: '搜索路线' }).click();
    await page.locator('.candidate').click();
    await expect(page.locator('.preview-presentation')).toBeVisible();
    const header = await page
      .locator('.preview-presentation header')
      .boundingBox();
    const title = await page.locator('.preview-scope').boundingBox();
    expect(title!.y + title!.height).toBeLessThanOrEqual(
      header!.y + header!.height,
    );
    const adopt = page.getByRole('button', { name: '使用这条路线' });
    await page
      .locator('.preview-presentation .preview-details:last-child > summary')
      .click();
    expect(adopts).toBe(0);
    if (blocked) {
      await expect(adopt).toBeDisabled();
      await expect(page.locator('.preview-important')).toContainText(
        '锁定的时间要求',
      );
    } else {
      await adopt.click();
      expect(adopts).toBe(0);
      await page.locator('#accept-adjustments').check();
      await adopt.click();
      await expect.poll(() => adopts).toBe(1);
      expect(body).toMatchObject({
        baseTripVersion: 1,
        acceptedUserAdjustments: preview.changeSummary.requiredUserAdjustments,
      });
    }
    expect(trip.version).toBe(1);
  });
}
