import type { InTripView } from '@travel/contracts';
import type { Actor } from './authorization.js';
import { authorize } from './authorization.js';
import { ApplicationError } from './errors.js';

export interface InTripReadRepository {
  findOwned(ownerUserId: string, tripId: string): Promise<InTripView | null>;
}

export class InTripReadService {
  constructor(private readonly repository: InTripReadRepository) {}

  async read(actor: Actor, tripId: string): Promise<InTripView> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        tripId,
      )
    )
      throw new ApplicationError('VALIDATION_ERROR', '旅行编号无效。', 400);
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const result = await this.repository.findOwned(actor.userId, tripId);
    if (!result) throw new ApplicationError('NOT_FOUND', '旅行不存在。', 404);
    return result;
  }
}
