import { mkdir } from 'node:fs/promises';
import { expect, type Page, type Route } from '@playwright/test';
import type { RoutePreviewView, TripView } from '@travel/contracts';
import {
  fixtureCandidate,
  fixtureSchedule,
  fixtureTrip,
  fromId,
  toId,
  tripId,
} from '../fixture.js';
import { liveEssentials } from '../../src/essentials.js';
import { inTripFixture } from '../in-trip-fixture.js';

export function responseGate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  return { pending, release, arrived, entered };
}
export async function browserHarness(page: Page) {
  const trip = fixtureTrip();
  const secondId = '20000000-0000-4000-8000-000000000099';
  const second: TripView = {
    ...trip,
    id: secondId,
    name: 'SYNTHETIC second Trip',
  };
  const candidate = fixtureCandidate();
  const preview: RoutePreviewView = {
    previewId: tripId,
    tripId,
    basisVersion: trip.version,
    candidateSnapshotId: candidate.candidateSnapshotId,
    candidateHash: 'SYNTHETIC',
    policyVersion: 'route-adoption-preview-v3',
    createdAt: '2030-10-01T04:00:00Z',
    expiresAt: '2030-10-01T06:00:00Z',
    adoptable: true,
    status: 'ACTIVE',
    currentConnection: {
      fromNodeId: fromId,
      toNodeId: toId,
      state: 'MISSING',
      transport: null,
    },
    candidate,
    changeSummary: {
      transportAction: 'CREATE',
      willReplaceTransportEdgeId: null,
      requiresGeneratedNodes: false,
      generatedTransferPoints: [],
      proposedSegments: [],
      temporalLayer: 'PLANNED',
      temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
    },
  };
  const backup = {
    ...liveEssentials(trip, null),
    schema: 'travel-static-backup-v1',
    id: tripId,
    tripId,
    tripVersion: trip.version,
    generatedAt: '2030-10-01T04:30:00Z',
  };
  const calls: {
    method: string;
    path: string;
    body: unknown;
    owner: string | undefined;
  }[] = [];
  const state = {
    queryError: null as { code: string; status: number } | null,
    previewError: null as { code: string; status: number } | null,
    adoptError: null as { code: string; status: number } | null,
    queryGate: null as ReturnType<typeof responseGate> | null,
    previewGate: null as ReturnType<typeof responseGate> | null,
    adoptGate: null as ReturnType<typeof responseGate> | null,
    savedPlacesGate: null as ReturnType<typeof responseGate> | null,
    placeSearchGate: null as ReturnType<typeof responseGate> | null,
    owner: tripId,
  };
  await page.addInitScript(() =>
    sessionStorage.setItem('travel.web.session', 'SYNTHETIC_P6C2_BROWSER'),
  );
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/u, '');
    calls.push({
      method: req.method(),
      path,
      body: req.postData() ? req.postDataJSON() : null,
      owner: req.headers().authorization,
    });
    const send = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    const respond = async (
      stage: 'query' | 'preview' | 'adopt',
      data: unknown,
      status = 200,
    ) => {
      const gate = state[`${stage}Gate`];
      const failure = state[`${stage}Error`];
      if (gate) {
        gate.arrived();
        await gate.pending;
      }
      return failure
        ? send(
            {
              error: {
                code: failure.code,
                message: `SYNTHETIC ${failure.code}`,
              },
            },
            failure.status,
          )
        : send(data, status);
    };
    if (path === '/me') return send({ id: state.owner });
    if (path === '/trips') {
      const gate = state.savedPlacesGate;
      if (gate) {
        gate.arrived();
        await gate.pending;
      }
      return send({ trips: [trip, second] });
    }
    if (path.endsWith('/place-search')) {
      const gate = state.placeSearchGate;
      if (gate) {
        gate.arrived();
        await gate.pending;
      }
      return send({
        expiresAt: '2035-01-01T00:00:00Z',
        candidates: [
          {
            provider: 'synthetic',
            externalId: 'SYNTHETIC_P6C2',
            name: 'SYNTHETIC searched place',
            formattedAddress: 'SYNTHETIC test address',
            coordinates: { latitude: 35.681, longitude: 139.767 },
            attribution: 'SYNTHETIC fixture',
            synthetic: true,
            selectionToken: 'SYNTHETIC_P6C2_TOKEN',
          },
        ],
      });
    }
    if (path === `/trips/${tripId}`) return send(trip);
    if (path === `/trips/${secondId}`) return send(second);
    if (path.endsWith('/schedule/evaluate'))
      return send(fixtureSchedule(path.includes(secondId) ? second : trip));
    if (path.endsWith('/routes/query'))
      return respond('query', {
        tripId,
        basisVersion: trip.version,
        fromNodeId: fromId,
        toNodeId: toId,
        timeCondition: candidate.queryTimeCondition,
        candidates: [candidate],
      });
    if (path.endsWith('/previews')) return respond('preview', preview, 201);
    if (path.endsWith('/adopt')) return respond('adopt', {});
    if (path === '/places')
      return send({ places: trip.days[0]!.nodes.map((n) => n.place) });
    if (path.endsWith('/impact'))
      return send({
        tripId: path.includes(secondId) ? secondId : tripId,
        basisVersion: trip.version,
        evaluatedAt: '2030-10-01T04:30:00Z',
        items: [],
        handoffs: [],
      });
    if (path.endsWith('/backup')) return send({ backup });
    if (path.endsWith('/in-trip')) return send(inTripFixture().evidence);
    if (path === '/auth/logout') return send({});
    return send({ error: { code: 'NOT_FOUND' } }, 404);
  });
  async function enter() {
    await page.goto('/');
    await page.locator(`[data-trip="${tripId}"]`).click();
    await expect(page.locator('.timeline')).toBeVisible();
  }
  async function open() {
    await page.locator('.connection').click();
    await expect(page.locator('#route-search')).toBeVisible();
  }
  async function query() {
    await page.getByRole('button', { name: '搜索路线', exact: true }).click();
    await expect(page.locator('.candidate')).toBeVisible();
  }
  async function prepare() {
    await query();
    await page.locator('[data-candidate]').click();
    await expect(page.locator('[data-action=adopt]')).toBeVisible();
  }
  const planning = () =>
    calls.filter((c) =>
      /\/(routes\/query|previews|adopt|undo)(\/|$)/u.test(c.path),
    );
  const formalWrites = () =>
    calls.filter(
      (c) =>
        c.method === 'POST' &&
        /\/(adopt|undo|commands|authoring|events|backup)(\/|$)/u.test(c.path),
    );
  return {
    state,
    trip,
    second,
    calls,
    enter,
    open,
    query,
    prepare,
    planning,
    formalWrites,
  };
}

export async function dragHandle(page: Page, distance = 140) {
  await page.locator('#detail').evaluate((e) => {
    e.scrollTop = 0;
  });
  const box = (await page.locator('[data-drag]').boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 8 + distance, { steps: 8 });
  await page.mouse.up();
}
export async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('#detail')
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  ).toBe(true);
}
export async function evidence(page: Page, name: string, project: string) {
  if (process.env.P6C2_SCREENSHOTS !== 'true' || project !== 'chromium') return;
  await mkdir('docs/status/assets/p6c-2-hardening', { recursive: true });
  await page.screenshot({
    path: `docs/status/assets/p6c-2-hardening/${name}.png`,
    fullPage: true,
  });
}
