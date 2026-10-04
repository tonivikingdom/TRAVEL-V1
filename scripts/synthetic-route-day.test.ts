import { describe, expect, it } from 'vitest';
import {
  fixtureLocalDate,
  syntheticExternalWindow,
  syntheticRouteDay,
} from './synthetic-route-day.mjs';

describe('SYNTHETIC Compose route day boundaries', () => {
  it.each(['2030-10-01T14:59:59Z', '2030-10-01T15:00:01Z'])(
    'keeps Ground Transit, handoff and suffix routes within one occurrence at %s',
    (instant) => {
      const now = new Date(instant);
      const before = now.getTime();
      const day = syntheticRouteDay(now);
      expect(day.timeZone).toBe('UTC');
      for (const minutes of [-15, 4, 14, 24, 34, 8, 18, 28, 38, 60]) {
        expect(
          fixtureLocalDate(new Date(before + minutes * 60_000), day.timeZone),
        ).toBe(day.localDate);
      }
      expect(now.getTime()).toBe(before);
    },
  );

  it('covers every minute of a UTC day without using the host timezone', () => {
    const start = Date.parse('2030-10-01T00:00:00Z');
    for (let minute = 0; minute < 1440; minute++) {
      const now = new Date(start + minute * 60_000);
      const { timeZone, localDate } = syntheticRouteDay(now);
      expect(
        fixtureLocalDate(new Date(now.getTime() - 15 * 60_000), timeZone),
      ).toBe(localDate);
      expect(
        fixtureLocalDate(new Date(now.getTime() + 60 * 60_000), timeZone),
      ).toBe(localDate);
    }
    expect(syntheticRouteDay(new Date(start)).timeZone).toBe('Asia/Tokyo');
    expect(syntheticRouteDay(new Date(start + 12 * 3600_000)).timeZone).toBe(
      'Asia/Tokyo',
    );
  });

  it.each(['2030-10-01T14:59:59Z', '2030-10-01T15:00:01Z'])(
    'retains trusted Tokyo context and explicit cross-day endpoints for external origin at %s',
    (instant) => {
      const now = new Date(instant);
      const window = syntheticExternalWindow(now);
      expect(window.timeZone).toBe('Asia/Tokyo');
      expect(window.fromDate).toBe('2030-10-01');
      expect(window.toDate).toBe('2030-10-02');
      expect(window.departure.getTime() - now.getTime()).toBe(-15 * 60_000);
      expect(window.arrival.getTime() - now.getTime()).toBe(45 * 60_000);
    },
  );
});
