import { resolveCurrentRouteReplacementCorridor } from '@travel/domain';
import type { Prisma } from './generated/prisma/client.js';

export async function resolveLockedRouteCorridor(
  transaction: Prisma.TransactionClient,
  tripId: string,
  fromNodeId: string,
  toNodeId: string,
) {
  const [nodes, edges, routes] = await Promise.all([
    transaction.itineraryNode.findMany({
      where: { tripId },
      select: { id: true, kind: true, source: true, adoptedRouteId: true },
      orderBy: [
        { dayOccurrence: { sequence: 'asc' } },
        { position: 'asc' },
        { id: 'asc' },
      ],
    }),
    transaction.transportEdge.findMany({
      where: { tripId },
      select: {
        id: true,
        tripId: true,
        fromNodeId: true,
        toNodeId: true,
        source: true,
        adoptedRouteId: true,
      },
    }),
    transaction.adoptedRoute.findMany({
      where: { tripId, status: 'ACTIVE' },
      select: {
        id: true,
        tripId: true,
        status: true,
        anchorFromNodeId: true,
        anchorToNodeId: true,
      },
    }),
  ]);
  return resolveCurrentRouteReplacementCorridor(
    tripId,
    nodes,
    edges,
    routes,
    fromNodeId,
    toNodeId,
  );
}
