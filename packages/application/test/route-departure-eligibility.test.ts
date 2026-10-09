import { describe, expect, it } from 'vitest';
import type {
  NormalizedRouteCandidate,
  RouteExecutionOriginEvent,
} from '@travel/domain';
import {
  hasMissedFixedDeparture,
  hasElapsedFixedDeparture,
} from '../src/route-departure-eligibility.js';
import type { TripAggregateRecord } from '../src/trip-ports.js';

const departure = new Date('2026-10-10T10:00:00Z');
const after = new Date('2026-10-10T10:05:00Z');
const arrival = new Date('2026-10-10T10:30:00Z');
const date = new Date('2026-10-10T00:00:00Z');
const point = {
  name: 'SYNTHETIC',
  latitude: 35,
  longitude: 139,
  providerPlaceRef: null,
};
const time = (instant: Date, timeZone = 'Asia/Shanghai') => ({
  instant,
  timeZone,
});
function candidate(): NormalizedRouteCandidate {
  return {
    candidateId: 'SYNTHETIC',
    provider: 'SYNTHETIC',
    providerCandidateRef: null,
    observedAt: departure,
    validUntil: null,
    departure: time(departure),
    arrival: time(arrival),
    durationSeconds: 1800,
    fare: null,
    legs: [
      {
        mode: 'BUS',
        from: point,
        to: point,
        departure: time(departure),
        arrival: time(arrival),
        durationSeconds: 1800,
        fixedService: true,
        serviceLabel: 'SYNTHETIC BUS',
        providerRef: null,
      },
    ],
  };
}
function event(
  overrides: Partial<RouteExecutionOriginEvent> = {},
): RouteExecutionOriginEvent {
  return {
    id: 'SYNTHETIC_EVENT',
    nodeId: 'origin',
    type: 'ARRIVAL',
    source: 'MANUAL',
    occurredAt: new Date('2026-10-10T09:59:00Z'),
    undoneAt: null,
    evidenceReliability: null,
    ...overrides,
  };
}
function trip(
  timeZone = 'Asia/Shanghai',
  events: readonly RouteExecutionOriginEvent[] = [event()],
): TripAggregateRecord {
  return {
    id: 'trip',
    ownerUserId: 'owner',
    name: 'SYNTHETIC',
    version: 1,
    planningAnchorDate: date,
    defaultPeopleCount: 1,
    effectiveStartDate: date,
    effectiveEndDate: date,
    createdAt: date,
    updatedAt: date,
    ownedDates: [date],
    transportEdges: [],
    routeExecutionEvents: events,
    dayOccurrences: [
      {
        id: 'day',
        tripId: 'trip',
        localDate: date,
        sequence: 0,
        createdAt: date,
        updatedAt: date,
        nodes: [
          {
            id: 'origin',
            tripId: 'trip',
            dayOccurrenceId: 'day',
            kind: 'PLACE_VISIT',
            position: 0,
            place: null,
            note: null,
            source: 'USER_PLANNED',
            createdAt: date,
            updatedAt: date,
            timeIntents: [],
            timeValues: [
              {
                id: 'time',
                layer: 'PLANNED',
                pointKind: 'DEPARTURE',
                instant: departure,
                timeZone,
                sourceKind: 'USER_VALUE',
                sourceRef: null,
                observedAt: null,
                createdAt: date,
                updatedAt: date,
              },
            ],
          },
        ],
      },
    ],
  };
}
const missed = (t = trip(), c = candidate(), now = after) =>
  hasMissedFixedDeparture(t, 'origin', c, now);

describe('execution-aware fixed departure rejection (SYNTHETIC)', () => {
  it('confirmed external origins reject elapsed fixed clocks without treating aggregate TRANSIT as fixed', () => {
    const c = candidate();
    expect(hasElapsedFixedDeparture(c, after)).toBe(true);
    expect(hasElapsedFixedDeparture(c, departure)).toBe(false);
    expect(
      hasElapsedFixedDeparture(
        {
          ...c,
          legs: [{ ...c.legs[0]!, fixedService: false, mode: 'TRANSIT' }],
        },
        after,
      ),
    ).toBe(false);
  });
  it('rejects a departed fixed service while manual execution remains AT_NODE', () =>
    expect(missed()).toBe(true));
  it('adds no boarding buffer: exact departure is allowed, one millisecond later rejected', () => {
    expect(missed(trip(), candidate(), departure)).toBe(false);
    expect(missed(trip(), candidate(), new Date(departure.getTime() + 1))).toBe(
      true,
    );
  });
  it('calendar-only planning is not classified as confirmed user execution', () =>
    expect(missed(trip('Asia/Shanghai', []))).toBe(false));
  it('vehicle ACTUAL and a location cache cannot exempt a missed departure', () => {
    const t = trip(),
      day = t.dayOccurrences[0]!,
      node = day.nodes[0]!;
    expect(
      missed({
        ...t,
        executionLocationCurrentNodeId: 'origin',
        dayOccurrences: [
          {
            ...day,
            nodes: [
              {
                ...node,
                timeValues: [
                  {
                    ...node.timeValues[0]!,
                    layer: 'ACTUAL',
                    sourceKind: 'PROVIDER_OBSERVATION',
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
  it('future planning remains available even when its clocks precede the query date in UTC', () =>
    expect(missed(trip(), candidate(), new Date('2026-10-09T10:05:00Z'))).toBe(
      false,
    ));
  it('historical editing after the Trip period remains available with old execution facts', () =>
    expect(missed(trip(), candidate(), new Date('2026-10-11T10:05:00Z'))).toBe(
      false,
    ));
  it('uses explicit Tokyo local date at the UTC midnight boundary', () => {
    const c = candidate(),
      start = new Date('2026-10-09T15:01:00Z');
    expect(
      missed(
        trip('Asia/Tokyo', [
          event({ occurredAt: new Date('2026-10-09T15:00:00Z') }),
        ]),
        {
          ...c,
          departure: time(start, 'Asia/Tokyo'),
          legs: [{ ...c.legs[0]!, departure: time(start, 'Asia/Tokyo') }],
        },
        new Date('2026-10-09T15:05:00Z'),
      ),
    ).toBe(true);
  });
  it('does not treat non-fixed aggregate TRANSIT duration as a timetable', () => {
    const c = candidate();
    expect(
      missed(trip(), {
        ...c,
        legs: [{ ...c.legs[0]!, mode: 'TRANSIT', fixedService: false }],
      }),
    ).toBe(false);
  });
  it('does not assume a stale leading walk has already been performed', () => {
    const c = candidate();
    expect(
      missed(trip(), {
        ...c,
        legs: [
          { ...c.legs[0]!, mode: 'WALKING', fixedService: false },
          { ...c.legs[0]!, departure: time(new Date('2026-10-10T10:10:00Z')) },
        ],
      }),
    ).toBe(true);
  });
  it('checks fixed legs rather than trusting only the overall clock', () => {
    const c = candidate();
    expect(
      missed(trip(), {
        ...c,
        departure: time(new Date('2026-10-10T10:10:00Z')),
      }),
    ).toBe(true);
  });
  it('fails closed when the Trip calendar cannot classify execution vs history', () => {
    expect(
      missed({ ...trip(), effectiveStartDate: null, effectiveEndDate: null }),
    ).toBe(true);
  });
  it('fails closed when the fixed departure is missing', () => {
    const c = candidate();
    expect(
      missed(trip(), { ...c, legs: [{ ...c.legs[0]!, departure: null }] }),
    ).toBe(true);
  });
  it('fails closed when execution date cannot be classified in a reliable timezone', () =>
    expect(missed(trip('SYNTHETIC_INVALID_ZONE'))).toBe(true));
  it.each([
    ['manual open origin', [event()], true],
    [
      'sufficient committed location arrival',
      [event({ source: 'LOCATION', evidenceReliability: 'SUFFICIENT' })],
      true,
    ],
    [
      'weak location',
      [event({ source: 'LOCATION', evidenceReliability: 'WEAK' })],
      false,
    ],
    ['undone arrival', [event({ undoneAt: after })], false],
    ['no user evidence', [], false],
    [
      'confirmed departure clears open origin',
      [
        event(),
        event({ id: 'departure', type: 'DEPARTURE', occurredAt: after }),
      ],
      false,
    ],
  ] as const)(
    'previous-day planning vs carry-over execution: %s',
    (_name, events, expected) => {
      const t = trip('Asia/Shanghai', events);
      expect(
        missed(
          {
            ...t,
            effectiveEndDate: new Date('2026-10-11T00:00:00Z'),
            executionLocationCurrentNodeId: 'origin',
          },
          candidate(),
          new Date('2026-10-11T00:05:00Z'),
        ),
      ).toBe(expected);
    },
  );
});

describe('P5E2 explicit calendar context vs serialized execution UTC (SYNTHETIC)', () => {
  function calendar(
    departureAt: string,
    nowAt: string,
    zone: string,
    planned = true,
  ) {
    const depart = new Date(departureAt),
      now = new Date(nowAt);
    const arrive = new Date(depart.getTime() + 30 * 60_000);
    const dayAt = (instant: Date) =>
      new Date(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(instant) + 'T00:00:00Z',
      );
    const arrived = event({ occurredAt: new Date(depart.getTime() - 60_000) });
    const t = trip(zone, [arrived]),
      day = t.dayOccurrences[0]!,
      node = day.nodes[0]!;
    const original = node.timeValues[0]!;
    const c = candidate();
    return {
      now,
      t: {
        ...t,
        effectiveStartDate: dayAt(depart),
        effectiveEndDate: dayAt(arrive),
        dayOccurrences: [
          {
            ...day,
            localDate: dayAt(depart),
            nodes: [
              {
                ...node,
                timeValues: [
                  {
                    ...original,
                    id: 'execution',
                    layer: 'ACTUAL' as const,
                    pointKind: 'ARRIVAL' as const,
                    instant: arrived.occurredAt,
                    timeZone: 'UTC',
                    sourceRef: `execution-event:${arrived.id}`,
                  },
                  ...(planned
                    ? [{ ...original, instant: depart, timeZone: zone }]
                    : []),
                ],
              },
            ],
          },
        ],
      },
      c: {
        ...c,
        departure: time(depart, zone),
        arrival: time(arrive, zone),
        legs: [
          {
            ...c.legs[0]!,
            departure: time(depart, zone),
            arrival: time(arrive, zone),
          },
        ],
      },
    };
  }
  it.each([
    [
      'Tokyo before midnight',
      '2030-09-30T14:57:00Z',
      '2030-09-30T14:59:00Z',
      'Asia/Tokyo',
    ],
    [
      'Tokyo after midnight',
      '2030-09-30T14:59:00Z',
      '2030-09-30T15:01:00Z',
      'Asia/Tokyo',
    ],
    [
      'Tokyo local date differs UTC',
      '2030-09-30T15:59:00Z',
      '2030-09-30T16:01:00Z',
      'Asia/Tokyo',
    ],
    [
      'UTC before midnight',
      '2030-09-30T23:57:00Z',
      '2030-09-30T23:59:00Z',
      'UTC',
    ],
    [
      'UTC after midnight',
      '2030-09-30T23:59:00Z',
      '2030-10-01T00:01:00Z',
      'UTC',
    ],
    [
      'Tokyo after UTC midnight',
      '2030-10-01T00:00:00Z',
      '2030-10-01T00:01:00Z',
      'Asia/Tokyo',
    ],
  ])(
    '%s protects a manually confirmed open origin',
    (_name, dep, now, zone) => {
      for (const planned of [true, false]) {
        const f = calendar(dep!, now!, zone!, planned);
        expect(hasMissedFixedDeparture(f.t, 'origin', f.c, f.now)).toBe(true);
      }
    },
  );
  it('explicit departure clears previous-day carry-over; arrival alone does not', () => {
    const f = calendar(
      '2030-09-30T14:59:00Z',
      '2030-09-30T15:01:00Z',
      'Asia/Tokyo',
    );
    expect(hasMissedFixedDeparture(f.t, 'origin', f.c, f.now)).toBe(true);
    expect(
      hasMissedFixedDeparture(
        {
          ...f.t,
          routeExecutionEvents: [
            ...f.t.routeExecutionEvents!,
            event({
              id: 'departed',
              type: 'DEPARTURE',
              occurredAt: new Date('2030-09-30T14:59:00Z'),
            }),
          ],
        },
        'origin',
        f.c,
        f.now,
      ),
    ).toBe(false);
  });
  it('old confirmed facts after the reliable Trip period remain historical editing', () => {
    const f = calendar(
      '2030-09-30T15:59:00Z',
      '2030-10-02T01:00:00Z',
      'Asia/Tokyo',
    );
    expect(hasMissedFixedDeparture(f.t, 'origin', f.c, f.now)).toBe(false);
  });
  it('serialized UTC cannot mask an invalid explicit calendar zone', () => {
    const f = calendar(
      '2030-09-30T15:59:00Z',
      '2030-09-30T16:01:00Z',
      'Asia/Tokyo',
    );
    const day = f.t.dayOccurrences[0]!,
      node = day.nodes[0]!;
    expect(
      hasMissedFixedDeparture(
        {
          ...f.t,
          dayOccurrences: [
            {
              ...day,
              nodes: [
                {
                  ...node,
                  timeValues: node.timeValues.map((v) =>
                    v.layer === 'PLANNED'
                      ? { ...v, timeZone: 'SYNTHETIC_INVALID_ZONE' }
                      : v,
                  ),
                },
              ],
            },
          ],
        },
        'origin',
        f.c,
        f.now,
      ),
    ).toBe(true);
  });
});
