import { describe, expect, it } from 'vitest';
import { resolveGroundTransitRouteReevaluationHandoff } from '@travel/domain';

import { resolveRouteOriginTimeZone } from '../src/ground-transit-route-reevaluation-service.js';
import type {
  ItineraryNodeRecord,
  TemporalValueRecord,
  TransportEdgeRecord,
} from '../src/trip-ports.js';

const originId = 'origin';
const downstreamId = 'transfer';

function value(
  timeZone: string,
  pointKind: TemporalValueRecord['pointKind'] = 'DEPARTURE',
): TemporalValueRecord {
  const instant = new Date('2030-10-01T10:00:00Z');
  return {
    id: 'value',
    layer: 'PLANNED',
    pointKind,
    instant,
    timeZone,
    sourceKind: 'USER_VALUE',
    sourceRef: null,
    observedAt: null,
    createdAt: instant,
    updatedAt: instant,
  };
}

function edge(
  fromNodeId: string,
  timeZone: string | null,
): Pick<TransportEdgeRecord, 'fromNodeId' | 'timeValues'> {
  return {
    fromNodeId,
    timeValues: timeZone === null ? [] : [value(timeZone)],
  };
}

function node(
  id: string,
  timeZone: string | null,
): Pick<ItineraryNodeRecord, 'id' | 'timeValues' | 'timeIntents'> {
  return {
    id,
    timeValues: timeZone === null ? [] : [value(timeZone, 'ARRIVAL')],
    timeIntents: [],
  };
}

function handoffFor(timeZone: string | null) {
  return resolveGroundTransitRouteReevaluationHandoff({
    requiredAction: 'ROUTE_REEVALUATION_REQUIRED',
    routeCurrent: true,
    operationalKnown: true,
    corridorResolved: true,
    legExecutionState: 'PENDING',
    independentExecutionProgress: false,
    basisVersion: 42,
    fromNodeId: originId,
    toNodeId: 'destination',
    timeZone,
    now: new Date('2030-10-01T09:50:00Z'),
  });
}

describe('route re-evaluation origin timezone evidence', () => {
  it('uses the Tokyo origin node rather than a Seoul downstream edge', () => {
    const timeZone = resolveRouteOriginTimeZone(
      originId,
      [edge(originId, null), edge(downstreamId, 'Asia/Seoul')],
      [node(originId, 'Asia/Tokyo'), node(downstreamId, null)],
    );
    expect(handoffFor(timeZone)).toMatchObject({
      readiness: 'READY',
      query: { hint: { timeZone: 'Asia/Tokyo' } },
    });
  });

  it('refuses a downstream timezone when the origin has no evidence', () => {
    const timeZone = resolveRouteOriginTimeZone(
      originId,
      [edge(originId, null), edge(downstreamId, 'Asia/Seoul')],
      [node(originId, null), node(downstreamId, null)],
    );
    expect(handoffFor(timeZone)).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      query: null,
      reasonCodes: expect.arrayContaining(['QUERY_TIME_ZONE_UNRESOLVED']),
    });
  });

  it('uses the departure timezone of the origin-boundary transport', () => {
    const timeZone = resolveRouteOriginTimeZone(
      originId,
      [edge(originId, 'Asia/Tokyo'), edge(downstreamId, 'Asia/Seoul')],
      [node(originId, null), node(downstreamId, null)],
    );
    expect(handoffFor(timeZone)).toMatchObject({
      readiness: 'READY',
      query: { hint: { timeZone: 'Asia/Tokyo' } },
    });
  });

  it('does not rescue invalid origin evidence with a valid downstream zone', () => {
    const timeZone = resolveRouteOriginTimeZone(
      originId,
      [edge(originId, 'Invalid/Origin'), edge(downstreamId, 'Asia/Seoul')],
      [node(originId, 'Invalid/Node'), node(downstreamId, null)],
    );
    expect(handoffFor(timeZone)).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      query: null,
      reasonCodes: expect.arrayContaining(['QUERY_TIME_ZONE_UNRESOLVED']),
    });
  });
});
