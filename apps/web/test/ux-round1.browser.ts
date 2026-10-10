import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { browserHarness, noOverflow } from './helpers/replanning-acceptance.js';
import { regionalCapabilityFixture } from './regional-map-fixture.js';
const assets = 'docs/status/assets/p7a-ux-round1/after';
test('SYNTHETIC malformed civil dates and clock ranges stay field errors without writes', async ({
  page,
}) => {
  const h = await browserHarness(page);
  await h.enter();
  await page.locator('[data-node]').first().click();
  await page.locator('.edit > summary').click();
  const form = page.locator('#time-edit');
  const before = h.calls.filter((c) => c.method === 'POST');
  for (const value of [
    '2030-10-01T99:99',
    '2030-02-31T10:00',
    '2030-10-01T10:60',
  ]) {
    await form
      .locator('[name=when]')
      .evaluate((input: HTMLInputElement, raw) => {
        input.value = raw;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    await form.evaluate((f: HTMLFormElement) => f.requestSubmit());
    await expect(form.locator('[name=when]')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(form.locator('.date-trigger')).toBeFocused();
    await expect(form.locator('.field-error:not([hidden])')).toHaveCount(1);
  }
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual(before);
  expect(h.formalWrites()).toEqual([]);
});
test('SYNTHETIC missing saved place focuses the visible selection without writes', async ({
  page,
}) => {
  const h = await browserHarness(page);
  await h.enter();
  await page.locator('[data-action=add-arrangement]').click();
  await page.locator('[data-source=saved]').click();
  await page.getByRole('button', { name: '添加地点', exact: true }).click();
  await expect(page.locator('select[name=place]')).toBeFocused();
  await expect(page.locator('#authoring-add')).toContainText('请选择地点');
  expect(h.formalWrites()).toEqual([]);
});
test('SYNTHETIC missing time zone focuses its visible selector without writes', async ({
  page,
}) => {
  const h = await browserHarness(page);
  await h.enter();
  await page.locator('[data-node]').first().click();
  await page.locator('.edit > summary').click();
  const form = page.locator('#time-edit');
  await form.locator('[name=when]').fill('2030-10-01T10:00');
  await form.locator('.zone-choice summary').click();
  await form.locator('[data-zone]').selectOption('');
  await page.getByRole('button', { name: '保存时间要求', exact: true }).click();
  await expect(form.locator('[data-zone]')).toBeFocused();
  await expect(form.locator('[data-zone]')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(form.locator('[data-zone]')).toHaveAttribute(
    'aria-describedby',
    /-error$/u,
  );
  expect(h.formalWrites()).toEqual([]);
});
for (const action of ['cancel', 'accept', 'blocked'] as const) {
  test(`SYNTHETIC asynchronous map ${action}: one confirmation, safe popup and retained draft`, async ({
    page,
    context,
  }) => {
    const h = await browserHarness(page);
    await page.route('**/provider-capability', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          regionalCapabilityFixture(
            h.trip,
            new URL(route.request().url()).pathname.replace(/^\/api/u, ''),
          ),
        ),
      }),
    );
    const requests: string[] = [];
    await context.route('https://www.google.com/**', async (route) => {
      requests.push(route.request().headers()['referer'] ?? '');
      await route.fulfill({
        contentType: 'text/html',
        body: '<p>SYNTHETIC external map</p>',
      });
    });
    if (action === 'blocked')
      await page.addInitScript(() => {
        window.open = () => null;
      });
    await h.enter();
    await page.locator('[data-node]').first().click();
    await page
      .locator('#note-edit textarea')
      .fill('SYNTHETIC retained map draft');
    const link = page.locator('#detail .map-links a').first();
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const popupPromise =
      action === 'blocked' ? null : page.waitForEvent('popup');
    await link.click();
    const popup = popupPromise ? await popupPromise : null;
    await link.evaluate((element: HTMLAnchorElement) => element.click());
    await expect(page.locator('dialog.confirmation')).toHaveCount(1);
    expect(context.pages()).toHaveLength(action === 'blocked' ? 1 : 2);
    await page
      .locator(
        action === 'cancel' ? '[data-confirm-cancel]' : '[data-confirm-accept]',
      )
      .click();
    await expect(page.locator('dialog.confirmation')).toHaveCount(0);
    await expect(page.locator('#note-edit textarea')).toHaveValue(
      'SYNTHETIC retained map draft',
    );
    if (action === 'cancel') {
      await expect.poll(() => popup!.isClosed()).toBe(true);
      expect(requests).toEqual([]);
    } else if (action === 'accept') {
      await expect(popup!).toHaveURL(/https:\/\/www.google.com\//u);
      expect(await popup!.evaluate(() => window.opener)).toBeNull();
      expect(requests).toEqual(['']);
    } else
      await expect(page.locator('#save-status')).toContainText(
        '浏览器阻止了新窗口',
      );
    expect(h.formalWrites()).toEqual([]);
  });
}
async function shot(page: import('@playwright/test').Page, name: string) {
  if (process.env.P7A_UX_SCREENSHOTS !== 'true') return;
  await mkdir(assets, { recursive: true });
  await page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
}

for (const width of [320, 375, 390, 430, 1440]) {
  test(`SYNTHETIC ${width}: invalid forms, calendar semantics, stepper and one dirty confirmation`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
    const h = await browserHarness(page);
    await page.goto('/');
    await page.locator('[data-action=create-trip]').click();
    const form = page.locator('#authoring-create');
    await expect(page.locator('.field-error:not([hidden])')).toHaveCount(0);
    await shot(page, `${info.project.name}-${width}-create`);
    await form.locator('[name=people]').fill('');
    await form.getByRole('button', { name: '创建旅行', exact: true }).click();
    await expect(form.locator('.field-error:not([hidden])')).toHaveCount(3);
    await expect(form.locator('[name=name]')).toBeFocused();
    await expect(form).toHaveAttribute('novalidate', '');
    await expect(form.locator('[name=date]')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(form.locator('[name=date]')).toHaveAttribute(
      'aria-describedby',
      /-error$/u,
    );
    await shot(page, `${info.project.name}-${width}-validation`);
    for (const value of ['0', '-1', '1.5']) {
      await form.locator('[name=people]').fill(value);
      await form.getByRole('button', { name: '创建旅行', exact: true }).click();
      await expect(form).toContainText('人数需为 1 或以上的整数');
    }
    await form.locator('[name=name]').fill('   ');
    await form.evaluate((f: HTMLFormElement) => f.submit());
    await expect(form).toContainText('请输入旅行名称');
    await form.locator('[name=name]').evaluate((f: HTMLInputElement) => {
      f.value = 'SYNTHETIC'.repeat(30);
    });
    await form.evaluate((f: HTMLFormElement) => f.requestSubmit());
    await expect(form).toContainText('旅行名称最多 200 字');
    await form.locator('[name=name]').fill('SYNTHETIC 草稿');
    await form.locator('[name=people]').fill('1');
    await expect(form.getByRole('button', { name: '减少人数' })).toBeDisabled();
    await form.getByRole('button', { name: '增加人数' }).click();
    await expect(form.locator('[name=people]')).toHaveValue('2');
    await form.locator('.date-trigger').click();
    await expect(form.locator('[name=date]')).toHaveValue('');
    await page.locator('.calendar [aria-label=年份]').selectOption('2001');
    await page.locator('.calendar [aria-label=月份]').selectOption('0');
    await page.locator('.calendar [data-date="2001-01-01"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(form.locator('[name=date]')).toHaveValue('2001-01-02');
    await expect(form.locator('.date-trigger')).toBeFocused();
    await form.locator('.date-trigger').click();
    await expect(
      page.locator('.calendar [aria-selected=true]'),
    ).toHaveAttribute('data-date', '2001-01-02');
    await shot(page, `${info.project.name}-${width}-calendar`);
    await page.keyboard.press('Escape');
    await expect(page.locator('.calendar')).toHaveCount(0);
    await expect(page.locator('#detail')).toBeVisible();
    await expect(form.locator('[name=date]')).toHaveValue('2001-01-02');
    await page.locator('[data-close]').first().click();
    await expect(page.locator('dialog.confirmation')).toBeVisible();
    await expect(page.locator('[data-confirm-cancel]')).toBeFocused();
    await shot(page, `${info.project.name}-${width}-confirmation`);
    await page.keyboard.press('Escape');
    await expect(form.locator('[name=name]')).toHaveValue('SYNTHETIC 草稿');
    await page.locator('[data-close]').first().click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('#detail')).not.toBeVisible();
    expect(h.formalWrites()).toEqual([]);
    expect(h.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
}

test('SYNTHETIC route stages preserve conditions and zero writes until explicit adopt', async ({
  page,
}) => {
  const h = await browserHarness(page);
  await h.enter();
  await h.open();
  const before = await page
    .locator('#route-search')
    .evaluate((f: HTMLFormElement) => [...new FormData(f).entries()]);
  await h.query();
  await expect(
    page.locator('section[data-route-stage=candidates]'),
  ).toBeVisible();
  await expect(page.locator('#route-search')).toBeHidden();
  await page.locator('[data-candidate]').click();
  await expect(page.locator('section[data-route-stage=preview]')).toBeVisible();
  await expect(page.locator('.preview-details').first()).not.toHaveAttribute(
    'open',
  );
  await page.locator('[data-route-back=candidates]').click();
  await expect(page.locator('.candidate')).toBeVisible();
  await page.locator('[data-route-back=search]').click();
  expect(
    await page
      .locator('#route-search')
      .evaluate((f: HTMLFormElement) => [...new FormData(f).entries()]),
  ).toEqual(before);
  expect(h.formalWrites()).toEqual([]);
});

test('SYNTHETIC partial local date and time remains dirty, IME Enter performs no search', async ({
  page,
}) => {
  const h = await browserHarness(page);
  await h.enter();
  await page.locator('[data-node]').first().click();
  await page.locator('.edit > summary').click();
  await page.locator('#time-edit [data-time-part]').fill('1');
  await page.locator('[data-close]').first().click();
  await expect(page.locator('dialog.confirmation')).toBeVisible();
  await page.locator('[data-confirm-accept]').click();
  await page.locator('[data-action=add-arrangement]').click();
  await expect(page.locator('[data-place-search]')).toBeEnabled();
  await page.locator('[data-place-query]').fill('SYNTHETIC 東京');
  await page.locator('[data-place-query]').evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(h.calls.filter((c) => c.path.endsWith('/place-search'))).toEqual([]);
  expect(h.formalWrites()).toEqual([]);
});

for (const width of [390, 1440])
  test(`SYNTHETIC dependency review card ${width} hover/focus/menu without API`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) requests.push(r.url());
    });
    await page.goto('/test/ux-review/index.html');
    expect(await page.locator('button button').count()).toBe(0);
    if (width < 760) {
      await page.locator('.mobile-menu').click();
      expect(
        await page.locator('.review-menu button').allTextContents(),
      ).toEqual(['重命名', '分享', '删除旅行']);
      await page.locator('.review-menu [data-rename]').click();
    } else {
      await page.locator('.card-open').focus();
      await page.locator('.review-card > [data-rename]').click();
    }
    await page.locator('[name=name]').fill('SYNTHETIC 演示名称');
    await page.locator('[name=name]').press('Escape');
    await expect(page.locator('.card-open')).toContainText('东京旅行');
    await shot(page, `${info.project.name}-${width}-dependency-card`);
    expect(requests).toEqual([]);
  });

test('SYNTHETIC 320px calendar at root 24px and landscape stays reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await browserHarness(page);
  await page.goto('/');
  await page.addStyleTag({ content: 'html {font-size:24px !important}' });
  await page.locator('[data-action=create-trip]').click();
  await page.locator('.date-trigger').click();
  await noOverflow(page);
  expect(
    await page
      .locator('.calendar')
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page.locator('[data-calendar-cancel]').click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('.date-trigger').click();
  await expect(page.locator('[data-calendar-cancel]')).toBeVisible();
});
