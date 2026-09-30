import type { GroundTransitRouteProgressRepository } from '@travel/application';

import type { PrismaClient } from './generated/prisma/client.js';

/** Only independent user execution/location evidence may invalidate a planned origin. */
export class PrismaGroundTransitRouteProgressRepository implements GroundTransitRouteProgressRepository {
  constructor(private readonly client: PrismaClient) {}

  async hasIndependentProgress(
    input: Parameters<
      GroundTransitRouteProgressRepository['hasIndependentProgress']
    >[0],
  ): Promise<boolean> {
    const ownerTrip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: { id: true },
    });
    if (ownerTrip === null || input.corridorNodeIds.length < 2) return false;
    const laterNodeIds = input.corridorNodeIds.slice(1);
    const [actual, skipped, location, leg, failureTransition] =
      await Promise.all([
        this.client.temporalValue.findFirst({
          where: {
            layer: 'ACTUAL',
            OR: [
              { nodeId: input.fromNodeId, pointKind: 'DEPARTURE' },
              { nodeId: { in: laterNodeIds } },
            ],
          },
          select: { id: true },
        }),
        this.client.nodeExecutionState.findFirst({
          where: {
            tripId: input.tripId,
            nodeId: { in: laterNodeIds },
            status: 'SKIPPED',
          },
          select: { nodeId: true },
        }),
        this.client.executionLocationState.findUnique({
          where: { tripId: input.tripId },
          select: { currentNodeId: true, locationStatus: true },
        }),
        this.client.groundTransitLegExecution.findFirst({
          where: { id: input.legExecutionId, tripId: input.tripId },
          select: { state: true },
        }),
        this.client.groundTransitStateTransition.findFirst({
          where: {
            legExecutionId: input.legExecutionId,
            toState: 'NO_LONGER_FEASIBLE',
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          select: { fromState: true },
        }),
      ]);
    return (
      actual !== null ||
      skipped !== null ||
      (location?.locationStatus === 'RELIABLE' &&
        location.currentNodeId !== null &&
        laterNodeIds.includes(location.currentNodeId)) ||
      leg?.state === 'IN_PROGRESS' ||
      leg?.state === 'ARRIVED_PENDING_HANDOFF' ||
      leg?.state === 'COMPLETED' ||
      (leg?.state === 'NO_LONGER_FEASIBLE' &&
        (failureTransition?.fromState === 'IN_PROGRESS' ||
          failureTransition?.fromState === 'ARRIVED_PENDING_HANDOFF' ||
          failureTransition?.fromState === 'COMPLETED'))
    );
  }
}
