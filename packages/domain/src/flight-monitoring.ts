export type FlightMonitorMode =
  'NORMAL' | 'DELAYED' | 'CANCELLED' | 'BAGGAGE' | 'STOPPED';

export type FlightNotificationPriority = 'NORMAL' | 'STRONG';

export type FlightNotificationChangeKind =
  | 'CANCELLED'
  | 'RESTORED_AFTER_CANCELLATION'
  | 'DELAY'
  | 'DELAY_IMPROVED'
  | 'DELAY_RECOVERED'
  | 'EARLY_DEPARTURE'
  | 'EARLY_DEPARTURE_RECOVERED'
  | 'GATE_AVAILABLE'
  | 'GATE_CHANGED'
  | 'TERMINAL_CHANGED'
  | 'BOARDING'
  | 'BAGGAGE_AVAILABLE'
  | 'BAGGAGE_CHANGED'
  | 'PROVIDER_UNAVAILABLE';

export interface MonitorMovement {
  readonly scheduledUtc: string | null;
  readonly revisedUtc: string | null;
  readonly predictedUtc: string | null;
  readonly runwayUtc: string | null;
  readonly gate: string | null;
  readonly terminal: string | null;
  readonly baggageBelt?: string | null;
}

export interface MonitorSnapshot {
  readonly status: string;
  readonly departure: MonitorMovement;
  readonly arrival: MonitorMovement;
}

export interface MonitorDecisionState {
  readonly mode: FlightMonitorMode;
  readonly arrivedAtAirportAt: Date | null;
  readonly lastNotifiedDelayMinutes: number | null;
  readonly earlyDepartureNotified: boolean;
  readonly lastNotifiedDepartureGate: string | null;
  readonly providerUnavailableWarned: boolean;
  readonly cancellationNotified: boolean;
  readonly baggageWindowStartedAt: Date | null;
  readonly baggageWindowEndsAt: Date | null;
  readonly lastNotifiedBaggage: string | null;
}

export interface FlightMonitorNotificationDecision {
  readonly priority: FlightNotificationPriority;
  readonly summary: string;
  readonly changeKinds: readonly FlightNotificationChangeKind[];
}

export interface FlightMonitorDecision {
  readonly state: MonitorDecisionState;
  readonly notification: FlightMonitorNotificationDecision | null;
  readonly nextCheckAt: Date | null;
  readonly replaceSchedule: boolean;
}

export const NORMAL_PREFLIGHT_OFFSETS_MS = [
  24 * 60 * 60_000,
  16 * 60 * 60_000,
  8 * 60 * 60_000,
  4 * 60 * 60_000,
  2 * 60 * 60_000,
  60 * 60_000,
  30 * 60_000,
  15 * 60_000,
] as const;

export function futureNormalCheckpoints(
  scheduledDeparture: Date,
  now: Date,
): readonly Date[] {
  return NORMAL_PREFLIGHT_OFFSETS_MS.map(
    (offset) => new Date(scheduledDeparture.getTime() - offset),
  ).filter((checkpoint) => checkpoint.getTime() >= now.getTime());
}

export function shouldSkipFixedRefresh(
  lastSuccessfulRefreshAt: Date | null,
  now: Date,
): boolean {
  return (
    lastSuccessfulRefreshAt !== null &&
    now.getTime() - lastSuccessfulRefreshAt.getTime() >= 0 &&
    now.getTime() - lastSuccessfulRefreshAt.getTime() <= 30 * 60_000
  );
}

export function shouldRefreshFlightDetail(
  lastSuccessfulRefreshAt: Date | null,
  now: Date,
): boolean {
  return (
    lastSuccessfulRefreshAt === null ||
    now.getTime() - lastSuccessfulRefreshAt.getTime() > 5 * 60_000
  );
}

export function decideAcceptedFlightRefresh(input: {
  readonly previous: MonitorSnapshot;
  readonly next: MonitorSnapshot;
  readonly state: MonitorDecisionState;
  readonly now: Date;
}): FlightMonitorDecision {
  const scheduled = requiredInstant(input.next.departure.scheduledUtc);
  const wasCancelled =
    input.previous.status === 'CANCELLED' || input.state.cancellationNotified;
  const isCancelled = input.next.status === 'CANCELLED';
  const isDeparted = ['DEPARTED', 'EN_ROUTE'].includes(input.next.status);
  const isLanded =
    ['LANDED', 'ARRIVED'].includes(input.next.status) ||
    input.next.arrival.runwayUtc !== null;
  let state: MonitorDecisionState = { ...input.state };

  if (isCancelled) {
    const firstCancellation = !input.state.cancellationNotified;
    state = { ...state, mode: 'CANCELLED', cancellationNotified: true };
    return {
      state,
      notification: firstCancellation
        ? {
            priority: 'STRONG',
            summary: '航班已取消，请查看航司信息并重新确认后续安排。',
            changeKinds: ['CANCELLED'],
          }
        : null,
      nextCheckAt: nextCancellationCheck(scheduled, input.now),
      replaceSchedule: true,
    };
  }

  if (isDeparted && !isLanded) {
    return {
      state: { ...state, mode: 'STOPPED' },
      notification: null,
      nextCheckAt: null,
      replaceSchedule: true,
    };
  }

  if (isLanded) {
    const startedAt = state.baggageWindowStartedAt ?? input.now;
    const endsAt =
      state.baggageWindowEndsAt ?? new Date(startedAt.getTime() + 30 * 60_000);
    const baggage = input.next.arrival.baggageBelt ?? null;
    const baggageKinds: FlightNotificationChangeKind[] = [];
    if (baggage !== null && baggage !== state.lastNotifiedBaggage) {
      baggageKinds.push(
        state.lastNotifiedBaggage === null
          ? 'BAGGAGE_AVAILABLE'
          : 'BAGGAGE_CHANGED',
      );
      state = { ...state, lastNotifiedBaggage: baggage };
    }
    if (terminalChanged(input.previous.arrival, input.next.arrival)) {
      baggageKinds.push('TERMINAL_CHANGED');
    }
    state = {
      ...state,
      mode: 'BAGGAGE',
      baggageWindowStartedAt: startedAt,
      baggageWindowEndsAt: endsAt,
    };
    return {
      state,
      notification:
        baggageKinds.length === 0
          ? null
          : {
              priority: 'NORMAL',
              summary: summarizeLanding(baggageKinds, baggage, input.next),
              changeKinds: baggageKinds,
            },
      nextCheckAt:
        input.now.getTime() < endsAt.getTime()
          ? new Date(
              Math.min(endsAt.getTime(), input.now.getTime() + 5 * 60_000),
            )
          : null,
      replaceSchedule: true,
    };
  }

  const restored = wasCancelled && !isCancelled;
  if (restored) {
    state = { ...state, cancellationNotified: false };
  }
  const changeKinds: FlightNotificationChangeKind[] = restored
    ? ['RESTORED_AFTER_CANCELLATION']
    : [];

  const delay =
    delayMinutes(input.next.departure) ??
    (input.next.status === 'SCHEDULED' ? 0 : null);
  const previouslyNotified = state.lastNotifiedDelayMinutes;
  if (delay !== null) {
    if (delay >= 30) {
      const priorBucket =
        previouslyNotified === null
          ? null
          : Math.floor(previouslyNotified / 30);
      const nextBucket = Math.floor(delay / 30);
      if (priorBucket === null || nextBucket > priorBucket) {
        changeKinds.push('DELAY');
        state = { ...state, lastNotifiedDelayMinutes: delay };
      } else if (
        previouslyNotified !== null &&
        previouslyNotified - delay >= 15
      ) {
        changeKinds.push('DELAY_IMPROVED');
        state = { ...state, lastNotifiedDelayMinutes: delay };
      }
    } else if (previouslyNotified !== null && previouslyNotified >= 30) {
      changeKinds.push('DELAY_RECOVERED');
      state = { ...state, lastNotifiedDelayMinutes: delay };
    }
  }

  const observedDeparture = estimatedDeparture(input.next.departure);
  const isEarly =
    observedDeparture !== null &&
    observedDeparture.getTime() < scheduled.getTime();
  if (isEarly && !state.earlyDepartureNotified) {
    changeKinds.push('EARLY_DEPARTURE');
    state = { ...state, earlyDepartureNotified: true };
  } else if (
    observedDeparture !== null &&
    !isEarly &&
    state.earlyDepartureNotified
  ) {
    changeKinds.push('EARLY_DEPARTURE_RECOVERED');
    state = { ...state, earlyDepartureNotified: false };
  }

  const observedGateChanged =
    input.previous.departure.gate !== null &&
    input.next.departure.gate !== null &&
    input.previous.departure.gate !== input.next.departure.gate;
  const gateNowRelevant =
    input.next.departure.gate !== null &&
    (state.arrivedAtAirportAt !== null ||
      input.now.getTime() >= scheduled.getTime() - 2 * 60 * 60_000);
  const gateChanged =
    input.next.departure.gate !== null &&
    ((state.lastNotifiedDepartureGate !== null &&
      state.lastNotifiedDepartureGate !== input.next.departure.gate) ||
      observedGateChanged);
  if (gateChanged) {
    changeKinds.push('GATE_CHANGED');
    state = {
      ...state,
      lastNotifiedDepartureGate: input.next.departure.gate,
    };
  } else if (gateNowRelevant && state.lastNotifiedDepartureGate === null) {
    changeKinds.push('GATE_AVAILABLE');
    state = {
      ...state,
      lastNotifiedDepartureGate: input.next.departure.gate,
    };
  }

  if (terminalChanged(input.previous.departure, input.next.departure)) {
    changeKinds.push('TERMINAL_CHANGED');
  }
  if (
    input.previous.status !== 'BOARDING' &&
    input.next.status === 'BOARDING'
  ) {
    changeKinds.push('BOARDING');
  }

  const delayed =
    input.next.status === 'DELAYED' ||
    (observedDeparture !== null &&
      observedDeparture.getTime() > scheduled.getTime());
  const mode: FlightMonitorMode = delayed ? 'DELAYED' : 'NORMAL';
  state = { ...state, mode };
  const notification =
    changeKinds.length === 0
      ? null
      : {
          priority: restored ? ('STRONG' as const) : ('NORMAL' as const),
          summary: summarize(changeKinds, delay, input.next),
          changeKinds,
        };
  return {
    state,
    notification,
    nextCheckAt: delayed
      ? nextDelayCheck(input.next.departure, input.now)
      : null,
    replaceSchedule: delayed || input.state.mode !== mode,
  };
}

function terminalChanged(
  previous: MonitorMovement,
  next: MonitorMovement,
): boolean {
  return (
    previous.terminal !== null &&
    next.terminal !== null &&
    previous.terminal !== next.terminal
  );
}

function summarizeLanding(
  kinds: readonly FlightNotificationChangeKind[],
  baggage: string | null,
  snapshot: MonitorSnapshot,
): string {
  const parts: string[] = [];
  if (
    (kinds.includes('BAGGAGE_AVAILABLE') ||
      kinds.includes('BAGGAGE_CHANGED')) &&
    baggage !== null
  ) {
    parts.push(`行李转盘现为 ${baggage}`);
  }
  if (kinds.includes('TERMINAL_CHANGED')) {
    parts.push(`到达航站楼现为 ${snapshot.arrival.terminal}`);
  }
  return `${parts.join('；')}。`;
}

export function decideProviderFailure(input: {
  readonly snapshot: MonitorSnapshot;
  readonly state: MonitorDecisionState;
  readonly now: Date;
}): FlightMonitorDecision {
  const scheduled = requiredInstant(input.snapshot.departure.scheduledUtc);
  const warn =
    input.now.getTime() >= scheduled.getTime() - 2 * 60 * 60_000 &&
    !input.state.providerUnavailableWarned;
  const nextCheckAt =
    input.state.mode === 'CANCELLED'
      ? nextCancellationCheck(scheduled, input.now)
      : input.state.mode === 'DELAYED'
        ? nextDelayCheck(input.snapshot.departure, input.now)
        : input.state.mode === 'BAGGAGE' &&
            input.state.baggageWindowEndsAt !== null &&
            input.now.getTime() < input.state.baggageWindowEndsAt.getTime()
          ? new Date(
              Math.min(
                input.state.baggageWindowEndsAt.getTime(),
                input.now.getTime() + 5 * 60_000,
              ),
            )
          : null;
  return {
    state: warn
      ? { ...input.state, providerUnavailableWarned: true }
      : input.state,
    notification: warn
      ? {
          priority: 'NORMAL',
          summary: '航班最新状态暂时无法确认，请留意航司或机场通知。',
          changeKinds: ['PROVIDER_UNAVAILABLE'],
        }
      : null,
    nextCheckAt,
    replaceSchedule: false,
  };
}

function delayMinutes(movement: MonitorMovement): number | null {
  const scheduled = instant(movement.scheduledUtc);
  const observed = estimatedDeparture(movement);
  if (scheduled === null || observed === null) return null;
  return Math.floor((observed.getTime() - scheduled.getTime()) / 60_000);
}

function estimatedDeparture(movement: MonitorMovement): Date | null {
  return instant(
    movement.runwayUtc ?? movement.revisedUtc ?? movement.predictedUtc,
  );
}

export function nextDelayCheck(movement: MonitorMovement, now: Date): Date {
  const revised = instant(movement.revisedUtc ?? movement.predictedUtc);
  const interval =
    revised === null
      ? 30 * 60_000
      : revised.getTime() - now.getTime() > 60 * 60_000
        ? 60 * 60_000
        : 15 * 60_000;
  return new Date(now.getTime() + interval);
}

export function nextCancellationCheck(
  scheduledDeparture: Date,
  now: Date,
): Date | null {
  const end = scheduledDeparture.getTime() + 2 * 60 * 60_000;
  if (now.getTime() >= end) return null;
  const interval =
    scheduledDeparture.getTime() - now.getTime() > 6 * 60 * 60_000
      ? 2 * 60 * 60_000
      : 60 * 60_000;
  const next = now.getTime() + interval;
  return new Date(Math.min(next, end));
}

function summarize(
  kinds: readonly FlightNotificationChangeKind[],
  delay: number | null,
  snapshot: MonitorSnapshot,
): string {
  if (kinds.includes('RESTORED_AFTER_CANCELLATION')) {
    return '航班已恢复执行，请查看最新起飞信息和后续安排。';
  }
  const parts: string[] = [];
  if (kinds.includes('DELAY') && delay !== null)
    parts.push(`航班当前延误约 ${delay} 分钟`);
  if (kinds.includes('DELAY_IMPROVED') && delay !== null)
    parts.push(`航班延误已改善至约 ${delay} 分钟`);
  if (kinds.includes('DELAY_RECOVERED'))
    parts.push('航班延误已恢复至 30 分钟以内');
  if (kinds.includes('EARLY_DEPARTURE')) parts.push('预计起飞时间早于原计划');
  if (kinds.includes('EARLY_DEPARTURE_RECOVERED'))
    parts.push('预计起飞时间已恢复到原计划');
  if (kinds.includes('GATE_AVAILABLE') || kinds.includes('GATE_CHANGED'))
    parts.push(`登机口现为 ${snapshot.departure.gate}`);
  if (kinds.includes('TERMINAL_CHANGED'))
    parts.push(`出发航站楼现为 ${snapshot.departure.terminal}`);
  if (kinds.includes('BOARDING')) parts.push('航班已开始登机');
  return `${parts.join('；')}。`;
}

function requiredInstant(value: string | null): Date {
  const result = instant(value);
  if (result === null) throw new Error('Scheduled departure is required');
  return result;
}

function instant(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
