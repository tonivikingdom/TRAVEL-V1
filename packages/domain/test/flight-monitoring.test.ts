import { describe, expect, it } from 'vitest';

import {
  decideAcceptedFlightRefresh,
  decideProviderFailure,
  futureNormalCheckpoints,
  shouldRefreshFlightDetail,
  shouldSkipFixedRefresh,
  type MonitorDecisionState,
  type MonitorSnapshot,
} from '../src/flight-monitoring.js';

const scheduled = '2030-01-02T12:00:00.000Z';

describe('flight monitoring policy', () => {
  it('defines every fixed preflight checkpoint from T-24h through T-15m', () => {
    expect(
      futureNormalCheckpoints(
        new Date(scheduled),
        new Date('2030-01-01T11:59:59.999Z'),
      ).map((value) => value.toISOString()),
    ).toEqual([
      '2030-01-01T12:00:00.000Z',
      '2030-01-01T20:00:00.000Z',
      '2030-01-02T04:00:00.000Z',
      '2030-01-02T08:00:00.000Z',
      '2030-01-02T10:00:00.000Z',
      '2030-01-02T11:00:00.000Z',
      '2030-01-02T11:30:00.000Z',
      '2030-01-02T11:45:00.000Z',
    ]);
  });

  it('schedules only future fixed checkpoints and never replays missed nodes', () => {
    expect(
      futureNormalCheckpoints(
        new Date(scheduled),
        new Date('2030-01-02T03:00:00.000Z'),
      ).map((value) => value.toISOString()),
    ).toEqual([
      '2030-01-02T04:00:00.000Z',
      '2030-01-02T08:00:00.000Z',
      '2030-01-02T10:00:00.000Z',
      '2030-01-02T11:00:00.000Z',
      '2030-01-02T11:30:00.000Z',
      '2030-01-02T11:45:00.000Z',
    ]);
  });

  it('uses the 30 minute fixed-node dedupe and 5 minute detail threshold', () => {
    const now = new Date('2030-01-02T10:00:00.000Z');
    expect(
      shouldSkipFixedRefresh(new Date('2030-01-02T09:30:00.000Z'), now),
    ).toBe(true);
    expect(
      shouldRefreshFlightDetail(new Date('2030-01-02T09:55:00.000Z'), now),
    ).toBe(false);
    expect(
      shouldRefreshFlightDetail(new Date('2030-01-02T09:54:59.999Z'), now),
    ).toBe(true);
  });

  it.each([
    ['2030-01-02T14:00:01.000Z', '2030-01-02T11:00:00.000Z', 60],
    ['2030-01-02T12:45:00.000Z', '2030-01-02T12:00:00.000Z', 15],
  ])(
    'sets delay polling from revised departure %s',
    (revised, now, minutes) => {
      const next = snapshot({ status: 'DELAYED', revisedUtc: revised });
      const result = decideAcceptedFlightRefresh({
        previous: snapshot(),
        next,
        state: state(),
        now: new Date(now),
      });
      expect(result.state.mode).toBe('DELAYED');
      expect(result.nextCheckAt?.toISOString()).toBe(
        new Date(Date.parse(now) + minutes * 60_000).toISOString(),
      );
    },
  );

  it('polls delayed flights without revised time every 30 minutes', () => {
    const result = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ status: 'DELAYED' }),
      state: state(),
      now: new Date('2030-01-02T11:00:00.000Z'),
    });
    expect(result.nextCheckAt?.toISOString()).toBe('2030-01-02T11:30:00.000Z');
  });

  it('replaces dynamic schedules even when the monitor mode is unchanged', () => {
    const delayed = decideAcceptedFlightRefresh({
      previous: snapshot({
        status: 'DELAYED',
        revisedUtc: '2030-01-02T13:00:00.000Z',
      }),
      next: snapshot({
        status: 'DELAYED',
        revisedUtc: '2030-01-02T12:45:00.000Z',
      }),
      state: state({ mode: 'DELAYED' }),
      now: new Date('2030-01-02T11:30:00.000Z'),
    });
    expect(delayed.replaceSchedule).toBe(true);

    const cancelled = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'CANCELLED' }),
      next: snapshot({ status: 'CANCELLED' }),
      state: state({ mode: 'CANCELLED', cancellationNotified: true }),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(cancelled.replaceSchedule).toBe(true);
  });

  it('continues the bounded baggage schedule after a provider failure', () => {
    const result = decideProviderFailure({
      snapshot: snapshot({ status: 'ARRIVED' }),
      state: state({
        mode: 'BAGGAGE',
        baggageWindowStartedAt: new Date('2030-01-02T14:00:00.000Z'),
        baggageWindowEndsAt: new Date('2030-01-02T14:30:00.000Z'),
      }),
      now: new Date('2030-01-02T14:10:00.000Z'),
    });
    expect(result.nextCheckAt?.toISOString()).toBe('2030-01-02T14:15:00.000Z');
  });

  it.each([30, 60, 90])('notifies the %i minute delay bucket', (minutes) => {
    const result = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({
        status: 'DELAYED',
        revisedUtc: new Date(
          Date.parse(scheduled) + minutes * 60_000,
        ).toISOString(),
      }),
      state: state({ lastNotifiedDelayMinutes: minutes - 30 || null }),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(result.notification?.changeKinds).toContain('DELAY');
  });

  it('does not round a sub-30-minute delay into the first notification bucket', () => {
    const result = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ revisedUtc: '2030-01-02T12:29:59.999Z' }),
      state: state(),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(result.state.mode).toBe('DELAYED');
    expect(result.notification).toBeNull();
  });

  it('does not repeat a delay bucket and notifies material improvement', () => {
    const same = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({
        status: 'DELAYED',
        revisedUtc: '2030-01-02T12:45:00.000Z',
      }),
      state: state({ lastNotifiedDelayMinutes: 30 }),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(same.notification).toBeNull();
    const improved = decideAcceptedFlightRefresh({
      previous: snapshot({
        status: 'DELAYED',
        revisedUtc: '2030-01-02T13:00:00.000Z',
      }),
      next: snapshot({
        status: 'DELAYED',
        revisedUtc: '2030-01-02T12:45:00.000Z',
      }),
      state: state({ lastNotifiedDelayMinutes: 60 }),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(improved.notification?.changeKinds).toContain('DELAY_IMPROVED');
  });

  it('notifies recovery below 30 only after a prior warning', () => {
    const notified = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'DELAYED' }),
      next: snapshot(),
      state: state({ lastNotifiedDelayMinutes: 45 }),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(notified.notification?.changeKinds).toContain('DELAY_RECOVERED');
    const unnoticed = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'DELAYED' }),
      next: snapshot(),
      state: state(),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(unnoticed.notification).toBeNull();
  });

  it('notifies any early departure and its restoration', () => {
    const early = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ revisedUtc: '2030-01-02T11:59:00.000Z' }),
      state: state(),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(early.notification?.changeKinds).toContain('EARLY_DEPARTURE');
    const restored = decideAcceptedFlightRefresh({
      previous: snapshot({ revisedUtc: '2030-01-02T11:59:00.000Z' }),
      next: snapshot({ revisedUtc: scheduled }),
      state: early.state,
      now: new Date('2030-01-02T10:10:00.000Z'),
    });
    expect(restored.notification?.changeKinds).toContain(
      'EARLY_DEPARTURE_RECOVERED',
    );

    const missingObservation = decideAcceptedFlightRefresh({
      previous: snapshot({ revisedUtc: '2030-01-02T11:59:00.000Z' }),
      next: snapshot(),
      state: state({ earlyDepartureNotified: true }),
      now: new Date('2030-01-02T10:20:00.000Z'),
    });
    expect(missingObservation.notification).toBeNull();
    expect(missingObservation.state.earlyDepartureNotified).toBe(true);
  });

  it('applies gate timing, gate changes, terminal changes and boarding aggregation', () => {
    const tooEarly = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ gate: 'A1', terminal: 'T1' }),
      state: state(),
      now: new Date('2030-01-02T09:00:00.000Z'),
    });
    expect(tooEarly.notification).toBeNull();
    const combined = decideAcceptedFlightRefresh({
      previous: snapshot({ gate: 'A1', terminal: 'T1' }),
      next: snapshot({ status: 'BOARDING', gate: 'B2', terminal: 'T2' }),
      state: state({ lastNotifiedDepartureGate: 'A1' }),
      now: new Date('2030-01-02T10:30:00.000Z'),
    });
    expect(combined.notification?.changeKinds).toEqual([
      'GATE_CHANGED',
      'TERMINAL_CHANGED',
      'BOARDING',
    ]);
  });

  it('gives cancellation sole strong priority and restores strongly', () => {
    const cancelled = decideAcceptedFlightRefresh({
      previous: snapshot({ gate: 'A1' }),
      next: snapshot({ status: 'CANCELLED', gate: 'B2' }),
      state: state(),
      now: new Date('2030-01-02T08:00:00.000Z'),
    });
    expect(cancelled.notification).toMatchObject({
      priority: 'STRONG',
      changeKinds: ['CANCELLED'],
    });
    const restored = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'CANCELLED' }),
      next: snapshot({
        status: 'DELAYED',
        revisedUtc: '2030-01-02T12:40:00.000Z',
      }),
      state: cancelled.state,
      now: new Date('2030-01-02T09:00:00.000Z'),
    });
    expect(restored.notification?.priority).toBe('STRONG');
    expect(restored.notification?.changeKinds[0]).toBe(
      'RESTORED_AFTER_CANCELLATION',
    );
  });

  it('uses bounded two-hour/hourly cancellation checks and stops at T+2h', () => {
    const distant = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ status: 'CANCELLED' }),
      state: state(),
      now: new Date('2030-01-02T04:00:00.000Z'),
    });
    expect(distant.nextCheckAt?.toISOString()).toBe('2030-01-02T06:00:00.000Z');
    const near = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ status: 'CANCELLED' }),
      state: state(),
      now: new Date('2030-01-02T11:30:00.000Z'),
    });
    expect(near.nextCheckAt?.toISOString()).toBe('2030-01-02T12:30:00.000Z');
    const ended = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ status: 'CANCELLED' }),
      state: state(),
      now: new Date('2030-01-02T14:00:00.000Z'),
    });
    expect(ended.nextCheckAt).toBeNull();
  });

  it('stops preflight on departure and starts bounded baggage polling on landing', () => {
    const departed = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ status: 'DEPARTED' }),
      state: state(),
      now: new Date('2030-01-02T12:05:00.000Z'),
    });
    expect(departed).toMatchObject({
      nextCheckAt: null,
      replaceSchedule: true,
    });
    expect(departed.state.mode).toBe('STOPPED');

    const landed = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'EN_ROUTE' }),
      next: snapshot({ status: 'ARRIVED', baggage: '5' }),
      state: state({ mode: 'STOPPED' }),
      now: new Date('2030-01-02T14:00:00.000Z'),
    });
    expect(landed.state.mode).toBe('BAGGAGE');
    expect(landed.notification?.changeKinds).toEqual(['BAGGAGE_AVAILABLE']);
    expect(landed.nextCheckAt?.toISOString()).toBe('2030-01-02T14:05:00.000Z');
    const changed = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'ARRIVED', baggage: '5' }),
      next: snapshot({ status: 'ARRIVED', baggage: '6' }),
      state: landed.state,
      now: new Date('2030-01-02T14:05:00.000Z'),
    });
    expect(changed.notification?.changeKinds).toEqual(['BAGGAGE_CHANGED']);
    const ended = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'ARRIVED', baggage: '6' }),
      next: snapshot({ status: 'ARRIVED', baggage: '6' }),
      state: changed.state,
      now: new Date('2030-01-02T14:30:00.000Z'),
    });
    expect(ended.nextCheckAt).toBeNull();
  });

  it('treats a trusted runway arrival as landed even before provider status catches up', () => {
    const landed = decideAcceptedFlightRefresh({
      previous: snapshot({ status: 'EN_ROUTE' }),
      next: snapshot({
        status: 'EN_ROUTE',
        arrivalRunwayUtc: '2030-01-02T14:01:00.000Z',
        baggage: '7',
      }),
      state: state({ mode: 'STOPPED' }),
      now: new Date('2030-01-02T14:02:00.000Z'),
    });
    expect(landed.state.mode).toBe('BAGGAGE');
    expect(landed.notification?.changeKinds).toEqual(['BAGGAGE_AVAILABLE']);
  });

  it('does not notify baggage before landing and aggregates arrival terminal with baggage', () => {
    const premature = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ baggage: '5' }),
      state: state(),
      now: new Date('2030-01-02T13:50:00.000Z'),
    });
    expect(premature.notification).toBeNull();
    const landed = decideAcceptedFlightRefresh({
      previous: snapshot({
        status: 'EN_ROUTE',
        arrivalTerminal: 'T1',
      }),
      next: snapshot({
        status: 'ARRIVED',
        baggage: '5',
        arrivalTerminal: 'T2',
      }),
      state: state({ mode: 'STOPPED' }),
      now: new Date('2030-01-02T14:00:00.000Z'),
    });
    expect(landed.notification?.changeKinds).toEqual([
      'BAGGAGE_AVAILABLE',
      'TERMINAL_CHANGED',
    ]);
  });

  it('warns once at T-2 for provider outage without inventing a flight event', () => {
    const first = decideProviderFailure({
      snapshot: snapshot(),
      state: state(),
      now: new Date('2030-01-02T10:00:00.000Z'),
    });
    expect(first.notification?.changeKinds).toEqual(['PROVIDER_UNAVAILABLE']);
    const repeated = decideProviderFailure({
      snapshot: snapshot(),
      state: first.state,
      now: new Date('2030-01-02T10:30:00.000Z'),
    });
    expect(repeated.notification).toBeNull();
  });

  it('notifies a still-relevant delay after provider recovery but not departure', () => {
    const warned = state({ providerUnavailableWarned: true });
    const delayed = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({
        status: 'DELAYED',
        revisedUtc: '2030-01-02T12:40:00.000Z',
      }),
      state: warned,
      now: new Date('2030-01-02T10:30:00.000Z'),
    });
    expect(delayed.notification?.changeKinds).toContain('DELAY');
    const departed = decideAcceptedFlightRefresh({
      previous: snapshot(),
      next: snapshot({ status: 'DEPARTED' }),
      state: warned,
      now: new Date('2030-01-02T12:05:00.000Z'),
    });
    expect(departed.notification).toBeNull();
  });
});

function state(
  override: Partial<MonitorDecisionState> = {},
): MonitorDecisionState {
  return {
    mode: 'NORMAL',
    arrivedAtAirportAt: null,
    lastNotifiedDelayMinutes: null,
    earlyDepartureNotified: false,
    lastNotifiedDepartureGate: null,
    providerUnavailableWarned: false,
    cancellationNotified: false,
    baggageWindowStartedAt: null,
    baggageWindowEndsAt: null,
    lastNotifiedBaggage: null,
    ...override,
  };
}

function snapshot(
  input: {
    readonly status?: string;
    readonly revisedUtc?: string | null;
    readonly gate?: string | null;
    readonly terminal?: string | null;
    readonly arrivalTerminal?: string | null;
    readonly arrivalRunwayUtc?: string | null;
    readonly baggage?: string | null;
  } = {},
): MonitorSnapshot {
  return {
    status: input.status ?? 'SCHEDULED',
    departure: {
      scheduledUtc: scheduled,
      revisedUtc: input.revisedUtc ?? null,
      predictedUtc: null,
      runwayUtc: null,
      gate: input.gate ?? null,
      terminal: input.terminal ?? null,
    },
    arrival: {
      scheduledUtc: '2030-01-02T14:00:00.000Z',
      revisedUtc: null,
      predictedUtc: null,
      runwayUtc:
        input.arrivalRunwayUtc ??
        (input.status === 'ARRIVED' ? '2030-01-02T14:00:00.000Z' : null),
      gate: null,
      terminal: input.arrivalTerminal ?? null,
      baggageBelt: input.baggage ?? null,
    },
  };
}
