import { StorageError, type ObjectStorage } from '@travel/storage';
import type {
  StoredObjectCleanupClaim,
  StoredObjectRepository,
} from './ports.js';

export interface StoredObjectCleanupConfig {
  readonly pendingStaleMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const DEFAULT_OBJECT_CLEANUP_CONFIG: StoredObjectCleanupConfig = {
  pendingStaleMs: 30 * 60_000,
  batchSize: 25,
  leaseMs: 60_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60 * 60_000,
};

export interface StorageReconciliationSummary {
  readonly claimed: number;
  readonly cleaned: number;
  readonly failed: number;
  readonly fenced: number;
}

/** Uses only a claimed DB identity/key; never discovers provider objects. */
export async function cleanupStoredObjectClaim(
  repository: StoredObjectRepository,
  storage: ObjectStorage,
  claim: StoredObjectCleanupClaim,
  now: () => Date,
  config: Pick<StoredObjectCleanupConfig, 'retryBaseMs' | 'retryMaxMs'>,
): Promise<'CLEANED' | 'FAILED' | 'FENCED'> {
  try {
    await storage.delete(claim.storageKey);
  } catch (error) {
    const errorCode =
      error instanceof StorageError ? error.code : 'DELETE_FAILED';
    const updated = await repository.failCleanup({
      claim,
      errorCode,
      retryAt: retryAt(claim, now(), config),
    });
    return updated ? 'FAILED' : 'FENCED';
  }
  try {
    return (await repository.completeCleanup({ claim, now: now() }))
      ? 'CLEANED'
      : 'FENCED';
  } catch {
    const updated = await repository.failCleanup({
      claim,
      errorCode: 'PERSISTENCE_UNAVAILABLE',
      retryAt: retryAt(claim, now(), config),
    });
    return updated ? 'FAILED' : 'FENCED';
  }
}

function retryAt(
  claim: StoredObjectCleanupClaim,
  now: Date,
  config: Pick<StoredObjectCleanupConfig, 'retryBaseMs' | 'retryMaxMs'>,
): Date {
  const delay = Math.min(
    config.retryMaxMs,
    config.retryBaseMs *
      2 ** Math.min(30, Math.max(0, claim.cleanupAttempts - 1)),
  );
  return new Date(now.getTime() + delay);
}

export class StoredObjectReconciliationService {
  constructor(
    private readonly repository: StoredObjectRepository,
    private readonly storage: ObjectStorage,
    private readonly config: StoredObjectCleanupConfig = DEFAULT_OBJECT_CLEANUP_CONFIG,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<StorageReconciliationSummary> {
    const now = this.now();
    const claims = await this.repository.claimCleanupBatch({
      now,
      pendingBefore: new Date(now.getTime() - this.config.pendingStaleMs),
      leaseUntil: new Date(now.getTime() + this.config.leaseMs),
      limit: this.config.batchSize,
    });
    const result = { claimed: claims.length, cleaned: 0, failed: 0, fenced: 0 };
    for (const claim of claims) {
      // A failure on one key, including a DB completion failure, cannot skip the rest.
      try {
        const status = await cleanupStoredObjectClaim(
          this.repository,
          this.storage,
          claim,
          this.now,
          this.config,
        );
        if (status === 'CLEANED') result.cleaned++;
        else if (status === 'FENCED') result.fenced++;
        else result.failed++;
      } catch {
        result.failed++;
      }
    }
    return result;
  }
}
