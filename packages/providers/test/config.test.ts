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
});
