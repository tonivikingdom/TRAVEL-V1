export interface CanonicalDwellAdjustment {
  readonly intentId: string;
  readonly nodeId: string;
  readonly fromDurationSeconds: number;
  readonly toDurationSeconds: number;
}

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareCanonicalDwellAdjustments(
  left: CanonicalDwellAdjustment,
  right: CanonicalDwellAdjustment,
): number {
  return (
    compareCanonicalText(left.intentId, right.intentId) ||
    compareCanonicalText(left.nodeId, right.nodeId) ||
    left.fromDurationSeconds - right.fromDurationSeconds ||
    left.toDurationSeconds - right.toDurationSeconds
  );
}
