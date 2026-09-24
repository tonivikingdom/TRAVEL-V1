import { isTripExecutionNaturallyComplete } from '@travel/domain';

import { Prisma } from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;

export async function stopTripAssistanceIfNaturallyComplete(
  transaction: Transaction,
  tripId: string,
  now: Date,
): Promise<boolean> {
  const occurrences = await transaction.dayOccurrence.findMany({
    where: { tripId },
    select: {
      sequence: true,
      nodes: {
        select: {
          id: true,
          position: true,
          temporalValues: {
            where: {
              layer: 'ACTUAL',
              pointKind: { in: ['ARRIVAL', 'DEPARTURE'] },
            },
            select: { pointKind: true },
          },
          executionState: { select: { status: true } },
        },
      },
    },
  });
  const complete = isTripExecutionNaturallyComplete(
    occurrences.flatMap((occurrence) =>
      occurrence.nodes.map((node) => ({
        id: node.id,
        sequence: occurrence.sequence,
        position: node.position,
        latitude: null,
        longitude: null,
        targetKind: 'PLACE' as const,
        hasActualArrival: node.temporalValues.some(
          (value) => value.pointKind === 'ARRIVAL',
        ),
        hasActualDeparture: node.temporalValues.some(
          (value) => value.pointKind === 'DEPARTURE',
        ),
        executionStatus: node.executionState?.status ?? null,
      })),
    ),
  );
  if (!complete) return false;

  const stopped = await transaction.tripAssistanceCapability.updateMany({
    where: { tripId, state: { in: ['ENABLED', 'PAUSED'] } },
    data: {
      state: 'STOPPED',
      revision: { increment: 1 },
      stoppedAt: now,
      stopReason: 'NATURAL_END',
    },
  });
  if (stopped.count === 0) return false;
  await transaction.executionLocationState.deleteMany({ where: { tripId } });
  return true;
}
