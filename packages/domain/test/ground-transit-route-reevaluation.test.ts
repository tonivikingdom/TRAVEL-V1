import { describe, expect, it } from 'vitest';

import { resolveGroundTransitRouteReevaluationHandoff } from '../src/ground-transit-route-reevaluation.js';

const now = new Date('2030-10-01T09:50:00.000Z');
const base = {
  requiredAction: 'ROUTE_REEVALUATION_REQUIRED' as const,
  routeCurrent: true,
  operationalKnown: true,
  corridorResolved: true,
  legExecutionState: 'PENDING' as const,
  independentExecutionProgress: false,
  basisVersion: 42,
  fromNodeId: 'from',
  toNodeId: 'to',
  timeZone: 'Asia/Tokyo',
  now,
};

describe('Ground Transit route re-evaluation handoff', () => {
  it('does not hand off a recovered or no-longer-current route', () => {
    expect(
      resolveGroundTransitRouteReevaluationHandoff({
        ...base,
        requiredAction: 'NONE',
      }).readiness,
    ).toBe('NOT_REQUIRED');
    expect(
      resolveGroundTransitRouteReevaluationHandoff({
        ...base,
        routeCurrent: false,
      }).query,
    ).toBeNull();
  });

  it('prepares the current full route corridor and DEPART_AT now before execution', () => {
    const decision = resolveGroundTransitRouteReevaluationHandoff(base);
    expect(decision.readiness).toBe('READY');
    expect(decision.originBasis).toBe('PLANNED_ROUTE_ORIGIN');
    expect(decision.query).toEqual({
      basisVersion: 42,
      fromNodeId: 'from',
      toNodeId: 'to',
      hint: { type: 'DEPART_AT', instant: now, timeZone: 'Asia/Tokyo' },
    });
  });

  it('uses a confirmed internal origin despite independent progress', () => {
    expect(
      resolveGroundTransitRouteReevaluationHandoff({
        ...base,
        independentExecutionProgress: true,
        legExecutionState: 'COMPLETED',
        executionOrigin: { status: 'CONFIRMED_NODE', nodeId: 'B' },
      }),
    ).toMatchObject({
      readiness: 'READY',
      originBasis: 'CONFIRMED_EXECUTION_NODE',
      query: { fromNodeId: 'B', toNodeId: 'to' },
    });
  });

  it.each(['UNRESOLVED', 'CONFLICT'] as const)(
    'does not prepare a Query for %s origin',
    (status) => {
      expect(
        resolveGroundTransitRouteReevaluationHandoff({
          ...base,
          executionOrigin: { status },
        }),
      ).toMatchObject({
        readiness: 'ORIGIN_UNRESOLVED',
        originBasis: null,
        query: null,
      });
    },
  );

  it('allows short-turn only while the existing corridor remains queryable', () => {
    expect(resolveGroundTransitRouteReevaluationHandoff(base).readiness).toBe(
      'READY',
    );
    expect(
      resolveGroundTransitRouteReevaluationHandoff({
        ...base,
        corridorResolved: false,
      }),
    ).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      query: null,
      reasonCodes: expect.arrayContaining([
        'CURRENT_ROUTE_CORRIDOR_UNRESOLVED',
      ]),
    });
  });

  it.each(['IN_PROGRESS', 'ARRIVED_PENDING_HANDOFF', 'COMPLETED'] as const)(
    'rejects the planned origin after independent %s evidence',
    (legExecutionState) => {
      expect(
        resolveGroundTransitRouteReevaluationHandoff({
          ...base,
          legExecutionState,
        }),
      ).toMatchObject({
        readiness: 'ORIGIN_UNRESOLVED',
        query: null,
        reasonCodes: expect.arrayContaining(['EXECUTION_ALREADY_PROGRESSING']),
      });
    },
  );

  it('does not infer user progress from a vehicle ACTUAL alone', () => {
    // The policy has no vehicle time input: such a fact cannot make the origin unresolved.
    expect(resolveGroundTransitRouteReevaluationHandoff(base).readiness).toBe(
      'READY',
    );
  });

  it('refuses to invent a timezone', () => {
    expect(
      resolveGroundTransitRouteReevaluationHandoff({ ...base, timeZone: null }),
    ).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      reasonCodes: expect.arrayContaining(['QUERY_TIME_ZONE_UNRESOLVED']),
      query: null,
    });
  });

  it('does not present missing operational evidence as a recovered route', () => {
    expect(
      resolveGroundTransitRouteReevaluationHandoff({
        ...base,
        operationalKnown: false,
      }),
    ).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      reasonCodes: ['OPERATIONAL_ASSESSMENT_UNAVAILABLE'],
      query: null,
    });
  });
});
