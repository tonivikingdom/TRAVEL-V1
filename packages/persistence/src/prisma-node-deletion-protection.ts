import type { GeneratedNodeDeletionReferenceFacts } from '@travel/application';

import type { Prisma } from './generated/prisma/client.js';

// Unadopted snapshots/previews remain temporary and may cascade normally.
// All route statuses and all receipt types retain their planning evidence.
const retainedSnapshot = {
  OR: [
    { adoptedRoutes: { some: {} } },
    {
      previews: {
        some: {
          OR: [
            { adoptedRoutes: { some: {} } },
            { operationReceipts: { some: {} } },
          ],
        },
      },
    },
  ],
} satisfies Prisma.RouteCandidateSnapshotWhereInput;

export const nodeDeletionReferenceInclude = {
  _count: {
    select: {
      adoptedRouteAnchorFrom: true,
      adoptedRouteAnchorTo: true,
      routeSnapshotsFrom: { where: retainedSnapshot },
      routeSnapshotsTo: { where: retainedSnapshot },
    },
  },
} satisfies Prisma.ItineraryNodeInclude;

export function nodeDeletionReferenceFacts(node: {
  readonly _count: {
    readonly adoptedRouteAnchorFrom: number;
    readonly adoptedRouteAnchorTo: number;
    readonly routeSnapshotsFrom: number;
    readonly routeSnapshotsTo: number;
  };
}): GeneratedNodeDeletionReferenceFacts {
  return {
    adoptedRouteAnchor:
      node._count.adoptedRouteAnchorFrom + node._count.adoptedRouteAnchorTo > 0,
    retainedPlanningData:
      node._count.routeSnapshotsFrom + node._count.routeSnapshotsTo > 0,
  };
}
