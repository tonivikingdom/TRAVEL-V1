import { describe, expect, it } from 'vitest';
import {
  resolveCurrentRouteReplacementCorridor,
  type CorridorNode,
  type CorridorTransport,
  type CorridorRoute,
} from '../src/route-replacement-corridor.js';

const nodes: CorridorNode[] = ['A', 'B', 'C', 'D'].map((id, index) => ({
  id,
  kind: 'PLACE_VISIT',
  source: index === 1 || index === 2 ? 'ROUTE_GENERATED' : 'USER_PLANNED',
  adoptedRouteId: index === 1 || index === 2 ? 'R1' : null,
}));
const edges: CorridorTransport[] = ['AB', 'BC', 'CD'].map((id, index) => ({
  id,
  tripId: 'trip',
  fromNodeId: nodes[index]!.id,
  toNodeId: nodes[index + 1]!.id,
  source: 'ADOPTED_ROUTE',
  adoptedRouteId: 'R1',
}));
const routes: CorridorRoute[] = [
  {
    id: 'R1',
    tripId: 'trip',
    status: 'ACTIVE',
    anchorFromNodeId: 'A',
    anchorToNodeId: 'D',
  },
];
const resolve = (from: string, to: string, n = nodes, e = edges, r = routes) =>
  resolveCurrentRouteReplacementCorridor('trip', n, e, r, from, to);

describe('SYNTHETIC provider-neutral replacement corridor', () => {
  it('retains full-corridor semantics', () => {
    expect(resolve('A', 'D')).toMatchObject({
      replacementScope: 'FULL_CORRIDOR',
      replacementNodeIds: ['A', 'B', 'C', 'D'],
      replacementTransportEdgeIds: ['AB', 'BC', 'CD'],
      preservedPrefixNodeIds: [],
      preservedPrefixTransportEdgeIds: [],
    });
  });
  it.each([
    ['B', ['B', 'C', 'D'], ['AB'], ['BC', 'CD']],
    ['C', ['C', 'D'], ['AB', 'BC'], ['CD']],
  ])(
    'resolves suffix from %s without any execution requirement',
    (
      from,
      replacementNodeIds,
      preservedPrefixTransportEdgeIds,
      replacementTransportEdgeIds,
    ) => {
      expect(resolve(from as string, 'D')).toMatchObject({
        replacementScope: 'SUFFIX',
        sourceAdoptedRouteId: 'R1',
        sourceRouteAnchorFromNodeId: 'A',
        sourceRouteAnchorToNodeId: 'D',
        replacementAnchorFromNodeId: from,
        replacementAnchorToNodeId: 'D',
        replacementNodeIds,
        preservedPrefixTransportEdgeIds,
        replacementTransportEdgeIds,
      });
    },
  );
  it.each([
    ['B', 'C'],
    ['A', 'C'],
    ['C', 'B'],
  ])('rejects unsupported %s to %s', (from, to) =>
    expect(resolve(from, to)).toBeNull(),
  );
  it.each(['REPLACED', 'UNDONE'])(
    'does not source a suffix from %s',
    (status) =>
      expect(
        resolve('B', 'D', nodes, edges, [{ ...routes[0]!, status }]),
      ).toBeNull(),
  );
  it('rejects a mixed-route suffix and non-generated internal ownership', () => {
    expect(
      resolve(
        'B',
        'D',
        nodes,
        edges.map((edge) =>
          edge.id === 'CD' ? { ...edge, adoptedRouteId: 'R2' } : edge,
        ),
      ),
    ).toBeNull();
    expect(
      resolve(
        'B',
        'D',
        nodes.map((node) =>
          node.id === 'B' ? { ...node, source: 'USER_PLANNED' } : node,
        ),
      ),
    ).toBeNull();
    expect(
      resolve(
        'B',
        'D',
        nodes.map((node) =>
          node.id === 'C' ? { ...node, kind: 'FREE_ACTION' } : node,
        ),
      ),
    ).toBeNull();
  });
  it('rejects incomplete or ambiguous route topology including the prefix', () => {
    expect(resolve('B', 'D', nodes, edges.slice(1))).toBeNull();
    expect(
      resolve('B', 'D', nodes, [...edges, { ...edges[1]!, id: 'duplicate' }]),
    ).toBeNull();
    expect(
      resolve('B', 'D', nodes, edges, [...routes, { ...routes[0]!, id: 'R2' }]),
    ).toBeNull();
    expect(
      resolve('B', 'D', [...nodes, { ...nodes[1]!, id: 'stray' }]),
    ).toBeNull();
  });
  it('retains ordinary manual/missing adjacency and excludes cross-trip sources', () => {
    expect(resolve('A', 'B', nodes, [], [])).toMatchObject({
      replacementScope: 'FULL_CORRIDOR',
      sourceAdoptedRouteId: null,
    });
    expect(
      resolve(
        'A',
        'B',
        nodes,
        [{ ...edges[0]!, source: 'MANUAL', adoptedRouteId: null }],
        [],
      ),
    ).toMatchObject({ replacementTransportEdgeIds: ['AB'] });
    expect(
      resolve('B', 'D', nodes, edges, [{ ...routes[0]!, tripId: 'other' }]),
    ).toBeNull();
  });
});
