import type {
  DayView,
  OperationReceiptView,
  RouteCandidateView,
  RoutePreviewView,
} from '@travel/contracts';

import { DebugApiError } from './api.js';

export type RouteQueryFailure =
  'PROVIDER_UNAVAILABLE' | 'NO_MATCHING_CANDIDATE' | 'OTHER';

export function classifyRouteQueryFailure(error: unknown): RouteQueryFailure {
  if (error instanceof DebugApiError) {
    if (
      error.code === 'PROVIDER_UNAVAILABLE' ||
      error.code === 'ROUTE_PROVIDER_UNCONFIGURED'
    ) {
      return 'PROVIDER_UNAVAILABLE';
    }
    if (error.code === 'NO_MATCHING_CANDIDATE') {
      return 'NO_MATCHING_CANDIDATE';
    }
  }
  return 'OTHER';
}

export function isCoreUnavailable(error: unknown): boolean {
  return (
    error instanceof DebugApiError &&
    (error.kind === 'NETWORK' ||
      error.status === 503 ||
      error.code === 'SERVICE_UNAVAILABLE')
  );
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof DebugApiError && error.code === 'VERSION_CONFLICT';
}

export function shouldClearRecoveredOutage(error: unknown): boolean {
  return error === null || isCoreUnavailable(error);
}

export function orderedDays(days: readonly DayView[]): readonly DayView[] {
  return [...days].sort((left, right) => left.sequence - right.sequence);
}

export function invalidateRouteArtifacts(): {
  readonly candidates: readonly RouteCandidateView[];
  readonly preview: RoutePreviewView | null;
} {
  return { candidates: [], preview: null };
}

export function canUndoReceipt(
  receipt: OperationReceiptView | null,
  now: Date,
): boolean {
  return (
    receipt?.operationType === 'ROUTE_ADOPT' &&
    receipt.undoExpiresAt !== null &&
    Date.parse(receipt.undoExpiresAt) > now.getTime()
  );
}
