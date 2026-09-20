import { describe, expect, it } from 'vitest';

import {
  evaluateExecutionRisks,
  type ExecutionRiskEvaluationInput,
} from '../src/execution-risk.js';

const BASE = new Date('2030-01-01T10:00:00.000Z');

describe('execution risk evaluator', () => {
  it('stays quiet when execution deviates without a protected downstream anchor', () => {
    expect(evaluateExecutionRisks(input({ arrival: at(20) }))).toEqual([]);
  });

  it('stays quiet while a fixed-service margin still satisfies user minimum dwell', () => {
    expect(
      evaluateExecutionRisks(
        input({ arrival: at(20), fixedDeparture: at(60), minimum: 30 * 60 }),
      ),
    ).toEqual([]);
  });

  it('reports executable risk when margin is below user minimum dwell', () => {
    const [risk] = evaluateExecutionRisks(
      input({ arrival: at(40), fixedDeparture: at(60), minimum: 30 * 60 }),
    );
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
      requiresRouteReevaluation: false,
    });
  });

  it('reports a missed fixed service when reliable arrival is later', () => {
    const [risk] = evaluateExecutionRisks(
      input({ arrival: at(65), fixedDeparture: at(60), minimum: 30 * 60 }),
    );
    expect(risk).toMatchObject({
      kind: 'FIXED_SERVICE_MISSED',
      severity: 'INFEASIBLE',
      requiresRouteReevaluation: true,
    });
  });

  it('treats ACTUAL as immutable evidence when a fixed service was missed', () => {
    const scenario = input({
      arrival: at(65),
      arrivalLayer: 'ACTUAL',
      fixedDeparture: at(60),
    });
    const before = scenario.nodes[0]!.timeValues[0]!.instant.toISOString();
    expect(evaluateExecutionRisks(scenario)[0]?.severity).toBe('INFEASIBLE');
    expect(scenario.nodes[0]!.timeValues[0]!.instant.toISOString()).toBe(
      before,
    );
  });

  it('reports UNKNOWN rather than safe when a protected margin lacks evidence', () => {
    const [risk] = evaluateExecutionRisks(input({ fixedDeparture: at(60) }));
    expect(risk).toMatchObject({
      kind: 'UNKNOWN_EXECUTION_MARGIN',
      severity: 'UNKNOWN',
    });
  });

  it('uses the same protected-target fingerprint across unknown, risk, and infeasible severity', () => {
    const unknown = evaluateExecutionRisks(
      input({ fixedDeparture: at(60) }),
    )[0]!;
    const atRisk = evaluateExecutionRisks(
      input({ arrival: at(40), fixedDeparture: at(60), minimum: 30 * 60 }),
    )[0]!;
    const infeasible = evaluateExecutionRisks(
      input({ arrival: at(65), fixedDeparture: at(60), minimum: 30 * 60 }),
    )[0]!;
    expect(unknown.fingerprintParts).toEqual(atRisk.fingerprintParts);
    expect(atRisk.fingerprintParts).toEqual(infeasible.fingerprintParts);
    expect([unknown.severity, atRisk.severity, infeasible.severity]).toEqual([
      'UNKNOWN',
      'EXECUTABLE_RISK',
      'INFEASIBLE',
    ]);
  });

  it('treats a non-fixed transport ACTUAL departure as an immutable protected anchor', () => {
    const [risk] = evaluateExecutionRisks({
      nodes: [
        {
          id: 'node-a',
          sequence: 0,
          position: 0,
          timeValues: [value('actual-arrival', 'ACTUAL', 'ARRIVAL', at(65))],
          intents: [],
        },
      ],
      transports: [
        {
          id: 'edge-actual',
          fromNodeId: 'node-a',
          toNodeId: 'node-b',
          fixedService: false,
          timeValues: [
            value('actual-departure', 'ACTUAL', 'DEPARTURE', at(60)),
          ],
        },
      ],
    });
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_INFEASIBLE',
      severity: 'INFEASIBLE',
      protectedTransportEdgeId: 'edge-actual',
      requiresRouteReevaluation: true,
    });
  });

  it('uses ACTUAL over ESTIMATED as current execution evidence', () => {
    const scenario = input({ fixedDeparture: at(60), minimum: 30 * 60 });
    const [risk] = evaluateExecutionRisks({
      ...scenario,
      nodes: [
        {
          ...scenario.nodes[0]!,
          timeValues: [
            value('estimated-arrival', 'ESTIMATED', 'ARRIVAL', at(20)),
            value('actual-arrival', 'ACTUAL', 'ARRIVAL', at(65)),
          ],
        },
      ],
    });
    expect(risk).toMatchObject({
      kind: 'FIXED_SERVICE_MISSED',
      severity: 'INFEASIBLE',
    });
    expect(risk?.evidenceRefs).toContain('temporal:actual-arrival');
  });

  it('evaluates the strongest explicit point-time deadline deterministically', () => {
    const node = {
      id: 'node-a',
      sequence: 0,
      position: 0,
      timeValues: [
        value('estimated-departure', 'ESTIMATED', 'DEPARTURE', at(70)),
      ],
      intents: [
        pointIntent('later', 'NOT_AFTER', at(80)),
        pointIntent('earlier', 'NOT_AFTER', at(60)),
      ],
    };
    const [risk] = evaluateExecutionRisks({ nodes: [node], transports: [] });
    const [shuffled] = evaluateExecutionRisks({
      nodes: [{ ...node, intents: [...node.intents].reverse() }],
      transports: [],
    });
    expect(risk).toEqual(shuffled);
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_INFEASIBLE',
      severity: 'INFEASIBLE',
      evidenceRefs: [
        'intent:earlier',
        'intent:later',
        'temporal:estimated-departure',
      ],
    });
  });

  it('treats a system suggestion breach as executable rather than infeasible', () => {
    const [risk] = evaluateExecutionRisks(
      input({
        arrival: at(45),
        fixedDeparture: at(60),
        suggestion: 30 * 60,
      }),
    );
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
    });
  });

  it('keeps a system minimum breach persistent but never invents an unknown minimum', () => {
    const known = evaluateExecutionRisks(
      input({
        buffers: [
          {
            id: 'connection-a',
            kind: 'SYSTEM_MINIMUM_CONNECTION',
            availableSeconds: 12 * 60,
            requiredSeconds: 15 * 60,
          },
        ],
      }),
    );
    expect(known[0]).toMatchObject({
      kind: 'BUFFER_BELOW_SYSTEM_MINIMUM',
      severity: 'EXECUTABLE_RISK',
    });
    expect(
      evaluateExecutionRisks(
        input({
          buffers: [
            {
              id: 'connection-unknown',
              kind: 'SYSTEM_MINIMUM_CONNECTION',
              availableSeconds: 12 * 60,
              requiredSeconds: null,
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it.each(['SYSTEM_SUGGESTED_BUFFER', 'USER_PREFERRED_BUFFER'] as const)(
    'treats %s breaches as soft executable risk',
    (kind) => {
      const [risk] = evaluateExecutionRisks(
        input({
          buffers: [
            {
              id: kind,
              kind,
              availableSeconds: 10,
              requiredSeconds: 20,
            },
          ],
        }),
      );
      expect(risk).toMatchObject({
        kind: 'PROTECTED_TIME_AT_RISK',
        severity: 'EXECUTABLE_RISK',
        requiresRouteReevaluation: false,
      });
    },
  );

  it('uses only the nearest protected downstream anchor', () => {
    const scenario = input({ arrival: at(65), fixedDeparture: at(60) });
    const laterNode = {
      ...scenario.nodes[0]!,
      id: 'node-b',
      sequence: 1,
      timeValues: [],
    };
    const risks = evaluateExecutionRisks({
      ...scenario,
      nodes: [...scenario.nodes, laterNode],
      transports: [
        ...scenario.transports,
        {
          id: 'edge-later',
          fromNodeId: 'node-b',
          toNodeId: 'node-c',
          fixedService: true,
          timeValues: [
            value('edge-later-departure', 'PLANNED', 'DEPARTURE', at(180)),
          ],
        },
      ],
    });
    expect(risks).toHaveLength(1);
    expect(risks[0]?.protectedTransportEdgeId).toBe('edge-fixed');
  });

  it('uses latest ACTUAL rather than a farther prediction as the execution frontier', () => {
    const nodes = [
      {
        id: 'node-a',
        sequence: 0,
        position: 0,
        timeValues: [value('actual-a', 'ACTUAL', 'DEPARTURE', at(0))],
        intents: [],
      },
      {
        id: 'node-b',
        sequence: 1,
        position: 0,
        timeValues: [value('estimate-b', 'ESTIMATED', 'ARRIVAL', at(65))],
        intents: [],
      },
      {
        id: 'node-c',
        sequence: 2,
        position: 0,
        timeValues: [value('estimate-c', 'ESTIMATED', 'ARRIVAL', at(170))],
        intents: [],
      },
    ];
    const risks = evaluateExecutionRisks({
      nodes,
      transports: [
        {
          id: 'edge-near',
          fromNodeId: 'node-b',
          toNodeId: 'node-c',
          fixedService: true,
          timeValues: [value('near-departure', 'PLANNED', 'DEPARTURE', at(60))],
        },
        {
          id: 'edge-far',
          fromNodeId: 'node-c',
          toNodeId: 'node-d',
          fixedService: true,
          timeValues: [value('far-departure', 'PLANNED', 'DEPARTURE', at(180))],
        },
      ],
    });
    expect(risks).toHaveLength(1);
    expect(risks[0]?.protectedTransportEdgeId).toBe('edge-near');
  });

  it('is deterministic for shuffled inputs', () => {
    const scenario = input({
      arrival: at(40),
      fixedDeparture: at(60),
      minimum: 30 * 60,
      buffers: [
        {
          id: 'b',
          kind: 'USER_PREFERRED_BUFFER',
          availableSeconds: 10,
          requiredSeconds: 20,
        },
        {
          id: 'a',
          kind: 'SYSTEM_SUGGESTED_BUFFER',
          availableSeconds: 10,
          requiredSeconds: 20,
        },
      ],
    });
    expect(evaluateExecutionRisks(scenario)).toEqual(
      evaluateExecutionRisks({
        ...scenario,
        nodes: [...scenario.nodes].reverse(),
        transports: [...scenario.transports].reverse(),
        buffers: [...(scenario.buffers ?? [])].reverse(),
      }),
    );
  });
});

function input(options: {
  arrival?: Date;
  arrivalLayer?: 'ESTIMATED' | 'ACTUAL';
  fixedDeparture?: Date;
  minimum?: number;
  suggestion?: number;
  buffers?: ExecutionRiskEvaluationInput['buffers'];
}): ExecutionRiskEvaluationInput {
  return {
    nodes: [
      {
        id: 'node-a',
        sequence: 0,
        position: 0,
        timeValues:
          options.arrival === undefined
            ? []
            : [
                value(
                  'node-arrival',
                  options.arrivalLayer ?? 'ESTIMATED',
                  'ARRIVAL',
                  options.arrival,
                ),
              ],
        intents:
          options.minimum === undefined
            ? []
            : [
                {
                  id: 'min-dwell',
                  kind: 'MIN_DWELL',
                  pointKind: null,
                  operator: 'MINIMUM',
                  instant: null,
                  durationSeconds: options.minimum,
                  locked: false,
                },
              ],
        systemDwellSuggestionSeconds: options.suggestion ?? null,
      },
    ],
    transports:
      options.fixedDeparture === undefined
        ? []
        : [
            {
              id: 'edge-fixed',
              fromNodeId: 'node-a',
              toNodeId: 'node-after',
              fixedService: true,
              timeValues: [
                value(
                  'fixed-departure',
                  'PLANNED',
                  'DEPARTURE',
                  options.fixedDeparture,
                ),
              ],
            },
          ],
    ...(options.buffers === undefined ? {} : { buffers: options.buffers }),
  };
}

function value(
  id: string,
  layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL',
  pointKind: 'ARRIVAL' | 'DEPARTURE',
  instant: Date,
) {
  return { id, layer, pointKind, instant } as const;
}

function pointIntent(
  id: string,
  operator: 'EXACT' | 'NOT_AFTER',
  instant: Date,
) {
  return {
    id,
    kind: 'POINT_TIME',
    pointKind: 'DEPARTURE',
    operator,
    instant,
    durationSeconds: null,
    locked: true,
  } as const;
}

function at(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60_000);
}
