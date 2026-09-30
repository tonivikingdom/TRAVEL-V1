import { createHash } from 'node:crypto';
import type { Prisma } from './generated/prisma/client.js';

/** Exact immutable prefix evidence, including endpoint facts; no ORM metadata
 * rewritten by timeline renumbering. Scope/topology is validated separately.
 */
export async function hashPreservedRoutePrefix(
  transaction: Prisma.TransactionClient,
  tripId: string,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
) {
  const [nodes, edges] = await Promise.all([
    transaction.itineraryNode.findMany({
      where: { tripId, id: { in: [...nodeIds] } },
      select: {
        id: true,
        kind: true,
        placeId: true,
        note: true,
        source: true,
        adoptedRouteId: true,
        provider: true,
        providerPlaceRef: true,
        providerHubRef: true,
        sourceOperationId: true,
        autoReplaceable: true,
        userModifiedAt: true,
        temporalValues: { orderBy: { id: 'asc' } },
        timeIntents: { orderBy: { id: 'asc' } },
      },
      orderBy: { id: 'asc' },
    }),
    transaction.transportEdge.findMany({
      where: { tripId, id: { in: [...edgeIds] } },
      include: {
        temporalValues: { orderBy: { id: 'asc' } },
        dayProjections: {
          orderBy: [{ dayOccurrenceId: 'asc' }, { role: 'asc' }],
        },
      },
      orderBy: { id: 'asc' },
    }),
  ]);
  return createHash('sha256')
    .update(JSON.stringify({ nodes, edges }))
    .digest('hex');
}
