import {
  ApplicationError,
  type FlightLookupInput,
  type FlightSnapshotProvider,
} from '@travel/application';

export class UnconfiguredFlightProvider implements FlightSnapshotProvider {
  search(input: FlightLookupInput): Promise<never> {
    void input;
    return Promise.reject(unconfigured());
  }

  refresh(input: FlightLookupInput): Promise<never> {
    void input;
    return Promise.reject(unconfigured());
  }
}

function unconfigured() {
  return new ApplicationError(
    'FLIGHT_PROVIDER_NOT_CONFIGURED',
    '航班数据源尚未配置或未启用。',
    503,
    true,
  );
}
