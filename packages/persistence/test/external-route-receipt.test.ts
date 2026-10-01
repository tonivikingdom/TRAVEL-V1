import { describe, expect, it } from 'vitest';
import type { RouteAdoptDeltaV5 } from '@travel/contracts';
import { parseRouteAdoptDelta } from '../src/prisma-route-undo.js';
import type { Prisma } from '../src/generated/prisma/client.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(): RouteAdoptDeltaV5 {
  const externalOrigin = {
    schema: 'external-route-origin-v1' as const,
    externalOriginId: id(50),
    provider: 'SYNTHETIC',
    providerHubRef: 'synthetic:E',
    canonicalHubRef: 'synthetic:hub:E',
    name: 'SYNTHETIC E',
    latitude: 35,
    longitude: 139,
    timeZone: 'Asia/Tokyo',
    arrivedAt: '2030-10-01T10:00:00.000Z',
    sourceAdoptedRouteId: id(3),
    sourceTransportEdgeId: id(31),
    sourceGroundTransitLegExecutionId: id(51),
    sourceGroundTransitObservationId: id(52),
    sourceObservationIdentity: 'SYNTHETIC observation',
    sourceObservationFetchedAt: '2030-10-01T09:00:00.000Z',
    sourceObservationFactsHash: 'b'.repeat(64),
  };
  return {
    schemaVersion: 'route-adopt-delta-v5',
    replacementScope: 'EXTERNAL_ORIGIN',
    externalOriginId: id(50),
    sourceAdoptedRouteId: id(3),
    previousActiveAdoptedRouteId: id(3),
    sourceTransportEdgeId: id(31),
    sourceGroundTransitLegExecutionId: id(51),
    sourceRouteAnchorFromNodeId: id(10),
    sourceRouteAnchorToNodeId: id(13),
    sourceDivergenceNodeId: id(10),
    destinationNodeId: id(13),
    materializedOriginNodeId: id(60),
    materializedOriginPlaceId: id(61),
    materializedOriginDayOccurrenceId: id(4),
    materializedOriginAnchorSnapshot: {
      schemaVersion: 'external-adopted-route-anchor-v1',
      externalOrigin,
      materializedNodeId: id(60),
      materializedPlaceId: id(61),
      materializedDayOccurrenceId: id(4),
      localDate: '2030-10-01',
    },
    preservedPrefixNodeIds: [id(10)],
    preservedPrefixTransportEdgeIds: [],
    preservedPrefixHash: 'a'.repeat(64),
    replacementNodeIds: [id(10), id(13)],
    archivedTransportEdgeIds: [id(31)],
    archivableProviderActualTransportEdgeIds: [id(31)],
    archivedSuffixHash: 'c'.repeat(64),
    afterGeneratedNodeFacts: [{ id: id(60) }],
    createdNodeIds: [id(60)],
    createdPlaceIds: [id(61)],
    createdDayOccurrenceIds: [],
    reusedNodeIds: [],
    removedGeneratedNodes: [],
    beforeGeneratedNodes: [],
    createdTransportEdgeIds: [id(71)],
    archivedTransportHistoryIds: [id(41)],
    createdDayProjections: [],
    removedDayProjections: [],
    affectedDayOccurrenceIds: [id(4)],
    beforeCorridorNodeIds: [id(10), id(13)],
    afterCorridorNodeIds: [id(60), id(13)],
    beforeDayOccurrences: [{ id: id(4), localDate: '2030-10-01', sequence: 0 }],
    beforeNodePlacements: [
      { nodeId: id(10), dayOccurrenceId: id(4), position: 0 },
      { nodeId: id(13), dayOccurrenceId: id(4), position: 1 },
    ],
    beforeOwnedDates: ['2030-10-01'],
    beforeEffectiveStartDate: '2030-10-01',
    beforeEffectiveEndDate: '2030-10-01',
    userDwellAdjustments: [],
  };
}
const parse = (value: unknown) =>
  parseRouteAdoptDelta(value as Prisma.JsonValue);
describe('external route receipt restoration relationships', () => {
  it('supports first-edge one-node prefix without inventing a divergence-to-E edge', () => {
    const delta = fixture();
    expect(parse(delta)).toEqual(delta);
  });
  it.each([
    ['source route', { previousActiveAdoptedRouteId: id(99) }],
    ['source destination', { sourceRouteAnchorToNodeId: id(99) }],
    ['before corridor', { beforeCorridorNodeIds: [id(12), id(13)] }],
    ['after corridor', { afterCorridorNodeIds: [id(12), id(13)] }],
    ['prefix divergence', { preservedPrefixNodeIds: [id(12)] }],
    ['prefix edge count', { preservedPrefixTransportEdgeIds: [id(99)] }],
    ['materialized creation', { createdNodeIds: [] }],
    ['materialized Place', { createdPlaceIds: [] }],
    ['archive source', { archivedTransportEdgeIds: [id(99)] }],
    ['archive count', { archivedTransportEdgeIds: [id(31), id(32)] }],
    [
      'provider ACTUAL subset',
      { archivableProviderActualTransportEdgeIds: [id(99)] },
    ],
    ['created/reused overlap', { reusedNodeIds: [id(60)] }],
    ['after facts', { afterGeneratedNodeFacts: [] }],
    ['edge count', { createdTransportEdgeIds: [] }],
    [
      'snapshot marker',
      {
        materializedOriginAnchorSnapshot: {
          ...fixture().materializedOriginAnchorSnapshot,
          schemaVersion: 'wrong',
        },
      },
    ],
  ])('rejects incompatible %s before restoration', (_name, change) => {
    expect(parse({ ...fixture(), ...(change as object) })).toBeNull();
  });
  it.each([2, 3, 4])(
    'continues reading legacy route-adopt-delta-v%s',
    (version) => {
      const base = fixture();
      const delta = {
        ...base,
        schemaVersion: `route-adopt-delta-v${version}`,
        replacementScope: 'FULL_CORRIDOR',
        replacementAnchorFromNodeId: id(10),
        replacementAnchorToNodeId: id(13),
        afterCorridorNodeIds: [id(10), id(13)],
        preservedPrefixNodeIds: [],
        preservedPrefixTransportEdgeIds: [],
      };
      expect(parse(delta)?.schemaVersion).toBe(`route-adopt-delta-v${version}`);
    },
  );
});
