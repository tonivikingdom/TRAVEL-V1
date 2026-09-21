import {
  decideExecutionLocation,
  DEFAULT_EXECUTION_LOCATION_POLICY,
  haversineDistanceMeters,
  resolveExecutionFrontier,
  type ExecutionDerivedLocationState,
  type ExecutionTimelineNode,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const a = node('a', 0, 0, 35, 139);
const b = node('b', 0, 1, 35.001, 139.001);
const c = node('c', 0, 2, 35.002, 139.002);

describe('execution location policy', () => {
  it('computes deterministic Haversine distance', () => {
    expect(
      haversineDistanceMeters(
        { latitude: 35, longitude: 139 },
        { latitude: 35.001, longitude: 139.001 },
      ),
    ).toBeCloseTo(143.7, 0);
  });

  it('orders the execution frontier by occurrence sequence and position', () => {
    const frontier = resolveExecutionFrontier([
      { ...c, sequence: 2 },
      { ...a, sequence: 0 },
      { ...b, sequence: 1 },
    ]);
    expect(frontier.orderedNodes.map((item) => item.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(frontier.targetNode?.id).toBe('a');
  });

  it('[AUDIT EXECUTION ORDER] exposes an open earlier node while advancing the target past a later completed node', () => {
    const frontier = resolveExecutionFrontier([
      { ...a, hasActualArrival: true, hasActualDeparture: false },
      { ...b, hasActualArrival: true, hasActualDeparture: true },
      c,
    ]);

    expect(frontier.currentNode?.id).toBe('a');
    expect(frontier.targetNode?.id).toBe('c');
    expect(frontier.state).toBe('AT_NODE');
  });

  it('confirms arrival immediately when a reliable sample is inside target radius', () => {
    const result = decideExecutionLocation({
      nodes: [a, b],
      previousState: null,
      sample: sample(35.0001, 139.0001),
      policy: DEFAULT_EXECUTION_LOCATION_POLICY,
    });
    expect(result).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      nodeId: 'a',
      possiblySkippedNodeIds: [],
    });
  });

  it('does not create a fact for poor accuracy or an outside sample', () => {
    expect(
      decideExecutionLocation({
        nodes: [a],
        previousState: null,
        sample: { ...sample(35, 139), accuracyMeters: 150 },
        policy: DEFAULT_EXECUTION_LOCATION_POLICY,
      }).status,
    ).toBe('INDETERMINATE_LOCATION');
    expect(
      decideExecutionLocation({
        nodes: [a],
        previousState: null,
        sample: sample(36, 140),
        policy: DEFAULT_EXECUTION_LOCATION_POLICY,
      }).status,
    ).toBe('NO_CHANGE');
  });

  it('requires consecutive outside movement toward the next target for departure', () => {
    const arrivedA = { ...a, hasActualArrival: true };
    const distantB = node('b', 0, 1, 35.01, 139.01);
    const first = decideExecutionLocation({
      nodes: [arrivedA, distantB],
      previousState: null,
      sample: sample(35.001, 139.001),
      policy: DEFAULT_EXECUTION_LOCATION_POLICY,
    });
    expect(first.status).toBe('NO_CHANGE');
    const second = decideExecutionLocation({
      nodes: [arrivedA, distantB],
      previousState: first.state,
      sample: sample(35.002, 139.002),
      policy: DEFAULT_EXECUTION_LOCATION_POLICY,
    });
    expect(second).toMatchObject({
      status: 'CONFIRMED_DEPARTURE',
      nodeId: 'a',
    });
  });

  it('does not confirm departure for a single jump or movement away from next target', () => {
    const arrivedA = { ...a, hasActualArrival: true };
    const distantB = node('b', 0, 1, 35.01, 139.01);
    const previous: ExecutionDerivedLocationState = {
      currentNodeId: 'a',
      targetNodeId: 'b',
      lastObservedAt: new Date('2030-01-01T10:00:00.000Z'),
      lastDistanceToCurrentTargetMeters: 120,
      lastDistanceToNextTargetMeters: 1_000,
      outsideTargetConsecutiveCount: 1,
      locationStatus: 'RELIABLE',
    };
    expect(
      decideExecutionLocation({
        nodes: [arrivedA, distantB],
        previousState: null,
        sample: sample(35.002, 139.002),
        policy: DEFAULT_EXECUTION_LOCATION_POLICY,
      }).status,
    ).toBe('NO_CHANGE');
    expect(
      decideExecutionLocation({
        nodes: [arrivedA, distantB],
        previousState: previous,
        sample: sample(35.001, 139.001),
        policy: DEFAULT_EXECUTION_LOCATION_POLICY,
      }).status,
    ).toBe('NO_CHANGE');
  });

  it('marks intervening nodes possibly skipped when a later node is reached', () => {
    const result = decideExecutionLocation({
      nodes: [a, b, c],
      previousState: null,
      sample: sample(35.002, 139.002),
      policy: DEFAULT_EXECUTION_LOCATION_POLICY,
    });
    expect(result).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      nodeId: 'c',
      possiblySkippedNodeIds: ['a', 'b'],
    });
  });

  it('does not use a coordinate-less target for automatic arrival', () => {
    expect(
      decideExecutionLocation({
        nodes: [{ ...a, latitude: null, longitude: null }],
        previousState: null,
        sample: sample(35, 139),
        policy: DEFAULT_EXECUTION_LOCATION_POLICY,
      }).status,
    ).toBe('MANUAL_CONFIRMATION_AVAILABLE');
  });
});

function node(
  id: string,
  sequence: number,
  position: number,
  latitude: number,
  longitude: number,
): ExecutionTimelineNode {
  return {
    id,
    sequence,
    position,
    latitude,
    longitude,
    targetKind: 'PLACE',
    hasActualArrival: false,
    hasActualDeparture: false,
    executionStatus: null,
  };
}

function sample(latitude: number, longitude: number) {
  return {
    latitude,
    longitude,
    accuracyMeters: 10,
    observedAt: new Date('2030-01-01T10:00:00.000Z'),
  };
}
