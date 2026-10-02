import { describe, expect, it, vi } from 'vitest';
import { runStorageReconciliation } from '../src/storage-reconciliation.js';
import { readWorkerConfig } from '../src/config.js';
import { readObjectStorageConfig } from '@travel/storage';

const env = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://synthetic:SYNTHETIC@localhost/test',
};
describe('bounded Worker object storage maintenance', () => {
  it('uses conservative stale/lease and batch defaults', () => {
    expect(readWorkerConfig(env).objectCleanup).toEqual({
      pendingStaleMs: 1_800_000,
      batchSize: 25,
      leaseMs: 60_000,
      retryBaseMs: 5_000,
      retryMaxMs: 3_600_000,
    });
  });
  it.each([
    ['OBJECT_PENDING_STALE_MS', '59999'],
    ['OBJECT_PENDING_STALE_MS', '604800001'],
    ['OBJECT_CLEANUP_BATCH_SIZE', '101'],
    ['OBJECT_CLEANUP_BATCH_SIZE', '0'],
    ['OBJECT_CLEANUP_BATCH_SIZE', '2oops'],
    ['OBJECT_CLEANUP_LEASE_MS', '999'],
    ['OBJECT_CLEANUP_RETRY_BASE_MS', 'NaN'],
    ['OBJECT_CLEANUP_RETRY_MAX_MS', '86400001'],
  ])('rejects unsafe %s=%s configuration', (key, value) => {
    expect(() => readWorkerConfig({ ...env, [key]: value })).toThrow(
      /Object cleanup/,
    );
  });
  it('runs one bounded reconciliation and logs only summary counts', async () => {
    const summary = { claimed: 2, cleaned: 1, failed: 1, fenced: 0 };
    const reconcile = vi.fn(async () => summary);
    const log = vi.fn();
    await runStorageReconciliation({ reconcile }, log);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'storage_reconciliation',
      ...summary,
    });
  });
  it('contains maintenance failures without leaking raw exception data or stopping heartbeat/jobs', async () => {
    const log = vi.fn();
    await expect(
      runStorageReconciliation(
        {
          reconcile: async () => {
            throw new Error('/private/path PASSWORD_SECRET');
          },
        },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|SECRET/);
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'storage_reconciliation',
      claimed: 0,
      cleaned: 0,
      failed: 1,
      fenced: 0,
    });
  });
  it.each(['staging', 'production'])(
    'keeps %s storage unconfigured and reconciliation a no-op',
    async (APP_ENV) => {
      expect(readObjectStorageConfig({ APP_ENV })).toMatchObject({
        enabled: false,
        provider: 'unconfigured',
      });
      const log = vi.fn();
      await runStorageReconciliation(null, log);
      expect(log).not.toHaveBeenCalled();
    },
  );
});
