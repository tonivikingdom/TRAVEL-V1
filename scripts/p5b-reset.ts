import type { PrismaClient } from '../packages/persistence/src/index.js';

import { isP5bSyntheticEmail } from './p5b-support.js';

export interface P5bResetResult {
  readonly matchedUsers: number;
  readonly deletedUsers: number;
  readonly deletedDeliveryRequests: number;
  readonly deletedJobs: number;
}

export async function countP5bSyntheticUsers(
  client: PrismaClient,
): Promise<number> {
  const candidates = await client.user.findMany({
    where: { normalizedEmail: { endsWith: '@synthetic.example.test' } },
    select: { normalizedEmail: true },
  });
  return candidates.filter((item) => isP5bSyntheticEmail(item.normalizedEmail))
    .length;
}

export async function resetP5bSyntheticData(
  client: PrismaClient,
): Promise<P5bResetResult> {
  return client.$transaction(async (transaction) => {
    const candidateUsers = await transaction.user.findMany({
      where: { normalizedEmail: { endsWith: '@synthetic.example.test' } },
      select: { id: true, normalizedEmail: true },
    });
    const users = candidateUsers.filter((item) =>
      isP5bSyntheticEmail(item.normalizedEmail),
    );
    const userIds = users.map((item) => item.id);
    const emails = users.map((item) => item.normalizedEmail);
    const candidateDeliveries =
      await transaction.magicLinkDeliveryRequest.findMany({
        where: { normalizedEmail: { endsWith: '@synthetic.example.test' } },
        select: { id: true, normalizedEmail: true },
      });
    const deliveryIds = candidateDeliveries
      .filter((item) => isP5bSyntheticEmail(item.normalizedEmail))
      .map((item) => item.id);
    const invitations = await transaction.invitation.findMany({
      where: {
        OR: [
          ...(emails.length === 0 ? [] : [{ normalizedEmail: { in: emails } }]),
          ...(userIds.length === 0
            ? []
            : [{ invitedByUserId: { in: userIds } }]),
        ],
      },
      select: { id: true },
    });
    const invitationIds = invitations.map((item) => item.id);
    const trips = await transaction.trip.findMany({
      where: { ownerUserId: { in: userIds } },
      select: { id: true },
    });
    const tripIds = trips.map((item) => item.id);

    const jobs = await transaction.job.deleteMany({
      where: { payloadRef: { in: deliveryIds } },
    });
    await transaction.magicLinkToken.deleteMany({
      where: {
        OR: [
          { userId: { in: userIds } },
          { invitationId: { in: invitationIds } },
          { deliveryRequestId: { in: deliveryIds } },
        ],
      },
    });
    await transaction.session.deleteMany({
      where: { userId: { in: userIds } },
    });
    await transaction.outboxEvent.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.operationReceipt.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    const history = await transaction.transportEdgeHistory.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true },
    });
    await transaction.transportEdgeHistoryTimeValue.deleteMany({
      where: { transportEdgeHistoryId: { in: history.map((item) => item.id) } },
    });
    await transaction.transportEdgeHistory.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    const nodes = await transaction.itineraryNode.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true },
    });
    const edges = await transaction.transportEdge.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true },
    });
    await transaction.temporalValue.deleteMany({
      where: {
        OR: [
          { nodeId: { in: nodes.map((item) => item.id) } },
          { transportEdgeId: { in: edges.map((item) => item.id) } },
        ],
      },
    });
    await transaction.userTimeIntent.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.transportDayProjection.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.transportEdge.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.adoptedRoute.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.routePreview.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.routeCandidateSnapshot.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.itineraryNode.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.dayOccurrence.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.dateOwnership.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await transaction.trip.deleteMany({ where: { id: { in: tripIds } } });
    await transaction.place.deleteMany({
      where: { ownerUserId: { in: userIds } },
    });
    await transaction.notificationEvent.deleteMany({
      where: { ownerUserId: { in: userIds } },
    });
    await transaction.storedObject.deleteMany({
      where: { ownerUserId: { in: userIds } },
    });
    await transaction.userPreference.deleteMany({
      where: { userId: { in: userIds } },
    });
    await transaction.invitation.deleteMany({
      where: { id: { in: invitationIds } },
    });
    const deliveries = await transaction.magicLinkDeliveryRequest.deleteMany({
      where: { id: { in: deliveryIds } },
    });
    const deletedUsers = await transaction.user.deleteMany({
      where: { id: { in: userIds } },
    });

    return {
      matchedUsers: users.length,
      deletedUsers: deletedUsers.count,
      deletedDeliveryRequests: deliveries.count,
      deletedJobs: jobs.count,
    };
  });
}
