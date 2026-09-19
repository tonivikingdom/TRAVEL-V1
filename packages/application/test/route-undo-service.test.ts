import type { TripView } from '@travel/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Actor } from '../src/authorization.js';
import type {
  OperationReceiptRecord,
  RoutePlanningRepository,
  UndoRouteAdoptionResult,
} from '../src/route-planning-ports.js';
import { hashRouteUndoRequest } from '../src/route-snapshot.js';
import { RouteUndoService } from '../src/route-undo-service.js';
import type { TripRepository } from '../src/trip-ports.js';
import { TripService } from '../src/trip-service.js';

const ownerUserId = '00000000-0000-4000-8000-000000000001';
const tripId = '00000000-0000-4000-8000-000000000002';
const targetReceiptId = '00000000-0000-4000-8000-000000000003';
const undoReceiptId = '00000000-0000-4000-8000-000000000004';
const previewId = '00000000-0000-4000-8000-000000000005';
const adoptedRouteId = '00000000-0000-4000-8000-000000000006';
const now = new Date('2030-01-01T00:00:00.000Z');

const actor: Actor = {
  userId: ownerUserId,
  email: 'owner@synthetic.example.test',
  role: 'USER',
  status: 'ACTIVE',
};

describe('RouteUndoService', () => {
  it('uses a stable server-side request hash and returns the compensated Trip', async () => {
    const repository = planningRepository({
      status: 'SUCCESS',
      receipt: undoReceipt(),
      idempotentReplay: false,
    });
    const tripService = stubTripService();
    const service = new RouteUndoService(repository, tripService, {
      now: () => now,
    });

    const result = await service.undoAdoption(actor, tripId, targetReceiptId, {
      baseTripVersion: 13,
      idempotencyKey: '  synthetic-undo-key  ',
    });

    expect(repository.undoAdoption).toHaveBeenCalledWith({
      ownerUserId,
      tripId,
      targetOperationReceiptId: targetReceiptId,
      baseTripVersion: 13,
      idempotencyKey: 'synthetic-undo-key',
      requestHash: hashRouteUndoRequest({
        tripId,
        targetOperationReceiptId: targetReceiptId,
        baseTripVersion: 13,
      }),
      now,
    });
    expect(result).toMatchObject({
      operationReceipt: {
        id: undoReceiptId,
        operationType: 'ROUTE_UNDO',
        targetOperationReceiptId: targetReceiptId,
        createdAt: now.toISOString(),
        undoExpiresAt: null,
      },
      trip: { id: tripId, version: 14 },
    });
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND', 404],
    ['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT', 409],
    ['UNDO_CONFLICT', 'UNDO_CONFLICT', 409],
    ['UNDO_EXPIRED', 'UNDO_EXPIRED', 409],
    ['UNDO_UNAVAILABLE', 'UNDO_UNAVAILABLE', 409],
  ] as const)(
    'maps %s to the public error contract',
    async (status, code, httpStatus) => {
      const service = new RouteUndoService(
        planningRepository({ status }),
        stubTripService(),
        { now: () => now },
      );

      await expect(
        service.undoAdoption(actor, tripId, targetReceiptId, {
          baseTripVersion: 13,
          idempotencyKey: 'synthetic-undo-key',
        }),
      ).rejects.toMatchObject({ code, httpStatus });
    },
  );

  it('rejects invalid request identifiers and version input before persistence', async () => {
    const repository = planningRepository({ status: 'UNDO_CONFLICT' });
    const service = new RouteUndoService(repository, stubTripService(), {
      now: () => now,
    });

    await expect(
      service.undoAdoption(actor, tripId, 'not-a-uuid', {
        baseTripVersion: 13,
        idempotencyKey: 'synthetic-undo-key',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
    });
    await expect(
      service.undoAdoption(actor, tripId, targetReceiptId, {
        baseTripVersion: 0,
        idempotencyKey: 'synthetic-undo-key',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 400,
    });
    expect(repository.undoAdoption).not.toHaveBeenCalled();
  });
});

function planningRepository(
  result: UndoRouteAdoptionResult,
): RoutePlanningRepository {
  return {
    saveCandidateSnapshots: vi.fn(),
    findSnapshotOwned: vi.fn(),
    createPreview: vi.fn(),
    findPreviewOwned: vi.fn(),
    undoAdoption: vi.fn().mockResolvedValue(result),
  };
}

function stubTripService(): TripService {
  const service = new TripService({} as TripRepository);
  vi.spyOn(service, 'getTrip').mockResolvedValue({
    id: tripId,
    version: 14,
  } as TripView);
  return service;
}

function undoReceipt(): OperationReceiptRecord {
  return {
    id: undoReceiptId,
    ownerUserId,
    tripId,
    operationType: 'ROUTE_UNDO',
    idempotencyKey: 'synthetic-undo-key',
    requestHash: hashRouteUndoRequest({
      tripId,
      targetOperationReceiptId: targetReceiptId,
      baseTripVersion: 13,
    }),
    baseTripVersion: 13,
    resultingTripVersion: 14,
    previewId,
    adoptedRouteId,
    targetOperationReceiptId: targetReceiptId,
    undoExpiresAt: null,
    delta: {
      schemaVersion: 'route-undo-delta-v1',
      targetOperationReceiptId: targetReceiptId,
      undoneAdoptedRouteId: adoptedRouteId,
      restoredAdoptedRouteId: null,
      removedCreatedNodeIds: [],
      restoredNodeIds: [],
      removedCreatedTransportEdgeIds: [],
      restoredTransportEdgeIds: [],
      restoredDayOccurrenceIds: [],
      removedAdoptCreatedDayOccurrenceIds: [],
      restoredOwnedDates: [],
    },
    createdAt: now,
  };
}
