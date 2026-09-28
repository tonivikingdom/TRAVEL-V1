import type {
  FlightLookupInput,
  FlightSnapshotProvider,
} from '@travel/application';
import type { FlightMovementView, FlightSnapshotView } from '@travel/contracts';

export interface SyntheticFlightProviderOptions {
  readonly scheduledUtc: string;
  readonly observedAt: string;
  readonly refreshMode: 'baseline' | 'delayed';
  readonly failFirstRefresh: boolean;
}

/** Isolated CI fixture. The current flight contract uses the aerodatabox
 * adapter shape; candidateId/rawStatus mark these observations synthetic. */
export class SyntheticFlightProvider implements FlightSnapshotProvider {
  private readonly attempted = new Set<string>();

  constructor(private readonly options: SyntheticFlightProviderOptions) {}

  async search(
    input: FlightLookupInput,
  ): Promise<readonly FlightSnapshotView[]> {
    return [this.snapshot(input, 'baseline', -1_000)];
  }

  async refresh(
    input: FlightLookupInput,
  ): Promise<readonly FlightSnapshotView[]> {
    const key = `${input.flightNumber}:${input.date}`;
    if (this.options.failFirstRefresh && !this.attempted.has(key)) {
      this.attempted.add(key);
      throw new Error('SYNTHETIC_FLIGHT_RETRY_INJECTION');
    }
    return [
      this.snapshot(
        input,
        this.options.refreshMode,
        this.options.refreshMode === 'delayed' ? 1_000 : 0,
      ),
    ];
  }

  private snapshot(
    input: FlightLookupInput,
    mode: 'baseline' | 'delayed',
    fetchedOffsetMs: number,
  ): FlightSnapshotView {
    const scheduledDeparture = new Date(this.options.scheduledUtc);
    const scheduledArrival = new Date(
      scheduledDeparture.getTime() + 2 * 60 * 60_000,
    );
    const delayed = mode === 'delayed';
    const movement = (
      airportIata: string,
      scheduled: Date,
      revised: Date | null,
    ): FlightMovementView => ({
      airportName: `SYNTHETIC ${airportIata}`,
      airportIata,
      airportIcao: null,
      timeZone: 'UTC',
      scheduledLocal: scheduled.toISOString(),
      scheduledUtc: scheduled.toISOString(),
      revisedLocal: revised?.toISOString() ?? null,
      revisedUtc: revised?.toISOString() ?? null,
      predictedLocal: null,
      predictedUtc: null,
      runwayLocal: null,
      runwayUtc: null,
      terminal: null,
      gate: null,
      checkInDesk: null,
      baggageBelt: null,
    });
    const revisedDeparture = delayed
      ? new Date(scheduledDeparture.getTime() + 45 * 60_000)
      : scheduledDeparture;
    const revisedArrival = delayed
      ? new Date(scheduledArrival.getTime() + 45 * 60_000)
      : scheduledArrival;
    return {
      provider: 'aerodatabox',
      candidateId: `synthetic-ci-only:${input.flightNumber}:${input.date}`,
      canonicalFlightNumber: input.flightNumber,
      displayFlightNumber: input.flightNumber,
      serviceDate: input.date,
      status: delayed ? 'DELAYED' : 'SCHEDULED',
      rawStatus: 'SYNTHETIC_CI_ONLY',
      airline: { name: 'SYNTHETIC CI ONLY', iata: null, icao: null },
      departure: movement('HND', scheduledDeparture, revisedDeparture),
      arrival: movement('CTS', scheduledArrival, revisedArrival),
      aircraft: null,
      departureDelayMinutes: delayed ? 45 : null,
      arrivalDelayMinutes: delayed ? 45 : null,
      departureDelayBasis: delayed ? 'REVISED_TIME' : null,
      arrivalDelayBasis: delayed ? 'REVISED_TIME' : null,
      fetchedAt: new Date(
        new Date(this.options.observedAt).getTime() + fetchedOffsetMs,
      ).toISOString(),
    };
  }
}
