import {
  ApplicationError,
  externalOriginView,
  type ExternalExecutionOriginRepository,
  type ExternalOriginContext,
  type ExternalOriginRecord,
} from '@travel/application';
import type { ExternalOriginMutationResponse } from '@travel/contracts';
import {
  resolveExecutionFrontier,
  resolveExternalExecutionOriginCurrentness,
} from '@travel/domain';
import { Prisma, type PrismaClient } from './generated/prisma/client.js';
import { readExternalOriginGroundLeg } from './prisma-ground-transit-repository.js';

type Client = PrismaClient | Prisma.TransactionClient;
export class PrismaExternalExecutionOriginRepository implements ExternalExecutionOriginRepository {
  constructor(private readonly client: PrismaClient) {}
  readPlanning(input: {
    ownerUserId: string;
    tripId: string;
    externalOriginId: string;
  }) {
    return loadExternalOriginPlanningContext(this.client, input);
  }
  read(input: Parameters<ExternalExecutionOriginRepository['read']>[0]) {
    return loadContext(
      this.client,
      input.ownerUserId,
      input.tripId,
      input.transportEdgeId,
    );
  }
  async mutate(
    input: Parameters<ExternalExecutionOriginRepository['mutate']>[0],
  ): Promise<ExternalOriginMutationResponse> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT true FROM pg_advisory_xact_lock(hashtextextended(${input.ownerUserId}, 2))`;
        const rows = await tx.$queryRaw<
          readonly { id: string; version: number }[]
        >`SELECT "id","version" FROM "Trip" WHERE "id"=${input.tripId}::uuid AND "ownerUserId"=${input.ownerUserId}::uuid FOR UPDATE`;
        if (rows.length === 0) throw error('NOT_FOUND');
        const receipt = await tx.externalExecutionOriginReceipt.findUnique({
          where: {
            ownerUserId_idempotencyKey: {
              ownerUserId: input.ownerUserId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (receipt !== null) {
          if (receipt.requestHash !== input.requestHash)
            throw error('IDEMPOTENCY_CONFLICT');
          return receipt.response as unknown as ExternalOriginMutationResponse;
        }
        if (rows[0]!.version !== input.baseTripVersion)
          throw error('VERSION_CONFLICT');
        const context = (await loadContext(
          tx,
          input.ownerUserId,
          input.tripId,
          input.transportEdgeId,
        ))!;
        let origin;
        const invalidated: ExternalOriginRecord[] = [];
        if (input.action === 'ARRIVAL') {
          const candidate = await input.revalidate(context);
          const openOrigins = context.origins.filter(
            (row) => row.status === 'ARRIVED',
          );
          // Recompute all proof before any write. Persisted ARRIVED history may
          // already be superseded; CURRENT and inconsistent evidence stay blocked.
          for (const existing of openOrigins) {
            const currentness = resolveExternalExecutionOriginCurrentness({
              origin: existing,
              origins: context.origins,
              executionEvents: context.executionEvents,
              frontierState: context.frontierState,
            });
            if (currentness !== 'SUPERSEDED' || input.now < existing.arrivedAt)
              throw error('EXTERNAL_ORIGIN_CONFLICT');
          }
          for (const existing of openOrigins) {
            invalidated.push(
              await tx.externalExecutionOrigin.update({
                where: { id: existing.id },
                data: { status: 'INVALIDATED', invalidatedAt: input.now },
              }),
            );
          }
          const { candidateRef: _candidateRef, ...metadata } = candidate;
          void _candidateRef;
          origin = await tx.externalExecutionOrigin.create({
            data: {
              ...metadata,
              sourceObservationFetchedAt: new Date(
                metadata.sourceObservationFetchedAt,
              ),
              ownerUserId: input.ownerUserId,
              tripId: input.tripId,
              arrivedAt: input.now,
            },
          });
        } else {
          const current = context.origins.find(
            (row) => row.id === input.originId,
          );
          if (current === undefined) throw error('NOT_FOUND');
          if (current.status !== 'ARRIVED' || input.now < current.arrivedAt)
            throw error('EXTERNAL_ORIGIN_CONFLICT');
          origin = await tx.externalExecutionOrigin.update({
            where: { id: current.id },
            data: { status: 'DEPARTED', departedAt: input.now },
          });
        }
        const trip = await tx.trip.update({
          where: { id: input.tripId },
          data: { version: { increment: 1 } },
          select: { version: true },
        });
        const updatedContext = {
          ...context,
          origins: [
            origin,
            ...context.origins
              .filter((row) => row.id !== origin.id)
              .map(
                (row) =>
                  invalidated.find((updated) => updated.id === row.id) ?? row,
              ),
          ],
        };
        const response = {
          origin: externalOriginView(origin, updatedContext),
          resultingTripVersion: trip.version,
        };
        const arrivalOrDepartureReceipt =
          await tx.externalExecutionOriginReceipt.create({
            data: {
              ownerUserId: input.ownerUserId,
              tripId: input.tripId,
              externalOriginId: origin.id,
              transition: input.action,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
              occurredAt: input.now,
              resultingTripVersion: trip.version,
              response: response as unknown as Prisma.InputJsonValue,
            },
          });
        for (const previous of invalidated) {
          await tx.externalExecutionOriginReceipt.create({
            data: {
              ownerUserId: input.ownerUserId,
              tripId: input.tripId,
              externalOriginId: previous.id,
              transition: 'INVALIDATION',
              idempotencyKey: null,
              requestHash: input.requestHash,
              triggeringReceiptId: arrivalOrDepartureReceipt.id,
              invalidationReason: 'SUPERSEDED_BY_LATER_EXECUTION',
              occurredAt: input.now,
              resultingTripVersion: trip.version,
              response: {
                origin: externalOriginView(previous, updatedContext),
                triggeringReceiptId: arrivalOrDepartureReceipt.id,
                newExternalOriginId: origin.id,
                reason: 'SUPERSEDED_BY_LATER_EXECUTION',
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return response;
      },
      { timeout: 10_000 },
    );
  }
}
async function loadContext(
  client: Client,
  ownerUserId: string,
  tripId: string,
  transportEdgeId: string | null,
): Promise<ExternalOriginContext | null> {
  const trip = await client.trip.findFirst({
    where: { id: tripId, ownerUserId },
    select: {
      version: true,
      nodes: {
        orderBy: [
          { dayOccurrence: { sequence: 'asc' } },
          { position: 'asc' },
          { id: 'asc' },
        ],
        select: {
          id: true,
          provider: true,
          providerHubRef: true,
          temporalValues: { where: { layer: 'ACTUAL' } },
          executionState: true,
        },
      },
      executionEvents: { where: { undoneAt: null } },
      externalExecutionOrigins: {
        orderBy: [{ arrivedAt: 'desc' }, { id: 'desc' }],
      },
    },
  });
  if (trip === null) return null;
  const leg =
    transportEdgeId === null
      ? null
      : await readExternalOriginGroundLeg(client, tripId, transportEdgeId);
  const row =
    leg === null
      ? null
      : await client.groundTransitLegExecution.findUnique({
          where: { id: leg.id },
          select: {
            latestObservationId: true,
            latestFetchedAt: true,
            latestObservationHash: true,
          },
        });
  const evidence =
    row?.latestObservationId == null ||
    row.latestFetchedAt === null ||
    row.latestObservationHash === null
      ? null
      : await client.groundTransitObservation.findFirst({
          where: {
            legExecutionId: leg!.id,
            observationIdentity: row.latestObservationId,
            fetchedAt: row.latestFetchedAt,
            factsHash: row.latestObservationHash,
          },
        });
  return {
    tripId,
    tripVersion: trip.version,
    leg,
    evidence:
      evidence === null
        ? null
        : {
            id: evidence.id,
            identity: evidence.observationIdentity,
            fetchedAt: evidence.fetchedAt,
            factsHash: evidence.factsHash,
          },
    itineraryHubs: trip.nodes,
    origins: trip.externalExecutionOrigins,
    executionEvents: trip.executionEvents,
    frontierState: resolveExecutionFrontier(
      trip.nodes.map((node, position) => ({
        id: node.id,
        sequence: 0,
        position,
        targetKind: 'PLACE',
        latitude: null,
        longitude: null,
        hasActualArrival: node.temporalValues.some(
          (value) => value.pointKind === 'ARRIVAL',
        ),
        hasActualDeparture: node.temporalValues.some(
          (value) => value.pointKind === 'DEPARTURE',
        ),
        executionStatus: node.executionState?.status ?? null,
      })),
    ).state,
  };
}
function error(
  code:
    | 'NOT_FOUND'
    | 'IDEMPOTENCY_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'EXTERNAL_ORIGIN_CONFLICT',
) {
  return new ApplicationError(
    code,
    code === 'NOT_FOUND'
      ? '执行记录不存在。'
      : '执行事实或版本已变化，请刷新。',
    code === 'NOT_FOUND' ? 404 : 409,
  );
}

export async function loadExternalOriginPlanningContext(
  client: Client,
  input: { ownerUserId: string; tripId: string; externalOriginId: string },
): Promise<import('@travel/application').ExternalOriginPlanningContext | null> {
  const context = await loadContext(
    client,
    input.ownerUserId,
    input.tripId,
    null,
  );
  if (context === null) return null;
  const origin =
    context.origins.find((row) => row.id === input.externalOriginId) ?? null;
  const sourceRoute =
    origin === null
      ? null
      : await client.adoptedRoute.findFirst({
          where: {
            id: origin.sourceAdoptedRouteId,
            tripId: input.tripId,
            trip: { ownerUserId: input.ownerUserId },
          },
          select: { id: true, status: true, anchorToNodeId: true },
        });
  const sourceEdge =
    origin === null
      ? null
      : await client.transportEdge.findFirst({
          where: { id: origin.sourceTransportEdgeId, tripId: input.tripId },
          select: { id: true, source: true, adoptedRouteId: true },
        });
  return { ...context, origin, sourceRoute, sourceEdge };
}
