import { expect, it, vi } from 'vitest';
import type { Actor } from '../src/authorization.js';
import type { TripView, PlaceSearchCandidate } from '@travel/contracts';
import { PlaceSearchService } from '../src/place-search-service.js';

it('SYNTHETIC current selection preserves version/owner checks but persists Provider identity only as note, never as verified route metadata', async () => {
  const actor: Actor = {
    userId: 'SYNTHETIC-owner',
    email: 'owner@synthetic.example.test',
    role: 'USER',
    status: 'ACTIVE',
  };
  const coordinates = { latitude: 35.68, longitude: 139.76 };
  const candidate: PlaceSearchCandidate = {
    provider: 'google',
    externalId: 'SYNTHETIC_GOOGLE_PLACE_ID',
    providerPlaceRef: 'SYNTHETIC_GOOGLE_PLACE_ID',
    name: 'SYNTHETIC place',
    formattedAddress: null,
    coordinateSystem: 'WGS84',
    coordinates,
    attribution: 'SYNTHETIC Google fixture',
    synthetic: true,
  };
  const trips = {
    getTrip: vi.fn(async () => ({}) as TripView),
    executeAuthoring: vi.fn(async () => ({}) as TripView),
  };
  const service = new PlaceSearchService(
    { search: async () => [candidate] },
    trips,
    () => new Date('2031-01-01T00:00:00Z'),
  );
  const results = await service.search(actor, 'SYNTHETIC-trip', 'SYNTHETIC');
  const input = {
    selectionToken: results.candidates[0]!.selectionToken,
    baseTripVersion: 7,
    idempotencyKey: 'SYNTHETIC-key',
    targetDay: { type: 'NEW' as const, localDate: '2031-01-01', sequence: 0 },
    position: 0,
  };
  await service.select(actor, 'SYNTHETIC-trip', input);
  expect(trips.executeAuthoring).toHaveBeenCalledWith(
    actor,
    'SYNTHETIC-trip',
    expect.objectContaining({
      baseTripVersion: 7,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay: input.targetDay,
        position: 0,
        place: {
          type: 'CUSTOM',
          name: 'SYNTHETIC place',
          address: null,
          ...coordinates,
        },
        note: expect.stringContaining('SYNTHETIC_GOOGLE_PLACE_ID'),
      },
    }),
  );
  await expect(
    service.select(
      { ...actor, userId: 'SYNTHETIC-other' },
      'SYNTHETIC-trip',
      input,
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  await expect(
    service.select(actor, 'SYNTHETIC-other-trip', input),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(trips.executeAuthoring).toHaveBeenCalledTimes(1);
  trips.executeAuthoring.mockRejectedValueOnce(
    Object.assign(new Error('SYNTHETIC version conflict'), {
      code: 'VERSION_CONFLICT',
    }),
  );
  await expect(
    service.select(actor, 'SYNTHETIC-trip', input),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
});
