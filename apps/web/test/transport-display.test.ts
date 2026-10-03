import { expect, it } from 'vitest';
import { transportClockPair } from '../src/transport-display.js';

it('shares context only for two known endpoints on the same local date and exact zone', () => {
  const from = { instant: '2030-10-01T06:10:00Z', timeZone: 'Asia/Tokyo' };
  const to = { instant: '2030-10-01T06:40:00Z', timeZone: 'Asia/Tokyo' };
  expect(transportClockPair(from, to)).toMatchObject({
    sharedContext: '2030年10月1日 · 东京当地时间',
    from: { clock: '15:10' },
    to: { clock: '15:40' },
  });
  expect(transportClockPair(from, null)).toMatchObject({
    sharedContext: null,
    from: { date: '2030年10月1日', timeZone: 'Asia/Tokyo' },
    to: null,
  });
  expect(
    transportClockPair(from, { ...to, timeZone: 'Unknown/Zone' }),
  ).toMatchObject({ sharedContext: null, to: null });
});
it('keeps each date/zone across midnight and timezone changes, including clock rollback', () => {
  const from = { instant: '2030-10-01T14:30:00Z', timeZone: 'Asia/Tokyo' };
  expect(
    transportClockPair(from, {
      instant: '2030-10-01T17:00:00Z',
      timeZone: 'Asia/Shanghai',
    }),
  ).toMatchObject({
    sharedContext: null,
    zoneChange: true,
    from: { date: '2030年10月1日', clock: '23:30', zone: '东京当地时间' },
    to: { date: '2030年10月2日', clock: '01:00', zone: '上海当地时间' },
  });
  expect(
    transportClockPair(from, {
      instant: '2030-10-01T15:00:00Z',
      timeZone: 'America/Los_Angeles',
    }),
  ).toMatchObject({
    sharedContext: null,
    zoneChange: true,
    to: { date: '2030年10月1日', clock: '08:00' },
  });
  expect(
    transportClockPair(from, {
      instant: '2030-10-01T16:00:00Z',
      timeZone: 'Asia/Tokyo',
    }).sharedContext,
  ).toBeNull();
});
