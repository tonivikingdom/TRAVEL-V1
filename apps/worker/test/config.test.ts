import { describe, expect, it } from 'vitest';

import { readWorkerConfig } from '../src/config.js';

const DATABASE_URL =
  'postgresql://synthetic:SYNTHETIC@127.0.0.1:5432/synthetic';

describe('worker security configuration', () => {
  it('uses an explicitly synthetic key only in development/test', () => {
    const config = readWorkerConfig({ APP_ENV: 'test', DATABASE_URL });
    expect(config.magicLinkTokenKey).toMatch(/SYNTHETIC/u);
  });

  it('requires a token key in staging', () => {
    expect(() =>
      readWorkerConfig({
        APP_ENV: 'staging',
        DATABASE_URL,
        AUTH_MAGIC_LINK_LANDING_URL: 'https://staging.example.test/login/magic',
      }),
    ).toThrow(/MAGIC_LINK_TOKEN_KEY/u);
  });

  it('rejects a synthetic token key in production', () => {
    expect(() =>
      readWorkerConfig({
        APP_ENV: 'production',
        DATABASE_URL,
        AUTH_MAGIC_LINK_LANDING_URL: 'https://example.test/login/magic',
        MAGIC_LINK_TOKEN_KEY:
          'SYNTHETIC_PRODUCTION_MUST_NOT_ACCEPT_THIS_SECRET_VALUE',
      }),
    ).toThrow(/must not be synthetic/u);
  });

  it('rejects an arbitrary long production string without a canonical key encoding', () => {
    expect(() =>
      readWorkerConfig({
        APP_ENV: 'production',
        DATABASE_URL,
        AUTH_MAGIC_LINK_LANDING_URL: 'https://example.test/login/magic',
        MAGIC_LINK_TOKEN_KEY: 'prod_9YjJ3nLq5h7R2uP8vX4mC6sF1kD0aBzEwTgN',
      }),
    ).toThrow(/base64url or hex/u);
  });

  it('accepts canonical 32-byte base64url and hex production keys', () => {
    const config = readWorkerConfig({
      APP_ENV: 'production',
      DATABASE_URL,
      AUTH_MAGIC_LINK_LANDING_URL: 'https://example.test/login/magic',
      MAGIC_LINK_TOKEN_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    });
    expect(config.mailProvider).toBe('unconfigured');

    expect(
      readWorkerConfig({
        APP_ENV: 'staging',
        DATABASE_URL,
        AUTH_MAGIC_LINK_LANDING_URL: 'https://staging.example.test/login/magic',
        MAGIC_LINK_TOKEN_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }).magicLinkTokenKey,
    ).toHaveLength(64);
  });
});
