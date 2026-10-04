import { describe, expect, it } from 'vitest';
import { coordinates, navigation, placeMap } from '../src/maps.js';
import {
  externalMapUrl,
  externalNavigationUrl,
  reliablePoint,
  configureMapAdapter,
  regionMapAdapter,
  unconfiguredMapAdapter,
  type MapAdapter,
} from '../src/map-adapter.js';
import { SyntheticMapAdapter } from '../src/synthetic-map-adapter.js';
const point = {
  name: 'SYNTHETIC saved place',
  latitude: 35.68,
  longitude: 139.76,
};
describe('saved-coordinate map boundary', () => {
  it.each([
    [null, 0],
    [0, null],
    [NaN, 0],
    [0, Infinity],
    [91, 0],
    [0, -181],
  ])('rejects unreliable coordinates %s / %s', (latitude, longitude) => {
    expect(reliablePoint({ ...point, latitude, longitude })).toBeNull();
    expect(coordinates({ ...point, latitude, longitude })).toBeNull();
  });
  it.each([
    [0, 0],
    [-90, -180],
    [90, 180],
    [35.68, 139.76],
  ])('keeps saved coordinates exactly %s / %s', (latitude, longitude) => {
    expect(reliablePoint({ ...point, latitude, longitude })).toEqual({
      ...point,
      latitude,
      longitude,
    });
  });
  it('has no implicit region selection or production SDK', () => {
    expect(regionMapAdapter()).toBe(unconfiguredMapAdapter);
    expect(regionMapAdapter().embedded).toBe(false);
    expect(regionMapAdapter().synthetic).toBe(false);
    expect(
      externalMapUrl(regionMapAdapter(), { kind: 'place', points: [point] }),
    ).toBeNull();
    expect(externalNavigationUrl(regionMapAdapter(), point)).toBeNull();
  });
  it('synthetic policy preserves saved endpoints and navigation destination', () => {
    const adapter = new SyntheticMapAdapter();
    const target = { ...point, latitude: 1, longitude: 2 };
    const url = externalMapUrl(adapter, {
      kind: 'transport',
      points: [point, target],
    });
    expect(new URL(url!).searchParams.get('points')).toBe('35.68,139.76;1,2');
    expect(
      new URL(externalNavigationUrl(adapter, point)!).searchParams.get(
        'destination',
      ),
    ).toBe('35.68,139.76');
  });
  it('isolates external adapter failures', () => {
    const fail = () => {
      throw new Error('SYNTHETIC policy failure');
    };
    const adapter = {
      ...unconfiguredMapAdapter,
      externalMapUrl: fail,
      externalNavigationUrl: fail,
    };
    expect(
      externalMapUrl(adapter, { kind: 'place', points: [point] }),
    ).toBeNull();
    expect(externalNavigationUrl(adapter, point)).toBeNull();
  });
  it.each([
    'javascript:alert(1)',
    'http://unsafe.invalid',
    'https://user:password@unsafe.invalid',
    '/relative',
    'invalid',
  ])('rejects unsafe adapter output %s', (url) => {
    const adapter: MapAdapter = {
      ...unconfiguredMapAdapter,
      externalMapUrl: () => url,
      externalNavigationUrl: () => url,
    };
    expect(
      externalMapUrl(adapter, { kind: 'place', points: [point] }),
    ).toBeNull();
    expect(externalNavigationUrl(adapter, point)).toBeNull();
  });
});

it('existing map callers delegate configured capability without selecting a region/provider', () => {
  const adapter = new SyntheticMapAdapter();
  configureMapAdapter(adapter);
  try {
    expect(placeMap(point)).toContain('synthetic-map.invalid');
    expect(placeMap(point, true)).toContain('synthetic-map.invalid');
    const url = new URL(
      navigation(point, { ...point, latitude: 1 }, 'transit')!,
    );
    expect(url.hostname).toBe('synthetic-map.invalid');
    expect(url.searchParams.get('origin')).toBe('1,139.76');
    expect(url.searchParams.get('travelmode')).toBe('transit');
    expect(navigation(point, { ...point, latitude: null })).toBeNull();
  } finally {
    configureMapAdapter(unconfiguredMapAdapter);
  }
});
