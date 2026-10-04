import { expect, test, type Page } from '@playwright/test';
import { fixtureSchedule, tripId, visit } from './fixture.js';
import {
  browserHarness,
  dragHandle,
  evidence,
  responseGate,
} from './helpers/replanning-acceptance.js';

test.use({ viewport: { width: 390, height: 844 } });
let h: Awaited<ReturnType<typeof browserHarness>>;
test.beforeEach(async ({ page }) => {
  h = await browserHarness(page);
});
async function addPlace(page: Page) {
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '地点', exact: true }).click();
}
async function loaded(page: Page) {
  await expect(page.locator('select[name=place] option')).toHaveCount(3);
  await expect(page.locator('[data-place-search]')).toBeEnabled();
}
function zeroWrites() {
  expect(h.planning()).toEqual([]);
  expect(
    h.calls.filter(
      (c) =>
        c.method === 'POST' &&
        !/\/(schedule\/evaluate|place-search)$/u.test(c.path),
    ),
  ).toEqual([]);
}

for (const timing of ['before-load', 'after-load'] as const) {
  for (const field of ['text', 'language'] as const) {
    for (const exit of ['button', 'drag', 'route'] as const) {
      test(`${timing} ${field}-only draft protects ${exit} and exact values`, async ({
        page,
      }, info) => {
        await h.enter();
        const hold = responseGate();
        if (timing === 'before-load') h.state.savedPlacesGate = hold;
        await addPlace(page);
        if (timing === 'before-load') await hold.entered;
        else await loaded(page);
        if (field === 'text')
          await page
            .locator('[data-place-query]')
            .fill('  SYNTHETIC 東京駅 draft  ');
        else await page.locator('[data-place-language]').selectOption('en');
        await expect(page.locator('#save-status')).toContainText(
          '还有未保存的修改',
        );
        hold.release();
        await loaded(page);
        // Saved-place response must not silently acknowledge these user edits.
        await expect(page.locator('#save-status')).toContainText(
          '还有未保存的修改',
        );
        let prompts = 0;
        page.on('dialog', async (dialog) => {
          prompts++;
          await dialog.dismiss();
        });
        if (exit === 'button') await page.locator('[data-close]').click();
        else if (exit === 'drag') await dragHandle(page);
        else
          await page
            .locator('.connection')
            .evaluate((e: HTMLElement) => e.click());
        await expect(page.locator('#detail')).toBeVisible();
        await expect(page.locator('#detail')).toHaveCSS('transform', 'none');
        await expect(page.locator('[data-place-query]')).toHaveValue(
          field === 'text' ? '  SYNTHETIC 東京駅 draft  ' : '',
        );
        await expect(page.locator('[data-place-language]')).toHaveValue(
          field === 'language' ? 'en' : 'ja',
        );
        expect(prompts).toBe(1);
        zeroWrites();
        if (timing === 'before-load' && field === 'text' && exit === 'drag')
          await evidence(
            page,
            'mobile-search-draft-protected',
            info.project.name,
          );
      });
    }
  }
}

test('language-only Escape refusal and Impact replacement retain the draft', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2030-10-01T04:30:00Z') });
  await h.enter();
  await page.locator('[data-view=today]').click();
  await addPlace(page);
  await loaded(page);
  await page.locator('[data-place-language]').selectOption('zh');
  let prompts = 0;
  page.on('dialog', async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await page.keyboard.press('Escape');
  await page
    .locator('[data-action=view-impact]')
    .evaluate((e: HTMLElement) => e.click());
  await expect(page.locator('[data-place-language]')).toHaveValue('zh');
  await expect(page.locator('#detail')).toBeVisible();
  expect(prompts).toBe(2);
  zeroWrites();
});

test('accepted discard closes and starts a fresh search draft; pristine loading stays clean', async ({
  page,
}) => {
  await h.enter();
  await addPlace(page);
  await loaded(page);
  await expect(page.locator('#save-status')).toContainText(
    '当前表单与已提交内容一致',
  );
  await page.locator('[data-place-query]').fill('SYNTHETIC discard');
  await page.locator('[data-place-language]').selectOption('en');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-close]').click();
  await expect(page.locator('#detail')).not.toBeVisible();
  await addPlace(page);
  await loaded(page);
  await expect(page.locator('[data-place-query]')).toHaveValue('');
  await expect(page.locator('[data-place-language]')).toHaveValue('ja');
  await expect(page.locator('#save-status')).toContainText(
    '当前表单与已提交内容一致',
  );
  zeroWrites();
});

for (const other of ['none', 'note', 'saved-place'] as const) {
  test(`cancel search discards only search state, preserves ${other} draft`, async ({
    page,
  }) => {
    await h.enter();
    await addPlace(page);
    await loaded(page);
    if (other === 'note')
      await page
        .locator('textarea[name=note]')
        .fill('SYNTHETIC unrelated note');
    if (other === 'saved-place')
      await page.locator('select[name=place]').selectOption({ index: 1 });
    const saved = await page.locator('select[name=place]').inputValue();
    await page.locator('[data-place-query]').fill('SYNTHETIC cancel');
    await page.locator('[data-place-language]').selectOption('en');
    await page.locator('[data-place-cancel]').click();
    await expect(page.locator('[data-place-query]')).toHaveValue('');
    await expect(page.locator('[data-place-language]')).toHaveValue('ja');
    await expect(page.locator('select[name=place]')).toHaveValue(saved);
    await expect(page.locator('textarea[name=note]')).toHaveValue(
      other === 'note' ? 'SYNTHETIC unrelated note' : '',
    );
    let prompts = 0;
    page.on('dialog', async (dialog) => {
      prompts++;
      await dialog.dismiss();
    });
    await page.locator('[data-close]').click();
    expect(prompts).toBe(other === 'none' ? 0 : 1);
    if (other !== 'none') await expect(page.locator('#detail')).toBeVisible();
    else await expect(page.locator('#detail')).not.toBeVisible();
    zeroWrites();
  });
}

test('cancel in-flight search prevents late candidates and preserves note protection', async ({
  page,
}) => {
  await h.enter();
  await addPlace(page);
  await loaded(page);
  await page.locator('textarea[name=note]').fill('SYNTHETIC keep note');
  await page.locator('[data-place-query]').fill('SYNTHETIC late');
  const hold = responseGate();
  h.state.placeSearchGate = hold;
  await page.locator('[data-place-search]').click();
  await hold.entered;
  await page.locator('[data-place-cancel]').click();
  const returned = page.waitForResponse((r) =>
    r.url().endsWith('/place-search'),
  );
  hold.release();
  await returned;
  await expect(page.locator('[data-candidate]')).toHaveCount(0);
  await expect(page.locator('[data-place-query]')).toHaveValue('');
  await expect(page.locator('textarea[name=note]')).toHaveValue(
    'SYNTHETIC keep note',
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  await dragHandle(page);
  await expect(page.locator('#detail')).toBeVisible();
  zeroWrites();
});

test('selected search candidate and note retain protection; cancel removes candidate only', async ({
  page,
}) => {
  await h.enter();
  await addPlace(page);
  await loaded(page);
  await page.locator('[data-place-query]').fill('SYNTHETIC candidate');
  await page.locator('[data-place-search]').click();
  await page.locator('[data-candidate]').click();
  await page.locator('textarea[name=note]').fill('SYNTHETIC selected note');
  page.once('dialog', (dialog) => dialog.dismiss());
  await dragHandle(page);
  await expect(page.locator('select[name=place]')).toHaveValue(
    'search:SYNTHETIC_P6C2_TOKEN',
  );
  await page.locator('[data-place-cancel]').click();
  await expect(page.locator('select[name=place]')).toHaveValue('');
  await expect(page.locator('textarea[name=note]')).toHaveValue(
    'SYNTHETIC selected note',
  );
  await expect(page.locator('#save-status')).toContainText('还有未保存的修改');
  zeroWrites();
});

for (const editedWhilePending of [false, true]) {
  test(`accepted authoring keeps formal duplicate protection and search baseline: pending edit ${editedWhilePending}`, async ({
    page,
  }) => {
    await h.enter();
    await addPlace(page);
    await loaded(page);
    await page.locator('select[name=place]').selectOption({ index: 1 });
    await page.locator('[data-place-query]').fill('SYNTHETIC submitted search');
    await page.locator('[data-place-language]').selectOption('en');
    const day = h.trip.days[0]!;
    const fresh = {
      ...h.trip,
      version: h.trip.version + 1,
      days: h.trip.days.map((d) =>
        d === day
          ? {
              ...d,
              nodes: [
                ...d.nodes,
                {
                  ...visit(
                    '10000000-0000-4000-8000-000000000099',
                    'SYNTHETIC accepted place',
                  ),
                  position: d.nodes.length,
                },
              ],
            }
          : d,
      ),
    };
    const hold = responseGate();
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/trips/${tripId}/authoring`, async (route) => {
      writes.push(route.request().postDataJSON());
      hold.arrived();
      await hold.pending;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(fresh),
      });
    });
    await page.route('**/api/trips/*/schedule/evaluate', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(fixtureSchedule(fresh)),
      }),
    );
    await page.locator('#authoring-add button.primary').click();
    await hold.entered;
    if (editedWhilePending) {
      await page.locator('[data-place-query]').fill('SYNTHETIC newer search');
      await page.locator('[data-place-language]').selectOption('zh');
    }
    hold.release();
    await expect(page.locator('#save-status')).toContainText('本次提交已保存');
    expect(Object.keys(writes[0]!).sort()).toEqual([
      'baseTripVersion',
      'command',
      'idempotencyKey',
    ]);
    expect(writes[0]!.baseTripVersion).toBe(h.trip.version);
    expect(writes[0]!.idempotencyKey).toEqual(expect.any(String));
    if (editedWhilePending)
      await expect(page.locator('#save-status')).toContainText(
        '新修改仍未保存',
      );
    else
      await expect(page.locator('#save-status')).not.toContainText(
        '新修改仍未保存',
      );
    // Search-only changes must never make the same accepted formal command writable again.
    await page.locator('#authoring-add button.primary').click();
    await expect(page.locator('#save-status')).toContainText(
      '这份内容已保存，请修改后再提交',
    );
    expect(writes).toHaveLength(1);
    let prompts = 0;
    page.on('dialog', async (dialog) => {
      prompts++;
      await dialog.dismiss();
    });
    await page.locator('[data-close]').click();
    expect(prompts).toBe(editedWhilePending ? 1 : 0);
    if (editedWhilePending) {
      await expect(page.locator('[data-place-query]')).toHaveValue(
        'SYNTHETIC newer search',
      );
      await expect(page.locator('[data-place-language]')).toHaveValue('zh');
    } else await expect(page.locator('#detail')).not.toBeVisible();
    expect(h.planning()).toEqual([]);
  });
}
