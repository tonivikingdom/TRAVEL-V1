import { test, expect, type Page } from '@playwright/test';
import type {
  GroundTransitRouteReevaluationHandoffView,
  RoutePreviewView,
  TripImpactView,
} from '@travel/contracts';
import { fixtureCandidate, fixtureSchedule } from './fixture.js';
import { inTripFixture } from './in-trip-fixture.js';
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
let f = inTripFixture(),
  calls: string[] = [],
  h: GroundTransitRouteReevaluationHandoffView,
  p: RoutePreviewView,
  fail = '',
  hold = '',
  release: (() => void) | null = null;
function preview(
  scope: 'FULL_CORRIDOR' | 'SUFFIX' | 'EXTERNAL_ORIGIN',
): RoutePreviewView {
  const first = f.trip.days[0]!.nodes[0]!,
    last = f.trip.days[0]!.nodes.at(-1)!;
  const base = fixtureCandidate();
  const origin =
    scope === 'EXTERNAL_ORIGIN'
      ? {
          name: 'SYNTHETIC 已确认临时终点',
          latitude: 35.72,
          longitude: 139.77,
          providerPlaceRef: null,
          providerHubRef: 'SYNTHETIC-E',
        }
      : {
          ...(scope === 'SUFFIX'
            ? f.trip.days[0]!.nodes[1]!.place!
            : first.place!),
          providerPlaceRef: null,
        };
  const candidate = {
    ...base,
    legs: base.legs.map((leg, index) => ({
      ...leg,
      ...(index === 0 ? { from: origin } : {}),
      ...(index === base.legs.length - 1
        ? { to: { ...last.place!, providerPlaceRef: null } }
        : {}),
    })),
  };
  const common = {
    previewId: f.trip.id,
    tripId: f.trip.id,
    basisVersion: f.trip.version,
    candidateSnapshotId: candidate.candidateSnapshotId,
    candidateHash: 'SYNTHETIC',
    policyVersion:
      scope === 'EXTERNAL_ORIGIN'
        ? 'route-external-origin-preview-v2'
        : 'route-adoption-preview-v3',
    createdAt: '2030-10-01T04:30:00Z',
    expiresAt: '2030-10-01T06:00:00Z',
    adoptable: true,
    status: 'ACTIVE' as const,
    currentConnection: {
      fromNodeId: first.id,
      toNodeId: last.id,
      state: 'ACTIVE' as const,
      transport: null,
    },
    candidate,
  };
  const changeSummary = {
    transportAction: 'REPLACE' as const,
    willReplaceTransportEdgeId: 'edge-1',
    willReplaceTransportEdgeIds: ['edge-1', 'edge-2'],
    requiresGeneratedNodes: false,
    generatedTransferPoints: [],
    proposedSegments: [],
    temporalLayer: 'PLANNED' as const,
    temporalSourceKind: 'ADOPTED_TRANSPORT_FACT' as const,
  };
  return {
    ...common,
    changeSummary: {
      ...changeSummary,
      ...(scope === 'EXTERNAL_ORIGIN'
        ? {
            externalOriginReplacement: {
              replacementScope: 'EXTERNAL_ORIGIN',
              externalOriginId: 'SYNTHETIC-E',
              sourceAdoptedRouteId: f.trip.id,
              sourceTransportEdgeId: 'edge-1',
              sourceGroundTransitLegExecutionId: 'leg-1',
              sourceRouteAnchorFromNodeId: first.id,
              sourceRouteAnchorToNodeId: last.id,
              sourceDivergenceNodeId: f.trip.days[0]!.nodes[1]!.id,
              destinationNodeId: last.id,
              preservedPrefixNodeIds: [first.id, f.trip.days[0]!.nodes[1]!.id],
              preservedPrefixTransportEdgeIds: ['edge-0'],
              replacementNodeIds: f.trip.days[0]!.nodes.slice(1).map(
                (n) => n.id,
              ),
              replacementTransportEdgeIds: ['edge-1', 'edge-2'],
              materializedOrigin: {
                ref: 'EXTERNAL_ORIGIN',
                action: 'CREATE',
                nodeId: null,
                kind: 'PLACE_VISIT',
                source: 'ROUTE_GENERATED',
                location: {
                  ...candidate.legs[0]!.from,
                  ref: 'EXTERNAL_ORIGIN',
                  name: 'SYNTHETIC 已确认临时终点',
                },
                localDate: '2030-10-01',
                dayOccurrenceId: null,
                provider: 'SYNTHETIC',
                providerPlaceRef: null,
                providerHubRef: 'SYNTHETIC-E',
                autoReplaceable: true,
                userModifiedAt: null,
                evidence: 'USER_CONFIRMED',
                temporalValues: [],
                executionEvents: [],
              },
            },
          }
        : {
            routeCorridor: {
              replacementScope: scope,
              anchorFromNodeId:
                scope === 'SUFFIX' ? f.trip.days[0]!.nodes[1]!.id : first.id,
              anchorToNodeId: last.id,
              currentNodeIds: f.trip.days[0]!.nodes.map((n) => n.id),
              currentAdoptedRouteId: f.trip.id,
              ...(scope === 'SUFFIX'
                ? {
                    preservedPrefixNodeIds: [
                      first.id,
                      f.trip.days[0]!.nodes[1]!.id,
                    ],
                  }
                : {}),
            },
          }),
    },
  };
}
function impact(): TripImpactView {
  return {
    tripId: f.trip.id,
    basisVersion: f.trip.version,
    evaluatedAt: '2030-10-01T04:30:00Z',
    items:
      h.readiness === 'NOT_REQUIRED'
        ? []
        : [
            {
              nodeId: null,
              transportEdgeId: 'edge-1',
              status: 'VIOLATED',
              changed: true,
              title: 'SYNTHETIC 交通取消',
              explanation: '原交通已取消，需要核对后续方案。',
            },
          ],
    handoffs: [h],
  };
}
test.beforeEach(async ({ page }) => {
  f = inTripFixture();
  calls = [];
  fail = '';
  hold = '';
  release = null;
  h = {
    tripId: f.trip.id,
    sourceTransportEdgeId: 'edge-1',
    adoptedRouteId: f.trip.id,
    readiness: 'READY',
    originBasis: 'PLANNED_ROUTE_ORIGIN',
    reasonCodes: ['SYNTHETIC_CANCELLED'],
    query: {
      basisVersion: f.trip.version,
      fromNodeId: f.trip.days[0]!.nodes[0]!.id,
      toNodeId: f.trip.days[0]!.nodes.at(-1)!.id,
      hint: {
        type: 'DEPART_AT',
        instant: '2030-10-01T04:30:00Z',
        timeZone: 'Asia/Tokyo',
      },
    },
  };
  p = preview('FULL_CORRIDOR');
  await page.clock.install({ time: new Date('2030-10-01T04:30:00Z') });
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_ALTERNATIVES_ONLY'),
  );
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api', '');
    calls.push(`${req.method()} ${path}`);
    const send = (v: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(v),
      });
    if (hold && path.endsWith(hold))
      await new Promise<void>((r) => {
        release = r;
      });
    if (path === '/me') return send({ id: f.trip.id });
    if (path === '/trips') return send({ trips: [f.trip] });
    if (path === `/trips/${f.trip.id}`) return send(f.trip);
    if (path.endsWith('/schedule/evaluate'))
      return send(fixtureSchedule(f.trip));
    if (path.endsWith('/in-trip'))
      return send({ ...f.evidence, tripVersion: f.trip.version });
    if (path.endsWith('/execution/ground-transit'))
      return send({ ...f.ground, tripVersion: f.trip.version });
    if (path.endsWith('/impact')) return send(impact());
    if (path.endsWith('/alternatives/query')) {
      expect(req.postDataJSON()).toEqual({ handoff: h });
      if (fail)
        return send(
          { error: { code: fail, message: 'SYNTHETIC 测试失败' } },
          fail === 'VERSION_CONFLICT' ? 409 : 503,
        );
      return send({
        handoff: h,
        result: {
          tripId: f.trip.id,
          basisVersion: f.trip.version,
          candidates: [p.candidate],
        },
      });
    }
    if (path.endsWith('/previews')) {
      if (fail === 'PREVIEW_STALE') return send({ error: { code: fail } }, 409);
      return send(p, 201);
    }
    if (path.endsWith('/adopt') || path.endsWith('/undo')) {
      if (fail === 'VERSION_CONFLICT')
        return send({ error: { code: fail } }, 409);
      f.trip = { ...f.trip, version: f.trip.version + 1 };
      h = path.endsWith('/undo')
        ? {
            ...h,
            readiness: 'READY',
            query: {
              basisVersion: f.trip.version,
              fromNodeId: f.trip.days[0]!.nodes[0]!.id,
              toNodeId: f.trip.days[0]!.nodes.at(-1)!.id,
              hint: {
                type: 'DEPART_AT',
                instant: '2030-10-01T04:30:00Z',
                timeZone: 'Asia/Tokyo',
              },
            },
          }
        : { ...h, readiness: 'NOT_REQUIRED', query: null };
      return send({ trip: f.trip, operationReceipt: { id: f.trip.id } });
    }
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
});
const count = (suffix: string) =>
  calls.filter((c) => c.endsWith(suffix)).length;
async function enter(page: Page) {
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await page.getByRole('button', { name: '查看影响', exact: true }).click();
}
async function open(page: Page) {
  await enter(page);
  await page.getByRole('button', { name: '查看调整方案', exact: true }).click();
  await expect(page.locator('.alternative-search')).toBeVisible();
}
async function search(page: Page) {
  await open(page);
  await page.getByRole('button', { name: '搜索替代方案', exact: true }).click();
  await expect(page.locator('.candidate')).toBeVisible();
}
async function choose(page: Page) {
  await search(page);
  await page.locator('.candidate').click();
  await expect(page.locator('.choice')).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (process.env.WEB_TEST_SCREENSHOTS === 'true')
    await page.screenshot({
      path: `docs/status/assets/p6c-2/${name}.png`,
      fullPage: false,
    });
}
test('READY entry and view are zero Query; only explicit search produces unselected candidates', async ({
  page,
}) => {
  await enter(page);
  await shot(page, 'mobile-ready-entry');
  expect(count('/alternatives/query')).toBe(0);
  await page.getByRole('button', { name: '查看调整方案' }).click();
  await shot(page, 'mobile-search-explicit');
  expect(count('/alternatives/query')).toBe(0);
  await page.getByRole('button', { name: '搜索替代方案' }).click();
  await expect(page.locator('.candidate')).toBeVisible();
  await shot(page, 'mobile-candidates');
  expect(count('/previews')).toBe(0);
  expect(count('/adopt')).toBe(0);
});
for (const state of ['NOT_REQUIRED', 'ORIGIN_UNRESOLVED'] as const)
  test(`${state} cannot search`, async ({ page }) => {
    h = { ...h, readiness: state, query: null };
    await enter(page);
    await expect(page.locator('[data-impact-handoff]')).toHaveCount(0);
    expect(count('/alternatives/query')).toBe(0);
  });
for (const [scope, name, text] of [
  ['FULL_CORRIDOR', 'mobile-preview-full', '替换这段路线'],
  ['SUFFIX', 'mobile-preview-suffix', '前面的已确认部分保持不变'],
  ['EXTERNAL_ORIGIN', 'mobile-preview-external', 'SYNTHETIC 已确认临时终点'],
] as const)
  test(`explicit Preview ${scope}`, async ({ page }) => {
    p = preview(scope);
    if (scope === 'EXTERNAL_ORIGIN')
      h = {
        ...h,
        originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
        query: null,
        externalQuery: {
          basisVersion: f.trip.version,
          externalOriginId: 'SYNTHETIC-E',
          toNodeId: f.trip.days[0]!.nodes.at(-1)!.id,
        },
      };
    if (scope === 'SUFFIX')
      h = {
        ...h,
        originBasis: 'CONFIRMED_EXECUTION_NODE',
        query: { ...h.query!, fromNodeId: f.trip.days[0]!.nodes[1]!.id },
      };
    await choose(page);
    await expect(page.locator('.alternative-changes')).toContainText(text);
    await shot(page, name);
    await page
      .getByRole('button', { name: '采用此调整' })
      .scrollIntoViewIfNeeded();
    await shot(page, `${name}-confirm`);
    expect(count('/previews')).toBe(1);
    expect(count('/adopt')).toBe(0);
  });
for (const state of ['BLOCKED', 'EXPIRED', 'ADOPT_UNSUPPORTED'] as const)
  test(`non-adoptable ${state}`, async ({ page }) => {
    p = { ...p, status: state, adoptable: false };
    await choose(page);
    await expect(
      page.getByRole('button', { name: '采用此调整' }),
    ).toBeDisabled();
    expect(count('/adopt')).toBe(0);
  });
test('Provider unavailable retains Impact and original route; retry is explicit', async ({
  page,
}) => {
  fail = 'PROVIDER_UNAVAILABLE';
  await open(page);
  await page.getByRole('button', { name: '搜索替代方案' }).click();
  await expect(page.locator('#candidates')).toContainText(
    '暂时无法搜索替代方案',
  );
  await expect(page.locator('.trip-impact')).toBeVisible();
  await shot(page, 'mobile-provider-unavailable');
  expect(f.trip.version).toBe(1);
  expect(count('/previews')).toBe(0);
  fail = '';
  await page.getByRole('button', { name: '搜索替代方案' }).click();
  await expect(page.locator('.candidate')).toBeVisible();
});
test('explicit Adopt refreshes Impact and Today then lightweight Undo refreshes again', async ({
  page,
}) => {
  await choose(page);
  const impactReads = count('/impact'),
    todayReads = count('/in-trip');
  await page.getByRole('button', { name: '采用此调整' }).click();
  await expect(page.locator('.undo')).toBeVisible();
  await expect(page.locator('.trip-impact')).toHaveClass(/impact-quiet/);
  await shot(page, 'mobile-adopt');
  expect(count('/adopt')).toBe(1);
  expect(count('/impact')).toBe(impactReads + 1);
  expect(count('/in-trip')).toBe(todayReads + 1);
  await page.getByRole('button', { name: '撤销刚才的路线修改' }).click();
  await expect(page.locator('.undo')).toHaveCount(0);
  await expect(page.locator('#app')).toContainText('刚才的路线修改已撤销');
  await expect(page.locator('.trip-impact')).toHaveClass(/impact-replan/);
  await shot(page, 'mobile-undo');
  expect(count('/undo')).toBe(1);
});
for (const action of ['query', 'previews', 'adopt'] as const)
  test(`double ${action} submits once`, async ({ page }) => {
    if (action === 'query') await open(page);
    else if (action === 'previews') await search(page);
    else await choose(page);
    hold = action === 'query' ? '/alternatives/query' : `/${action}`;
    const button =
      action === 'query'
        ? page.locator('[data-action=search-alternatives]')
        : action === 'previews'
          ? page.locator('.candidate')
          : page.locator('[data-action=adopt]');
    await button.evaluate((b) => {
      (b as HTMLButtonElement).click();
      (b as HTMLButtonElement).click();
    });
    await expect.poll(() => !!release).toBe(true);
    expect(count(hold)).toBe(1);
    release!();
    if (action === 'query')
      await expect(page.locator('.candidate')).toBeVisible();
    else if (action === 'previews')
      await expect(page.locator('.choice')).toBeVisible();
    else await expect(page.locator('.undo')).toBeVisible();
  });
for (const step of ['query', 'preview', 'adopt'] as const)
  test(`stale ${step} fails closed and recheck is reachable`, async ({
    page,
  }) => {
    if (step === 'query') await open(page);
    else if (step === 'preview') await search(page);
    else await choose(page);
    fail = step === 'preview' ? 'PREVIEW_STALE' : 'VERSION_CONFLICT';
    await (
      step === 'query'
        ? page.locator('[data-action=search-alternatives]')
        : step === 'preview'
          ? page.locator('.candidate')
          : page.locator('[data-action=adopt]')
    ).click();
    await expect(page.locator('#save-status')).toContainText(
      '行程或方案已变化',
    );
    await expect(
      page.locator('[data-action=search-alternatives]'),
    ).toBeDisabled();
    await expect(page.locator('.choice')).toHaveCount(0);
    fail = '';
    await page.getByRole('button', { name: '重新核验影响' }).click();
    await expect(page.locator('.impact-detail')).toBeVisible();
    expect(f.trip.version).toBe(1);
  });
for (const width of [320, 375, 390, 430])
  test(`alternative drawer ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await choose(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const body = page.locator('.sheet-body');
    expect(await body.evaluate((b) => b.scrollWidth <= b.clientWidth + 1)).toBe(
      true,
    );
    await expect(
      page.getByRole('button', { name: '采用此调整' }),
    ).toBeVisible();
    if (width === 320 || width === 390) await shot(page, `mobile-${width}`);
  });
test('enlarged mobile text remains reachable', async ({ page }) => {
  await choose(page);
  await page.addStyleTag({ content: 'html { font-size:24px !important }' });
  await page
    .getByRole('button', { name: '采用此调整' })
    .scrollIntoViewIfNeeded();
  expect(
    await page
      .locator('.sheet-body')
      .evaluate((b) => b.scrollWidth <= b.clientWidth + 1),
  ).toBe(true);
  await shot(page, 'mobile-enlarged');
});
test('desktop side drawer retains Today and controlled flow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await choose(page);
  await shot(page, 'desktop');
  await expect(page.locator('.next-step')).toBeVisible();
  expect(count('/adopt')).toBe(0);
});

test('lost Adopt response replays exact request and key without a second version increment', async ({
  page,
}) => {
  await choose(page);
  const submitted: unknown[] = [];
  let committed = false;
  await page.route('**/api/trips/*/previews/*/adopt', async (route) => {
    submitted.push(route.request().postDataJSON());
    if (!committed) {
      committed = true;
      f.trip = { ...f.trip, version: f.trip.version + 1 };
      h = { ...h, readiness: 'NOT_REQUIRED', query: null };
      return route.abort('failed');
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        trip: f.trip,
        operationReceipt: { id: f.trip.id },
      }),
    });
  });
  await page.getByRole('button', { name: '采用此调整' }).click();
  await expect(page.locator('#adoption-retry')).toBeVisible();
  await expect(page.locator('.alternative-search')).toBeHidden();
  await page.getByRole('button', { name: '核验本次采用' }).click();
  await expect(page.locator('.undo')).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(f.trip.version).toBe(2);
});

test('accepted Adopt with failed reread reports written state and preserves receipt for refresh', async ({
  page,
}) => {
  await choose(page);
  let readsFailed = false;
  await page.route(`**/api/trips/${f.trip.id}`, async (route) => {
    if (!readsFailed) {
      readsFailed = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(f.trip),
    });
  });
  await page.getByRole('button', { name: '采用此调整' }).click();
  await expect(page.locator('#app')).toContainText('后续读取/核对未完成');
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.undo')).toBeVisible();
  expect(count('/adopt')).toBe(1);
});
