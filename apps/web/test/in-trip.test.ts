import { describe, expect, it } from 'vitest';
import { inTripProjection, todayContext } from '../src/in-trip.js';
import { fixtureSchedule, fixtureTrip } from './fixture.js';
import { inTripFixture } from './in-trip-fixture.js';

describe('P6B SYNTHETIC in-trip projection', () => {
  it('selects a future first arrangement with an explicit device zone', () => {
    const t = fixtureTrip();
    const p = inTripProjection(
      t,
      fixtureSchedule(t),
      null,
      new Date('2030-10-01T03:00:00Z'),
      'Asia/Tokyo',
    );
    expect(p.step?.kind).toBe('node');
    expect(p.progress).toBe('当前进度未知');
    expect(p.context?.clock).toBe('12:00');
  });
  it.each(['ESTIMATED', 'ACTUAL'] as const)(
    'vehicle %s cannot become a user execution fact',
    (layer) => {
      const { trip, evidence } = inTripFixture(layer);
      const p = inTripProjection(
        trip,
        fixtureSchedule(trip),
        evidence,
        new Date('2030-10-01T05:11:00Z'),
        'Asia/Tokyo',
      );
      expect(p.step?.kind).toBe('transport');
      expect(p.progress).toBe('当前进度未知');
      expect(p.step?.start?.layer).toBe(layer);
      expect(trip.version).toBe(1);
    },
  );
  it('uses real sequence and leaves unidentified legs without a saved identity', () => {
    const { trip } = inTripFixture();
    const broken = {
      ...trip,
      savedRoutes: trip.savedRoutes!.map((r) => ({
        ...r,
        legTransportEdges: [],
      })),
    };
    const p = inTripProjection(
      broken,
      fixtureSchedule(broken),
      null,
      new Date('2030-10-01T05:11:00Z'),
      'Asia/Tokyo',
    );
    expect(
      p.steps
        .filter((s) => s.kind === 'transport')
        .map((s) => s.connection.transport!.mode),
    ).toEqual(['WALKING', 'BUS', 'RAIL', 'WALKING']);
    expect(p.step?.kind === 'transport' ? p.step.legIndex : 'wrong').toBe(null);
  });
  it('fails closed on repeated dates, invalid or missing time context', () => {
    const t = fixtureTrip();
    const repeated = {
      ...t,
      days: [
        t.days[0]!,
        { ...t.days[0]!, dayOccurrenceId: 'other', sequence: 1 },
      ],
    };
    expect(
      inTripProjection(
        repeated,
        fixtureSchedule(repeated),
        null,
        new Date('2030-10-01T03:00:00Z'),
        'Asia/Tokyo',
      ).ambiguous,
    ).toBe(true);
    expect(todayContext(new Date(), null)).toBe(null);
    expect(todayContext(new Date(), 'bad')).toBe(null);
    expect(
      inTripProjection(
        t,
        fixtureSchedule(t),
        null,
        new Date('invalid'),
        'Asia/Tokyo',
      ).step,
    ).toBe(null);
  });
  it('accepts matching recorded user facts but rejects mixed versions and future records', () => {
    const { trip, evidence } = inTripFixture();
    const recorded = {
      ...evidence,
      execution: {
        ...evidence.execution,
        state: 'AT_NODE' as const,
        currentNodeId: trip.days[0]!.nodes[0]!.id,
        recordedAt: '2030-10-01T04:00:00Z',
      },
    };
    const now = new Date('2030-10-01T05:11:00Z');
    expect(
      inTripProjection(trip, fixtureSchedule(trip), recorded, now, 'Asia/Tokyo')
        .progress,
    ).toBe('已有用户到达记录');
    expect(
      inTripProjection(
        trip,
        fixtureSchedule(trip),
        { ...recorded, tripVersion: 2 },
        now,
        'Asia/Tokyo',
      ).progress,
    ).toBe('当前进度未知');
    expect(
      inTripProjection(
        trip,
        fixtureSchedule(trip),
        {
          ...recorded,
          execution: {
            ...recorded.execution,
            recordedAt: '2031-01-01T00:00:00Z',
          },
        },
        now,
        'Asia/Tokyo',
      ).progress,
    ).toBe('当前进度未知');
  });
  it('does not claim completion when all planned times have passed', () => {
    const t = fixtureTrip();
    const timed = {
      ...t,
      days: t.days.map((d) => ({
        ...d,
        nodes: d.nodes.map((n) => ({
          ...n,
          timeValues: t.days[0]!.nodes[0]!.timeValues,
        })),
      })),
    };
    const p = inTripProjection(
      timed,
      fixtureSchedule(timed),
      null,
      new Date('2030-10-01T12:00:00Z'),
      'Asia/Tokyo',
    );
    expect(p.past).toBe(true);
    expect(p.progress).toBe('当前进度未知');
  });
});
