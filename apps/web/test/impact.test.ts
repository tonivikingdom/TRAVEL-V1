import { describe, expect, it } from 'vitest';
import { impactDetails, impactPresentation } from '../src/impact.js';
import { fixtureTrip } from './fixture.js';
import type { TripImpactView } from '@travel/contracts';
const t = fixtureTrip();
const base: TripImpactView = {
  tripId: t.id,
  basisVersion: t.version,
  evaluatedAt: '2030-10-01T04:00:00Z',
  items: [],
  handoffs: [],
};
describe('impact displays authoritative states without computing risk', () => {
  it.each([
    ['SATISFIED', false, 'quiet'],
    ['SATISFIED', true, 'attention'],
    ['VIOLATED', false, 'replan'],
    ['CONFLICT', false, 'replan'],
    ['UNKNOWN', false, 'unknown'],
  ] as const)('%s / changed %s maps to %s', (status, changed, tone) => {
    expect(
      impactPresentation(t, {
        ...base,
        items: [
          {
            status,
            changed,
            nodeId: null,
            transportEdgeId: null,
            title: 'SYNTHETIC',
            explanation: '已有判定',
          },
        ],
      }).tone,
    ).toBe(tone);
  });
  it('mismatched version and absent evidence never claim normal', () => {
    expect(impactPresentation(t, null).tone).toBe('unknown');
    expect(impactPresentation(t, { ...base, basisVersion: 2 }).tone).toBe(
      'unknown',
    );
  });
  it('NOT_REQUIRED has no replan action; READY only has a read-only entry', () => {
    const h = {
      tripId: t.id,
      sourceTransportEdgeId: 'synthetic',
      adoptedRouteId: t.id,
      readiness: 'NOT_REQUIRED' as const,
      query: null,
      reasonCodes: [],
    };
    expect(impactDetails(t, { ...base, handoffs: [h] })).not.toContain(
      'data-impact-handoff',
    );
    expect(
      impactDetails(t, {
        ...base,
        handoffs: [
          {
            ...h,
            readiness: 'READY',
            originBasis: 'CONFIRMED_EXECUTION_NODE',
            query: {
              basisVersion: 1,
              fromNodeId: t.days[0]!.nodes[0]!.id,
              toNodeId: t.days[0]!.nodes[1]!.id,
            },
          },
        ],
      }),
    ).toContain('前面的已确认部分保持不变');
  });
  it('unresolved source stays unknown and has no query action', () => {
    const v = {
      ...base,
      handoffs: [
        {
          tripId: t.id,
          sourceTransportEdgeId: 'synthetic',
          adoptedRouteId: t.id,
          readiness: 'ORIGIN_UNRESOLVED' as const,
          query: null,
          reasonCodes: [],
        },
      ],
    };
    expect(impactPresentation(t, v).tone).toBe('unknown');
    expect(impactDetails(t, v)).toContain('需要先确认当前位置');
    expect(impactDetails(t, v)).not.toContain('data-impact-handoff');
  });
});
