import { openRouteSearch } from './helpers/replanning-acceptance.js';
import { expect, type Page } from '@playwright/test';
import type {
  RouteCandidateLegView,
  RouteCandidateView,
  RoutePreviewView,
  TripView,
} from '@travel/contracts';
// Test-runner-only dynamic import follows the existing regional fixture boundary.
// These adapters and synthetic server credentials never enter Web's production graph.
type ProviderTime = { instant: Date; timeZone: string };
type ProviderCandidate = {
  provider: string;
  departure: ProviderTime;
  arrival: ProviderTime;
  durationSeconds: number;
  legs: (Omit<RouteCandidateLegView, 'departure' | 'arrival'> & {
    departure: ProviderTime | null;
    arrival: ProviderTime | null;
  })[];
};
const { BaiduOrdinaryRouteProvider } = (await import(
  new URL(
    '../../../packages/providers/src/regional-route-adapters.ts',
    import.meta.url,
  ).href
)) as {
  BaiduOrdinaryRouteProvider: new (
    key: string,
    fetcher: typeof fetch,
    now: () => Date,
    approved: boolean,
  ) => {
    queryRoutes(
      input: unknown,
    ): Promise<{ status: string; candidates: ProviderCandidate[] }>;
  };
};
const { baiduToWgs84 } = (await import(
  new URL(
    '../../../packages/providers/src/baidu-coordinates.ts',
    import.meta.url,
  ).href
)) as {
  baiduToWgs84(
    lat: number,
    lng: number,
  ): { latitude: number; longitude: number };
};
import {
  fixtureCandidate,
  fixtureSchedule,
  fixtureTrip,
  fromId,
  toId,
  tripId,
} from './fixture.js';
import { regionalCapabilityFixture } from './regional-map-fixture.js';

export const frozen = '2026-10-08T04:00:00Z';
export const departure = '2026-10-10T10:00:00.000Z';
const raw = [
  { lat: 39.915, lng: 116.404 },
  { lat: 39.925, lng: 116.414 },
];
export async function travelHarness(
  page: Page,
  mode: 'DRIVING' | 'TRANSIT' = 'DRIVING',
  strictMode = false,
) {
  const base = fixtureTrip();
  const stamp = (
    i: number,
    pointKind: 'ARRIVAL' | 'DEPARTURE',
    instant: string,
  ) => ({
    ...base.days[0]!.nodes[0]!.timeValues[0]!,
    id: `SYNTHETIC-time-${i}-${pointKind}`,
    pointKind,
    instant,
    timeZone: 'Asia/Shanghai',
  });
  const nodes = base.days[0]!.nodes.map((n, i) => ({
    ...n,
    place: {
      ...n.place!,
      ...baiduToWgs84(raw[i]!.lat, raw[i]!.lng),
      name: `SYNTHETIC ${i === 0 ? '前一地点' : '高铁站'} · 长地点名称和地址用于旅行场景验收`,
      address:
        'SYNTHETIC 很长的测试地址，仅用于窄屏换行与滚动验收，绝非真实旅行地点'.repeat(
          4,
        ),
    },
    note: 'SYNTHETIC 用户备注。'.repeat(40),
    timeValues:
      i === 0
        ? [
            stamp(i, 'ARRIVAL', '2026-10-10T09:00:00Z'),
            stamp(i, 'DEPARTURE', departure),
          ]
        : [
            stamp(i, 'ARRIVAL', '2026-10-10T10:30:00Z'),
            stamp(i, 'DEPARTURE', '2026-10-10T11:30:00Z'),
          ],
    timeIntents:
      i === 0
        ? [
            {
              ...base.days[0]!.nodes[0]!.timeIntents[0]!,
              kind: 'POINT_TIME' as const,
              pointKind: 'DEPARTURE' as const,
              operator: 'NOT_BEFORE' as const,
              instant: departure,
              timeZone: 'Asia/Shanghai',
              durationSeconds: null,
            },
          ]
        : [],
  }));
  const c = fixtureCandidate();
  const transport = {
    id: 'SYNTHETIC-driving-edge',
    fromNodeId: fromId,
    toNodeId: toId,
    mode,
    fixedService: false,
    serviceLabel: null,
    note: null,
    source: 'MANUAL' as const,
    adoptedRouteId: null,
    provider: null,
    providerRef: null,
    createdAt: frozen,
    updatedAt: frozen,
    timeValues: [
      stamp(2, 'DEPARTURE', departure),
      stamp(2, 'ARRIVAL', '2026-10-10T10:30:00Z'),
    ],
  };
  let trip: TripView = {
    ...base,
    name: 'SYNTHETIC 10月10日18:00到高铁站',
    planningAnchorDate: '2026-10-10',
    effectiveStartDate: '2026-10-10',
    effectiveEndDate: '2026-10-10',
    days: [{ ...base.days[0]!, localDate: '2026-10-10', nodes }],
    connections: [
      { fromNodeId: fromId, toNodeId: toId, state: 'ACTIVE', transport },
    ],
  };
  // Normalize the fixture through the actual Provider adapter, not a made-up timetable.
  const provider = new BaiduOrdinaryRouteProvider(
    'SYNTHETIC_NO_REAL_KEY',
    async () =>
      new Response(
        JSON.stringify({
          status: 0,
          result: {
            origin:
              mode === 'DRIVING'
                ? raw[0]
                : { city_id: 'SYNTHETIC:city', location: raw[0] },
            destination:
              mode === 'DRIVING'
                ? raw[1]
                : { city_id: 'SYNTHETIC:city', location: raw[1] },
            routes: [{ duration: 1800 }],
          },
        }),
      ),
    () => new Date(frozen),
    true,
  );
  const result = await provider.queryRoutes({
    travelMode: mode,
    origin: { ...nodes[0]!.place!, placeId: fromId, timeZone: 'Asia/Shanghai' },
    destination: {
      ...nodes[1]!.place!,
      placeId: toId,
      timeZone: 'Asia/Shanghai',
    },
    earliestDeparture: new Date(departure),
    latestArrival: null,
    preference: {
      type: 'DEPART_AT',
      instant: new Date(departure),
      timeZone: 'Asia/Shanghai',
    },
  });
  if (result.status !== 'SUCCESS')
    throw new Error('SYNTHETIC fixture normalization failed');
  const normalized = result.candidates[0]!;
  const tp = (p: typeof normalized.departure) => ({
    instant: p.instant.toISOString(),
    timeZone: p.timeZone,
  });
  const candidate: RouteCandidateView = {
    ...c,
    provider: normalized.provider,
    observedAt: frozen,
    snapshotExpiresAt: '2026-10-08T04:15:00Z',
    overall: {
      departure: tp(normalized.departure),
      arrival: tp(normalized.arrival),
      durationSeconds: normalized.durationSeconds,
    },
    fare: null,
    legs: normalized.legs.map((l) => ({
      ...l,
      departure: l.departure ? tp(l.departure) : null,
      arrival: l.arrival ? tp(l.arrival) : null,
    })),
    queryTimeCondition: {
      ...c.queryTimeCondition,
      hardEarliestDeparture: departure,
      earliestDeparture: departure,
      preference: {
        type: 'DEPART_AT',
        instant: departure,
        timeZone: 'Asia/Shanghai',
      },
      hint: {
        type: 'DEPART_AT',
        instant: departure,
        timeZone: 'Asia/Shanghai',
      },
    },
  };
  const calls: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }[] = [];
  const state = {
    failure: false,
    staleCandidate: false,
    fixedBus: false,
    confirmedOrigin: false,
    previewAvailable: false,
  };
  let latestCandidate = candidate;
  await page.clock.setFixedTime(new Date(frozen));
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_TRAVEL_SCENARIO'),
  );
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      return route.abort('blockedbyclient');
    return route.continue();
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, '');
    const body = req.postData()
      ? (req.postDataJSON() as Record<string, unknown>)
      : null;
    calls.push({ method: req.method(), path, body });
    const send = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    if (path === '/me') return send({ id: 'SYNTHETIC_OWNER' });
    if (path === '/trips') return send({ trips: [trip] });
    if (path === `/trips/${tripId}`) return send(trip);
    if (path.endsWith('/schedule/evaluate')) return send(fixtureSchedule(trip));
    if (path.endsWith('/in-trip'))
      return send({
        tripId,
        tripVersion: trip.version,
        execution: {
          state: state.confirmedOrigin ? 'AT_NODE' : 'NOT_STARTED',
          currentNodeId: state.confirmedOrigin ? fromId : null,
          targetNodeId: state.confirmedOrigin ? null : fromId,
          recordedAt: state.confirmedOrigin ? '2026-10-10T09:59:00Z' : null,
        },
        flights: [],
      });
    if (path.endsWith('/execution/ground-transit'))
      return send({ tripId, tripVersion: trip.version, legs: [] });
    if (path.endsWith('/impact'))
      return send({
        tripId,
        basisVersion: trip.version,
        evaluatedAt: await page.evaluate(() => new Date().toISOString()),
        handoffs: [],
        items: state.failure
          ? [
              {
                nodeId: toId,
                transportEdgeId: transport.id,
                status: 'VIOLATED',
                changed: true,
                title: 'SYNTHETIC 后续交通衔接冲突',
                explanation: 'SYNTHETIC 预计到达晚于下一班交通，原安排仍保留。',
              },
            ]
          : [],
      });
    if (path.endsWith('/provider-capability'))
      return send(regionalCapabilityFixture(trip, path));
    if (path === '/places') return send({ places: nodes.map((n) => n.place) });
    if (path.endsWith('/routes/query')) {
      if (strictMode && body?.travelMode !== mode)
        return send(
          {
            error: {
              code: 'ROUTE_QUERY_UNSUPPORTED',
              message:
                'SYNTHETIC RegionalRouteProvider rejects missing travelMode',
            },
          },
          422,
        );
      const value = state.staleCandidate
        ? {
            ...candidate,
            overall: {
              ...candidate.overall,
              departure: {
                ...candidate.overall.departure,
                instant: '2026-10-10T09:55:00Z',
              },
            },
          }
        : state.fixedBus
          ? {
              ...candidate,
              provider: 'SYNTHETIC',
              legs: candidate.legs.map((l) => ({
                ...l,
                mode: 'BUS' as const,
                fixedService: true,
                serviceLabel: 'SYNTHETIC 18:00 fixed bus',
              })),
            }
          : candidate;
      const observedAt = await page.evaluate(() => new Date().toISOString());
      const freshValue = {
        ...value,
        observedAt,
        snapshotExpiresAt: new Date(
          new Date(observedAt).getTime() + 15 * 60_000,
        ).toISOString(),
      };
      latestCandidate = freshValue;
      return send({
        tripId,
        basisVersion: trip.version,
        fromNodeId: fromId,
        toNodeId: toId,
        timeCondition: value.queryTimeCondition,
        candidates: [freshValue],
      });
    }
    if (path.endsWith('/previews') && state.previewAvailable) {
      const createdAt = await page.evaluate(() => new Date().toISOString());
      const currentConnection = trip.connections[0];
      if (!currentConnection || currentConnection.state !== 'ACTIVE')
        throw new Error(
          'SYNTHETIC saved Preview requires an active connection',
        );
      const view: RoutePreviewView = {
        previewId: 'SYNTHETIC-preview',
        tripId,
        basisVersion: trip.version,
        candidateSnapshotId: latestCandidate.candidateSnapshotId,
        candidateHash: 'SYNTHETIC-hash',
        policyVersion: 'route-adoption-preview-v3',
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 600_000).toISOString(),
        adoptable: true,
        status: 'ACTIVE',
        currentConnection: {
          ...currentConnection,
          state: currentConnection.state,
        },
        candidate: latestCandidate,
        changeSummary: {
          transportAction: 'REPLACE',
          willReplaceTransportEdgeId: trip.connections[0]!.transport!.id,
          requiresGeneratedNodes: false,
          generatedTransferPoints: [],
          proposedSegments: latestCandidate.legs.map((leg, legIndex) => ({
            ...leg,
            legIndex,
            fromRef: 'FROM_NODE',
            toRef: 'TO_NODE',
          })),
          temporalLayer: 'PLANNED',
          temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
        },
      };
      return send(view, 201);
    }
    if (path.endsWith('/previews'))
      return send(
        {
          error: {
            code: 'PREVIEW_STALE',
            message: 'SYNTHETIC no implicit adoption',
          },
        },
        409,
      );
    if (path.endsWith('/backup')) return send({ backup: null });
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
  async function enter() {
    await page.goto('/');
    await page.locator(`[data-trip="${tripId}"]`).tap();
    await expect(page.locator('.timeline')).toBeVisible();
  }
  async function open() {
    await page.locator('.connection').tap();
    await openRouteSearch(page);
    await expect(page.locator('#route-search')).toBeVisible();
  }
  const queries = () => calls.filter((c) => c.path.endsWith('/routes/query'));
  const writes = () =>
    calls.filter(
      (c) =>
        c.method === 'POST' &&
        /\/(adopt|undo|authoring|commands|events|temporal-values|backup)(\/|$)/.test(
          c.path,
        ),
    );
  return {
    get trip() {
      return trip;
    },
    candidate,
    calls,
    state,
    enter,
    open,
    queries,
    writes,
    setTrip(value: TripView) {
      trip = value;
    },
  };
}
