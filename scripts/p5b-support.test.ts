import { describe, expect, it } from 'vitest';

import {
  aggregateObservations,
  evaluateResetGuard,
  isP5bSyntheticEmail,
  percentile,
  redactSecrets,
} from './p5b-support.js';

describe('P5B acceptance helpers', () => {
  it('matches only the strict P5B synthetic namespace', () => {
    expect(
      isP5bSyntheticEmail('synthetic-p5b-user-01@synthetic.example.test'),
    ).toBe(true);
    expect(
      isP5bSyntheticEmail('synthetic-p5a-user@synthetic.example.test'),
    ).toBe(false);
    expect(isP5bSyntheticEmail('ordinary@example.test')).toBe(false);
    expect(
      isP5bSyntheticEmail('prefix-synthetic-p5b-user@synthetic.example.test'),
    ).toBe(false);
  });

  it('enforces production, staging, and explicit-confirm reset guards', () => {
    expect(
      evaluateResetGuard({
        appEnv: 'production',
        confirmed: true,
        allowStaging: true,
      }),
    ).toEqual({
      allowed: false,
      reason: 'Production reset is permanently denied',
    });
    expect(
      evaluateResetGuard({
        appEnv: 'staging',
        confirmed: true,
        allowStaging: false,
      }),
    ).toEqual({ allowed: true, dryRun: true });
    expect(
      evaluateResetGuard({
        appEnv: 'test',
        confirmed: false,
        allowStaging: false,
      }),
    ).toEqual({ allowed: true, dryRun: true });
    expect(
      evaluateResetGuard({
        appEnv: 'development',
        confirmed: true,
        allowStaging: false,
      }),
    ).toEqual({ allowed: true, dryRun: false });
  });

  it('calculates deterministic latency percentiles and aggregates outcomes', () => {
    expect(percentile([40, 10, 20, 30], 0.5)).toBe(20);
    expect(percentile([40, 10, 20, 30], 0.95)).toBe(40);
    expect(
      aggregateObservations([
        { ok: true, status: 200, latencyMs: 10, networkFailure: false },
        { ok: false, status: 409, latencyMs: 20, networkFailure: false },
        { ok: false, status: 503, latencyMs: 30, networkFailure: false },
        { ok: false, status: null, latencyMs: 40, networkFailure: true },
      ]),
    ).toEqual({
      requests: 4,
      success: 1,
      clientErrors: 1,
      unexpected5xx: 1,
      networkFailures: 1,
      medianMs: 20,
      p95Ms: 40,
      maxMs: 40,
    });
  });

  it('redacts bearer, Magic Link, database, and credential secrets', () => {
    const redacted = redactSecrets(
      'Bearer abc.def #token=RAW_TOKEN postgresql://user:secret@db/test "credential":"SESSION"',
    );
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('RAW_TOKEN');
    expect(redacted).not.toContain(':secret@');
    expect(redacted).not.toContain('SESSION');
  });
});
