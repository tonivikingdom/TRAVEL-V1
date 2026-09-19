import { describe, expect, it } from 'vitest';

import {
  evaluateScheduleConstraints,
  type ScheduleTemporalValue,
  type ScheduleUserTimeIntent,
} from '../src/schedule-evaluator.js';

const timestamp = new Date('2030-01-01T00:00:00.000Z');

describe('evaluateScheduleConstraints', () => {
  it('evaluates EXACT against the current planned instant', () => {
    const satisfied = evaluate(
      [pointIntent('i1', 'EXACT', '10:00')],
      [timeValue('p1', 'PLANNED', 'ARRIVAL', '10:00')],
    );
    expect(satisfied.nodes[0]?.evaluations[0]?.status).toBe('SATISFIED');

    const violated = evaluate(
      [pointIntent('i1', 'EXACT', '10:01')],
      [timeValue('p1', 'PLANNED', 'ARRIVAL', '10:00')],
    );
    expect(violated.nodes[0]?.evaluations[0]?.status).toBe('VIOLATED');
  });

  it('evaluates NOT_AFTER and NOT_BEFORE using instants', () => {
    const result = evaluate(
      [
        pointIntent('i1', 'NOT_AFTER', '10:00'),
        pointIntent('i2', 'NOT_BEFORE', '09:00', 'DEPARTURE'),
      ],
      [
        timeValue('a', 'PLANNED', 'ARRIVAL', '10:15'),
        timeValue('d', 'PLANNED', 'DEPARTURE', '09:30'),
      ],
    );
    expect(result.nodes[0]?.evaluations.map((entry) => entry.status)).toEqual([
      'VIOLATED',
      'SATISFIED',
    ]);
  });

  it.each([
    ['10:00', '10:40', 2_400, 'SATISFIED'],
    ['10:00', '10:20', 2_400, 'VIOLATED'],
  ] as const)(
    'evaluates minimum dwell from effective arrival and departure',
    (arrival, departure, minimum, expected) => {
      const result = evaluate(
        [dwellIntent(minimum)],
        [
          timeValue('a', 'PLANNED', 'ARRIVAL', arrival),
          timeValue('d', 'PLANNED', 'DEPARTURE', departure),
        ],
      );
      expect(result.nodes[0]?.dwellSeconds).toBe(
        (clock(departure).getTime() - clock(arrival).getTime()) / 1_000,
      );
      expect(result.nodes[0]?.evaluations[0]?.status).toBe(expected);
    },
  );

  it('returns UNKNOWN for dwell when either point is missing', () => {
    const result = evaluate(
      [dwellIntent(2_400)],
      [timeValue('a', 'PLANNED', 'ARRIVAL', '10:00')],
    );
    expect(result.nodes[0]?.dwellSeconds).toBeNull();
    expect(result.nodes[0]?.status).toBe('UNKNOWN');
  });

  it('chooses ACTUAL then ESTIMATED then PLANNED without merging stored layers', () => {
    const result = evaluate(
      [pointIntent('i1', 'EXACT', '10:20')],
      [
        timeValue('planned', 'PLANNED', 'ARRIVAL', '10:00'),
        timeValue('estimated', 'ESTIMATED', 'ARRIVAL', '10:10'),
        timeValue('actual', 'ACTUAL', 'ARRIVAL', '10:20'),
      ],
    );
    const arrival = result.nodes[0]?.arrival;
    expect(arrival?.planned?.id).toBe('planned');
    expect(arrival?.estimated?.id).toBe('estimated');
    expect(arrival?.actual?.id).toBe('actual');
    expect(arrival?.effective?.value.id).toBe('actual');
  });

  it('reports an intent that conflicts with ACTUAL without changing the fact', () => {
    const actual = timeValue('actual', 'ACTUAL', 'ARRIVAL', '19:42');
    const result = evaluate(
      [pointIntent('i1', 'NOT_AFTER', '19:30')],
      [actual],
    );
    expect(result.violations[0]).toMatchObject({
      status: 'VIOLATED',
      currentLayer: 'ACTUAL',
    });
    expect(actual.instant).toEqual(clock('19:42'));
  });

  it('detects contradictory lower and upper user bounds without a current value', () => {
    const result = evaluate(
      [
        pointIntent('lower', 'NOT_BEFORE', '20:30'),
        pointIntent('upper', 'NOT_AFTER', '20:00'),
      ],
      [],
    );
    expect(result.nodes[0]?.status).toBe('CONFLICT');
    expect(result.conflicts[0]).toMatchObject({
      intentIds: ['lower', 'upper'],
      rule: 'USER_CONSTRAINT_CONFLICT',
    });
  });

  it('detects an EXACT intent outside its user bounds', () => {
    const result = evaluate(
      [
        pointIntent('exact', 'EXACT', '20:10'),
        pointIntent('upper', 'NOT_AFTER', '20:00'),
      ],
      [],
    );
    expect(result.conflicts[0]?.intentIds).toEqual(['exact', 'upper']);
  });

  it('uses a fixed transport planned anchor without copying it into Node layers', () => {
    const anchor = timeValue(
      'train-departure',
      'PLANNED',
      'DEPARTURE',
      '20:21',
    );
    const result = evaluateScheduleConstraints({
      nodes: [node([pointIntent('i1', 'EXACT', '20:21', 'DEPARTURE')], [])],
      fixedTransportAnchors: [
        {
          transportEdgeId: 'edge-1',
          nodeId: 'node-1',
          pointKind: 'DEPARTURE',
          value: anchor,
        },
      ],
    });
    expect(result.nodes[0]?.departure.planned).toBeNull();
    expect(result.nodes[0]?.departure.effective).toMatchObject({
      subjectType: 'FIXED_TRANSPORT',
      subjectId: 'edge-1',
      anchor: 'FIXED_TRANSPORT',
    });
    expect(result.nodes[0]?.evaluations[0]?.status).toBe('SATISFIED');
  });

  it('preserves caller sequence even when occurrence local dates would go backward', () => {
    const result = evaluateScheduleConstraints({
      nodes: [
        { ...node([], []), nodeId: 'tokyo', dayOccurrenceId: 'day-2030-01-10' },
        {
          ...node([], []),
          nodeId: 'los-angeles',
          dayOccurrenceId: 'day-2030-01-09',
        },
      ],
      fixedTransportAnchors: [],
    });
    expect(result.nodes.map((entry) => entry.nodeId)).toEqual([
      'tokyo',
      'los-angeles',
    ]);
  });
});

function evaluate(
  intents: readonly ScheduleUserTimeIntent[],
  timeValues: readonly ScheduleTemporalValue[],
) {
  return evaluateScheduleConstraints({
    nodes: [node(intents, timeValues)],
    fixedTransportAnchors: [],
  });
}

function node(
  intents: readonly ScheduleUserTimeIntent[],
  timeValues: readonly ScheduleTemporalValue[],
) {
  return {
    nodeId: 'node-1',
    dayOccurrenceId: 'day-1',
    intents,
    timeValues,
  };
}

function pointIntent(
  id: string,
  operator: 'EXACT' | 'NOT_BEFORE' | 'NOT_AFTER',
  time: string,
  pointKind: 'ARRIVAL' | 'DEPARTURE' = 'ARRIVAL',
): ScheduleUserTimeIntent {
  return {
    id,
    nodeId: 'node-1',
    kind: 'POINT_TIME',
    pointKind,
    operator,
    instant: clock(time),
    timeZone: 'UTC',
    durationSeconds: null,
    locked: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function dwellIntent(durationSeconds: number): ScheduleUserTimeIntent {
  return {
    id: 'dwell',
    nodeId: 'node-1',
    kind: 'MIN_DWELL',
    pointKind: null,
    operator: 'MINIMUM',
    instant: null,
    timeZone: null,
    durationSeconds,
    locked: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function timeValue(
  id: string,
  layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL',
  pointKind: 'ARRIVAL' | 'DEPARTURE',
  time: string,
): ScheduleTemporalValue {
  return {
    id,
    layer,
    pointKind,
    instant: clock(time),
    timeZone: 'UTC',
    sourceKind: 'USER_VALUE',
    sourceRef: null,
    observedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function clock(value: string): Date {
  return new Date(`2030-10-01T${value}:00.000Z`);
}
