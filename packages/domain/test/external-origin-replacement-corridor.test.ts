import { describe, expect, it } from 'vitest';
import {
  classifyExternalReplacementTransportActual,
  resolveExternalOriginReplacementCorridor,
} from '../src/external-origin-replacement-corridor.js';

const nodes = ['A', 'B', 'C', 'D'].map((id, index) => ({
  id,
  kind: 'PLACE_VISIT',
  source: index === 1 || index === 2 ? 'ROUTE_GENERATED' : 'USER_PLANNED',
  adoptedRouteId: index === 1 || index === 2 ? 'R1' : null,
}));
const edges = ['AB', 'BC', 'CD'].map((id, index) => ({
  id,
  tripId: 'trip',
  fromNodeId: nodes[index]!.id,
  toNodeId: nodes[index + 1]!.id,
  source: 'ADOPTED_ROUTE',
  adoptedRouteId: 'R1',
}));
const route = {
  id: 'R1',
  tripId: 'trip',
  status: 'ACTIVE',
  anchorFromNodeId: 'A',
  anchorToNodeId: 'D',
};
const basis = {
  tripId: 'trip',
  orderedNodes: nodes,
  transports: edges,
  sourceRoute: route,
  sourceTransportEdgeId: 'BC',
  destinationNodeId: 'D',
};

describe('SYNTHETIC external-origin replacement topology', () => {
  it.each([
    ['AB', ['A'], [], ['A', 'B', 'C', 'D'], ['AB', 'BC', 'CD']],
    ['BC', ['A', 'B'], ['AB'], ['B', 'C', 'D'], ['BC', 'CD']],
    ['CD', ['A', 'B', 'C'], ['AB', 'BC'], ['C', 'D'], ['CD']],
  ])(
    'resolves first/middle/last source edge %s deterministically',
    (
      sourceTransportEdgeId,
      preservedPrefixNodeIds,
      preservedPrefixTransportEdgeIds,
      replacementNodeIds,
      replacementTransportEdgeIds,
    ) => {
      const input = {
        ...basis,
        sourceTransportEdgeId: sourceTransportEdgeId as string,
      };
      const result = resolveExternalOriginReplacementCorridor(input);
      expect(result).toEqual({
        replacementScope: 'EXTERNAL_ORIGIN',
        sourceAdoptedRouteId: 'R1',
        sourceRouteAnchorFromNodeId: 'A',
        sourceRouteAnchorToNodeId: 'D',
        sourceTransportEdgeId,
        sourceDivergenceNodeId: (replacementNodeIds as string[])[0],
        destinationNodeId: 'D',
        preservedPrefixNodeIds,
        preservedPrefixTransportEdgeIds,
        replacementNodeIds,
        replacementTransportEdgeIds,
      });
      expect(
        resolveExternalOriginReplacementCorridor({
          ...input,
          transports: [...edges].reverse(),
        }),
      ).toEqual(result);
      // Only strict internal nodes after divergence can be removed; endpoints survive.
      expect(result?.replacementNodeIds.slice(1, -1)).toEqual(
        sourceTransportEdgeId === 'AB'
          ? ['B', 'C']
          : sourceTransportEdgeId === 'BC'
            ? ['C']
            : [],
      );
    },
  );
  it.each(['REPLACED', 'UNDONE'])('rejects historical %s route', (status) =>
    expect(
      resolveExternalOriginReplacementCorridor({
        ...basis,
        sourceRoute: { ...route, status },
      }),
    ).toBeNull(),
  );
  it.each([
    { sourceTransportEdgeId: 'outside' },
    { destinationNodeId: 'C' },
    { sourceRoute: { ...route, tripId: 'other' } },
    {
      transports: edges.map((edge) =>
        edge.id === 'BC' ? { ...edge, adoptedRouteId: 'R2' } : edge,
      ),
    },
    {
      transports: edges.map((edge) =>
        edge.id === 'BC' ? { ...edge, source: 'MANUAL' } : edge,
      ),
    },
    { transports: edges.slice(1) },
    { transports: [...edges, { ...edges[1]!, id: 'duplicate' }] },
    {
      transports: [
        ...edges,
        { ...edges[1]!, id: 'stray', fromNodeId: 'A', toNodeId: 'D' },
      ],
    },
    {
      orderedNodes: nodes.map((node) =>
        node.id === 'C' ? { ...node, source: 'USER_PLANNED' } : node,
      ),
    },
    { orderedNodes: [...nodes, { ...nodes[1]!, id: 'stray' }] },
    { orderedNodes: [...nodes, nodes[1]!] },
  ])('rejects missing/ambiguous/foreign topology %#', (change) =>
    expect(
      resolveExternalOriginReplacementCorridor({ ...basis, ...change }),
    ).toBeNull(),
  );
});

describe('external-only ACTUAL archival policy', () => {
  it.each([
    'USER_VALUE',
    'EXECUTION_OBSERVATION',
    'DERIVED',
    'SYSTEM_SUGGESTION',
    'ADOPTED_TRANSPORT_FACT',
  ])('protects %s even alongside vehicle ACTUAL', (sourceKind) => {
    expect(
      classifyExternalReplacementTransportActual([
        {
          id: 'BC',
          timeValues: [
            { layer: 'ACTUAL', sourceKind },
            { layer: 'ACTUAL', sourceKind: 'PROVIDER_OBSERVATION' },
          ],
        },
      ]),
    ).toEqual({
      protectedBlockingTransportEdgeIds: ['BC'],
      archivableProviderActualTransportEdgeIds: [],
    });
  });
  it('archives provider-only ACTUAL and ignores PLANNED/ESTIMATED facts', () => {
    expect(
      classifyExternalReplacementTransportActual([
        {
          id: 'BC',
          timeValues: [{ layer: 'ACTUAL', sourceKind: 'PROVIDER_OBSERVATION' }],
        },
        {
          id: 'CD',
          timeValues: [{ layer: 'PLANNED', sourceKind: 'USER_VALUE' }],
        },
      ]),
    ).toEqual({
      protectedBlockingTransportEdgeIds: [],
      archivableProviderActualTransportEdgeIds: ['BC'],
    });
  });
});
