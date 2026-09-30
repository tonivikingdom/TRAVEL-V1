import {
  ApplicationError,
  externalOriginView,
  type ExternalExecutionOriginRepository,
  type ExternalOriginContext,
} from '@travel/application';
import type { ExternalOriginMutationResponse } from '@travel/contracts';
import { resolveExecutionFrontier } from '@travel/domain';
import { Prisma, type PrismaClient } from './generated/prisma/client.js';
import { readExternalOriginGroundLeg } from './prisma-ground-transit-repository.js';

type Client = PrismaClient | Prisma.TransactionClient;
export class PrismaExternalExecutionOriginRepository implements ExternalExecutionOriginRepository {
  constructor(private readonly client: PrismaClient) {}
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
        if (input.action === 'ARRIVAL') {
          const candidate = await input.revalidate(context);
          if (context.origins.some((row) => row.status === 'ARRIVED'))
            throw error('EXTERNAL_ORIGIN_CONFLICT');
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
            ...context.origins.filter((row) => row.id !== origin.id),
          ],
        };
        const response = {
          origin: externalOriginView(origin, updatedContext),
          resultingTripVersion: trip.version,
        };
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
