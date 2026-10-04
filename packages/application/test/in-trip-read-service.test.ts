import { describe, expect, it, vi } from 'vitest';
import { InTripReadService } from '../src/in-trip-read-service.js';
import type { Actor } from '../src/authorization.js';

const actor: Actor = {
  userId: 'SYNTHETIC-owner',
  email: 'owner@synthetic.example.test',
  role: 'USER',
  status: 'ACTIVE',
};
const tripId = '00000000-0000-4000-8000-000000000002';
describe('P6B owned stored read', () => {
  it('cannot read a foreign Trip, including an administrator', async () => {
    const repository = { findOwned: vi.fn(async () => null) };
    const service = new InTripReadService(repository);
    await expect(
      service.read({ ...actor, role: 'ADMIN' }, tripId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repository.findOwned).toHaveBeenCalledWith(actor.userId, tripId);
  });
  it('rejects disabled actors and malformed identities before repository access', async () => {
    const repository = { findOwned: vi.fn(async () => null) };
    const service = new InTripReadService(repository);
    await expect(
      service.read({ ...actor, status: 'DISABLED' }, tripId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.read(actor, 'bad')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(repository.findOwned).not.toHaveBeenCalled();
  });
});
