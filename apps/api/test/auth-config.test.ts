import { describe, expect, it } from 'vitest';

import { readAuthRuntimeConfig } from '../src/auth-config.js';

describe('magic-link landing URL configuration', () => {
  it('defaults development to a localhost landing page', () => {
    const config = readAuthRuntimeConfig({ APP_ENV: 'development' });

    expect(config.service.magicLinkLandingUrl).toBe(
      'http://127.0.0.1:3000/login/magic',
    );
  });

  it('allows an explicit localhost HTTP landing URL in test', () => {
    const config = readAuthRuntimeConfig({
      APP_ENV: 'test',
      AUTH_MAGIC_LINK_LANDING_URL: 'http://localhost:4173/login/magic',
    });

    expect(config.service.magicLinkLandingUrl).toBe(
      'http://localhost:4173/login/magic',
    );
  });

  it('requires HTTPS for a staging landing URL', () => {
    expect(() =>
      readAuthRuntimeConfig({
        APP_ENV: 'staging',
        AUTH_MAGIC_LINK_LANDING_URL: 'http://staging.example.test/login/magic',
      }),
    ).toThrow(/HTTPS/u);
  });

  it('requires an explicit production landing URL', () => {
    expect(() => readAuthRuntimeConfig({ APP_ENV: 'production' })).toThrow(
      /AUTH_MAGIC_LINK_LANDING_URL/u,
    );
  });

  it('accepts an explicit HTTPS production landing URL', () => {
    const config = readAuthRuntimeConfig({
      APP_ENV: 'production',
      AUTH_MAGIC_LINK_LANDING_URL: 'https://travel.example.test/login/magic',
    });

    expect(config.service.magicLinkLandingUrl).toBe(
      'https://travel.example.test/login/magic',
    );
  });
});
