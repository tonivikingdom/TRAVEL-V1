import type {
  ExecutionRiskView,
  FlightBindingView,
  RefreshFlightResponse,
} from '@travel/contracts';
import { describe, expect, it } from 'vitest';

import { hasFlightRelatedDownstreamImpact } from '../src/flight-monitoring-service.js';

const flightTransportEdgeId = '50000000-0000-4000-8000-000000000024';

describe('flight monitoring downstream impact correlation', () => {
  it('marks a risk sourced by the monitored flight transport', () => {
    expect(
      hasFlightRelatedDownstreamImpact(
        response([risk({ sourceTransportEdgeId: flightTransportEdgeId })]),
      ),
    ).toBe(true);
  });

  it('does not treat an unrelated active trip risk as flight impact', () => {
    expect(
      hasFlightRelatedDownstreamImpact(
        response([
          risk({
            sourceTransportEdgeId: '50000000-0000-4000-8000-000000000099',
            evidenceRefs: ['transport:unrelated-edge'],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('changes from no impact to impact when the refresh creates a flight-sourced risk', () => {
    expect(hasFlightRelatedDownstreamImpact(response([]))).toBe(false);
    expect(
      hasFlightRelatedDownstreamImpact(
        response([risk({ sourceTransportEdgeId: flightTransportEdgeId })]),
      ),
    ).toBe(true);
  });

  it('accepts explicit transport evidence for an existing correlated risk', () => {
    expect(
      hasFlightRelatedDownstreamImpact(
        response([
          risk({
            sourceTransportEdgeId: null,
            evidenceRefs: [`transport:${flightTransportEdgeId}`],
          }),
        ]),
      ),
    ).toBe(true);
  });
});

function response(
  risks: readonly ExecutionRiskView[],
): Pick<RefreshFlightResponse, 'flightBinding' | 'riskEvaluation'> {
  return {
    flightBinding: {
      transportEdgeId: flightTransportEdgeId,
    } as FlightBindingView,
    riskEvaluation: {
      tripId: '10000000-0000-4000-8000-000000000024',
      evaluationBasisTripVersion: 1,
      risks,
      resolvedRisks: [],
      notificationsCreated: [],
    },
  };
}

function risk(override: Partial<ExecutionRiskView>): ExecutionRiskView {
  return {
    id: '60000000-0000-4000-8000-000000000024',
    tripId: '10000000-0000-4000-8000-000000000024',
    kind: 'FIXED_SERVICE_MISSED',
    severity: 'INFEASIBLE',
    status: 'OPEN',
    sourceNodeId: null,
    sourceTransportEdgeId: null,
    protectedNodeId: null,
    protectedTransportEdgeId: null,
    firstSeenAt: '2030-01-02T12:00:00.000Z',
    lastSeenAt: '2030-01-02T12:00:00.000Z',
    acknowledgedAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    evaluationBasisTripVersion: 1,
    evidenceRefs: [],
    requiresRouteReevaluation: true,
    ...override,
  };
}
