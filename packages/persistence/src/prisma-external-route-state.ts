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

/** Stable execution evidence; ORM created/updated timestamps are not semantic. */
export async function externalGroundTransitExecutionFacts(
  tx: Prisma.TransactionClient,
  tripId: string,
  adoptedRouteId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await tx.groundTransitLegExecution.findMany({
    where: { tripId, adoptedRouteId },
    select: {
      id: true,
      tripId: true,
      adoptedRouteId: true,
      transportEdgeId: true,
      legIndex: true,
      provider: true,
      mode: true,
      serviceClass: true,
      serviceIdentityKey: true,
      baseline: true,
      state: true,
      latestFetchedAt: true,
      latestObservationId: true,
      latestObservationHash: true,
      latestObservation: true,
      deviationStartedAt: true,
      deviationCount: true,
      nextCheckAt: true,
      observations: {
        select: {
          id: true,
          legExecutionId: true,
          observationIdentity: true,
          fetchedAt: true,
          factsHash: true,
          facts: true,
        },
        orderBy: { id: 'asc' },
      },
      stateTransitions: { orderBy: { id: 'asc' } },
    },
    orderBy: { id: 'asc' },
  });
  return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
}

/** Keep historical legs, but serialize new FK evidence until Undo completes. */
export async function lockExternalGroundTransitExecutionRows(
  tx: Prisma.TransactionClient,
  tripId: string,
  adoptedRouteId: string,
) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GroundTransitLegExecution"
    WHERE "tripId"=${tripId}::uuid AND "adoptedRouteId"=${adoptedRouteId}::uuid
    ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GroundTransitObservation"
    WHERE "legExecutionId" IN (SELECT "id" FROM "GroundTransitLegExecution"
      WHERE "tripId"=${tripId}::uuid AND "adoptedRouteId"=${adoptedRouteId}::uuid)
    ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GroundTransitStateTransition"
    WHERE "legExecutionId" IN (SELECT "id" FROM "GroundTransitLegExecution"
      WHERE "tripId"=${tripId}::uuid AND "adoptedRouteId"=${adoptedRouteId}::uuid)
    ORDER BY "id" FOR UPDATE`);
}
