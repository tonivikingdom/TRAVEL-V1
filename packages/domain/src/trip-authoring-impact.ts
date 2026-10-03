interface Placement {
  readonly id: string;
  readonly dayOccurrenceId: string;
}
/** Identity/sequence only: this never reorders by clock/date or authorizes archival. */
export function resolveTripAuthoringImpact(input: {
  readonly before: readonly Placement[];
  readonly after: readonly Placement[];
  readonly transports: readonly {
    readonly fromNodeId: string;
    readonly toNodeId: string;
  }[];
  readonly movedNodeId?: string;
  readonly executedNodeIds: readonly string[];
}): 'SAFE' | 'TRANSPORT_CONFLICT' | 'EXECUTION_ORDER_CONFLICT' {
  const adjacency = new Set(
    input.after.slice(1).map((n, i) => `${input.after[i]!.id}:${n.id}`),
  );
  const changedDay = (id: string) =>
    input.before.find((n) => n.id === id)?.dayOccurrenceId !==
    input.after.find((n) => n.id === id)?.dayOccurrenceId;
  if (
    input.transports.some(
      (e) =>
        !adjacency.has(`${e.fromNodeId}:${e.toNodeId}`) ||
        changedDay(e.fromNodeId) ||
        changedDay(e.toNodeId),
    )
  )
    return 'TRANSPORT_CONFLICT';
  if (
    input.movedNodeId &&
    input.executedNodeIds.some(
      (id) =>
        input.before.findIndex((n) => n.id === id) <
          input.before.findIndex((n) => n.id === input.movedNodeId) !==
        input.after.findIndex((n) => n.id === id) <
          input.after.findIndex((n) => n.id === input.movedNodeId),
    )
  )
    return 'EXECUTION_ORDER_CONFLICT';
  return 'SAFE';
}
