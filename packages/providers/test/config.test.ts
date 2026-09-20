import { describe, expect, it } from 'vitest';

import { readRouteProviderConfig } from '../src/config.js';

describe('route provider configuration', () => {
  it('does not silently enable SYNTHETIC', () => {
    expect(readRouteProviderConfig({ APP_ENV: 'development' })).toEqual({
      provider: 'unconfigured',
      synthetic: false,
      reason: 'ROUTE_PROVIDER_UNCONFIGURED',
    });
  });

  it.each(['development', 'test'])(
    'allows an explicit SYNTHETIC provider in %s',
    (appEnvironment) => {
      expect(
        readRouteProviderConfig({
          APP_ENV: appEnvironment,
          ROUTE_PROVIDER: 'synthetic',
        }),
      ).toEqual({ provider: 'synthetic', synthetic: true });
    },
  );

  it.each(['staging', 'production'])(
    'rejects SYNTHETIC in %s',
    (appEnvironment) => {
      expect(() =>
        readRouteProviderConfig({
          APP_ENV: appEnvironment,
          ROUTE_PROVIDER: 'synthetic',
        }),
      ).toThrow(/development or test/u);
    },
  );

  it.each(['development', 'test'])(
    'allows the explicit Google Consumer experimental provider in %s',
    (appEnvironment) => {
      expect(
        readRouteProviderConfig({
          APP_ENV: appEnvironment,
          ROUTE_PROVIDER: 'google_consumer_experimental',
          GOOGLE_CONSUMER_TRANSIT_TOKEN: 'SYNTHETIC_TEST_TOKEN',
        }),
      ).toEqual({
        provider: 'google_consumer_experimental',
        synthetic: false,
        baseUrl: 'http://127.0.0.1:8787',
        token: 'SYNTHETIC_TEST_TOKEN',
        timeoutMs: 30_000,
      });
    },
  );

  it.each(['staging', 'production'])(
    'rejects the experimental provider in %s',
    (appEnvironment) => {
      expect(() =>
        readRouteProviderConfig({
          APP_ENV: appEnvironment,
          ROUTE_PROVIDER: 'google_consumer_experimental',
          GOOGLE_CONSUMER_TRANSIT_TOKEN: 'SYNTHETIC_TEST_TOKEN',
        }),
      ).toThrow(/development or test/u);
    },
  );

  it('requires the local token when selected', () => {
    expect(() =>
      readRouteProviderConfig({
        APP_ENV: 'development',
        ROUTE_PROVIDER: 'google_consumer_experimental',
      }),
    ).toThrow('GOOGLE_CONSUMER_TRANSIT_TOKEN');
  });

  it.each([
    'https://127.0.0.1:8787',
    'http://192.168.1.10:8787',
    'http://example.test:8787',
    'http://127.0.0.1:8787/path',
  ])('rejects non-loopback or non-origin base URL %s', (baseUrl) => {
    expect(() =>
      readRouteProviderConfig({
        APP_ENV: 'development',
        ROUTE_PROVIDER: 'google_consumer_experimental',
        GOOGLE_CONSUMER_TRANSIT_TOKEN: 'SYNTHETIC_TEST_TOKEN',
        GOOGLE_CONSUMER_TRANSIT_BASE_URL: baseUrl,
      }),
    ).toThrow('HTTP loopback origin');
  });

  it.each(['http://localhost:8787', 'http://[::1]:8787'])(
    'accepts explicit loopback base URL %s',
    (baseUrl) => {
      expect(
        readRouteProviderConfig({
          APP_ENV: 'development',
          ROUTE_PROVIDER: 'google_consumer_experimental',
          GOOGLE_CONSUMER_TRANSIT_TOKEN: 'SYNTHETIC_TEST_TOKEN',
          GOOGLE_CONSUMER_TRANSIT_BASE_URL: baseUrl,
        }),
      ).toMatchObject({ baseUrl });
    },
  );

  it.each(['0', '999', '120001', 'not-a-number'])(
    'rejects invalid timeout %s',
    (timeout) => {
      expect(() =>
        readRouteProviderConfig({
          APP_ENV: 'development',
          ROUTE_PROVIDER: 'google_consumer_experimental',
          GOOGLE_CONSUMER_TRANSIT_TOKEN: 'SYNTHETIC_TEST_TOKEN',
          GOOGLE_CONSUMER_TRANSIT_TIMEOUT_MS: timeout,
        }),
      ).toThrow('GOOGLE_CONSUMER_TRANSIT_TIMEOUT_MS');
    },
  );
});
