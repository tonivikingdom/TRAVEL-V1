import { describe, expect, it } from 'vitest';

const fixtureModule = './synthetic-route-endpoint-dates.mjs';
const {
  syntheticRouteEndpointDates,
  syntheticSameDayRouteTimeZone,
}: {
  syntheticSameDayRouteTimeZone: (now: Date) => string;
  syntheticRouteEndpointDates: (
    departure: Date,
    timeZone?: string,
  ) => {
    departureDate: string;
    arrivalDate: string;
  };
} = await import(fixtureModule);

describe('existing synthetic route endpoint dates', () => {
  it('keeps distinct departure and arrival dates across midnight', () => {
    expect(
      syntheticRouteEndpointDates(new Date('2026-10-03T14:35:00Z')),
    ).toEqual({
      departureDate: '2026-10-03',
      arrivalDate: '2026-10-04',
    });
  });
  it('keeps same-day candidates in the same occurrence', () => {
    expect(
      syntheticRouteEndpointDates(new Date('2026-10-03T10:00:00Z')),
    ).toEqual({
      departureDate: '2026-10-03',
      arrivalDate: '2026-10-03',
    });
  });
  it('keeps actual endpoint dates across the year boundary', () => {
    expect(
      syntheticRouteEndpointDates(new Date('2026-12-31T14:45:00Z')),
    ).toEqual({
      departureDate: '2026-12-31',
      arrivalDate: '2027-01-01',
    });
  });
});

it('keeps immediate replacement away from Tokyo midnight', () => {
  expect(syntheticSameDayRouteTimeZone(new Date('2026-10-03T14:35:00Z'))).toBe(
    'UTC',
  );
});
it('keeps immediate replacement away from UTC midnight', () => {
  expect(syntheticSameDayRouteTimeZone(new Date('2026-10-03T23:45:00Z'))).toBe(
    'Asia/Tokyo',
  );
});
