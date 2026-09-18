import { describe, expect, it } from 'vitest';

import { readObjectStorageConfig } from '../src/index.js';

describe('object storage runtime configuration', () => {
  it('uses explicit synthetic defaults only in development and test', () => {
    const config = readObjectStorageConfig({ APP_ENV: 'test' });
    expect(config).toMatchObject({
      enabled: true,
      provider: 'local-filesystem',
      maxFileBytes: 10 * 1024 * 1024,
      maxUserTotalBytes: 100 * 1024 * 1024,
    });
  });

  it('keeps staging and production storage unconfigured', () => {
    for (const appEnvironment of ['staging', 'production']) {
      expect(readObjectStorageConfig({ APP_ENV: appEnvironment })).toEqual({
        enabled: false,
        provider: 'unconfigured',
        reason: 'OBJECT_STORAGE_PROVIDER_UNCONFIGURED',
      });
    }
  });

  it('strictly validates configured limits and media types', () => {
    expect(() =>
      readObjectStorageConfig({
        APP_ENV: 'test',
        OBJECT_MAX_FILE_BYTES: 'unlimited',
      }),
    ).toThrow(/positive integers/u);
    expect(() =>
      readObjectStorageConfig({
        APP_ENV: 'test',
        OBJECT_ALLOWED_MEDIA_TYPES: 'not-a-media-type',
      }),
    ).toThrow(/MIME allowlist/u);
  });
});
