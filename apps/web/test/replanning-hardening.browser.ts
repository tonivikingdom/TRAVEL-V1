import { expect, test } from '@playwright/test';
import {
  browserHarness,
  dragHandle,
  evidence,
  noOverflow,
  responseGate,
} from './helpers/replanning-acceptance.js';

test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
let h: Awaited<ReturnType<typeof browserHarness>>;
test.beforeEach(async ({ page }) => {
  h = await browserHarness(page);
});

test('Provider unavailable is local; retry pending disables repeated tap and never writes Trip', async ({
  page,
}, info) => {
  await h.enter();
  await h.open();
  h.state.queryError = { code: 'PROVIDER_UNAVAILABLE', status: 503 };
  await page.getByRole('button', { name: '搜索路线', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText(
    'SYNTHETIC PROVIDER_UNAVAILABLE',
  );
  await expect(page.locator('.timeline')).toBeVisible();
  expect(h.formalWrites()).toEqual([]);
  await evidence(page, 'mobile-provider-unavailable', info.project.name);
  h.state.queryError = null;
  const hold = responseGate();
  h.state.queryGate = hold;
  await page.getByRole('button', { name: '搜索路线', exact: true }).click();
  await hold.entered;
  const query = page.getByRole('button', { name: '搜索路线', exact: true });
  await expect(query).toBeDisabled();
  await expect(page.locator('[data-close]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await dragHandle(page);
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
  await query.evaluate((e: HTMLButtonElement) => {
    e.click();
    e.click();
  });
  expect(h.planning()).toHaveLength(2);
  await evidence(page, 'mobile-pending-disabled', info.project.name);
  hold.release();
  await expect(page.locator('.candidate')).toBeVisible();
  await expect(query).toBeEnabled();
  expect(h.formalWrites()).toEqual([]);
});

test('late Query after changed search intent is discarded', async ({
  page,
}) => {
  await h.enter();
  await h.open();
  const hold = responseGate();
  h.state.queryGate = hold;
  await page.getByRole('button', { name: '搜索路线', exact: true }).click();
  await hold.entered;
  await page.locator('#route-search input[name=when]').fill('2030-10-01T15:30');
  const returned = page.waitForResponse((r) =>
    r.url().endsWith('/routes/query'),
  );
  hold.release();
  await returned;
  await expect(
    page.getByRole('button', { name: '搜索路线', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.candidate')).toHaveCount(0);
  expect(h.formalWrites()).toEqual([]);
});

for (const stage of ['preview', 'adopt'] as const) {
  test(`${stage} version conflict rejects old result and never retries a formal write`, async ({
    page,
  }, info) => {
    await h.enter();
    await h.open();
    if (stage === 'preview') {
      await h.query();
      h.state.previewError = { code: 'VERSION_CONFLICT', status: 409 };
      await page.locator('[data-candidate]').click();
    } else {
      await h.prepare();
      h.state.adoptError = { code: 'VERSION_CONFLICT', status: 409 };
      await page.locator('[data-action=adopt]').click();
    }
    await expect(page.locator('#save-status')).toContainText(
      '行程或方案已变化',
    );
    await expect(page.locator('[data-action=adopt]')).not.toBeVisible();
    expect(h.formalWrites()).toHaveLength(stage === 'adopt' ? 1 : 0);
    await evidence(page, `mobile-${stage}-version-conflict`, info.project.name);
  });
}

test('slow Adopt repeated tap sends one request and failure does not auto retry', async ({
  page,
}) => {
  await h.enter();
  await h.open();
  await h.prepare();
  const hold = responseGate();
  h.state.adoptGate = hold;
  h.state.adoptError = { code: 'PROVIDER_UNAVAILABLE', status: 503 };
  await page.locator('[data-action=adopt]').click();
  await hold.entered;
  await expect(page.locator('[data-action=adopt]')).toBeDisabled();
  await page.locator('[data-action=adopt]').evaluate((e: HTMLButtonElement) => {
    e.click();
    e.click();
  });
  expect(h.formalWrites()).toHaveLength(1);
  hold.release();
  await expect(page.locator('#save-status')).toContainText(
    'PROVIDER_UNAVAILABLE',
  );
  await expect(page.locator('[data-action=adopt]')).toBeEnabled();
  await page.locator('[data-close]').click();
  expect(h.formalWrites()).toHaveLength(1);
});

for (const close of ['button', 'escape', 'drag'] as const) {
  test(`preview ${close} closes without Adopt`, async ({ page }) => {
    await h.enter();
    await h.open();
    await h.prepare();
    if (close === 'button') await page.locator('[data-close]').click();
    else if (close === 'escape') await page.keyboard.press('Escape');
    else await dragHandle(page);
    await expect(page.locator('#detail')).not.toBeVisible();
    expect(h.formalWrites()).toEqual([]);
  });
}

test('Query 401 during request fails closed and prevents subsequent Adopt', async ({
  page,
}) => {
  await h.enter();
  await h.open();
  const hold = responseGate();
  h.state.queryGate = hold;
  h.state.queryError = { code: 'UNAUTHENTICATED', status: 401 };
  await page.getByRole('button', { name: '搜索路线', exact: true }).click();
  await hold.entered;
  hold.release();
  await expect(page.locator('#save-status')).toContainText('登录已失效');
  await expect(page.locator('.candidate')).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem('travel.web.session')),
  ).toBeNull();
  expect(h.formalWrites()).toEqual([]);
});

test('Impact and backup view never start planning', async ({ page }) => {
  await h.enter();
  await page.locator('[data-view=today]').click();
  await page.locator('[data-action=view-impact]').click();
  await expect(page.locator('#detail')).toBeVisible();
  await page.locator('[data-close]').click();
  await page.locator('[data-action=essentials]').click();
  await expect(page.locator('[data-action=view-backup]')).toBeVisible();
  await page.locator('[data-action=view-backup]').click();
  await expect(page.getByText('正在查看备份', { exact: true })).toBeVisible();
  expect(h.planning()).toEqual([]);
  expect(h.formalWrites()).toEqual([]);
});

for (const kind of ['authoring', 'place-search'] as const) {
  test(`${kind} draft refuses drag close and route open without clearing values`, async ({
    page,
  }, info) => {
    await h.enter();
    await page.locator('[data-action=add-arrangement]').click();
    await page
      .getByRole('button', {
        name: kind === 'authoring' ? '自由行动' : '地点',
        exact: true,
      })
      .click();
    if (kind === 'place-search') {
      await expect(page.locator('select[name=place] option')).toHaveCount(3);
      await expect(page.locator('[data-place-search]')).toBeEnabled();
    }
    const field =
      kind === 'authoring'
        ? page.locator('input[name=title]')
        : page.locator('[data-place-query]');
    await field.fill(`SYNTHETIC ${kind} protected draft`);
    let prompts = 0;
    page.on('dialog', async (dialog) => {
      prompts++;
      await dialog.dismiss();
    });
    if (kind === 'place-search') {
      await evidence(
        page,
        'mobile-place-search-draft-before-close',
        info.project.name,
      );
      await dragHandle(page);
      await evidence(
        page,
        'mobile-place-search-draft-lost-after-close',
        info.project.name,
      );
      // A normal handle gesture must respect the same draft protection.
      await expect(page.locator('#detail')).toBeVisible();
      await expect(field).toHaveValue(`SYNTHETIC ${kind} protected draft`);
      expect(prompts).toBe(1);
    }
    // The modal blocks background touch. Exercise its navigation handler without hiding it.
    await page.locator('.connection').evaluate((e: HTMLElement) => e.click());
    await expect(field).toHaveValue(`SYNTHETIC ${kind} protected draft`);
    await dragHandle(page);
    await expect(field).toHaveValue(`SYNTHETIC ${kind} protected draft`);
    expect(prompts).toBe(kind === 'place-search' ? 3 : 2);
    expect(h.planning()).toEqual([]);
    expect(h.formalWrites()).toEqual([]);
  });
}

test.describe('SYNTHETIC mobile route failure safety', () => {
  test.use({ isMobile: true, hasTouch: true });
  for (const width of [320, 375, 390, 430]) {
    test(`${width}px large text slow request, keyboard viewport, scrolling and drag`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 740 });
      await h.enter();
      await page.addStyleTag({ content: ':root { font-size: 24px; }' });
      await h.open();
      await page.locator('#route-search input[name=when]').focus();
      await page.evaluate(() => {
        Object.defineProperty(visualViewport!, 'height', {
          configurable: true,
          value: 360,
        });
        Object.defineProperty(visualViewport!, 'offsetTop', {
          configurable: true,
          value: 30,
        });
        visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect
        .poll(async () => {
          const box = (await page
            .locator('#route-search input[name=when]')
            .boundingBox())!;
          return box.y + box.height;
        })
        .toBeLessThanOrEqual(391);
      await noOverflow(page);
      await page.evaluate(() => {
        delete (visualViewport as unknown as { height?: number }).height;
        delete (visualViewport as unknown as { offsetTop?: number }).offsetTop;
        visualViewport!.dispatchEvent(new Event('resize'));
      });
      h.state.queryError = { code: 'PROVIDER_UNAVAILABLE', status: 503 };
      await page.getByRole('button', { name: '搜索路线', exact: true }).tap();
      await expect(page.locator('#save-status')).toContainText(
        'PROVIDER_UNAVAILABLE',
      );
      await noOverflow(page);
      await evidence(
        page,
        `mobile-${width}-large-text-failure`,
        info.project.name,
      );
      await dragHandle(page, 50);
      await expect(page.locator('#detail')).toBeVisible();
      await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
      await dragHandle(page);
      await expect(page.locator('#detail')).not.toBeVisible();
      expect(h.formalWrites()).toEqual([]);
    });
  }
  test('landscape failure sheet remains scrollable and close reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 740, height: 375 });
    await h.enter();
    await h.open();
    h.state.queryError = { code: 'PROVIDER_UNAVAILABLE', status: 503 };
    await page.getByRole('button', { name: '搜索路线', exact: true }).tap();
    await expect(page.locator('#save-status')).toContainText(
      'PROVIDER_UNAVAILABLE',
    );
    await noOverflow(page);
    await page.locator('[data-close]').tap();
    await expect(page.locator('#detail')).not.toBeVisible();
    expect(h.formalWrites()).toEqual([]);
  });
});
