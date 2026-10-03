import { test, expect, type Page } from '@playwright/test';
import type {
  FlightMovementView,
  FlightSnapshotView,
  InTripView,
  TripView,
} from '@travel/contracts';
import { fixtureSchedule, fixtureTrip, tripId } from './fixture.js';
import { inTripFixture } from './in-trip-fixture.js';

test.use({ timezoneId: 'Asia/Tokyo', viewport: { width: 390, height: 844 } });
let fixture = inTripFixture();
let calls: string[] = [];
let coreUnavailable = false;
let groundUnavailable = false;
let inTripUnavailable = false;
let delayEvidence = false;
let evidenceForbidden = false;
let holdEvidence = false;
let releaseEvidence: (() => void) | undefined;
let authoringNetworkFailure = false;
let authoringBodies: Record<string, unknown>[] = [];

test.beforeEach(async ({ page }) => {
  fixture = inTripFixture();
  calls = [];
  coreUnavailable = false;
  groundUnavailable = false;
  inTripUnavailable = false;
  delayEvidence = false;
  evidenceForbidden = false;
  holdEvidence = false;
  releaseEvidence = undefined;
  authoringNetworkFailure = false;
  authoringBodies = [];
  await page.clock.install({ time: new Date('2030-10-01T05:11:00Z') });
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_P6B_ONLY'),
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api', '');
    calls.push(`${request.method()} ${path}`);
    const send = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    if (path === '/me') return send({ id: tripId });
    if (path === '/trips') return send({ trips: [fixture.trip] });
    if (path === `/trips/${tripId}`)
      return coreUnavailable
        ? send({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503)
        : send(fixture.trip);
    if (path.endsWith('/authoring')) {
      const body = request.postDataJSON();
      authoringBodies.push(body);
      if (authoringNetworkFailure) {
        authoringNetworkFailure = false;
        return route.abort('failed');
      }
      const day = fixture.trip.days[0]!;
      fixture.trip = {
        ...fixture.trip,
        version: fixture.trip.version + 1,
        days: [
          {
            ...day,
            nodes: [
              ...day.nodes,
              {
                ...day.nodes.at(-1)!,
                id: crypto.randomUUID(),
                kind: 'FREE_ACTION',
                place: null,
                note: body.command.note,
                position: day.nodes.length,
                timeValues: [],
                timeIntents: [],
              },
            ],
          },
        ],
      };
      fixture.evidence = {
        ...fixture.evidence,
        tripVersion: fixture.trip.version,
      };
      fixture.ground = { ...fixture.ground, tripVersion: fixture.trip.version };
      return send(fixture.trip);
    }
    if (path.endsWith('/schedule/evaluate'))
      return send(fixtureSchedule(fixture.trip));
    if (path.endsWith('/in-trip')) {
      if (holdEvidence)
        await new Promise<void>((r) => {
          releaseEvidence = r;
        });
      if (evidenceForbidden) return send({ error: { code: 'FORBIDDEN' } }, 403);
      if (delayEvidence)
        await new Promise((resolve) => setTimeout(resolve, 300));
      return inTripUnavailable
        ? send({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503)
        : send(fixture.evidence);
    }
    if (path.endsWith('/execution/ground-transit'))
      return groundUnavailable
        ? send({ error: { code: 'PROVIDER_UNAVAILABLE' } }, 503)
        : send(fixture.ground);
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
});

async function enter(page: Page) {
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await expect(page.locator('.in-trip')).toBeVisible();
}
async function capture(page: Page, name: string, fullPage = false) {
  if (process.env.WEB_TEST_SCREENSHOTS === 'true')
    await page.screenshot({
      path: `docs/status/assets/p6b-1/${name}.png`,
      fullPage,
    });
}
function noWrites() {
  expect(
    calls.filter(
      (c) => c.startsWith('POST') && !c.endsWith('/schedule/evaluate'),
    ),
  ).toEqual([]);
  expect(
    calls.some((c) =>
      /query|preview|adopt|refresh|execution-triggers|execution\/events/u.test(
        c,
      ),
    ),
  ).toBe(false);
}

test('integrated authoring and Today coexist; another device version invalidates the pending read', async ({
  page,
}) => {
  await enter(page);
  await expect(page.locator('[data-action=add-arrangement]')).toBeVisible();
  await capture(page, 'mobile-authoring-and-today');
  holdEvidence = true;
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect.poll(() => !!releaseEvidence).toBe(true);
  await page.evaluate(
    async ({ id, version, day }) => {
      const response = await fetch(`/api/trips/${id}/authoring`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseTripVersion: version,
          idempotencyKey: 'SYNTHETIC-other-device',
          command: {
            type: 'ADD_FREE_ACTION',
            targetDay: { type: 'EXISTING', dayOccurrenceId: day },
            position: 99,
            note: 'SYNTHETIC other device',
          },
        }),
      });
      if (!response.ok) throw new Error('SYNTHETIC authoring failed');
    },
    {
      id: tripId,
      version: fixture.trip.version,
      day: fixture.trip.days[0]!.dayOccurrenceId,
    },
  );
  holdEvidence = false;
  releaseEvidence!();
  await expect(page.locator('.in-trip')).toHaveCount(0);
  await expect(page.getByText('行程或方案已变化')).toBeVisible();
  await enter(page);
  await expect(page.locator('.next-leg .segment-service')).toContainText('BUS');
  expect(authoringBodies).toHaveLength(1);
});

test('integrated in-trip read failure preserves an authoring draft and its unknown-outcome retry key', async ({
  page,
}) => {
  await enter(page);
  await page.locator('[data-action=add-arrangement]').click();
  await page.getByRole('button', { name: '自由行动', exact: true }).click();
  const title = page.locator('#authoring-add input[name=title]');
  await title.fill('SYNTHETIC retained authoring draft');
  inTripUnavailable = true;
  expect(
    await page.evaluate(
      async (id) => (await fetch(`/api/trips/${id}/in-trip`)).status,
      tripId,
    ),
  ).toBe(503);
  await expect(title).toHaveValue('SYNTHETIC retained authoring draft');
  await expect(page.locator('#save-status')).toContainText('未保存');
  page.once('dialog', (d) => d.dismiss());
  await page
    .locator('.view-switch [data-view=itinerary]')
    .evaluate((b: HTMLButtonElement) => b.click());
  await expect(title).toHaveValue('SYNTHETIC retained authoring draft');
  expect(authoringBodies).toHaveLength(0);
  authoringNetworkFailure = true;
  const initialVersion = fixture.trip.version;
  await page.getByRole('button', { name: '添加自由行动', exact: true }).click();
  await expect(page.locator('#authoring-recovery')).toBeVisible();
  await expect(title).toHaveValue('SYNTHETIC retained authoring draft');
  await page
    .getByRole('button', { name: '重新读取并核对', exact: true })
    .click();
  await expect(page.locator('[data-authoring-ack]')).toBeVisible();
  expect(authoringBodies).toHaveLength(2);
  expect(authoringBodies[0]).toEqual(authoringBodies[1]);
  expect(authoringBodies[1]?.baseTripVersion).toBe(initialVersion);
  await expect(title).toHaveValue('SYNTHETIC retained authoring draft');
  await expect(page.locator('.in-trip')).toBeVisible();
  await expect(page.locator('.next-leg .segment-service')).toContainText('BUS');
  await page.locator('[data-authoring-ack]').click();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.locator('.view-switch [data-view=itinerary]').click();
  await page.locator('[data-node]').first().click();
  await expect(page.locator('#note-edit')).toBeVisible();
});

test('future place, unknown progress, reliable navigation and original detail', async ({
  page,
}) => {
  const trip = fixtureTrip();
  fixture = {
    ...fixture,
    trip,
    evidence: { ...fixture.evidence, tripVersion: trip.version },
    ground: { ...fixture.ground, legs: [] },
  };
  await page.clock.setSystemTime(new Date('2030-10-01T03:00:00Z'));
  await enter(page);
  await expect(page.locator('.next-step h2')).toContainText('SYNTHETIC');
  await expect(page.locator('.progress-status')).toContainText('当前进度未知');
  await expect(page.getByText('暂时无法确定建议出发时间')).toBeVisible();
  expect(
    await page.getByRole('link', { name: '导航到这里' }).getAttribute('href'),
  ).toContain('destination=35.6812%2C139.7671');
  await capture(page, 'mobile-today');
  await capture(page, 'mobile-place', true);
  await page.getByRole('button', { name: '查看完整详情', exact: true }).click();
  await expect(page.locator('#note-edit')).toBeVisible();
  noWrites();
});

test('next selected bus, collapsed transfer, sequence, boarding links and detail reachability', async ({
  page,
}) => {
  await enter(page);
  await expect(page.locator('.next-leg .segment-service')).toContainText('BUS');
  await expect(page.locator('.transfer-details')).not.toHaveAttribute(
    'open',
    '',
  );
  const link = page
    .locator('.next-leg')
    .getByRole('link', { name: '步行到上车点' });
  expect(await link.getAttribute('href')).toContain('travelmode=walking');
  expect(await link.getAttribute('href')).toContain(
    'destination=35.7138%2C139.7773',
  );
  await capture(page, 'mobile-transport');
  await page.locator('.transfer-details > summary').click();
  expect(
    await page.locator('.transfer-details .segment-mode').allTextContents(),
  ).toEqual(['步行', '公交', '铁路', '步行']);
  await capture(page, 'mobile-transfer', true);
  await page.getByRole('button', { name: '查看整段路线' }).click();
  await expect(page.getByRole('button', { name: '搜索路线' })).toBeVisible();
  noWrites();
});

for (const layer of ['ESTIMATED', 'ACTUAL'] as const) {
  test(`Provider ${layer} keeps plan secondary and cannot assert user departure`, async ({
    page,
  }) => {
    fixture = inTripFixture(layer);
    await enter(page);
    await expect(page.locator('.next-leg .clock-end').first()).toContainText(
      layer === 'ESTIMATED' ? '预计' : '车辆实测',
    );
    await expect(page.locator('.next-leg .clock-end').first()).toContainText(
      '14:20',
    );
    await expect(page.locator('.next-leg .original-plan')).toContainText(
      '14:15',
    );
    await expect(page.locator('.progress-status')).toContainText(
      '当前进度未知',
    );
    if (layer === 'ACTUAL')
      await expect(page.locator('.next-leg .vehicle-note')).toContainText(
        '不表示你本人',
      );
    await capture(
      page,
      layer === 'ESTIMATED' ? 'mobile-estimated' : 'mobile-vehicle-actual',
    );
    noWrites();
  });
}

test('Provider unavailable and stale estimates leave other trip content visible', async ({
  page,
}) => {
  fixture = inTripFixture('ESTIMATED');
  groundUnavailable = true;
  await enter(page);
  await expect(page.locator('.realtime-status')).toContainText(
    '实时状态暂不可用',
  );
  await expect(page.locator('.next-leg .clock-end').first()).toContainText(
    '计划',
  );
  await expect(page.locator('.next-leg .clock-end').first()).toContainText(
    '14:15',
  );
  await expect(page.locator('.following')).toBeVisible();
  await capture(page, 'mobile-unavailable');
  groundUnavailable = false;
  fixture.ground = {
    ...fixture.ground,
    legs: fixture.ground.legs.map((l) => ({
      ...l,
      safety: {
        ...l.safety,
        boarding: { ...l.safety.boarding, realtimeFreshness: 'STALE' },
      },
    })),
  };
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.realtime-status')).toContainText('更新已过期');
  noWrites();
});

test('missing boarding coordinates and contradictory provenance never invent a navigation target', async ({
  page,
}) => {
  fixture.trip = {
    ...fixture.trip,
    savedRoutes: fixture.trip.savedRoutes!.map((r) => ({
      ...r,
      legs: r.legs.map((l, i) =>
        i === 1
          ? { ...l, from: { ...l.from, latitude: null, longitude: null } }
          : l,
      ),
    })),
  };
  await enter(page);
  await expect(
    page.locator('.next-leg').getByRole('link', { name: '步行到上车点' }),
  ).toHaveCount(0);
  await expect(page.locator('.next-leg')).toContainText('暂无可靠导航目标');
  fixture.trip = {
    ...fixture.trip,
    savedRoutes: fixture.trip.savedRoutes!.map((r) => ({
      ...r,
      legTransportEdges: [],
    })),
  };
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.next-step')).toContainText('上/下车地点未保存');
  await expect(
    page.locator('.next-step .segment-navigation:visible'),
  ).toHaveCount(0);
  noWrites();
});

test('version mismatch refuses mixed Trip data; missing read projection stays unknown', async ({
  page,
}) => {
  fixture.evidence = {
    ...fixture.evidence,
    tripVersion: 20,
    execution: {
      state: 'AT_NODE',
      currentNodeId: fixture.trip.days[0]!.nodes[0]!.id,
      targetNodeId: null,
      recordedAt: '2030-10-01T04:00:00Z',
    },
  };
  delayEvidence = true;
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await expect(page.getByText('行程或方案已变化')).toBeVisible();
  await expect(page.locator('.in-trip')).toHaveCount(0);
  fixture.evidence = { ...fixture.evidence, tripVersion: fixture.trip.version };
  inTripUnavailable = true;
  await enter(page);
  await expect(page.getByText('执行记录与航班资料暂不可用')).toBeVisible();
  inTripUnavailable = true;
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.progress-status')).toContainText('当前进度未知');
  noWrites();
});

test('denied evidence cannot leave another owner’s Trip on screen', async ({
  page,
}) => {
  evidenceForbidden = true;
  await page.goto('/');
  await page.locator('[data-trip]').click();
  await page.locator('[data-view=today]').click();
  await expect(page.getByText('没有访问这份旅行的权限。')).toBeVisible();
  await expect(page.locator('.in-trip, .timeline')).toHaveCount(0);
  await expect(page.locator('a[href*="maps"]')).toHaveCount(0);
  noWrites();
});

test('manual walking keeps a trusted destination without inventing boarding', async ({
  page,
}) => {
  fixture.trip = {
    ...fixture.trip,
    savedRoutes: [],
    connections: fixture.trip.connections.map((c, i) =>
      i === 1 ? { ...c, transport: { ...c.transport!, mode: 'WALKING' } } : c,
    ),
  };
  await enter(page);
  const target = page
    .locator('.next-step')
    .getByRole('link', { name: '步行到分段终点' });
  expect(await target.getAttribute('href')).toContain(
    'destination=35.7138%2C139.7773',
  );
  expect(await target.getAttribute('href')).toContain('travelmode=walking');
  noWrites();
});

test('320px enlarged long place and free action keep unknown address, position and time honest', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.clock.setSystemTime(new Date('2030-10-01T03:00:00Z'));
  const t = fixtureTrip();
  fixture.trip = {
    ...t,
    days: t.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n, i) =>
        i === 0 && n.place
          ? {
              ...n,
              place: {
                ...n.place,
                name: 'SYNTHETIC 很长的旅行地点名称与抵达区域说明'.repeat(3),
                address: null,
                latitude: NaN,
                longitude: NaN,
              },
            }
          : n,
      ),
    })),
  };
  fixture.evidence = { ...fixture.evidence, tripVersion: fixture.trip.version };
  await enter(page);
  await page.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  await expect(page.locator('.next-step')).toContainText('地址待定');
  await expect(page.locator('.next-step a[href*="maps"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, 'mobile-place-long-enlarged', true);
  fixture.trip = {
    ...fixture.trip,
    days: fixture.trip.days.map((d) => ({
      ...d,
      nodes: d.nodes.map((n, i) =>
        i === 0
          ? {
              ...n,
              kind: 'FREE_ACTION',
              place: null,
              note: 'SYNTHETIC 自由探索，时间尚未确定',
              timeValues: [],
              timeIntents: [],
            }
          : n,
      ),
    })),
  };
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.next-step')).toContainText('自由行动 · 地点待定');
  await expect(page.locator('.next-step .action-time')).toContainText(
    '时间待定',
  );
  await page.locator('.next-step > button').scrollIntoViewIfNeeded();
  await expect(page.locator('.next-step > button')).toBeInViewport();
  noWrites();
});

test('unchanged estimated instant does not add a duplicate original plan', async ({
  page,
}) => {
  fixture = inTripFixture('ESTIMATED');
  fixture.trip = {
    ...fixture.trip,
    connections: fixture.trip.connections.map((c) => ({
      ...c,
      transport: {
        ...c.transport!,
        timeValues: c.transport!.timeValues.map((v) =>
          v.layer === 'ESTIMATED'
            ? {
                ...v,
                instant: new Date(
                  Date.parse(v.instant) - 5 * 60000,
                ).toISOString(),
              }
            : v,
        ),
      },
    })),
  };
  await enter(page);
  await expect(page.locator('.next-leg .clock-end').first()).toContainText(
    '预计',
  );
  await expect(page.locator('.next-leg .original-plan')).toHaveCount(0);
  noWrites();
});

test('core outage and actual offline conceal current trip and navigation until a fresh read', async ({
  page,
  context,
}) => {
  await enter(page);
  coreUnavailable = true;
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.in-trip')).toHaveCount(0);
  await expect(page.getByText('核心服务暂时不可用')).toBeVisible();
  await expect(page.locator('a[href*="maps"]')).toHaveCount(0);
  coreUnavailable = false;
  await enter(page);
  await context.setOffline(true);
  await expect(page.locator('.in-trip')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.locator('.in-trip')).toHaveCount(0);
  noWrites();
});

function flightFixture(): InTripView['flights'][number] {
  const movement: FlightMovementView = {
    airportName: 'SYNTHETIC Airport',
    airportIata: 'SYN',
    airportIcao: null,
    timeZone: 'Asia/Tokyo',
    scheduledLocal: null,
    scheduledUtc: '2030-10-01T05:15:00Z',
    revisedLocal: null,
    revisedUtc: '2030-10-01T05:35:00Z',
    predictedLocal: null,
    predictedUtc: '2030-10-01T05:40:00Z',
    runwayLocal: null,
    runwayUtc: null,
    terminal: 'SYNTHETIC T2',
    gate: 'SYNTHETIC G8',
    checkInDesk: null,
    baggageBelt: 'SYNTHETIC B3',
  };
  const snapshot: FlightSnapshotView = {
    provider: 'aerodatabox',
    candidateId: 'SYNTHETIC-FLIGHT',
    canonicalFlightNumber: 'SY123',
    displayFlightNumber: 'SY123 · SYNTHETIC',
    serviceDate: '2030-10-01',
    status: 'SCHEDULED',
    rawStatus: null,
    airline: { name: 'SYNTHETIC Airline', iata: null, icao: null },
    departure: movement,
    arrival: {
      ...movement,
      scheduledUtc: '2030-10-01T07:00:00Z',
      revisedUtc: '2030-10-01T07:20:00Z',
    },
    aircraft: {
      model: 'SYNTHETIC Aircraft',
      registration: null,
      icao24: null,
      callSign: null,
    },
    departureDelayMinutes: null,
    arrivalDelayMinutes: null,
    departureDelayBasis: null,
    arrivalDelayBasis: null,
    fetchedAt: '2030-10-01T05:10:00Z',
  };
  return {
    transportEdgeId: 'edge-1',
    selectedSnapshot: snapshot,
    latestSnapshot: snapshot,
    providerUnavailable: false,
  };
}
function tripWithFlight(
  flight: InTripView['flights'][number],
  protectedDeparture: string | null = null,
): TripView {
  const trip = fixtureTrip();
  const from = trip.days[0]!.nodes[0]!;
  const to = trip.days[0]!.nodes[1]!;
  const edge = inTripFixture().trip.connections[1]!.transport!;
  const values = (['DEPARTURE', 'ARRIVAL'] as const).flatMap((pointKind) => {
    const m =
      pointKind === 'DEPARTURE'
        ? flight.latestSnapshot.departure
        : flight.latestSnapshot.arrival;
    const actual =
      pointKind === 'DEPARTURE'
        ? (protectedDeparture ?? m.runwayUtc)
        : m.runwayUtc;
    return (
      [
        ['PLANNED', m.scheduledUtc],
        ['ESTIMATED', m.revisedUtc],
        ['ACTUAL', actual],
      ] as const
    ).flatMap(([layer, instant]) =>
      instant
        ? [
            {
              ...edge.timeValues[0]!,
              id: `SYNTHETIC-FLIGHT-${pointKind}-${layer}`,
              pointKind,
              layer,
              instant,
              sourceKind:
                layer === 'PLANNED'
                  ? ('ADOPTED_TRANSPORT_FACT' as const)
                  : ('PROVIDER_OBSERVATION' as const),
              observedAt:
                layer === 'PLANNED' ? null : flight.latestSnapshot.fetchedAt,
            },
          ]
        : [],
    );
  });
  return {
    ...trip,
    savedRoutes: [],
    connections: [
      {
        fromNodeId: from.id,
        toNodeId: to.id,
        state: 'ACTIVE',
        transport: {
          ...edge,
          id: flight.transportEdgeId,
          fromNodeId: from.id,
          toNodeId: to.id,
          mode: 'FLIGHT',
          serviceLabel: flight.latestSnapshot.displayFlightNumber,
          source: 'MANUAL',
          adoptedRouteId: null,
          provider: 'aerodatabox',
          providerRef: flight.latestSnapshot.candidateId,
          timeValues: values,
        },
      },
    ],
  };
}
test('flight scheduled, revised, predicted and runway evidence remain distinct', async ({
  page,
}) => {
  const flight = flightFixture();
  fixture.evidence = { ...fixture.evidence, flights: [flight] };
  fixture.trip = tripWithFlight(flight);
  await enter(page);
  await expect(page.locator('.flight-info')).toContainText('修订 / 预计');
  await expect(page.locator('.flight-info')).toContainText('原计划');
  await expect(page.locator('.flight-info')).toContainText('SYNTHETIC G8');
  await capture(page, 'mobile-flight', true);
  for (const kind of ['scheduled', 'predicted', 'actual'] as const) {
    const m = flight.latestSnapshot.departure;
    fixture.evidence = {
      ...fixture.evidence,
      flights: [
        {
          ...flight,
          latestSnapshot: {
            ...flight.latestSnapshot,
            departure: {
              ...m,
              revisedUtc: null,
              predictedUtc: kind === 'predicted' ? m.predictedUtc : null,
              runwayUtc: kind === 'actual' ? '2030-10-01T05:08:00Z' : null,
            },
          },
        },
      ],
    };
    fixture.trip = tripWithFlight(fixture.evidence.flights[0]!);
    await page.getByRole('button', { name: '重新载入' }).click();
    await expect(
      page.locator('.flight-info .flight-clock').first(),
    ).toContainText(
      kind === 'actual'
        ? '车辆实测 · 跑道时间'
        : kind === 'predicted'
          ? '预测 · 非实际'
          : '计划',
    );
    await expect(page.locator('.progress-status')).toContainText(
      '当前进度未知',
    );
  }
  noWrites();
});

test('flight unavailable and contradictory runway preserve authoritative actual facts', async ({
  page,
}) => {
  const flight = flightFixture();
  fixture.evidence = {
    ...fixture.evidence,
    flights: [
      {
        ...flight,
        providerUnavailable: true,
        latestSnapshot: {
          ...flight.latestSnapshot,
          departure: {
            ...flight.latestSnapshot.departure,
            runwayUtc: '2030-10-01T05:10:00Z',
          },
        },
      },
    ],
  };
  fixture.trip = tripWithFlight(
    fixture.evidence.flights[0]!,
    '2030-10-01T05:08:00Z',
  );
  await enter(page);
  await expect(page.locator('.flight-info')).toContainText('实时状态暂不可用');
  await expect(
    page.locator('.flight-info .flight-clock').first(),
  ).toContainText('14:08');
  await expect(page.locator('.flight-info')).toContainText(
    '与已保护车辆事实不一致',
  );
  await expect(page.locator('.progress-status')).toContainText('当前进度未知');
  const unavailable = { ...flight, providerUnavailable: true };
  fixture.evidence = { ...fixture.evidence, flights: [unavailable] };
  fixture.trip = tripWithFlight(unavailable);
  await page.getByRole('button', { name: '重新载入' }).click();
  await expect(page.locator('.next-step .realtime-status')).toContainText(
    '实时状态暂不可用',
  );
  await expect(
    page.locator('.next-step > .current-transport-times'),
  ).toContainText('计划');
  await expect(
    page.locator('.next-step > .current-transport-times'),
  ).not.toContainText('预计');
  noWrites();
});

for (const width of [320, 375, 390, 430, 1440]) {
  test(`mobile-first ${width}px long text, enlarged text, safe-area and scroll reachability`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    fixture = inTripFixture('ESTIMATED');
    await enter(page);
    await expect(page.locator('.next-step')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await capture(page, width === 1440 ? 'desktop' : `mobile-${width}`);
    await page.addStyleTag({
      content: ':root { font-size: 24px !important; }',
    });
    await page.locator('.transfer-details > summary').click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator('.in-trip > button').scrollIntoViewIfNeeded();
    await expect(page.locator('.in-trip > button')).toBeInViewport();
    if (width === 320) await capture(page, 'mobile-enlarged', true);
    await page.locator('.in-trip > button').click();
    await expect(page.locator('.timeline')).toBeVisible();
    noWrites();
  });
}
