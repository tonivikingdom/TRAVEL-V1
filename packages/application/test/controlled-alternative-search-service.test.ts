import { describe, expect, it, vi } from 'vitest';
import {
  ControlledAlternativeSearchService,
  handoffPlanningIdentity,
} from '../src/controlled-alternative-search-service.js';
import type { GroundTransitRouteReevaluationHandoffView } from '@travel/contracts';
const actor = {
  userId: 'owner',
  email: 'synthetic@example.test',
  role: 'USER',
  status: 'ACTIVE',
} as const;
function handoff(): GroundTransitRouteReevaluationHandoffView {
  return {
    tripId: 'trip',
    sourceTransportEdgeId: 'edge',
    adoptedRouteId: 'route',
    readiness: 'READY',
    originBasis: 'PLANNED_ROUTE_ORIGIN',
    reasonCodes: ['DISRUPTION'],
    query: {
      basisVersion: 3,
      fromNodeId: 'from',
      toNodeId: 'to',
      hint: {
        type: 'DEPART_AT',
        instant: '2030-10-01T04:00:00Z',
        timeZone: 'Asia/Tokyo',
      },
    },
  };
}
function setup(current = handoff()) {
  const reevaluation = { getHandoff: vi.fn().mockResolvedValue(current) };
  const routes = {
    queryRoutes: vi.fn().mockResolvedValue({ candidates: [] }),
    queryExternalOriginRoutes: vi.fn().mockResolvedValue({ candidates: [] }),
  };
  return {
    reevaluation,
    routes,
    service: new ControlledAlternativeSearchService(reevaluation, routes),
  };
}
describe('controlled alternative search orchestration', () => {
  it('uses the revalidated server handoff time and calls only the node query', async () => {
    const old = handoff(),
      fresh = handoff();
    const current = {
      ...fresh,
      query: {
        ...fresh.query!,
        hint: {
          type: 'DEPART_AT' as const,
          instant: '2030-10-01T04:01:00Z',
          timeZone: 'Asia/Tokyo',
        },
      },
    };
    const s = setup(current);
    await s.service.search(actor, 'trip', { handoff: old });
    expect(s.routes.queryRoutes).toHaveBeenCalledExactlyOnceWith(
      actor,
      'trip',
      current.query,
    );
    expect(s.routes.queryExternalOriginRoutes).not.toHaveBeenCalled();
    expect(s.reevaluation.getHandoff).toHaveBeenCalledTimes(2);
  });
  it('dispatches the existing external-origin contract without invented locations', async () => {
    const h = {
      ...handoff(),
      originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN' as const,
      query: null,
      externalQuery: { externalOriginId: 'E', basisVersion: 3, toNodeId: 'D' },
    };
    const s = setup(h);
    await s.service.search(actor, 'trip', { handoff: h });
    expect(s.routes.queryExternalOriginRoutes).toHaveBeenCalledExactlyOnceWith(
      actor,
      'trip',
      'E',
      h.externalQuery,
    );
    expect(s.routes.queryRoutes).not.toHaveBeenCalled();
  });
  for (const readiness of ['NOT_REQUIRED', 'ORIGIN_UNRESOLVED'] as const)
    it(`${readiness} rejects before query`, async () => {
      const s = setup({ ...handoff(), readiness, query: null });
      await expect(
        s.service.search(actor, 'trip', { handoff: handoff() }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(s.routes.queryRoutes).not.toHaveBeenCalled();
    });
  for (const change of [
    'version',
    'origin',
    'destination',
    'edge',
    'route',
    'zone',
    'basis',
    'reason',
  ] as const)
    it(`rejects changed ${change} before provider`, async () => {
      const original = handoff();
      const h = {
        ...original,
        sourceTransportEdgeId:
          change === 'edge' ? 'other' : original.sourceTransportEdgeId,
        adoptedRouteId: change === 'route' ? 'other' : original.adoptedRouteId,
        originBasis:
          change === 'basis'
            ? ('CONFIRMED_EXECUTION_NODE' as const)
            : (original.originBasis ?? null),
        reasonCodes: change === 'reason' ? ['RECOVERY'] : original.reasonCodes,
        query: {
          ...original.query!,
          basisVersion: change === 'version' ? 4 : 3,
          fromNodeId: change === 'origin' ? 'other' : 'from',
          toNodeId: change === 'destination' ? 'other' : 'to',
          hint: {
            type: 'DEPART_AT' as const,
            instant: '2030-10-01T04:00:00Z',
            timeZone: change === 'zone' ? 'UTC' : 'Asia/Tokyo',
          },
        },
      };
      const s = setup(h);
      await expect(
        s.service.search(actor, 'trip', { handoff: handoff() }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(s.routes.queryRoutes).not.toHaveBeenCalled();
    });
  it('fences changed authorization after provider return', async () => {
    const s = setup();
    s.reevaluation.getHandoff
      .mockResolvedValueOnce(handoff())
      .mockResolvedValueOnce({
        ...handoff(),
        readiness: 'NOT_REQUIRED',
        query: null,
      });
    await expect(
      s.service.search(actor, 'trip', { handoff: handoff() }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('does not turn provider failure into empty candidates', async () => {
    const s = setup();
    const error = { code: 'PROVIDER_UNAVAILABLE' };
    s.routes.queryRoutes.mockRejectedValue(error);
    await expect(
      s.service.search(actor, 'trip', { handoff: handoff() }),
    ).rejects.toBe(error);
  });
  it('rejects changed observation/evidence read basis even at unchanged Trip version', async () => {
    const s = setup({ ...handoff(), planningFactsHash: 'new' });
    await expect(
      s.service.search(actor, 'trip', {
        handoff: { ...handoff(), planningFactsHash: 'old' },
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(s.routes.queryRoutes).not.toHaveBeenCalled();
  });
  it('rejects ambiguous dual origin and malformed version', () => {
    expect(
      handoffPlanningIdentity({
        ...handoff(),
        externalQuery: {
          externalOriginId: 'E',
          basisVersion: 3,
          toNodeId: 'D',
        },
      }),
    ).toBeNull();
    expect(
      handoffPlanningIdentity({
        ...handoff(),
        query: { basisVersion: NaN, fromNodeId: 'A', toNodeId: 'D' },
      }),
    ).toBeNull();
  });
});

import { hashRoutePlanningReadBasis } from '../src/route-snapshot.js';
it('read-basis hash canonicalizes field order and Date values', () => {
  expect(
    hashRoutePlanningReadBasis({
      at: new Date('2030-10-01T00:00:00Z'),
      state: 'READY',
    }),
  ).toBe(
    hashRoutePlanningReadBasis({
      state: 'READY',
      at: '2030-10-01T00:00:00.000Z',
    }),
  );
  expect(
    hashRoutePlanningReadBasis({ at: new Date('2030-10-01T00:00:00Z') }),
  ).not.toBe(
    hashRoutePlanningReadBasis({ at: new Date('2030-10-01T00:01:00Z') }),
  );
});
