import type { DayView, OperationReceiptView } from '@travel/contracts';
import { describe, expect, it } from 'vitest';

import { DebugApiError } from '../src/api.js';
import {
  canUndoReceipt,
  classifyRouteQueryFailure,
  invalidateRouteArtifacts,
  isCoreUnavailable,
  isVersionConflict,
  orderedDays,
  shouldClearRecoveredOutage,
} from '../src/state.js';

describe('debug-web UI state rules', () => {
  it('keeps PROVIDER_UNAVAILABLE separate from NO_MATCHING_CANDIDATE', () => {
    expect(classifyRouteQueryFailure(apiError('PROVIDER_UNAVAILABLE'))).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect(classifyRouteQueryFailure(apiError('NO_MATCHING_CANDIDATE'))).toBe(
      'NO_MATCHING_CANDIDATE',
    );
  });

  it('recognizes VERSION_CONFLICT without treating it as network outage', () => {
    const error = apiError('VERSION_CONFLICT', 409);
    expect(isVersionConflict(error)).toBe(true);
    expect(isCoreUnavailable(error)).toBe(false);
  });

  it('recognizes network, 503, and SERVICE_UNAVAILABLE as core outage', () => {
    expect(
      isCoreUnavailable(
        new DebugApiError('offline', 'NETWORK', null, null, null, true),
      ),
    ).toBe(true);
    expect(isCoreUnavailable(apiError('SERVICE_UNAVAILABLE', 503))).toBe(true);
  });

  it('clears a stale outage error after recovery without hiding other errors', () => {
    expect(
      shouldClearRecoveredOutage(
        new DebugApiError('offline', 'NETWORK', null, null, null, true),
      ),
    ).toBe(true);
    expect(
      shouldClearRecoveredOutage(apiError('SERVICE_UNAVAILABLE', 503)),
    ).toBe(true);
    expect(shouldClearRecoveredOutage(apiError('VERSION_CONFLICT', 409))).toBe(
      false,
    );
  });

  it('invalidates stale Candidate and Preview together', () => {
    expect(invalidateRouteArtifacts()).toEqual({
      candidates: [],
      preview: null,
    });
  });

  it('renders by DayOccurrence sequence and keeps duplicate localDate cards', () => {
    const days = [day('b', '2030-01-09', 2), day('a', '2030-01-09', 0)];
    expect(orderedDays(days).map((item) => item.dayOccurrenceId)).toEqual([
      'a',
      'b',
    ]);
    expect(orderedDays(days)).toHaveLength(2);
  });

  it('offers Undo only for an unexpired ROUTE_ADOPT receipt', () => {
    const receipt = syntheticReceipt('ROUTE_ADOPT');
    expect(canUndoReceipt(receipt, new Date('2030-01-01T00:05:00Z'))).toBe(
      true,
    );
    expect(canUndoReceipt(receipt, new Date('2030-01-01T00:11:00Z'))).toBe(
      false,
    );
    expect(
      canUndoReceipt(
        syntheticReceipt('ROUTE_UNDO'),
        new Date('2030-01-01T00:05:00Z'),
      ),
    ).toBe(false);
  });
});

function apiError(
  code:
    | 'PROVIDER_UNAVAILABLE'
    | 'NO_MATCHING_CANDIDATE'
    | 'VERSION_CONFLICT'
    | 'SERVICE_UNAVAILABLE',
  status = 503,
): DebugApiError {
  return new DebugApiError('failure', 'API', status, code, 'request-1', false);
}

function day(id: string, localDate: string, sequence: number): DayView {
  return {
    dayOccurrenceId: id,
    localDate,
    sequence,
    nodes: [],
    transportProjections: [],
  };
}

function syntheticReceipt(
  operationType: OperationReceiptView['operationType'],
): OperationReceiptView {
  return {
    id: 'receipt-1',
    operationType,
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    baseTripVersion: 1,
    resultingTripVersion: 2,
    previewId: 'preview-1',
    adoptedRouteId: 'route-1',
    targetOperationReceiptId:
      operationType === 'ROUTE_UNDO' ? 'target-receipt' : null,
    undoExpiresAt: '2030-01-01T00:10:00.000Z',
    delta: {},
    createdAt: '2030-01-01T00:00:00.000Z',
  };
}
