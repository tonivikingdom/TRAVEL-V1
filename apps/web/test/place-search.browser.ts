import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { PlaceSearchResponse, TripView } from '@travel/contracts';
import { fixtureTrip, fixtureSchedule, tripId, visit } from './fixture.js';
const response: PlaceSearchResponse = {
  expiresAt: '2035-01-01T00:00:00Z',
  candidates: [0, 1, 2].map((i) => ({
    provider: 'synthetic',
    externalId: `SYNTHETIC-${i}`,
    name: 'SYNTHETIC 東京駅・非常に長い日本語の地点名称',
    formattedAddress: `SYNTHETIC 東京都千代田区丸の内一丁目・${i + 1}番地・北口地下連絡通路`,
    coordinates:
      i === 2
        ? null
        : {
            latitude: Number((35.681 + i / 1000).toFixed(6)),
            longitude: 139.767,
          },
    attribution: 'SYNTHETIC fixture — not real Provider data',
    synthetic: true,
    selectionToken: `SYNTHETIC-token-${i}`,
  })),
};
let trip: TripView,
  writes: number,
  searches: number,
  unavailable: boolean,
  conflict: boolean,
  invalidEvidence: boolean,
  unknownWrite: boolean,
  tripReadFails: boolean,
  coreSearchFails: boolean,
  submitted: Record<string, unknown>;
test.beforeEach(async ({ page }) => {
  trip = { ...fixtureTrip(), name: 'SYNTHETIC Place Search', connections: [] };
  writes = 0;
  searches = 0;
  unavailable = false;
  conflict = false;
  invalidEvidence = false;
  unknownWrite = false;
  tripReadFails = false;
  coreSearchFails = false;
  submitted = {};
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_BROWSER_ONLY'),
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/u, '');
    const send = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    if (path === '/me') return send({ id: tripId });
    if (path === '/trips') return send({ trips: [trip] });
    if (path === `/trips/${tripId}`)
      return tripReadFails
        ? send(
            {
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'SYNTHETIC core outage',
              },
            },
            503,
          )
        : send(trip);
    if (path.endsWith('/schedule/evaluate')) return send(fixtureSchedule(trip));
    if (path.endsWith('/in-trip'))
      return send({
        tripId: trip.id,
        tripVersion: trip.version,
        execution: {
          state: 'NOT_STARTED',
          currentNodeId: null,
          targetNodeId: null,
          recordedAt: null,
        },
        flights: [],
      });
    if (path.endsWith('/execution/ground-transit'))
      return send({ tripId: trip.id, tripVersion: trip.version, legs: [] });
    if (path.endsWith('/impact'))
      return send({
        tripId: trip.id,
        basisVersion: trip.version,
        evaluatedAt: '2030-10-01T05:00:00Z',
        items: [],
        handoffs: [],
      });

    if (path.endsWith('/place-search')) {
      searches++;
      if (coreSearchFails)
        return send(
          {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'SYNTHETIC core outage',
            },
          },
          503,
        );
      return unavailable
        ? send(
            {
              error: {
                code: 'PLACE_SEARCH_UNAVAILABLE',
                message: 'SYNTHETIC outage',
              },
            },
            503,
          )
        : send(response);
    }
    if (path.endsWith('/place-selection') || path.endsWith('/authoring')) {
      writes++;
      if (unknownWrite) return route.abort('failed');
      if (invalidEvidence)
        return send(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'SYNTHETIC expired evidence',
            },
          },
          400,
        );
      submitted = route.request().postDataJSON();
      if (conflict)
        return send(
          {
            error: {
              code: 'VERSION_CONFLICT',
              message: 'SYNTHETIC other-device edit',
            },
          },
          409,
        );
      const selected = response.candidates.find(
        (c) => c.selectionToken === submitted.selectionToken,
      );
      const day = trip.days[0]!;
      const node = {
        ...visit(crypto.randomUUID(), ''),
        dayOccurrenceId: day.dayOccurrenceId,
        position: day.nodes.length,
        place: selected
          ? {
              id: crypto.randomUUID(),
              createdAt: '2030-01-01T00:00:00Z',
              name: selected.name,
              address: selected.formattedAddress,
              ...selected.coordinates!,
            }
          : day.nodes[0]!.place,
        note: submitted.note as string,
        timeValues: [],
        timeIntents: [],
      };
      trip = {
        ...trip,
        version: trip.version + 1,
        days: trip.days.map((d) =>
          d === day ? { ...d, nodes: [...d.nodes, node] } : d,
        ),
      };
      return send(trip);
    }
    return send({});
  });
});
async function open(page: Page) {
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '地点', exact: true }).click();
  await expect(page.locator('select[name=place] option')).toHaveCount(3);
}
async function search(page: Page) {
  await page.locator('[data-place-query]').fill('東京駅');
  await page.locator('[data-place-search]').click();
  await expect(page.locator('[data-candidate]')).toHaveCount(3);
}
async function capture(page: Page, name: string, project: string) {
  if (project === 'chromium') {
    await page.evaluate(() => {
      const footer = document.querySelector('.place-attribution');
      if (footer && !footer.querySelector('[data-synthetic-capture]')) {
        const label = document.createElement('strong');
        label.dataset.syntheticCapture = 'true';
        label.textContent = 'SYNTHETIC acceptance fixture';
        footer.prepend(document.createElement('br'));
        footer.prepend(label);
      }
    });
    await mkdir('docs/status/assets/place-search', { recursive: true });
    await page.screenshot({
      path: `docs/status/assets/place-search/${name}.png`,
      fullPage: true,
    });
  }
}
test('explicit ambiguous selection and add; search/select/cancel have zero writes', async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-place-query]').fill('東京駅');
  await page.locator('[data-place-query]').press('Enter');
  await expect(page.locator('[data-candidate]')).toHaveCount(3);
  expect(writes).toBe(0);
  expect(searches).toBe(1);
  await expect(page.locator('select[name=place]')).toHaveValue('');
  await expect(page.locator('[data-candidate="2"]')).toBeDisabled();
  await page.locator('[data-candidate="1"]').click();
  expect(writes).toBe(0);
  await expect(page.locator('select[name=place]')).toHaveValue(
    'search:SYNTHETIC-token-1',
  );
  await page.locator('select[name=place]').selectOption({ index: 1 });
  await expect(page.locator('[data-selected-summary]')).toBeHidden();
  await page
    .locator('select[name=place]')
    .selectOption('search:SYNTHETIC-token-1');
  await expect(page.locator('[data-selected-summary]')).toBeVisible();
  let releaseIdentity: () => void = () => {};
  let identityStarted: () => void = () => {};
  const identityWaiting = new Promise<void>((r) => {
    identityStarted = r;
  });
  await page.route('**/api/me', async (route) => {
    await new Promise<void>((r) => {
      releaseIdentity = r;
      identityStarted();
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: tripId }),
    });
  });
  await page.locator('#authoring-add button.primary').click();
  await identityWaiting;
  await page.locator('select[name=place]').selectOption({ index: 1 });
  releaseIdentity();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await expect(page.locator('#save-status')).toContainText('新修改仍未保存');
  await page.unroute('**/api/me');
  expect(writes).toBe(1);
  expect(submitted.selectionToken).toBe('SYNTHETIC-token-1');
  expect(submitted.baseTripVersion).toBe(fixtureTrip().version);
  const firstKey = submitted.idempotencyKey;
  await page.locator('[data-candidate="0"]').click();
  await expect(page.locator('#save-status')).toContainText('还有未保存的修改');
  await page.locator('#authoring-add button.primary').click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  expect(writes).toBe(2);
  expect(submitted.selectionToken).toBe('SYNTHETIC-token-0');
  expect(submitted.idempotencyKey).not.toBe(firstKey);
  expect(submitted.baseTripVersion).toBe(fixtureTrip().version + 1);
});
test('cancel clears candidate and prevents formal writes', async ({ page }) => {
  await open(page);
  await search(page);
  await page.locator('[data-candidate="0"]').click();
  await page.locator('[data-place-cancel]').click();
  await expect(page.locator('select[name=place]')).toHaveValue('');
  await expect(page.locator('[data-search-status]')).toContainText('未保存');
  expect(writes).toBe(0);
});
test('provider failure preserves note draft and saved-place fallback', async ({
  page,
}) => {
  unavailable = true;
  await open(page);
  await page.locator('textarea[name=note]').fill('SYNTHETIC 未保存草稿');
  await page.locator('[data-place-query]').fill('東京駅');
  await page.locator('[data-place-search]').click();
  await expect(page.locator('[data-search-status]')).toContainText(
    '仍可选择已保存地点',
  );
  await expect(page.locator('textarea[name=note]')).toHaveValue(
    'SYNTHETIC 未保存草稿',
  );
  await page.locator('select[name=place]').selectOption({ index: 1 });
  await page.locator('#authoring-add button.primary').click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  expect(writes).toBe(1);
  expect(submitted.selectionToken).toBeUndefined();
});
test('version conflict retains selected evidence and draft for explicit recovery', async ({
  page,
}) => {
  await open(page);
  await search(page);
  await page.locator('[data-candidate="0"]').click();
  await page.locator('textarea[name=note]').fill('SYNTHETIC 草稿');
  conflict = true;
  await page.locator('#authoring-add button.primary').click();
  await expect(page.locator('#authoring-recovery')).toBeVisible();
  await page.locator('[data-authoring-recover]').click();
  await expect(page.locator('[data-authoring-ack]')).toBeVisible();
  await expect(page.locator('select[name=place]')).toHaveValue(
    'search:SYNTHETIC-token-0',
  );
  await expect(page.locator('textarea[name=note]')).toHaveValue(
    'SYNTHETIC 草稿',
  );
  expect(writes).toBe(1);
});
for (const width of [320, 375, 390, 430, 1280])
  test(`long Japanese place/address, safe scroll at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    if (width === 375) await capture(page, 'mobile-search', info.project.name);
    await search(page);
    await page.locator('[data-search-results]').scrollIntoViewIfNeeded();
    await expect(page.locator('.place-candidate')).toHaveCount(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('dialog')
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await capture(
      page,
      width === 1280
        ? 'desktop'
        : width === 320
          ? 'mobile-320'
          : width === 390
            ? 'mobile-results'
            : `mobile-${width}`,
      info.project.name,
    );
    if (width === 375) {
      await capture(page, 'mobile-ambiguous', info.project.name);
      await page.locator('[data-candidate="1"]').click();
      await page.locator('[data-selected-summary]').scrollIntoViewIfNeeded();
      await capture(page, 'mobile-selected', info.project.name);
    }
    await page
      .locator('#authoring-add button.primary')
      .scrollIntoViewIfNeeded();
    await expect(
      page.locator('#authoring-add button.primary'),
    ).toBeInViewport();
  });
test('enlarged text and provider unavailable visual fallback', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await open(page);
  const enlargedStyle = await page.addStyleTag({
    content: ':root {font-size:22px}',
  });
  await search(page);
  await page.locator('[data-search-results]').scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator('.place-candidate strong').first()).toHaveCSS(
    'font-size',
    '22px',
  );
  expect(
    await page
      .locator('dialog')
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  ).toBe(true);
  await capture(page, 'mobile-enlarged', info.project.name);
  await page.locator('#authoring-add button.primary').scrollIntoViewIfNeeded();
  await expect(page.locator('#authoring-add button.primary')).toBeInViewport();
  await enlargedStyle.evaluate((e) => e.parentNode?.removeChild(e));
  unavailable = true;
  await page.locator('[data-place-search]').click();
  await expect(page.locator('[data-search-status]')).toContainText(
    '暂时不可用',
  );
  await page.locator('[data-search-status]').scrollIntoViewIfNeeded();
  await capture(page, 'mobile-provider-unavailable', info.project.name);
  await page.locator('select[name=place]').selectOption({ index: 1 });
  await page.locator('select[name=place]').scrollIntoViewIfNeeded();
  await capture(page, 'mobile-saved-fallback', info.project.name);
});

test('unknown selection write then expired evidence reads authority and retains note without acknowledging or retrying a new write', async ({
  page,
}) => {
  await open(page);
  await search(page);
  await page.locator('[data-candidate="0"]').click();
  await page
    .locator('textarea[name=note]')
    .fill('SYNTHETIC unknown-write draft');
  unknownWrite = true;
  await page.locator('#authoring-add button.primary').click();
  await expect(page.locator('#authoring-recovery')).toBeVisible();
  unknownWrite = false;
  invalidEvidence = true;
  await page.locator('[data-authoring-recover]').click();
  await expect(page.locator('#authoring-recovery')).toContainText(
    '上次写入结果仍需核对',
  );
  await expect(page.locator('textarea[name=note]')).toHaveValue(
    'SYNTHETIC unknown-write draft',
  );
  await expect(page.locator('select[name=place]')).toHaveValue('');
  expect(writes).toBe(2);
  await expect(page.locator('#save-status')).not.toContainText(
    '本次提交已保存',
  );
});

test('core failure during search uses existing recovery and preserves draft rather than claiming only Provider failure', async ({
  page,
}) => {
  await open(page);
  await page.locator('textarea[name=note]').fill('SYNTHETIC core-read draft');
  coreSearchFails = true;
  await page.locator('[data-place-query]').fill('東京駅');
  await page.locator('[data-place-search]').click();
  await expect(page.locator('#authoring-recovery')).toBeVisible();
  await expect(page.locator('dialog')).toHaveAttribute(
    'data-unavailable',
    'true',
  );
  await expect(page.locator('textarea[name=note]')).toHaveValue(
    'SYNTHETIC core-read draft',
  );
  expect(writes).toBe(0);
  coreSearchFails = false;
  await page.locator('[data-authoring-recover]').click();
  await expect(page.locator('[data-authoring-ack]')).toBeVisible();
  await page.locator('[data-authoring-ack]').click();
  await expect(page.locator('[data-place-search]')).toBeEnabled();
  await search(page);
  expect(writes).toBe(0);
});

test.describe('SYNTHETIC Place Search with integrated mobile touch hardening', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [320, 375, 390, 430]) {
    test(`${width}px search draft retains touch, large text and keyboard protections until explicit authoring`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await open(page);
      await page.addStyleTag({ content: ':root { font-size: 24px; }' });
      await search(page);
      await expect(page.locator('[data-candidate="2"]')).toBeDisabled();
      await page.locator('[data-candidate="1"]').tap();
      const note = page.locator('textarea[name=note]');
      await note.fill('SYNTHETIC 東京駅の長い住所と保存前の草稿');
      await expect(page.locator('[data-place-query]')).toHaveCSS(
        'font-size',
        '24px',
      );
      expect(
        (await page.locator('[data-drag]').boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      expect(
        (await page.locator('[data-close]').boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      expect(writes).toBe(0);
      expect(searches).toBe(1);

      await page
        .locator('#detail')
        .evaluate((element) => (element.scrollTop = 0));
      let handle = (await page.locator('.handle').boundingBox())!;
      await page.mouse.move(handle.x + 15, handle.y + 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + 15, handle.y + 60, { steps: 4 });
      // Release real capture; a DOM-only lost event leaves native capture unchanged.
      await page.locator('#detail').evaluate((element) => {
        if (!element.hasPointerCapture(1))
          throw new Error('SYNTHETIC drag must capture its active pointer');
        element.releasePointerCapture(1);
      });
      await page.mouse.move(handle.x + 15, handle.y + 60);
      await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
      await page.mouse.up();
      await expect(page.getByRole('dialog')).toBeVisible();

      handle = (await page.locator('.handle').boundingBox())!;
      let discardPrompts = 0;
      page.once('dialog', async (dialog) => {
        discardPrompts++;
        await dialog.dismiss();
      });
      await page.mouse.move(handle.x + 15, handle.y + 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + 15, handle.y + 140, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(note).toHaveValue(
        'SYNTHETIC 東京駅の長い住所と保存前の草稿',
      );
      await expect(page.locator('select[name=place]')).toHaveValue(
        'search:SYNTHETIC-token-1',
      );

      await expect.poll(() => discardPrompts).toBe(1);
      await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
      await note.focus();
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, 'height', {
          configurable: true,
          value: 360,
        });
        Object.defineProperty(viewport, 'offsetTop', {
          configurable: true,
          value: 40,
        });
        viewport.dispatchEvent(new Event('resize'));
      });
      await expect
        .poll(async () => {
          const box = (await page.locator('#detail').boundingBox())!;
          return box.y + box.height;
        })
        .toBeLessThanOrEqual(401);
      const submit = page.locator('#authoring-add button.primary');
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeInViewport();
      expect(
        await page
          .locator('#detail')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(writes).toBe(0);
      await page.evaluate(() => {
        delete (window.visualViewport as unknown as { height?: number }).height;
        delete (window.visualViewport as unknown as { offsetTop?: number })
          .offsetTop;
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await submit.tap();
      await expect.poll(() => writes).toBe(1);
      expect(submitted.selectionToken).toBe('SYNTHETIC-token-1');
      expect(submitted.note).toBe('SYNTHETIC 東京駅の長い住所と保存前の草稿');
    });
  }
});

test('Today Impact returns to explicit Place Search authoring without consuming its draft', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await page.getByRole('button', { name: '查看影响', exact: true }).click();
  await expect(page.locator('.impact-detail')).toBeVisible();
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '全部日程', exact: true }).click();
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '地点', exact: true }).click();
  await search(page);
  await page.locator('[data-candidate="1"]').click();
  await page
    .locator('textarea[name=note]')
    .fill('SYNTHETIC Impact 后的搜索草稿');
  expect(writes).toBe(0);
  expect(searches).toBe(1);
  await expect(page.locator('select[name=place]')).toHaveValue(
    'search:SYNTHETIC-token-1',
  );
  await page.locator('#authoring-add button.primary').click();
  await expect.poll(() => writes).toBe(1);
  expect(submitted.selectionToken).toBe('SYNTHETIC-token-1');
  expect(submitted.note).toBe('SYNTHETIC Impact 后的搜索草稿');
});
