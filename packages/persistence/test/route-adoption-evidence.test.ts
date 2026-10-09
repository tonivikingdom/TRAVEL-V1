import { describe, expect, it } from 'vitest';
import { hasExpiredAdoptionEvidence } from '../src/route-adoption-evidence.js';

const now = new Date('2030-10-01T09:59:02Z');
const future = new Date(now.getTime() + 60_000);
type Field = 'preview' | 'snapshot' | 'provider';
function evidence(field: Field, boundary: Date) {
  return {
    expiresAt: field === 'preview' ? boundary : future,
    candidateSnapshot: {
      expiresAt: field === 'snapshot' ? boundary : future,
      providerValidUntil: field === 'provider' ? boundary : future,
    },
  };
}

describe('new-adoption evidence TTL boundary', () => {
  for (const field of ['preview', 'snapshot', 'provider'] as const) {
    it.each([-1, 0, 1])(
      `${field} independently expires at <= now (%s ms)`,
      (offset) => {
        expect(
          hasExpiredAdoptionEvidence(
            evidence(field, new Date(now.getTime() + offset)),
            now,
          ),
        ).toBe(offset <= 0);
      },
    );
  }
  it('absent Provider TTL does not invent an expiry', () => {
    const preview = evidence('preview', future);
    expect(
      hasExpiredAdoptionEvidence(
        {
          ...preview,
          candidateSnapshot: {
            ...preview.candidateSnapshot,
            providerValidUntil: null,
          },
        },
        now,
      ),
    ).toBe(false);
  });
  it.each(['preview', 'snapshot'] as const)(
    'null Provider TTL still enforces %s TTL',
    (field) => {
      const preview = evidence(field, now);
      expect(
        hasExpiredAdoptionEvidence(
          {
            ...preview,
            candidateSnapshot: {
              ...preview.candidateSnapshot,
              providerValidUntil: null,
            },
          },
          now,
        ),
      ).toBe(true);
    },
  );
  it('the same immutable evidence becomes stale when the fresh server clock advances', () => {
    const preview = evidence('preview', now);
    expect(
      hasExpiredAdoptionEvidence(preview, new Date(now.getTime() - 1)),
    ).toBe(false);
    expect(
      hasExpiredAdoptionEvidence(preview, new Date(now.getTime() + 1)),
    ).toBe(true);
    expect(preview.expiresAt).toEqual(now);
  });
});
