import type { RoutePreviewView, TripView } from '@travel/contracts';
import {
  fixtureTrip,
  fixtureCandidate,
  visit,
  fromId,
  toId,
  dayId,
  tripId,
} from './fixture.js';
export const previewCases = [
  'full',
  'suffix',
  'external',
  'protected',
  'removed',
  'minimal',
  'unknown',
  'expired',
  'long',
] as const;
export type PreviewCase = (typeof previewCases)[number];
export function previewFixture(kind: PreviewCase = 'full'): {
  preview: RoutePreviewView;
  trip: TripView;
} {
  const baseTrip = fixtureTrip();
  const intermediate = {
    ...visit('generated-node', '東京駅・旧乗換口 · SYNTHETIC'),
    position: 1,
    source: 'ROUTE_GENERATED' as const,
    autoReplaceable: true,
  };
  const from = { ...baseTrip.days[0]!.nodes[0]!, timeIntents: [] };
  const to = { ...baseTrip.days[0]!.nodes[1]!, position: 2 };
  const oldEdge = {
    id: 'old-edge',
    fromNodeId: fromId,
    toNodeId: toId,
    mode: 'RAIL' as const,
    fixedService: true,
    serviceLabel: '旧・山手線 · SYNTHETIC',
    note: null,
    source: 'ADOPTED_ROUTE' as const,
    adoptedRouteId: 'old-route',
    provider: 'SYNTHETIC',
    providerRef: null,
    createdAt: baseTrip.createdAt,
    updatedAt: baseTrip.updatedAt,
    timeValues: [],
  };
  let trip: TripView = {
    ...baseTrip,
    days: [{ ...baseTrip.days[0]!, nodes: [from, intermediate, to] }],
    connections: [
      {
        fromNodeId: fromId,
        toNodeId: toId,
        state: 'ACTIVE',
        transport: oldEdge,
      },
    ],
  };
  const baseCandidate = fixtureCandidate();
  const candidate = {
    ...baseCandidate,
    legs: baseCandidate.legs.map((leg) => ({
      ...leg,
      mode: 'RAIL' as const,
      fixedService: true,
      serviceLabel: '新・山手線 · SYNTHETIC',
    })),
  };
  const corridor = {
    replacementScope: 'FULL_CORRIDOR' as const,
    anchorFromNodeId: fromId,
    anchorToNodeId: toId,
    currentNodeIds: [fromId, intermediate.id, toId],
    currentAdoptedRouteId: 'old-route',
  };
  const summary: RoutePreviewView['changeSummary'] = {
    transportAction: 'REPLACE',
    willReplaceTransportEdgeId: oldEdge.id,
    willReplaceTransportEdgeIds: [oldEdge.id],
    requiresGeneratedNodes: false,
    generatedTransferPoints: [],
    proposedSegments: [
      {
        fromRef: 'FROM_NODE',
        toRef: 'TO_NODE',
        legIndex: 0,
        mode: 'RAIL',
        serviceLabel: '新・山手線 · SYNTHETIC',
        providerRef: 'private-provider-ref',
        fixedService: true,
        departure: candidate.overall.departure,
        arrival: candidate.overall.arrival,
        durationSeconds: 1800,
      },
    ],
    routeCorridor: corridor,
    nodesToRemove: [],
    temporalLayer: 'PLANNED',
    temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
    downstreamImpact: {
      nodeId: toId,
      arrival: candidate.overall.arrival.instant,
      departure: '2030-10-01T06:30:00Z',
      projectedDwellSeconds: 3600,
      systemSuggestedDwellSeconds: 3600,
      userMinimumDwellSeconds: null,
      status: 'NORMAL',
      requiredUserAdjustments: [],
    },
  };
  const {
    routeCorridor: omittedCorridor,
    downstreamImpact: omittedImpact,
    ...withoutScopeAndImpact
  } = summary;
  void omittedCorridor;
  void omittedImpact;
  let preview: RoutePreviewView = {
    previewId: 'private-preview-id',
    tripId,
    basisVersion: 1,
    candidateSnapshotId: candidate.candidateSnapshotId,
    candidateHash: 'private-hash',
    policyVersion: 'SYNTHETIC',
    createdAt: candidate.observedAt,
    expiresAt: candidate.snapshotExpiresAt,
    adoptable: true,
    status: 'ACTIVE',
    currentConnection: {
      fromNodeId: fromId,
      toNodeId: toId,
      state: 'ACTIVE',
      transport: oldEdge,
    },
    candidate,
    changeSummary: summary,
  };
  if (kind === 'suffix')
    preview = {
      ...preview,
      changeSummary: {
        ...summary,
        routeCorridor: {
          ...corridor,
          replacementScope: 'SUFFIX',
          preservedPrefixNodeIds: ['prefix-node'],
          preservedPrefixTransportEdgeIds: ['prefix-edge'],
        },
      },
    };
  if (kind === 'external')
    preview = {
      ...preview,
      changeSummary: {
        ...withoutScopeAndImpact,
        externalOriginReplacement: {
          replacementScope: 'EXTERNAL_ORIGIN',
          externalOriginId: 'secret-origin-id',
          sourceAdoptedRouteId: 'secret-source-route',
          sourceTransportEdgeId: 'secret-source-edge',
          sourceGroundTransitLegExecutionId: 'secret-execution-id',
          sourceRouteAnchorFromNodeId: fromId,
          sourceRouteAnchorToNodeId: toId,
          sourceDivergenceNodeId: fromId,
          destinationNodeId: toId,
          preservedPrefixNodeIds: ['prefix-node'],
          preservedPrefixTransportEdgeIds: ['prefix-edge'],
          replacementNodeIds: [intermediate.id],
          replacementTransportEdgeIds: [oldEdge.id],
          materializedOrigin: {
            ref: 'EXTERNAL_ORIGIN',
            action: 'CREATE',
            nodeId: null,
            kind: 'PLACE_VISIT',
            source: 'ROUTE_GENERATED',
            autoReplaceable: true,
            userModifiedAt: null,
            evidence: 'USER_CONFIRMED',
            temporalValues: [],
            executionEvents: [],
            location: {
              ref: 'EXTERNAL_ORIGIN',
              name: '你确认的品川站 · SYNTHETIC',
              latitude: 35.6,
              longitude: 139.7,
              providerPlaceRef: null,
              providerHubRef: 'secret-hub-ref',
            },
            localDate: '2030-10-01',
            dayOccurrenceId: dayId,
            provider: 'SYNTHETIC',
            providerPlaceRef: null,
            providerHubRef: 'secret-hub-ref',
          },
        },
      },
    };
  if (kind === 'protected') {
    const protectedNode = {
      ...intermediate,
      timeIntents: [
        { ...baseTrip.days[0]!.nodes[0]!.timeIntents[0]!, locked: true },
      ],
    };
    trip = {
      ...trip,
      days: [{ ...trip.days[0]!, nodes: [from, protectedNode, to] }],
    };
    preview = {
      ...preview,
      adoptable: false,
      status: 'BLOCKED',
      changeSummary: {
        ...summary,
        protectedBlockingNodes: [
          {
            nodeId: intermediate.id,
            dayOccurrenceId: dayId,
            protected: true,
            protectionReasons: ['USER_TIME_INTENT'],
          },
        ],
        protectedBlockingTransportEdgeIds: [oldEdge.id],
        downstreamImpact: {
          ...summary.downstreamImpact!,
          status: 'INFEASIBLE',
        },
      },
    };
  }
  if (kind === 'removed')
    preview = {
      ...preview,
      changeSummary: {
        ...summary,
        nodesToRemove: [
          {
            nodeId: intermediate.id,
            dayOccurrenceId: dayId,
            protected: false,
            protectionReasons: [],
          },
        ],
      },
    };
  if (kind === 'minimal')
    preview = {
      ...preview,
      currentConnection: {
        ...preview.currentConnection,
        state: 'MISSING',
        transport: null,
      },
      changeSummary: {
        ...summary,
        transportAction: 'CREATE',
        willReplaceTransportEdgeId: null,
        willReplaceTransportEdgeIds: [],
        nodesToRemove: [],
      },
    };
  if (kind === 'unknown')
    preview = {
      ...preview,
      adoptable: false,
      changeSummary: {
        ...withoutScopeAndImpact,

        proposedSegments: [
          {
            ...summary.proposedSegments[0]!,
            fromRef: 'missing-label',
            toRef: 'missing-label',
            departure: null,
            arrival: null,
            serviceLabel: null,
          },
        ],
      },
    };
  if (kind === 'expired')
    preview = { ...preview, adoptable: false, status: 'EXPIRED' };
  if (kind === 'long') {
    trip = {
      ...trip,
      days: [
        {
          ...trip.days[0]!,
          nodes: [
            {
              ...from,
              place: {
                ...from.place!,
                name: '東京都千代田区丸の内・東京駅八重洲地下街地下中央改札から日本橋方面へ続く長い集合地点 · SYNTHETIC',
              },
            },
            intermediate,
            {
              ...to,
              place: {
                ...to.place!,
                name: '東京都台東区上野恩賜公園・国立科学博物館特別展集合入口と長い日本語の目的地 · SYNTHETIC',
              },
            },
          ],
        },
      ],
    };
  }
  return { preview, trip };
}
