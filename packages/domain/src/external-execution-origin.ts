import type {
  GroundTransitBaseline,
  GroundTransitObservation,
  GroundTransitOperationalAssessment,
} from './ground-transit-execution.js';

export interface GroundTransitHubMetadata {
  readonly provider: string;
  readonly providerHubRef: string;
  readonly canonicalHubRef: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeZone: string;
}

export function resolveExternalTransitHubIdentity(input: {
  readonly current: boolean;
  readonly baseline: GroundTransitBaseline | null;
  readonly observation: GroundTransitObservation | null;
  readonly assessment: GroundTransitOperationalAssessment | null;
  readonly itineraryHubs: readonly {
    provider: string | null;
    providerHubRef: string | null;
  }[];
}):
  | {
      status: 'ELIGIBLE';
      provider: string;
      providerHubRef: string;
      labelHint: string | null;
    }
  | { status: 'NOT_AVAILABLE' | 'UNRESOLVED'; reason: string } {
  const { observation, baseline, assessment } = input;
  if (
    !input.current ||
    baseline === null ||
    observation === null ||
    assessment?.requiredAction !== 'ROUTE_REEVALUATION_REQUIRED'
  )
    return { status: 'NOT_AVAILABLE', reason: 'EXTERNAL_HUB_NOT_REQUIRED' };
  const relevant =
    assessment.changeKinds.some(
      (kind) => kind === 'SERVICE_SHORT_TURNED' || kind === 'TERMINUS_CHANGED',
    ) || observation.alightingTargetServiceability === 'NOT_SERVED';
  if (!relevant)
    return { status: 'NOT_AVAILABLE', reason: 'EXTERNAL_HUB_NOT_REQUIRED' };
  const terminus = observation.currentTerminusRef;
  const operating = observation.operatingToHubRef;
  if (terminus != null && operating != null && terminus !== operating)
    return { status: 'UNRESOLVED', reason: 'EXTERNAL_HUB_IDENTITY_CONFLICT' };
  const ref = terminus ?? operating;
  if (ref == null || ref.trim() === '')
    return { status: 'UNRESOLVED', reason: 'EXTERNAL_HUB_IDENTITY_UNRESOLVED' };
  if (ref === baseline.alightingHubRef)
    return {
      status: 'NOT_AVAILABLE',
      reason: 'HUB_IS_PLANNED_ALIGHTING_TARGET',
    };
  if (
    input.itineraryHubs.some(
      (hub) =>
        hub.provider === observation.provider && hub.providerHubRef === ref,
    )
  )
    return {
      status: 'NOT_AVAILABLE',
      reason: 'HUB_ALREADY_REPRESENTED_IN_ITINERARY',
    };
  return {
    status: 'ELIGIBLE',
    provider: observation.provider,
    providerHubRef: ref,
    labelHint: observation.currentTerminusLabel ?? null,
  };
}

export function isValidResolvedTransitHub(
  hub: GroundTransitHubMetadata,
  provider: string,
  providerHubRef: string,
): boolean {
  if (hub === null || typeof hub !== 'object') return false;
  if (
    hub.provider !== provider ||
    hub.providerHubRef !== providerHubRef ||
    [
      hub.provider,
      hub.providerHubRef,
      hub.canonicalHubRef,
      hub.name,
      hub.timeZone,
    ].some(
      (value) =>
        typeof value !== 'string' || value.trim() === '' || value.length > 300,
    ) ||
    hub.provider.length > 100 ||
    hub.timeZone.length > 100 ||
    !Number.isFinite(hub.latitude) ||
    Math.abs(hub.latitude) > 90 ||
    !Number.isFinite(hub.longitude) ||
    Math.abs(hub.longitude) > 180
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: hub.timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface ExternalOriginFact {
  readonly id: string;
  readonly status: 'ARRIVED' | 'DEPARTED' | 'INVALIDATED';
  readonly arrivedAt: Date;
  readonly departedAt: Date | null;
  readonly invalidatedAt: Date | null;
}
export type ExternalExecutionOriginCurrentness =
  'CURRENT' | 'DEPARTED' | 'SUPERSEDED' | 'CONFLICT';
export function resolveExternalExecutionOriginCurrentness(input: {
  readonly origin: ExternalOriginFact;
  readonly origins: readonly ExternalOriginFact[];
  readonly executionEvents: readonly {
    occurredAt: Date;
    undoneAt: Date | null;
  }[];
  readonly frontierState: string;
}): ExternalExecutionOriginCurrentness {
  const origin = input.origin;
  if (origin.status === 'DEPARTED')
    return origin.departedAt !== null && origin.departedAt >= origin.arrivedAt
      ? 'DEPARTED'
      : 'CONFLICT';
  if (origin.status === 'INVALIDATED')
    return origin.invalidatedAt !== null ? 'SUPERSEDED' : 'CONFLICT';
  if (
    origin.departedAt !== null ||
    origin.invalidatedAt !== null ||
    input.frontierState === 'INCONSISTENT' ||
    input.origins.filter((row) => row.status === 'ARRIVED').length > 1
  )
    return 'CONFLICT';
  if (
    input.origins.some(
      (row) => row.id !== origin.id && row.arrivedAt > origin.arrivedAt,
    ) ||
    input.executionEvents.some(
      (event) => event.undoneAt === null && event.occurredAt > origin.arrivedAt,
    )
  )
    return 'SUPERSEDED';
  return 'CURRENT';
}
