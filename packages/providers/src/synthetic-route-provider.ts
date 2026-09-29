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
  return new SyntheticRouteProvider((input) =>
    input.destination.name === 'SYNTHETIC_P5E2_GROUND_DESTINATION'
      ? createDevelopmentSyntheticGroundTransitRouteProvider(now).queryRoutes(
          input,
        )
      : { status: 'SUCCESS', candidates: [developmentCandidate(input, now())] },
  );
}

/** Explicit Dev/Test-only two-leg corridor for P5E2 cross-layer verification. */
export function createDevelopmentSyntheticGroundTransitRouteProvider(
  now: () => Date = () => new Date(),
): SyntheticRouteProvider {
  return new SyntheticRouteProvider((input) => {
    const basis = developmentCandidate(input, now());
    const departure = basis.departure.instant;
    const arrival = basis.arrival.instant;
    const midpoint = new Date(
      departure.getTime() +
        Math.floor(
          ((arrival.getTime() - departure.getTime()) * 2) / 3 / 1_000,
        ) *
          1_000,
    );
    const transferArrival = new Date(
      departure.getTime() +
        Math.floor((arrival.getTime() - departure.getTime()) / 3 / 1_000) *
          1_000,
    );
    const hubRef = `synthetic-hub:${input.origin.placeId}:${input.destination.placeId}`;
    const hub = {
      name: 'SYNTHETIC TRANSFER HUB',
      latitude: (input.origin.latitude + input.destination.latitude) / 2,
      longitude: (input.origin.longitude + input.destination.longitude) / 2,
      providerPlaceRef: hubRef,
      providerHubRef: hubRef,
    };
    const first = {
      mode: 'BUS' as const,
      from: basis.legs[0]!.from,
      to: hub,
      departure: basis.departure,
      arrival: { instant: transferArrival, timeZone: basis.departure.timeZone },
      durationSeconds:
        (transferArrival.getTime() - departure.getTime()) / 1_000,
      fixedService: false,
      serviceLabel: 'SYNTHETIC BUS',
      providerRef: `${basis.providerCandidateRef}:bus`,
      groundTransit: {
        serviceClass: 'HIGH_FREQUENCY' as const,
        serviceIdentityKey: null,
        lineRef: 'synthetic-bus-line',
        lineName: 'SYNTHETIC BUS',
        directionRef: 'toward-transfer-hub',
        directionLabel: 'Transfer Hub',
        boardingHubRef: `synthetic-origin:${input.origin.placeId}`,
        alightingHubRef: hubRef,
        headwayMinSeconds: 180,
        headwayMaxSeconds: 300,
        minimumTransferSeconds: 300,
      },
    };
    const second = {
      mode: 'RAIL' as const,
      from: hub,
      to: basis.legs[0]!.to,
      departure: { instant: midpoint, timeZone: basis.departure.timeZone },
      arrival: basis.arrival,
      durationSeconds: (arrival.getTime() - midpoint.getTime()) / 1_000,
      fixedService: true,
      serviceLabel: 'SYNTHETIC RAIL 1',
      providerRef: `${basis.providerCandidateRef}:rail`,
      groundTransit: {
        serviceClass: 'FIXED_SERVICE' as const,
        serviceIdentityKey: `synthetic-fixed:${hubRef}:${midpoint.toISOString()}`,
        lineRef: 'synthetic-rail-line',
        lineName: 'SYNTHETIC RAIL',
        directionRef: 'toward-destination',
        directionLabel: 'Destination',
        boardingHubRef: hubRef,
        alightingHubRef: `synthetic-destination:${input.destination.placeId}`,
        headwayMinSeconds: null,
        headwayMaxSeconds: null,
        minimumTransferSeconds: 300,
      },
    };
    return {
      status: 'SUCCESS' as const,
      candidates: [
        {
          ...basis,
          candidateId: `${basis.candidateId}:GROUND_TRANSIT`,
          legs: [first, second],
        },
      ],
    };
  });
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
