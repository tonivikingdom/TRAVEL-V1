export interface GeneratedNodeDeletionReferenceFacts {
  readonly adoptedRouteAnchor: boolean;
  readonly retainedPlanningData: boolean;
}

/** Persistent references protect deletion, not reuse of the same node identity. */
export function generatedNodeDeletionProtectionReasons(
  facts: GeneratedNodeDeletionReferenceFacts | undefined,
): readonly string[] {
  const reasons: string[] = [];
  if (facts?.adoptedRouteAnchor) reasons.push('REFERENCED_BY_ADOPTED_ROUTE');
  if (facts?.retainedPlanningData) {
    reasons.push('REFERENCED_BY_RETAINED_PLANNING_DATA');
  }
  return reasons;
}
