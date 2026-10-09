interface SnapshotEvidence {
  readonly expiresAt: Date;
  readonly providerValidUntil: Date | null;
}

export function hasExpiredSnapshotEvidence(
  snapshot: SnapshotEvidence,
  now: Date,
): boolean {
  return (
    snapshot.expiresAt <= now ||
    (snapshot.providerValidUntil !== null && snapshot.providerValidUntil <= now)
  );
}

export function hasExpiredPreviewEvidence(
  preview: { readonly expiresAt: Date },
  snapshot: SnapshotEvidence,
  now: Date,
): boolean {
  return preview.expiresAt <= now || hasExpiredSnapshotEvidence(snapshot, now);
}
