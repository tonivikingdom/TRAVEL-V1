import { describe, it, expect, vi } from 'vitest';
import type { Actor } from '../src/authorization.js';
import type { TripView, PlaceSearchCandidate } from '@travel/contracts';
import { PlaceSearchService } from '../src/place-search-service.js';
const actor: Actor = {
  userId: 'SYNTHETIC-owner',
  email: 'owner@synthetic.example.test',
  role: 'USER',
  status: 'ACTIVE',
};
const candidate: PlaceSearchCandidate = {
  provider: 'synthetic',
  externalId: 'SYNTHETIC:123',
  name: 'SYNTHETIC 東京駅',
  formattedAddress: null,
  coordinates: { latitude: 35, longitude: 139 },
  attribution: 'SYNTHETIC fixture',
  synthetic: true,
};
function setup() {
  let clock = new Date('2030-01-01T00:00:00Z');
  const provider = { search: vi.fn(async () => [candidate]) };
  const trips = {
    getTrip: vi.fn(async () => ({}) as TripView),
    executeAuthoring: vi.fn(async () => ({}) as TripView),
  };
  const service = new PlaceSearchService(provider, trips, () => clock, 2);
  return {
    provider,
    trips,
    service,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
const select = (token: string) => ({
  selectionToken: token,
  baseTripVersion: 1,
  idempotencyKey: 'SYNTHETIC-key',
  targetDay: { type: 'NEW' as const, localDate: '2030-01-01', sequence: 0 },
  position: 0,
});
describe('Place Search selection evidence', () => {
  it('rejects expired evidence and restart evidence without authoring', async () => {
    const s = setup();
    const response = await s.service.search(actor, 'SYNTHETIC-trip', '東京駅');
    s.advance(86400001);
    await expect(
      s.service.select(
        actor,
        'SYNTHETIC-trip',
        select(response.candidates[0]!.selectionToken),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      setup().service.select(
        actor,
        'SYNTHETIC-trip',
        select(response.candidates[0]!.selectionToken),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.trips.executeAuthoring).not.toHaveBeenCalled();
  });
  it('throttles explicit calls and bounds daily spend without retries; resets on a new UTC day', async () => {
    const s = setup();
    await s.service.search(actor, 'SYNTHETIC-trip', '東京駅');
    await expect(
      s.service.search(actor, 'SYNTHETIC-trip', '東京駅'),
    ).rejects.toMatchObject({ code: 'PLACE_SEARCH_UNAVAILABLE' });
    s.advance(2000);
    await s.service.search(actor, 'SYNTHETIC-trip', '東京駅');
    s.advance(2000);
    await expect(
      s.service.search(actor, 'SYNTHETIC-trip', '東京駅'),
    ).rejects.toMatchObject({ code: 'PLACE_SEARCH_UNAVAILABLE' });
    expect(s.provider.search).toHaveBeenCalledTimes(2);
    s.advance(86400000);
    await s.service.search(actor, 'SYNTHETIC-trip', '東京駅');
    expect(s.provider.search).toHaveBeenCalledTimes(3);
  });
  it.each(['', ' '.repeat(4), '名'.repeat(201)])(
    'rejects invalid query before Provider call',
    async (query) => {
      const s = setup();
      await expect(
        s.service.search(actor, 'SYNTHETIC-trip', query),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(s.provider.search).not.toHaveBeenCalled();
    },
  );
  it('authorizes the Trip before Provider access', async () => {
    const s = setup();
    s.trips.getTrip.mockRejectedValue(new Error('not owned'));
    await expect(
      s.service.search(actor, 'SYNTHETIC-trip', '東京駅'),
    ).rejects.toThrow('not owned');
    expect(s.provider.search).not.toHaveBeenCalled();
  });
  it('selection constructs only one existing explicit command from signed fields, including source attribution', async () => {
    const s = setup();
    const r = await s.service.search(actor, 'SYNTHETIC-trip', '東京駅');
    await s.service.select(
      actor,
      'SYNTHETIC-trip',
      select(r.candidates[0]!.selectionToken),
    );
    expect(s.trips.executeAuthoring).toHaveBeenCalledWith(
      actor,
      'SYNTHETIC-trip',
      expect.objectContaining({
        baseTripVersion: 1,
        idempotencyKey: 'SYNTHETIC-key',
        command: expect.objectContaining({
          type: 'ADD_PLACE_VISIT',
          place: {
            type: 'CUSTOM',
            name: candidate.name,
            address: null,
            latitude: 35,
            longitude: 139,
          },
          note: expect.stringContaining(candidate.externalId),
        }),
      }),
    );
  });
});
