import type { FlightBindingView } from '@travel/contracts';
import type {
  FlightMonitorNotificationDecision,
  MonitorDecisionState,
} from '@travel/domain';

import type { Actor } from './authorization.js';
import type { NotificationRecord } from './ports.js';

export interface FlightMonitorContext {
  readonly actor: Actor;
  readonly binding: FlightBindingView;
  readonly state: MonitorDecisionState & {
    readonly lastSuccessfulMonitorRefreshAt: Date | null;
  };
}

export interface FlightMonitoringRepository {
  ensureEligibleMonitoring(now: Date): Promise<number>;
  findContext(flightBindingId: string): Promise<FlightMonitorContext | null>;
  recordAirportArrival(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
    readonly airportIata: string;
    readonly now: Date;
  }): Promise<FlightMonitorContext | null>;
  commitRefresh(input: {
    readonly flightBindingId: string;
    readonly acceptedFetchedAt: Date;
    readonly hasDownstreamImpact: boolean;
    readonly recordSuccessfulRefresh: boolean;
    readonly now: Date;
  }): Promise<NotificationRecord | null>;
  commitProviderFailure(input: {
    readonly flightBindingId: string;
    readonly state: MonitorDecisionState;
    readonly notification: FlightMonitorNotificationDecision | null;
    readonly nextCheckAt: Date | null;
    readonly now: Date;
  }): Promise<NotificationRecord | null>;
  cancelFutureMonitoring(flightBindingId: string, now: Date): Promise<void>;
}
