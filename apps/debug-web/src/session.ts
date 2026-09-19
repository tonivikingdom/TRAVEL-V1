import type { OperationReceiptView } from '@travel/contracts';

const CREDENTIAL_KEY = 'travel.debug.credential';
const SELECTED_TRIP_KEY = 'travel.debug.selectedTripId';
const RECEIPT_KEY = 'travel.debug.lastReceipt';

interface StoredReceipt {
  readonly tripId: string;
  readonly receipt: OperationReceiptView;
}

export interface SessionStore {
  getCredential(): string | null;
  setCredential(value: string): void;
  clearCredential(): void;
  getSelectedTripId(): string | null;
  setSelectedTripId(value: string | null): void;
  getLastReceipt(tripId: string | null): OperationReceiptView | null;
  setLastReceipt(tripId: string, value: OperationReceiptView): void;
  clearLastReceipt(): void;
  clearTripState(): void;
}

export function createSessionStore(storage: Storage): SessionStore {
  return {
    getCredential: () => storage.getItem(CREDENTIAL_KEY),
    setCredential: (value) => storage.setItem(CREDENTIAL_KEY, value),
    clearCredential: () => storage.removeItem(CREDENTIAL_KEY),
    getSelectedTripId: () => storage.getItem(SELECTED_TRIP_KEY),
    setSelectedTripId(value) {
      if (value === null) storage.removeItem(SELECTED_TRIP_KEY);
      else storage.setItem(SELECTED_TRIP_KEY, value);
    },
    getLastReceipt(tripId) {
      if (tripId === null) return null;
      const raw = storage.getItem(RECEIPT_KEY);
      if (raw === null) return null;
      try {
        const stored = JSON.parse(raw) as Partial<StoredReceipt>;
        if (stored.tripId !== tripId || stored.receipt === undefined) {
          return null;
        }
        return stored.receipt;
      } catch {
        storage.removeItem(RECEIPT_KEY);
        return null;
      }
    },
    setLastReceipt(tripId, value) {
      storage.setItem(RECEIPT_KEY, JSON.stringify({ tripId, receipt: value }));
    },
    clearLastReceipt: () => storage.removeItem(RECEIPT_KEY),
    clearTripState() {
      storage.removeItem(SELECTED_TRIP_KEY);
      storage.removeItem(RECEIPT_KEY);
    },
  };
}
