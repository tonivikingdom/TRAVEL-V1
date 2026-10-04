import { expect, it } from 'vitest';
import { resolveTripAuthoringImpact } from '../src/trip-authoring-impact.js';
const before = ['A', 'B', 'C'].map((id) => ({ id, dayOccurrenceId: 'day1' }));
it('blocks altered current transport adjacency/dates without inventing any archive action', () => {
  expect(
    resolveTripAuthoringImpact({
      before,
      after: [before[0]!, before[2]!, before[1]!],
      transports: [{ fromNodeId: 'A', toNodeId: 'B' }],
      executedNodeIds: [],
    }),
  ).toBe('TRANSPORT_CONFLICT');
  expect(
    resolveTripAuthoringImpact({
      before,
      after: before.map((n) => ({ ...n, dayOccurrenceId: 'day2' })),
      transports: [{ fromNodeId: 'A', toNodeId: 'B' }],
      executedNodeIds: [],
    }),
  ).toBe('TRANSPORT_CONFLICT');
  expect(
    resolveTripAuthoringImpact({
      before,
      after: [...before, { id: 'D', dayOccurrenceId: 'day2' }],
      transports: [{ fromNodeId: 'A', toNodeId: 'B' }],
      executedNodeIds: [],
    }),
  ).toBe('SAFE');
});
it('does not reorder unexecuted content across established execution order', () => {
  expect(
    resolveTripAuthoringImpact({
      before,
      after: [before[2]!, before[0]!, before[1]!],
      transports: [],
      executedNodeIds: ['A'],
      movedNodeId: 'C',
    }),
  ).toBe('EXECUTION_ORDER_CONFLICT');
});
