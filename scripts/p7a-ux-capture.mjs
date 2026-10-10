/** Same SYNTHETIC fixtures on the archived baseline and current formal Web. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { browserHarness } from '../apps/web/test/helpers/replanning-acceptance.ts';

const root = 'docs/status/assets/p7a-ux-round1';
const browser = await chromium.launch();
try {
  for (const [version, port] of [
    ['before', 5176],
    ['after', 5174],
  ]) {
    await mkdir(`${root}/${version}`, { recursive: true });
    for (const [device, width] of [
      ['desktop', 1440],
      ['mobile', 390],
    ]) {
      const context = await browser.newContext({
        baseURL: `http://127.0.0.1:${port}`,
        viewport: { width, height: device === 'desktop' ? 1000 : 844 },
        timezoneId: 'Asia/Shanghai',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const h = await browserHarness(page);
      const shot = async (name) =>
        page.screenshot({
          path: `${root}/${version}/${device}-${name}.png`,
          fullPage: false,
        });
      await page.goto('/');
      await page.locator('[data-action=create-trip]').click();
      await expect(page.locator('#authoring-create')).toBeVisible();
      await shot('create');
      await page.getByRole('button', { name: '创建旅行', exact: true }).click();
      await shot('validation');
      if (version === 'after') {
        await page.locator('.date-trigger').click();
        await shot('calendar');
        await page.keyboard.press('Escape');
        await page
          .locator('#authoring-create [name=name]')
          .fill('SYNTHETIC 草稿');
        await page.locator('[data-close]').first().click();
        await expect(page.locator('.confirmation')).toBeVisible();
        await shot('confirmation');
        await page.locator('[data-confirm-accept]').click();
      } else await page.locator('[data-close]').first().click();
      await page.locator('[data-trip]').first().click();
      await expect(page.locator('.timeline')).toBeVisible();
      await shot('itinerary');
      await page.locator('[data-node]').first().click();
      await expect(page.locator('#note-edit')).toBeVisible();
      await shot('place');
      await page.locator('[data-close]').first().click();
      await page.locator('.connection').click();
      await expect(page.locator('#route-search')).toBeVisible();
      await shot('route');
      await page.locator('[data-close]').first().click();
      await page.locator('[data-action=essentials]').click();
      await expect(page.locator('.essentials')).toBeVisible();
      await shot('materials');
      assert.deepEqual(h.formalWrites(), []);
      await context.close();
    }
  }
  // A compact review sheet; screenshots are composed in HTML, not altered.
  const tiles = [];
  for (const [device, name] of [
    ['desktop', 'create'],
    ['mobile', 'create'],
    ['mobile', 'route'],
  ]) {
    for (const version of ['before', 'after']) {
      const data = await readFile(`${root}/${version}/${device}-${name}.png`);
      tiles.push(
        `<figure><figcaption>${version === 'before' ? '修改前' : '首稿'} · ${device} · ${name}</figcaption><img src="data:image/png;base64,${data.toString('base64')}"></figure>`,
      );
    }
  }
  const sheet = await browser.newPage({
    viewport: { width: 1200, height: 1800 },
  });
  await sheet.setContent(
    `<html lang="zh"><style>body{font:20px system-ui;background:#eef3f7;margin:24px}h1{font-size:25px}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;background:white;padding:12px}figcaption{margin-bottom:12px}img{display:block;width:100%;height:470px;object-fit:contain;object-position:top}</style><h1>TRAVEL-V1 正式 Web · 同一 SYNTHETIC 夹具前后对照</h1><main>${tiles.join('')}</main></html>`,
  );
  await sheet.screenshot({ path: `${root}/comparison.png`, fullPage: true });
  await writeFile(
    `${root}/capture.json`,
    JSON.stringify(
      {
        synthetic: true,
        baseline: '4f6b31a262acdf9ac634f0ad58eab437ca79d4cb',
        beforePort: 5176,
        afterPort: 5174,
        widths: [390, 1440],
        businessWrites: 0,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
