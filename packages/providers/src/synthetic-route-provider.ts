import type {
  RouteProvider,
  RouteProviderQueryInput,
  RouteProviderResult,
} from '@travel/application';
import type { NormalizedRouteCandidate } from '@travel/domain';

type SyntheticResponder = (
  input: RouteProviderQueryInput,
) => RouteProviderResult | Promise<RouteProviderResult>;

export class SyntheticRouteProvider implements RouteProvider {
  readonly provider = 'SYNTHETIC' as const;

  constructor(private readonly responder: SyntheticResponder) {}

  queryRoutes(input: RouteProviderQueryInput): Promise<RouteProviderResult> {
    return Promise.resolve(this.responder(input));
  }
}

export function createDevelopmentSyntheticRouteProvider(
  now: () => Date = () => new Date(),
): SyntheticRouteProvider {
  return new SyntheticRouteProvider((input) => ({
    status: 'SUCCESS',
    candidates: [developmentCandidate(input, now())],
  }));
}

function developmentCandidate(
  input: RouteProviderQueryInput,
  observedAt: Date,
): NormalizedRouteCandidate {
  const latestArrival = input.latestArrival;
  const earliestDeparture = input.earliestDeparture;
  const departure =
    earliestDeparture ??
    new Date((latestArrival ?? observedAt).getTime() - 30 * 60 * 1_000);
  const arrival =
    latestArrival === null
      ? new Date(departure.getTime() + 30 * 60 * 1_000)
      : latestArrival;
  const durationSeconds = Math.max(
    0,
    (arrival.getTime() - departure.getTime()) / 1_000,
  );
  const providerRef = [
    input.origin.placeId,
    input.destination.placeId,
    departure.toISOString(),
    arrival.toISOString(),
  ].join(':');
  return {
    candidateId: `SYNTHETIC:${providerRef}`,
    provider: 'SYNTHETIC',
    providerCandidateRef: providerRef,
    observedAt,
    validUntil: null,
    departure: { instant: departure, timeZone: providerTimeZone(input) },
    arrival: { instant: arrival, timeZone: providerTimeZone(input) },
    durationSeconds,
    legs: [
      {
        mode: 'WALKING',
        from: {
          name: input.origin.name,
          latitude: input.origin.latitude,
          longitude: input.origin.longitude,
          providerPlaceRef: null,
        },
        to: {
          name: input.destination.name,
          latitude: input.destination.latitude,
          longitude: input.destination.longitude,
          providerPlaceRef: null,
        },
        departure: {
          instant: departure,
          timeZone: providerTimeZone(input),
        },
        arrival: {
          instant: arrival,
          timeZone: providerTimeZone(input),
        },
        durationSeconds,
        fixedService: false,
        serviceLabel: null,
        providerRef,
      },
    ],
    fare: null,
  };
}

function providerTimeZone(input: RouteProviderQueryInput): string {
  return input.preference.type === 'NONE' ? 'UTC' : input.preference.timeZone;
}
