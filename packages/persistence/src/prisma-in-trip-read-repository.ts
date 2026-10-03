import type { InTripReadRepository } from '@travel/application';
import type { FlightSnapshotView, InTripView } from '@travel/contracts';
import { resolveExecutionFrontier } from '@travel/domain';
import { Prisma, type PrismaClient } from './generated/prisma/client.js';

/** B-owned read projection; no changes to authoring or Provider behavior. */
export class PrismaInTripReadRepository implements InTripReadRepository {
  constructor(private readonly client: PrismaClient) {}

  async findOwned(
    ownerUserId: string,
    tripId: string,
  ): Promise<InTripView | null> {
    return this.client.$transaction(
      async (tx) => {
        const trip = await tx.trip.findFirst({
          where: { id: tripId, ownerUserId },
          select: {
            id: true,
            version: true,
            dayOccurrences: {
              orderBy: { sequence: 'asc' },
              select: {
                sequence: true,
                nodes: {
                  orderBy: { position: 'asc' },
                  select: {
                    id: true,
                    position: true,
                  },
                },
              },
            },
            executionEvents: {
              where: { undoneAt: null },
              select: {
                nodeId: true,
                type: true,
                occurredAt: true,
              },
            },
            flightBindings: {
              where: {
                transportEdge: { mode: 'FLIGHT', provider: 'aerodatabox' },
              },
              select: {
                transportEdgeId: true,
                providerFlightRef: true,
                transportEdge: { select: { providerRef: true } },
                selectedSnapshot: true,
                latestSnapshot: true,
                monitorState: { select: { providerUnavailableWarned: true } },
              },
            },
          },
        });
        if (!trip) return null;
        // Only explicit, non-undone user execution events enter the frontier.
        // Vehicle observations and propagated schedule ACTUALs are not evidence.
        const frontier = resolveExecutionFrontier(
          trip.dayOccurrences.flatMap((day) =>
            day.nodes.map((node) => ({
              id: node.id,
              sequence: day.sequence,
              position: node.position,
              latitude: null,
              longitude: null,
              targetKind: 'PLACE' as const,
              hasActualArrival: trip.executionEvents.some(
                (e) => e.nodeId === node.id && e.type === 'ARRIVAL',
              ),
              hasActualDeparture: trip.executionEvents.some(
                (e) => e.nodeId === node.id && e.type === 'DEPARTURE',
              ),
              executionStatus: trip.executionEvents.some(
                (e) => e.nodeId === node.id && e.type === 'SKIP_CONFIRMED',
              )
                ? ('SKIPPED' as const)
                : null,
            })),
          ),
        );
        return {
          tripId: trip.id,
          tripVersion: trip.version,
          execution: {
            state: frontier.state,
            currentNodeId: frontier.currentNode?.id ?? null,
            targetNodeId: frontier.targetNode?.id ?? null,
            recordedAt: trip.executionEvents.length
              ? new Date(
                  Math.max(
                    ...trip.executionEvents.map((e) => e.occurredAt.getTime()),
                  ),
                ).toISOString()
              : null,
          },
          flights: trip.flightBindings
            .filter((f) => f.transportEdge.providerRef === f.providerFlightRef)
            .map((f) => ({
              transportEdgeId: f.transportEdgeId,
              selectedSnapshot:
                f.selectedSnapshot as unknown as FlightSnapshotView,
              latestSnapshot: f.latestSnapshot as unknown as FlightSnapshotView,
              providerUnavailable:
                f.monitorState?.providerUnavailableWarned ?? false,
            })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
