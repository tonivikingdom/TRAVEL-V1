import type {
  StoredObjectReconciliationService,
  StorageReconciliationSummary,
} from '@travel/application';

type Event = {
  readonly event: 'storage_reconciliation';
} & StorageReconciliationSummary;

/** An unconfigured storage adapter is a safe no-op; failures do not stop jobs. */
export async function runStorageReconciliation(
  service: Pick<StoredObjectReconciliationService, 'reconcile'> | null,
  onSummary: (event: Event) => void,
): Promise<void> {
  if (service === null) return;
  try {
    onSummary({
      event: 'storage_reconciliation',
      ...(await service.reconcile()),
    });
  } catch {
    onSummary({
      event: 'storage_reconciliation',
      claimed: 0,
      cleaned: 0,
      failed: 1,
      fenced: 0,
    });
  }
}
