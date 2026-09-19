import { describe, expect, it } from 'vitest';

import {
  propagateScheduleBounds,
  type SchedulePropagationTransportAnchor,
} from '../src/schedule-propagator.js';
import type {
  ScheduleNodeInput,
  ScheduleTemporalValue,
  ScheduleUserTimeIntent,
} from '../src/schedule-evaluator.js';

const timestamp = new Date('2030-01-01T00:00:00.000Z');

describe('propagateScheduleBounds', () => {
  it('turns EXACT into an exact requirement window', () => {
    const result = propagate([pointIntent('exact', 'EXACT', '10:00')]);
    expect(result.nodes[0]?.arrival).toMatchObject({
      earliest: clock('10:00'),
      latest: clock('10:00'),
      status: 'EXACT',
    });
  });

  it.each([
    ['NOT_BEFORE', 'LOWER_BOUNDED', clock('10:00'), null],
    ['NOT_AFTER', 'UPPER_BOUNDED', null, clock('10:00')],
  ] as const)(
    'maps %s to the corresponding one-sided bound',
    (operator, status, earliest, latest) => {
      const result = propagate([pointIntent('bound', operator, '10:00')]);
      expect(result.nodes[0]?.arrival).toMatchObject({
        earliest,
        latest,
        status,
      });
    },
  );

  it('uses a Node ACTUAL as an immovable exact anchor', () => {
    const result = propagate(
      [],
      [timeValue('actual', 'ACTUAL', 'ARRIVAL', '10:05')],
    );
    expect(result.nodes[0]?.arrival).toMatchObject({
      earliest: clock('10:05'),
      latest: clock('10:05'),
      status: 'EXACT',
    });
    expect(result.nodes[0]?.arrival.earliestBasis[0]).toMatchObject({
      ruleId: 'NODE_ACTUAL',
      sourceRefs: ['actual'],
    });
  });

  it.each([
    ['DEPARTURE', 'from-node', 'departure'],
    ['ARRIVAL', 'to-node', 'arrival'],
  ] as const)(
    'uses Transport ACTUAL %s as an exact adjacent-node anchor',
    (pointKind, nodeId, projection) => {
      const actual = timeValue(
        'transport-actual',
        'ACTUAL',
        pointKind,
        '20:21',
      );
      const result = propagateScheduleBounds({
        nodes: [node('from-node'), node('to-node')],
        transportAnchors: [transportAnchor('TRANSPORT_ACTUAL', nodeId, actual)],
      });
      const projected = result.nodes.find((entry) => entry.nodeId === nodeId);
      expect(projected?.[projection]).toMatchObject({
        earliest: clock('20:21'),
        latest: clock('20:21'),
        status: 'EXACT',
      });
    },
  );

  it.each(['DEPARTURE', 'ARRIVAL'] as const)(
    'uses fixed-service PLANNED %s as an exact anchor',
    (pointKind) => {
      const planned = timeValue('fixed-plan', 'PLANNED', pointKind, '20:21');
      const result = propagateScheduleBounds({
        nodes: [node('node-1')],
        transportAnchors: [
          transportAnchor('FIXED_TRANSPORT_PLANNED', 'node-1', planned),
        ],
      });
      const window =
        pointKind === 'ARRIVAL'
          ? result.nodes[0]?.arrival
          : result.nodes[0]?.departure;
      expect(window).toMatchObject({ status: 'EXACT' });
      expect(window?.earliestBasis[0]?.ruleId).toBe('FIXED_TRANSPORT_PLANNED');
    },
  );

  it('does not use Node PLANNED or ESTIMATED as hard propagation bounds', () => {
    const result = propagate(
      [],
      [
        timeValue('planned', 'PLANNED', 'ARRIVAL', '10:00'),
        timeValue('estimated', 'ESTIMATED', 'DEPARTURE', '10:30'),
      ],
    );
    expect(result.nodes[0]?.arrival.status).toBe('UNBOUNDED');
    expect(result.nodes[0]?.departure.status).toBe('UNBOUNDED');
  });

  it('propagates MIN_DWELL forward from arrival lower to departure lower', () => {
    const result = propagate([
      pointIntent('arrival', 'EXACT', '10:00'),
      dwellIntent(2_400),
    ]);
    expect(result.nodes[0]?.departure).toMatchObject({
      earliest: clock('10:40'),
      latest: null,
      status: 'LOWER_BOUNDED',
    });
    expect(result.nodes[0]?.departure.earliestBasis[0]).toMatchObject({
      ruleId: 'MIN_DWELL_FORWARD',
      sourceRefs: ['arrival', 'dwell'],
    });
  });

  it('propagates MIN_DWELL backward from departure upper to arrival upper', () => {
    const result = propagate([
      pointIntent('departure', 'EXACT', '20:21', 'DEPARTURE'),
      dwellIntent(2_400),
    ]);
    expect(result.nodes[0]?.arrival).toMatchObject({
      earliest: null,
      latest: clock('19:41'),
      status: 'UPPER_BOUNDED',
    });
    expect(result.nodes[0]?.arrival.latestBasis[0]).toMatchObject({
      ruleId: 'MIN_DWELL_BACKWARD',
      sourceRefs: ['departure', 'dwell'],
    });
  });

  it('converges bidirectionally to exact arrival and departure windows', () => {
    const result = propagate([
      pointIntent('arrival-lower', 'NOT_BEFORE', '19:20'),
      pointIntent('departure-upper', 'NOT_AFTER', '20:00', 'DEPARTURE'),
      dwellIntent(2_400),
    ]);
    expect(result.nodes[0]?.arrival).toMatchObject({
      earliest: clock('19:20'),
      latest: clock('19:20'),
      status: 'EXACT',
    });
    expect(result.nodes[0]?.departure).toMatchObject({
      earliest: clock('20:00'),
      latest: clock('20:00'),
      status: 'EXACT',
    });
  });

  it('leaves both points unbounded when MIN_DWELL has no anchor', () => {
    const result = propagate([dwellIntent(2_400)]);
    expect(result.nodes[0]?.arrival.status).toBe('UNBOUNDED');
    expect(result.nodes[0]?.departure.status).toBe('UNBOUNDED');
  });

  it('reports lower-greater-than-upper conflicts with both provenances', () => {
    const result = propagate([
      pointIntent('lower', 'NOT_BEFORE', '20:00'),
      pointIntent('upper', 'NOT_AFTER', '19:41'),
    ]);
    expect(result.nodes[0]?.arrival.status).toBe('CONFLICT');
    expect(result.conflicts[0]).toMatchObject({
      type: 'PROPAGATION_BOUND_CONFLICT',
      nodeId: 'node-1',
      pointKind: 'ARRIVAL',
      lower: clock('20:00'),
      upper: clock('19:41'),
      sourceRefs: ['lower', 'upper'],
    });
  });

  it('keeps ACTUAL fixed when future constraints make the window impossible', () => {
    const result = propagate(
      [
        pointIntent('departure', 'EXACT', '20:21', 'DEPARTURE'),
        dwellIntent(2_400),
      ],
      [timeValue('actual-arrival', 'ACTUAL', 'ARRIVAL', '20:00')],
    );
    expect(result.nodes[0]?.arrival.earliest).toEqual(clock('20:00'));
    expect(result.nodes[0]?.arrival.latest).toEqual(clock('19:41'));
    expect(result.conflicts[0]?.sourceRefs).toEqual([
      'actual-arrival',
      'departure',
      'dwell',
    ]);
  });

  it.each([
    [1_200, '20:01'],
    [2_400, '19:41'],
  ] as const)(
    'C01/C02: fixed 20:21 departure and %s seconds dwell yields arrival latest %s',
    (durationSeconds, expected) => {
      const fixedDeparture = timeValue(
        'train-plan',
        'PLANNED',
        'DEPARTURE',
        '20:21',
      );
      const result = propagateScheduleBounds({
        nodes: [node('node-1', [dwellIntent(durationSeconds)])],
        transportAnchors: [
          transportAnchor('FIXED_TRANSPORT_PLANNED', 'node-1', fixedDeparture),
        ],
      });
      expect(result.nodes[0]?.arrival.latest).toEqual(clock(expected));
    },
  );

  it('C03: separate exact points do not invent a dwell constraint', () => {
    const fixedDeparture = timeValue(
      'train-plan',
      'PLANNED',
      'DEPARTURE',
      '20:21',
    );
    const result = propagateScheduleBounds({
      nodes: [node('node-1', [pointIntent('arrival', 'EXACT', '19:30')])],
      transportAnchors: [
        transportAnchor('FIXED_TRANSPORT_PLANNED', 'node-1', fixedDeparture),
      ],
    });
    expect(result.nodes[0]?.arrival.status).toBe('EXACT');
    expect(result.nodes[0]?.departure.status).toBe('EXACT');
    expect(
      [
        ...(result.nodes[0]?.arrival.earliestBasis ?? []),
        ...(result.nodes[0]?.departure.earliestBasis ?? []),
      ].some((basis) => basis.ruleId.startsWith('MIN_DWELL')),
    ).toBe(false);
  });

  it('compares cross-timezone inputs by absolute instant', () => {
    const intent = {
      ...pointIntent('tokyo', 'EXACT', '08:00'),
      instant: new Date('2030-10-01T17:00:00+09:00'),
      timeZone: 'Asia/Tokyo',
    };
    const actual = {
      ...timeValue('la-fact', 'ACTUAL', 'ARRIVAL', '08:00'),
      instant: new Date('2030-10-01T01:00:00-07:00'),
      timeZone: 'America/Los_Angeles',
    };
    const result = propagate([intent], [actual]);
    expect(result.nodes[0]?.arrival.status).toBe('EXACT');
    expect(result.conflicts).toHaveLength(0);
  });

  it('preserves caller sequence across repeated and decreasing local dates', () => {
    const result = propagateScheduleBounds({
      nodes: [
        node('tokyo', [], [], 'day-2030-01-10-a'),
        node('los-angeles', [], [], 'day-2030-01-09'),
        node('tokyo-return', [], [], 'day-2030-01-10-b'),
      ],
      transportAnchors: [],
    });
    expect(result.nodes.map((entry) => entry.nodeId)).toEqual([
      'tokyo',
      'los-angeles',
      'tokyo-return',
    ]);
  });

  it('is deterministic across repeated runs and shuffled constraint input', () => {
    const intents = [
      dwellIntent(2_400),
      pointIntent('departure', 'NOT_AFTER', '20:00', 'DEPARTURE'),
      pointIntent('arrival', 'NOT_BEFORE', '19:20'),
    ];
    const first = propagate(intents);
    const repeated = propagate(intents);
    const shuffled = propagate([...intents].reverse());
    expect(repeated).toEqual(first);
    expect(shuffled).toEqual(first);
  });

  it('reaches a bounded fixed point without numeric tolerance iteration', () => {
    const result = propagate([
      pointIntent('arrival', 'EXACT', '10:00'),
      pointIntent('departure', 'NOT_AFTER', '11:00', 'DEPARTURE'),
      dwellIntent(2_400),
    ]);
    expect(result.relaxationCount).toBeLessThanOrEqual(2);
    expect(result.nodes[0]?.departure.status).toBe('BOUNDED');
  });
});

function propagate(
  intents: readonly ScheduleUserTimeIntent[],
  timeValues: readonly ScheduleTemporalValue[] = [],
) {
  return propagateScheduleBounds({
    nodes: [node('node-1', intents, timeValues)],
    transportAnchors: [],
  });
}

function node(
  nodeId: string,
  intents: readonly ScheduleUserTimeIntent[] = [],
  timeValues: readonly ScheduleTemporalValue[] = [],
  dayOccurrenceId = 'day-1',
): ScheduleNodeInput {
  return { nodeId, dayOccurrenceId, intents, timeValues };
}

function pointIntent(
  id: string,
  operator: 'EXACT' | 'NOT_BEFORE' | 'NOT_AFTER',
  time: string,
  pointKind: 'ARRIVAL' | 'DEPARTURE' = 'ARRIVAL',
): Extract<ScheduleUserTimeIntent, { kind: 'POINT_TIME' }> {
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

function dwellIntent(
  durationSeconds: number,
): Extract<ScheduleUserTimeIntent, { kind: 'MIN_DWELL' }> {
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

function transportAnchor(
  anchorKind: SchedulePropagationTransportAnchor['anchorKind'],
  nodeId: string,
  value: ScheduleTemporalValue,
): SchedulePropagationTransportAnchor {
  return {
    transportEdgeId: 'edge-1',
    nodeId,
    pointKind: value.pointKind,
    anchorKind,
    value,
  };
}

function clock(value: string): Date {
  return new Date(`2030-10-01T${value}:00.000Z`);
}
