import { describe, expect, it } from 'vitest';
import {
  resolveConfirmedRouteExecutionOrigin,
  type RouteExecutionOriginEvent,
} from '../src/confirmed-route-execution-origin.js';

const instant = new Date('2030-10-01T10:20:00Z');
const event: RouteExecutionOriginEvent = {
  id: 'arrival-b',
  nodeId: 'B',
  type: 'ARRIVAL',
  source: 'MANUAL',
  occurredAt: instant,
  undoneAt: null,
  evidenceReliability: null,
};
function input() {
  return {
    corridorNodeIds: ['A', 'B', 'C', 'D'],
    nodes: ['A', 'B', 'C', 'D'].map((id) => ({
      id,
      kind: 'PLACE_VISIT',
      actualArrival:
        id === 'B'
          ? {
              instant,
              sourceRef: 'execution-event:arrival-b',
              sourceKind: 'USER_VALUE',
            }
          : null,
      actualDeparture: null as {
        instant: Date;
        sourceRef: string;
        sourceKind: string;
      } | null,
      executionStatus: null as 'SKIPPED' | null,
    })),
    events: [event],
  };
}

describe('confirmed route execution origin authorization', () => {
  it('keeps planned origin eligibility separate from topology', () => {
    const proof = input();
    proof.nodes[1]!.actualArrival = null;
    proof.events = [];
    expect(resolveConfirmedRouteExecutionOrigin(proof)).toEqual({
      status: 'NOT_PROGRESSING',
    });
  });
  it('accepts an active manual arrival tied to its exact ACTUAL fact', () => {
    expect(resolveConfirmedRouteExecutionOrigin(input())).toEqual({
      status: 'CONFIRMED_NODE',
      nodeId: 'B',
    });
  });
  it('accepts a sufficient LOCATION confirmation tied to its ACTUAL fact', () => {
    const proof = input();
    proof.events[0] = {
      ...event,
      source: 'LOCATION',
      evidenceReliability: 'SUFFICIENT',
    };
    proof.nodes[1]!.actualArrival!.sourceKind = 'EXECUTION_OBSERVATION';
    expect(resolveConfirmedRouteExecutionOrigin(proof)).toEqual({
      status: 'CONFIRMED_NODE',
      nodeId: 'B',
    });
  });
  it.each([
    'bare-fact',
    'undone',
    'wrong-ref',
    'wrong-instant',
    'weak-location',
    'provider-fact',
  ])('refuses %s as confirmed user arrival', (kind) => {
    const proof = input();
    if (kind === 'bare-fact') proof.events = [];
    if (kind === 'undone') proof.events[0] = { ...event, undoneAt: instant };
    if (kind === 'wrong-ref')
      proof.nodes[1]!.actualArrival!.sourceRef = 'other';
    if (kind === 'wrong-instant')
      proof.nodes[1]!.actualArrival!.instant = new Date(
        instant.getTime() + 1000,
      );
    if (kind === 'weak-location')
      proof.events[0] = {
        ...event,
        source: 'LOCATION',
        evidenceReliability: 'WEAK',
      };
    if (kind === 'provider-fact')
      proof.nodes[1]!.actualArrival!.sourceKind = 'PROVIDER_OBSERVATION';
    expect(resolveConfirmedRouteExecutionOrigin(proof).status).toBe(
      'UNRESOLVED',
    );
  });
  it('never upgrades reliable GPS state to arrival confirmation', () => {
    const proof = input();
    proof.nodes[1]!.actualArrival = null;
    proof.events = [];
    expect(
      resolveConfirmedRouteExecutionOrigin({
        ...proof,
        locationCurrentNodeId: 'B',
      }),
    ).toEqual({ status: 'UNRESOLVED' });
  });
  it('rejects a departed origin', () => {
    const proof = input();
    proof.nodes[1]!.actualDeparture = {
      instant,
      sourceKind: 'USER_VALUE',
      sourceRef: 'execution-event:departure-b',
    };
    expect(resolveConfirmedRouteExecutionOrigin(proof)).toEqual({
      status: 'UNRESOLVED',
    });
  });
  it('does not roll back past a later durable event even when its fact is missing', () => {
    const proof = input();
    proof.events.push({
      ...event,
      id: 'later-c',
      nodeId: 'C',
      occurredAt: new Date(instant.getTime() + 1000),
    });
    expect(resolveConfirmedRouteExecutionOrigin(proof)).toEqual({
      status: 'CONFLICT',
    });
  });
  it('rejects an inconsistent frontier with two open arrivals', () => {
    const proof = input();
    proof.nodes[2]!.actualArrival = { ...proof.nodes[1]!.actualArrival! };
    expect(resolveConfirmedRouteExecutionOrigin(proof)).toEqual({
      status: 'CONFLICT',
    });
  });
  it.each(['A', 'D'])(
    'does not authorize %s as an internal live origin',
    (nodeId) => {
      const proof = input();
      proof.nodes[1]!.actualArrival = null;
      proof.nodes.find((node) => node.id === nodeId)!.actualArrival = {
        instant,
        sourceKind: 'USER_VALUE',
        sourceRef: 'execution-event:arrival-b',
      };
      proof.events[0] = { ...event, nodeId };
      expect(resolveConfirmedRouteExecutionOrigin(proof).status).not.toBe(
        'CONFIRMED_NODE',
      );
    },
  );
});
