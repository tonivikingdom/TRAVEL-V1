import type {
  GroundTransitProvider,
  GroundTransitProviderResult,
} from '@travel/application';
import type { GroundTransitObservation } from '@travel/domain';

export type SyntheticGroundTransitScenario =
  | 'ON_TIME'
  | 'FIXED_DELAY'
  | 'MATERIAL_DELAY'
  | 'EARLY_DEPARTURE'
  | 'PLATFORM_CHANGE'
  | 'CANCEL_FIXED'
  | 'SHORT_TURN'
  | 'RECOVERY'
  | 'FAIL_FIRST_THEN_CANCEL_FIXED'
  | 'ACTUAL_DEPARTURE'
  | 'IDENTITY_MISMATCH'
  | 'HIGH_FREQUENCY_3_TO_5'
  | 'NEXT_DEPARTURE_2'
  | 'REPLAY_SAME'
  | 'STALE'
  | 'FAIL_FIRST';

/** Only Dev/Test may construct this adapter; it never contacts an external provider. */
export class SyntheticGroundTransitProvider implements GroundTransitProvider {
  readonly name = 'SYNTHETIC';
  private calls = 0;
  private readonly replayObservations = new Map<
    string,
    GroundTransitObservation
  >();

  constructor(
    private readonly scenario: SyntheticGroundTransitScenario,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchObservation(
    input: Parameters<GroundTransitProvider['fetchObservation']>[0],
  ): Promise<GroundTransitProviderResult> {
    if (input.signal?.aborted) return { status: 'UNAVAILABLE' };
    this.calls += 1;
    if (
      (this.scenario === 'FAIL_FIRST' ||
        this.scenario === 'FAIL_FIRST_THEN_CANCEL_FIXED') &&
      this.calls === 1
    ) {
      return { status: 'UNAVAILABLE' };
    }
    const baseline = input.leg.baseline;
    if (baseline === null || baseline.provider !== this.name) {
      return { status: 'UNAVAILABLE' };
    }
    const replay = this.replayObservations.get(input.leg.id);
    if (
      (this.scenario === 'REPLAY_SAME' ||
        this.scenario === 'NEXT_DEPARTURE_2') &&
      replay !== undefined
    )
      return { status: 'SUCCESS', observation: replay };
    const fetchedAt =
      this.scenario === 'STALE'
        ? new Date(this.now().getTime() - 10 * 60_000)
        : this.now();
    const delayMs =
      this.scenario === 'FIXED_DELAY'
        ? 10 * 60_000
        : this.scenario === 'MATERIAL_DELAY'
          ? 25 * 60_000
          : this.scenario === 'EARLY_DEPARTURE'
            ? -7 * 60_000
            : 0;
    const delayed = (value: Date | null) =>
      value === null ? null : new Date(value.getTime() + delayMs);
    const observation: GroundTransitObservation = {
      provider: this.name,
      // API and Worker may run distinct synthetic scenarios against the same
      // leg. Keep their observation identities disjoint instead of treating
      // different scenario facts as a conflicting replay.
      observationIdentity: `synthetic:${this.scenario}:${input.leg.id}:${this.calls}`,
      fetchedAt,
      serviceClass: baseline.serviceClass,
      mode: baseline.mode,
      lineRef: baseline.lineRef,
      lineName: null,
      directionRef: baseline.directionRef,
      directionLabel: null,
      boardingHubRef: baseline.boardingHubRef,
      alightingHubRef: baseline.alightingHubRef,
      serviceIdentityKey:
        this.scenario === 'IDENTITY_MISMATCH'
          ? 'synthetic:other-service'
          : baseline.serviceIdentityKey,
      scheduledDeparture: baseline.plannedDeparture,
      scheduledArrival: baseline.plannedArrival,
      estimatedDeparture:
        delayMs !== 0 ? delayed(baseline.plannedDeparture) : null,
      estimatedArrival: delayMs > 0 ? delayed(baseline.plannedArrival) : null,
      actualDeparture:
        this.scenario === 'ACTUAL_DEPARTURE' ? baseline.plannedDeparture : null,
      actualArrival: null,
      departurePlatform:
        this.scenario === 'PLATFORM_CHANGE'
          ? this.calls === 1
            ? '2'
            : '5'
          : null,
      arrivalPlatform: null,
      serviceStatus:
        (this.scenario === 'CANCEL_FIXED' ||
          this.scenario === 'FAIL_FIRST_THEN_CANCEL_FIXED') &&
        baseline.serviceClass === 'FIXED_SERVICE'
          ? 'CANCELLED'
          : delayMs > 0
            ? 'DELAYED'
            : 'ON_TIME',
      boardingTargetServiceability: 'SERVED',
      alightingTargetServiceability:
        this.scenario === 'SHORT_TURN' ? 'NOT_SERVED' : 'SERVED',
      currentTerminusRef:
        this.scenario === 'SHORT_TURN'
          ? 'synthetic:short-terminus'
          : baseline.alightingHubRef,
      currentTerminusLabel:
        this.scenario === 'SHORT_TURN' ? 'Synthetic short terminus' : null,
      operatingFromHubRef: baseline.boardingHubRef,
      operatingToHubRef:
        this.scenario === 'SHORT_TURN'
          ? 'synthetic:short-terminus'
          : baseline.alightingHubRef,
      headwayMinSeconds:
        this.scenario === 'HIGH_FREQUENCY_3_TO_5'
          ? 180
          : baseline.headwayMinSeconds,
      headwayMaxSeconds:
        this.scenario === 'HIGH_FREQUENCY_3_TO_5'
          ? 300
          : baseline.headwayMaxSeconds,
      nextDepartureInSeconds: this.scenario === 'NEXT_DEPARTURE_2' ? 120 : null,
      minimumTransferSeconds: null,
    };
    if (this.scenario === 'REPLAY_SAME' || this.scenario === 'NEXT_DEPARTURE_2')
      this.replayObservations.set(input.leg.id, observation);
    return { status: 'SUCCESS', observation };
  }
}

export class UnconfiguredGroundTransitProvider implements GroundTransitProvider {
  readonly name = 'UNCONFIGURED';
  async fetchObservation(): Promise<GroundTransitProviderResult> {
    return { status: 'UNAVAILABLE' };
  }
}

export function createGroundTransitProvider(
  environment: NodeJS.ProcessEnv,
): GroundTransitProvider {
  const scenario = environment.GROUND_TRANSIT_SYNTHETIC_SCENARIO;
  if (scenario === undefined || scenario === 'UNCONFIGURED') {
    return new UnconfiguredGroundTransitProvider();
  }
  if (
    !['development', 'test'].includes(environment.APP_ENV ?? '') ||
    environment.SYNTHETIC_CI_ONLY !== 'true'
  ) {
    throw new Error(
      'Synthetic ground transit requires Dev/Test and SYNTHETIC_CI_ONLY=true',
    );
  }
  const scenarios: readonly SyntheticGroundTransitScenario[] = [
    'ON_TIME',
    'FIXED_DELAY',
    'MATERIAL_DELAY',
    'EARLY_DEPARTURE',
    'PLATFORM_CHANGE',
    'CANCEL_FIXED',
    'SHORT_TURN',
    'RECOVERY',
    'FAIL_FIRST_THEN_CANCEL_FIXED',
    'ACTUAL_DEPARTURE',
    'IDENTITY_MISMATCH',
    'HIGH_FREQUENCY_3_TO_5',
    'NEXT_DEPARTURE_2',
    'REPLAY_SAME',
    'STALE',
    'FAIL_FIRST',
  ];
  if (!scenarios.includes(scenario as SyntheticGroundTransitScenario)) {
    throw new Error('Unsupported GROUND_TRANSIT_SYNTHETIC_SCENARIO');
  }
  return new SyntheticGroundTransitProvider(
    scenario as SyntheticGroundTransitScenario,
  );
}
