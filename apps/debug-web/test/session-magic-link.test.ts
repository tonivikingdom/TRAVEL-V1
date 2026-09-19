import type { OperationReceiptView } from '@travel/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  consumeFragmentToken,
  extractMagicLinkToken,
} from '../src/magic-link.js';
import { createSessionStore } from '../src/session.js';

describe('debug-web credential and Magic Link handling', () => {
  it('extracts the token from the fragment and produces a token-free URL', () => {
    expect(
      extractMagicLinkToken(
        'http://127.0.0.1:5173/login/magic#token=RAW_SECRET_VALUE',
      ),
    ).toEqual({
      token: 'RAW_SECRET_VALUE',
      cleanUrl: 'http://127.0.0.1:5173/login/magic',
    });
  });

  it('cleans the URL immediately when consuming the fragment token', () => {
    const replace = vi.fn();
    expect(
      consumeFragmentToken(
        'http://127.0.0.1:5173/login/magic#token=RAW_SECRET_VALUE',
        replace,
      ),
    ).toBe('RAW_SECRET_VALUE');
    expect(replace).toHaveBeenCalledWith('http://127.0.0.1:5173/login/magic');
  });

  it('stores only credential, selected Trip, and recent receipt in session storage', () => {
    const memory = new MemoryStorage();
    const store = createSessionStore(memory);
    const receipt = syntheticReceipt();
    store.setCredential('SYNTHETIC_SESSION');
    store.setSelectedTripId('trip-1');
    store.setLastReceipt('trip-1', receipt);
    expect(store.getCredential()).toBe('SYNTHETIC_SESSION');
    expect(store.getSelectedTripId()).toBe('trip-1');
    expect(store.getLastReceipt('trip-1')).toEqual(receipt);
    expect(store.getLastReceipt('trip-2')).toBeNull();
    expect(store.getLastReceipt(null)).toBeNull();
    expect([...memory.keys()].sort()).toEqual([
      'travel.debug.credential',
      'travel.debug.lastReceipt',
      'travel.debug.selectedTripId',
    ]);
    store.clearCredential();
    store.clearTripState();
    expect(memory.length).toBe(0);
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  keys(): IterableIterator<string> {
    return this.values.keys();
  }
}

function syntheticReceipt(): OperationReceiptView {
  return {
    id: 'receipt-1',
    operationType: 'ROUTE_ADOPT',
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    baseTripVersion: 1,
    resultingTripVersion: 2,
    previewId: 'preview-1',
    adoptedRouteId: 'route-1',
    targetOperationReceiptId: null,
    undoExpiresAt: '2030-01-01T00:10:00.000Z',
    delta: {},
    createdAt: '2030-01-01T00:00:00.000Z',
  };
}
