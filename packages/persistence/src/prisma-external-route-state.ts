import { createHash } from 'node:crypto';
import { Prisma } from './generated/prisma/client.js';

export function hashExternalRouteAudit(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, v]) => [key, canonical(v)]),
      );
    return item;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))))
    .digest('hex');
}

/** Parent locks serialize new FK child inserts; existing child rows are locked too. */
export async function lockExternalRouteMutationRows(
  tx: Prisma.TransactionClient,
  tripId: string,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
) {
  if (edgeIds.length) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "TransportEdge" WHERE "tripId"=${tripId}::uuid AND "id" IN (${Prisma.join(edgeIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "TemporalValue" WHERE "transportEdgeId" IN (${Prisma.join(edgeIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`,
    );
  }
  if (nodeIds.length) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ItineraryNode" WHERE "tripId"=${tripId}::uuid AND "id" IN (${Prisma.join(nodeIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "TemporalValue" WHERE "nodeId" IN (${Prisma.join(nodeIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "UserTimeIntent" WHERE "nodeId" IN (${Prisma.join(nodeIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Place" WHERE "id" IN (SELECT "placeId" FROM "ItineraryNode" WHERE "tripId"=${tripId}::uuid AND "id" IN (${Prisma.join(nodeIds.map((id) => Prisma.sql`${id}::uuid`))})) ORDER BY "id" FOR UPDATE`,
    );
  }
}

export async function externalGeneratedNodeFacts(
  tx: Prisma.TransactionClient,
  tripId: string,
  ids: readonly string[],
): Promise<Record<string, unknown>[]> {
  const rows = await tx.itineraryNode.findMany({
    where: { tripId, id: { in: [...ids] } },
    include: {
      place: true,
      dayOccurrence: true,
      temporalValues: { orderBy: { id: 'asc' } },
      timeIntents: { orderBy: { id: 'asc' } },
      executionEvents: {
        select: {
          id: true,
          type: true,
          source: true,
          occurredAt: true,
          undoneAt: true,
        },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: { id: 'asc' },
  });
  return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
}
