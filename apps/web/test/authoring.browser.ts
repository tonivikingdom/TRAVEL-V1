import { chooseSavedPlace } from './helpers/replanning-acceptance.js';
import { expect, test, type Page } from '@playwright/test';
import type { TripView, ItineraryNodeView } from '@travel/contracts';
import { fixtureTrip, fixtureSchedule, tripId, visit } from './fixture.js';
let evaluationFails = false;
let catalogFails = false;
let trip: TripView,
  writes: number,
  release: (() => void) | undefined,
  hold: boolean,
  failure: string | undefined;
async function enter(page: Page) {
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await expect(page.locator('[data-action=add-arrangement]')).toBeVisible();
}
async function add(page: Page) {
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '自由行动', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  evaluationFails = false;
  catalogFails = false;
  trip = fixtureTrip();
  trip = { ...trip, name: 'SYNTHETIC authoring', connections: [] };
  writes = 0;
  hold = false;
  failure = undefined;
  release = undefined;
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
    if (path === '/trips')
      return catalogFails
        ? send(
            {
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'SYNTHETIC catalog outage',
              },
            },
            503,
          )
        : send({ trips: [trip] });
    if (path === `/trips/${tripId}`) return send(trip);
    if (path.endsWith('/schedule/evaluate'))
      return evaluationFails
        ? send(
            {
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'SYNTHETIC read failure',
              },
            },
            503,
          )
        : send(fixtureSchedule(trip));
    if (path.endsWith('/authoring')) {
      writes++;
      const body = route.request().postDataJSON();
      if (hold) await new Promise<void>((r) => (release = r));
      if (failure)
        return send(
          { error: { code: failure, message: 'SYNTHETIC conflict' } },
          409,
        );
      const c = body.command;
      if (c.type === 'ADD_FREE_ACTION' || c.type === 'ADD_PLACE_VISIT') {
        const day = trip.days.find(
          (d) => d.dayOccurrenceId === c.targetDay.dayOccurrenceId,
        )!;
        const n: ItineraryNodeView = {
          ...visit(crypto.randomUUID(), ''),
          place:
            c.type === 'ADD_PLACE_VISIT' ? trip.days[0]!.nodes[0]!.place : null,
          kind: c.type === 'ADD_PLACE_VISIT' ? 'PLACE_VISIT' : 'FREE_ACTION',
          dayOccurrenceId: day.dayOccurrenceId,
          position: day.nodes.length,
          note: c.note,
          timeValues: [],
          timeIntents: [],
        };
        trip = {
          ...trip,
          version: trip.version + 1,
          days: trip.days.map((d) =>
            d === day ? { ...d, nodes: [...d.nodes, n] } : d,
          ),
        };
      }
      return send(trip);
    }
    return send({});
  });
});
test('submitted activity snapshot retains new typing and never repeats accepted input', async ({
  page,
}) => {
  await enter(page);
  await add(page);
  const title = page.locator('[name=title]');
  await title.fill('SYNTHETIC A');
  hold = true;
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect.poll(() => release !== undefined).toBe(true);
  await title.fill('SYNTHETIC B');
  hold = false;
  release!();
  await expect(page.locator('#save-status')).toContainText('新修改仍未保存');
  await expect(title).toHaveValue('SYNTHETIC B');
  expect(trip.days[0]!.nodes.at(-1)!.note).toBe('SYNTHETIC A');
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect.poll(() => writes).toBe(2);
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  expect(writes).toBe(2);
});
test('version conflict recovery is reachable without dropping the same owner activity draft', async ({
  page,
}) => {
  await enter(page);
  await add(page);
  await page.locator('[name=title]').fill('SYNTHETIC retained');
  failure = 'VERSION_CONFLICT';
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('[data-authoring-recover]')).toBeVisible();
  await expect(page.locator('[name=title]')).toHaveValue('SYNTHETIC retained');
  failure = undefined;
  await page.locator('[data-authoring-recover]').click();
  await page.locator('[data-authoring-ack]').click();
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  expect(trip.days[0]!.nodes.at(-1)!.note).toBe('SYNTHETIC retained');
});
for (const width of [320, 375, 390, 430, 1280])
  test(`authoring controls reachable without overflow at ${width}px and large text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await enter(page);
    await page.addStyleTag({ content: 'html{font-size:20px}' });
    await add(page);
    await page
      .locator('[name=title]')
      .fill('SYNTHETIC 很长的自由活动名称保持正文可读并且不暴露内部数字与状态');
    await expect(page.locator('[name=title]')).toBeVisible();
    await expect(
      page.getByRole('button', { name: '添加自由行动', exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.sheet-body')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  });
test('temporary blank next day makes no write and disappears on reload', async ({
  page,
}) => {
  await enter(page);
  await page.locator('[data-action=next-day]').click();
  await expect(page.locator('.temporary-day-note')).toBeVisible();
  expect(writes).toBe(0);
  await page.reload();
  await page.locator('[data-trip]').click();
  await expect(page.locator('.temporary-day-note')).toHaveCount(0);
  expect(writes).toBe(0);
});

test('place note edited while adding is retained after the accepted request', async ({
  page,
}) => {
  await enter(page);
  await page.locator('[data-action=add-arrangement]').click();
  await chooseSavedPlace(page, trip.days[0]!.nodes[0]!.place!.id);
  await page.locator('[name=note]').fill('SYNTHETIC A');
  hold = true;
  await page.getByRole('button', { name: '添加地点', exact: true }).click();
  await expect.poll(() => release !== undefined).toBe(true);
  await page.locator('[name=note]').fill('SYNTHETIC B');
  hold = false;
  release!();
  await expect(page.locator('#save-status')).toContainText('新修改仍未保存');
  await expect(page.locator('[name=note]')).toHaveValue('SYNTHETIC B');
  expect(trip.days[0]!.nodes.at(-1)!.note).toBe('SYNTHETIC A');
});
test('accepted addition and failed evaluation retain truthful write status, newer draft and recover without another write', async ({
  page,
}) => {
  await enter(page);
  await add(page);
  await page.locator('[name=title]').fill('SYNTHETIC A');
  hold = true;
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect.poll(() => release !== undefined).toBe(true);
  await page.locator('[name=title]').fill('SYNTHETIC B');
  evaluationFails = true;
  hold = false;
  release!();
  await expect(page.locator('#save-status')).toContainText('已保存到服务器');
  await expect(page.locator('#save-status')).toContainText('后续读取');
  await expect(page.locator('[name=title]')).toHaveValue('SYNTHETIC B');
  evaluationFails = false;
  await page.locator('[data-authoring-recover]').click();
  await page.locator('[data-authoring-ack]').click();
  expect(writes).toBe(1);
  await expect(page.locator('[name=title]')).toHaveValue('SYNTHETIC B');
});

test('place catalog outage recovery keeps notes and restores a reachable reliable selection', async ({
  page,
}) => {
  await enter(page);
  catalogFails = true;
  await page.locator('[data-action=add-arrangement]').click();
  await expect(page.locator('[data-authoring-recover]')).toBeVisible();
  await page.locator('[name=note]').fill('SYNTHETIC 保留新备注');
  catalogFails = false;
  await page.locator('[data-authoring-recover]').click();
  await page.locator('[data-authoring-ack]').click();
  await expect(page.locator('[name=note]')).toHaveValue('SYNTHETIC 保留新备注');
  await chooseSavedPlace(page, trip.days[0]!.nodes[0]!.place!.id);
  await page.getByRole('button', { name: '添加地点', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  expect(trip.days[0]!.nodes.at(-1)!.note).toBe('SYNTHETIC 保留新备注');
});

test('a removed target date requires explicit reselection without losing the activity draft', async ({
  page,
}) => {
  await enter(page);
  await add(page);
  await page.locator('[name=title]').fill('SYNTHETIC 原日期被移走后的草稿');
  const surviving = trip.days[1]!;
  trip = {
    ...trip,
    version: trip.version + 1,
    days: [
      {
        ...surviving,
        sequence: 0,
        nodes: trip.days[0]!.nodes.map((n) => ({
          ...n,
          dayOccurrenceId: surviving.dayOccurrenceId,
        })),
      },
    ],
  };
  failure = 'VERSION_CONFLICT';
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('[data-authoring-recover]')).toBeVisible();
  failure = undefined;
  await page.locator('[data-authoring-recover]').click();
  await expect(page.locator('#authoring-retarget')).toBeVisible();
  await page.locator('[data-authoring-ack]').click();
  expect(writes).toBe(1);
  await expect(page.locator('#save-status')).toContainText('请选择');
  await page
    .locator('#authoring-retarget')
    .selectOption(surviving.dayOccurrenceId);
  await page.locator('[data-authoring-ack]').click();
  await expect(page.locator('.authoring-date')).toContainText(
    surviving.localDate,
  );
  await expect(page.locator('[name=title]')).toHaveValue(
    'SYNTHETIC 原日期被移走后的草稿',
  );
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('本次提交已保存');
  expect(trip.days[0]!.nodes.at(-1)!.note).toBe(
    'SYNTHETIC 原日期被移走后的草稿',
  );
});
