interface AdoptionEvidence {
  readonly expiresAt: Date;
  readonly candidateSnapshot: {
    readonly expiresAt: Date;
    readonly providerValidUntil: Date | null;
  };
}

/** Called for a NEW adoption only, after authoritative locks and again after
 * tentative writes. A recorded successful receipt is replayed before this.
 */
export function hasExpiredAdoptionEvidence(
  preview: AdoptionEvidence,
  now: Date,
): boolean {
  return (
    preview.expiresAt <= now ||
    preview.candidateSnapshot.expiresAt <= now ||
    (preview.candidateSnapshot.providerValidUntil !== null &&
      preview.candidateSnapshot.providerValidUntil <= now)
  );
}
