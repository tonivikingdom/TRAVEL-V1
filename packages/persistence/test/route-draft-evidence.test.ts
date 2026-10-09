import { describe, expect, it } from 'vitest';
import {
  hasExpiredPreviewEvidence,
  hasExpiredSnapshotEvidence,
} from '../src/route-draft-evidence.js';

const now = new Date('2030-10-01T09:59:02Z');
const later = new Date(now.getTime() + 60_000);
describe('draft evidence TTL predicates', () => {
  for (const field of ['snapshot', 'provider', 'preview'] as const) {
    it.each([-1, 0, 1])(
      `${field} independently expires at <= now (%s ms)`,
      (offset) => {
        const boundary = new Date(now.getTime() + offset);
        const snapshot = {
          expiresAt: field === 'snapshot' ? boundary : later,
          providerValidUntil: field === 'provider' ? boundary : later,
        };
        const preview = { expiresAt: field === 'preview' ? boundary : later };
        expect(hasExpiredPreviewEvidence(preview, snapshot, now)).toBe(
          offset <= 0,
        );
        expect(hasExpiredSnapshotEvidence(snapshot, now)).toBe(
          field !== 'preview' && offset <= 0,
        );
      },
    );
  }
  it('null Provider TTL neither invents expiry nor suppresses Snapshot/Preview expiry', () => {
    expect(
      hasExpiredSnapshotEvidence(
        { expiresAt: later, providerValidUntil: null },
        now,
      ),
    ).toBe(false);
    expect(
      hasExpiredSnapshotEvidence(
        { expiresAt: now, providerValidUntil: null },
        now,
      ),
    ).toBe(true);
    expect(
      hasExpiredPreviewEvidence(
        { expiresAt: now },
        { expiresAt: later, providerValidUntil: null },
        now,
      ),
    ).toBe(true);
  });
  it('checks immutable evidence against successive fresh clocks without renewing it', () => {
    const snapshot = { expiresAt: now, providerValidUntil: null };
    expect(
      hasExpiredSnapshotEvidence(snapshot, new Date(now.getTime() - 1)),
    ).toBe(false);
    expect(
      hasExpiredSnapshotEvidence(snapshot, new Date(now.getTime() + 1)),
    ).toBe(true);
    expect(snapshot.expiresAt).toEqual(now);
  });
});
