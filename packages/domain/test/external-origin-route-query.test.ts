import { describe, expect, it } from 'vitest';
import { resolveExternalOriginRouteQueryAuthorization as authorize } from '../src/external-origin-route-query.js';
const basis = {
  origin: {
    id: 'E',
    status: 'ARRIVED' as const,
    arrivedAt: new Date('2030-01-01'),
    departedAt: null,
    invalidatedAt: null,
    provider: 'SYNTHETIC',
    providerHubRef: 'synthetic:E',
    canonicalHubRef: 'synthetic:hub:E',
    name: 'SYNTHETIC E',
    latitude: 35,
    longitude: 139,
    timeZone: 'Asia/Tokyo',
    sourceAdoptedRouteId: 'R1',
    sourceTransportEdgeId: 'BC',
  },
  currentness: 'CURRENT' as const,
  sourceRoute: { id: 'R1', status: 'ACTIVE', anchorToNodeId: 'D' },
  sourceEdge: { id: 'BC', source: 'ADOPTED_ROUTE', adoptedRouteId: 'R1' },
  toNodeId: 'D',
};
describe('External-origin planning authorization', () => {
  it('authorizes a CURRENT user arrival to its source route destination', () =>
    expect(authorize(basis)).toBe('AUTHORIZED'));
  it('vehicle recovery is irrelevant to the user execution origin', () =>
    expect(authorize(basis)).toBe('AUTHORIZED'));
  it('rejects another destination', () =>
    expect(authorize({ ...basis, toNodeId: 'C' })).toBe(
      'DESTINATION_MISMATCH',
    ));
  it.each(['REPLACED', 'UNDONE'])('rejects %s source route', (status) =>
    expect(
      authorize({ ...basis, sourceRoute: { ...basis.sourceRoute, status } }),
    ).toBe('SOURCE_ROUTE_NOT_CURRENT'),
  );
  it.each([
    null,
    { ...basis.sourceEdge, adoptedRouteId: 'R2' },
    { ...basis.sourceEdge, id: 'OTHER' },
    { ...basis.sourceEdge, source: 'USER' },
  ])('rejects a missing or mismatched current source edge %j', (sourceEdge) =>
    expect(authorize({ ...basis, sourceEdge })).toBe(
      'SOURCE_ROUTE_NOT_CURRENT',
    ),
  );
  it.each(['SUPERSEDED', 'DEPARTED', 'CONFLICT'] as const)(
    'rejects %s derived currentness',
    (currentness) =>
      expect(authorize({ ...basis, currentness })).not.toBe('AUTHORIZED'),
  );
  it.each(['DEPARTED', 'INVALIDATED'] as const)(
    'rejects persisted %s even with a misleading currentness',
    (status) =>
      expect(authorize({ ...basis, origin: { ...basis.origin, status } })).toBe(
        'NOT_CURRENT',
      ),
  );
  it.each([
    { timeZone: 'invalid/Zone' },
    { latitude: 91 },
    { longitude: 181 },
    { name: '' },
  ])('rejects invalid trusted metadata %j', (patch) =>
    expect(authorize({ ...basis, origin: { ...basis.origin, ...patch } })).toBe(
      'CONFLICT',
    ),
  );
});
