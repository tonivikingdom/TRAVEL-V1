import { resolveConfirmedRouteExecutionOrigin } from '@travel/domain';
import type { Prisma } from './generated/prisma/client.js';

/** Caller owns the owner/Trip locks; read current durable proof before writing. */
export async function resolveLockedConfirmedRouteExecutionOrigin(
  transaction: Prisma.TransactionClient,
  tripId: string,
  anchorFromNodeId: string,
  anchorToNodeId: string,
) {
  const [nodes, events, origins] = await Promise.all([
    transaction.itineraryNode.findMany({
      where: { tripId },
      orderBy: [
        { dayOccurrence: { sequence: 'asc' } },
        { position: 'asc' },
        { id: 'asc' },
      ],
      select: {
        id: true,
        kind: true,
        executionState: true,
        temporalValues: { where: { layer: 'ACTUAL' } },
      },
    }),
    transaction.executionEvent.findMany({ where: { tripId, undoneAt: null } }),
    transaction.externalExecutionOrigin.findMany({
      where: { tripId },
      select: { arrivedAt: true, departedAt: true },
    }),
  ]);
  const from = nodes.findIndex((node) => node.id === anchorFromNodeId);
  const to = nodes.findIndex((node) => node.id === anchorToNodeId);
  return resolveConfirmedRouteExecutionOrigin({
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      actualArrival:
        node.temporalValues.find((value) => value.pointKind === 'ARRIVAL') ??
        null,
      actualDeparture:
        node.temporalValues.find((value) => value.pointKind === 'DEPARTURE') ??
        null,
      executionStatus: node.executionState?.status ?? null,
    })),
    corridorNodeIds:
      from < 0 || to <= from
        ? []
        : nodes.slice(from, to + 1).map((node) => node.id),
    events,
    externalExecutionFacts: origins.flatMap((origin) => [
      origin.arrivedAt,
      ...(origin.departedAt === null ? [] : [origin.departedAt]),
    ]),
  });
}
