export type ProbeProviderStatus =
  | 'SUCCESS'
  | 'NO_ROUTE'
  | 'UNSUPPORTED'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_RESPONSE';

export type ProbeTimeMode = 'DEPART_AT' | 'ARRIVE_BY';

export interface ProbeLocation {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
}

export interface RouteProbeQuery {
  readonly origin: ProbeLocation;
  readonly destination: ProbeLocation;
  readonly mode: ProbeTimeMode;
  readonly instant: string;
  readonly timeZone: string;
}

export interface ProviderProbeCapabilities {
  readonly publicTransit: boolean | null;
  readonly rail: boolean | null;
  readonly bus: boolean | null;
  readonly subway: boolean | null;
  readonly ferry: boolean | null;
  readonly walking: boolean | null;
  readonly departAt: boolean | null;
  readonly arriveBy: boolean | null;
  readonly fare: boolean | null;
  readonly realtime: boolean | null;
  readonly lineNames: boolean | null;
}

export interface ProviderHealthResult {
  readonly status: 'PASS' | 'FAIL' | 'NOT_CONFIGURED';
  readonly httpStatus: number | null;
  readonly message: string;
  readonly rawEvidence?: unknown;
}

export interface ProviderCapabilityResult {
  readonly status: ProbeProviderStatus;
  readonly httpStatus: number | null;
  readonly capabilities: ProviderProbeCapabilities;
  readonly notes: readonly string[];
  readonly regions: readonly ProbeRegionEvidence[];
  readonly rawEvidence?: unknown;
}

export interface ProbeRegionEvidence {
  readonly code: string;
  readonly modes: readonly string[];
  readonly containsHokkaido: boolean;
  readonly japanRelated: boolean;
}

export interface ProbeFare {
  readonly amount: string;
  readonly currency: string;
}

export interface ProbeLeg {
  readonly mode: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly departure: string | null;
  readonly arrival: string | null;
  readonly durationSeconds: number | null;
  readonly lineName: string | null;
  readonly operatorName: string | null;
  readonly providerRef: string | null;
  readonly timing: 'REALTIME' | 'SCHEDULED' | null;
}

export interface ProbeRoute {
  readonly providerRef: string | null;
  readonly departure: string;
  readonly arrival: string;
  readonly totalDurationSeconds: number;
  readonly fare: ProbeFare | null;
  readonly legs: readonly ProbeLeg[];
  readonly transferCount: number;
  readonly walkingSeconds: number;
  readonly timeConstraintSatisfied: boolean;
}

export interface ProbeFactMatrix {
  readonly routeFound: boolean;
  readonly railPresent: boolean;
  readonly busPresent: boolean;
  readonly walkingPresent: boolean;
  readonly lineNamesPresent: boolean;
  readonly departureTimesPresent: boolean;
  readonly arrivalTimesPresent: boolean;
  readonly farePresent: boolean;
  readonly realtimePresent: boolean;
  readonly timeConstraintSatisfied: boolean | null;
}

export interface ProviderProbeResult {
  readonly provider: string;
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly request: {
    readonly origin: ProbeLocation;
    readonly destination: ProbeLocation;
    readonly mode: ProbeTimeMode;
    readonly requestedInstant: string;
    readonly timeZone: string;
  };
  readonly providerStatus: ProbeProviderStatus;
  readonly httpStatus: number | null;
  readonly capabilities: ProviderProbeCapabilities;
  readonly routes: readonly ProbeRoute[];
  readonly routeCount: number;
  readonly facts: ProbeFactMatrix;
  readonly notes: readonly string[];
  readonly rawEvidence?: unknown;
}

export interface ProviderProbeAdapter {
  readonly id: string;
  readonly displayName: string;
  healthCheck(): Promise<ProviderHealthResult>;
  capabilities(): Promise<ProviderCapabilityResult>;
  route(
    scenario: ProbeScenario,
    query: RouteProbeQuery,
    capabilities: ProviderProbeCapabilities,
  ): Promise<ProviderProbeResult>;
}

export interface ProbeScenario {
  readonly id: string;
  readonly suiteId: string;
  readonly name: string;
  readonly origin: ProbeLocation;
  readonly destination: ProbeLocation;
}

export interface ProviderProbeRun {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly mode: 'quick' | 'full';
  readonly provider: string;
  readonly displayName: string;
  readonly health: ProviderHealthResult;
  readonly capabilityDiscovery: ProviderCapabilityResult | null;
  readonly results: readonly ProviderProbeResult[];
  readonly requestCount: number;
}
