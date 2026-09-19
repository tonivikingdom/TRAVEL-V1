export const P5B_EMAIL_PATTERN =
  /^synthetic-p5b-[a-z0-9-]+@synthetic\.example\.test$/u;

export interface ResetGuardInput {
  readonly appEnv: string | undefined;
  readonly confirmed: boolean;
  readonly allowStaging: boolean;
}

export type ResetGuard =
  | { readonly allowed: true; readonly dryRun: boolean }
  | { readonly allowed: false; readonly reason: string };

export function isP5bSyntheticEmail(email: string): boolean {
  return P5B_EMAIL_PATTERN.test(email.trim().toLowerCase());
}

export function evaluateResetGuard(input: ResetGuardInput): ResetGuard {
  if (input.appEnv === 'production') {
    return { allowed: false, reason: 'Production reset is permanently denied' };
  }
  if (!['development', 'test', 'staging'].includes(input.appEnv ?? '')) {
    return {
      allowed: false,
      reason: 'APP_ENV must be development, test, or staging',
    };
  }
  if (input.appEnv === 'staging' && !input.allowStaging) {
    return {
      allowed: true,
      dryRun: true,
    };
  }
  return { allowed: true, dryRun: !input.confirmed };
}

export interface RequestObservation {
  readonly ok: boolean;
  readonly status: number | null;
  readonly latencyMs: number;
  readonly networkFailure: boolean;
}

export interface AcceptanceAggregate {
  readonly requests: number;
  readonly success: number;
  readonly clientErrors: number;
  readonly unexpected5xx: number;
  readonly networkFailures: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export function percentile(
  values: readonly number[],
  fraction: number,
): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error('Percentile fraction must be between 0 and 1');
  }
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return roundMilliseconds(ordered[index]!);
}

export function aggregateObservations(
  observations: readonly RequestObservation[],
): AcceptanceAggregate {
  const latencies = observations.map((item) => item.latencyMs);
  return {
    requests: observations.length,
    success: observations.filter((item) => item.ok).length,
    clientErrors: observations.filter(
      (item) => item.status !== null && item.status >= 400 && item.status < 500,
    ).length,
    unexpected5xx: observations.filter(
      (item) => item.status !== null && item.status >= 500,
    ).length,
    networkFailures: observations.filter((item) => item.networkFailure).length,
    medianMs: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: roundMilliseconds(Math.max(0, ...latencies)),
  };
}

export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [REDACTED]')
    .replace(/([#?]token=)[A-Za-z0-9_-]+/giu, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, '$1[REDACTED]@')
    .replace(/("credential"\s*:\s*")[^"]+("?)/giu, '$1[REDACTED]$2');
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
