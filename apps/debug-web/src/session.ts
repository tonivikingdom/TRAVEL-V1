import type { OperationReceiptView } from '@travel/contracts';

const CREDENTIAL_KEY = 'travel.debug.credential';
const SELECTED_TRIP_KEY = 'travel.debug.selectedTripId';
const RECEIPT_KEY = 'travel.debug.lastReceipt';

export interface SessionStore {
  getCredential(): string | null;
  setCredential(value: string): void;
  clearCredential(): void;
  getSelectedTripId(): string | null;
  setSelectedTripId(value: string | null): void;
  getLastReceipt(): OperationReceiptView | null;
  setLastReceipt(value: OperationReceiptView | null): void;
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
    getLastReceipt() {
      const raw = storage.getItem(RECEIPT_KEY);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as OperationReceiptView;
      } catch {
        storage.removeItem(RECEIPT_KEY);
        return null;
      }
    },
    setLastReceipt(value) {
      if (value === null) storage.removeItem(RECEIPT_KEY);
      else storage.setItem(RECEIPT_KEY, JSON.stringify(value));
    },
    clearTripState() {
      storage.removeItem(SELECTED_TRIP_KEY);
      storage.removeItem(RECEIPT_KEY);
    },
  };
}
