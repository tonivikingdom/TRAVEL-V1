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

  it('keeps a fixed service classified as missed when its departure is ACTUAL', () => {
    const [risk] = evaluateExecutionRisks({
      nodes: [
        {
          id: 'node-a',
          sequence: 0,
          position: 0,
          timeValues: [
            value('estimated-arrival', 'ESTIMATED', 'ARRIVAL', at(65)),
          ],
          intents: [],
        },
      ],
      transports: [
        {
          id: 'edge-fixed-actual',
          fromNodeId: 'node-a',
          toNodeId: 'node-b',
          fixedService: true,
          timeValues: [
            value('actual-departure', 'ACTUAL', 'DEPARTURE', at(60)),
          ],
        },
      ],
    });
    expect(risk).toMatchObject({
      kind: 'FIXED_SERVICE_MISSED',
      severity: 'INFEASIBLE',
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

  it('uses an incoming transport ESTIMATED arrival for fixed-service margin and provenance', () => {
    const [risk] = evaluateExecutionRisks(
      boundaryInput({
        incomingArrival: at(40),
        fixedPlannedDeparture: at(60),
        minimum: 30 * 60,
      }),
    );
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
      sourceNodeId: 'node-connection',
      sourceTransportEdgeId: 'edge-incoming',
    });
    expect(risk?.evidenceRefs).toEqual([
      'intent:min-dwell',
      'temporal:fixed-planned-departure',
      'temporal:incoming-arrival',
      'transport:edge-fixed',
      'transport:edge-incoming',
    ]);
  });

  it('uses an incoming transport ACTUAL arrival to detect a missed fixed service', () => {
    const [risk] = evaluateExecutionRisks(
      boundaryInput({
        incomingArrival: at(65),
        incomingArrivalLayer: 'ACTUAL',
        fixedPlannedDeparture: at(60),
      }),
    );
    expect(risk).toMatchObject({
      kind: 'FIXED_SERVICE_MISSED',
      severity: 'INFEASIBLE',
      sourceTransportEdgeId: 'edge-incoming',
      requiresRouteReevaluation: true,
    });
  });

  it('uses a later fixed-service ESTIMATED departure over PLANNED', () => {
    expect(
      evaluateExecutionRisks(
        boundaryInput({
          incomingArrival: at(50),
          fixedPlannedDeparture: at(60),
          fixedEstimatedDeparture: at(90),
          minimum: 30 * 60,
        }),
      ),
    ).toEqual([]);
  });

  it('uses an earlier fixed-service ESTIMATED departure over PLANNED', () => {
    const [risk] = evaluateExecutionRisks(
      boundaryInput({
        incomingArrival: at(40),
        fixedPlannedDeparture: at(60),
        fixedEstimatedDeparture: at(45),
        minimum: 30 * 60,
      }),
    );
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
      protectedTransportEdgeId: 'edge-fixed',
    });
    expect(risk?.evidenceRefs).toContain('temporal:fixed-estimated-departure');
    expect(risk?.evidenceRefs).not.toContain(
      'temporal:fixed-planned-departure',
    );
  });

  it('uses fixed-service ACTUAL departure over ESTIMATED and PLANNED', () => {
    const scenario = boundaryInput({
      incomingArrival: at(40),
      fixedPlannedDeparture: at(60),
      fixedEstimatedDeparture: at(90),
    });
    const [risk] = evaluateExecutionRisks({
      ...scenario,
      transports: scenario.transports.map((edge) =>
        edge.id === 'edge-fixed'
          ? {
              ...edge,
              timeValues: [
                ...edge.timeValues,
                value('fixed-actual-departure', 'ACTUAL', 'DEPARTURE', at(35)),
              ],
            }
          : edge,
      ),
    });
    expect(risk).toMatchObject({
      kind: 'FIXED_SERVICE_MISSED',
      severity: 'INFEASIBLE',
    });
    expect(risk?.evidenceRefs).toContain('temporal:fixed-actual-departure');
  });

  it('evaluates ARRIVAL point-time intent from incoming transport evidence', () => {
    const scenario = boundaryInput({ incomingArrival: at(70) });
    const [risk] = evaluateExecutionRisks({
      ...scenario,
      nodes: scenario.nodes.map((node) =>
        node.id === 'node-connection'
          ? {
              ...node,
              intents: [
                {
                  ...pointIntent('arrival-deadline', 'NOT_AFTER', at(60)),
                  pointKind: 'ARRIVAL' as const,
                },
              ],
            }
          : node,
      ),
    });
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_INFEASIBLE',
      sourceTransportEdgeId: 'edge-incoming',
    });
    expect(risk?.evidenceRefs).toEqual([
      'intent:arrival-deadline',
      'temporal:incoming-arrival',
      'transport:edge-incoming',
    ]);
  });

  it('evaluates DEPARTURE point-time intent from outgoing transport evidence', () => {
    const [risk] = evaluateExecutionRisks({
      nodes: [
        {
          id: 'node-connection',
          sequence: 0,
          position: 0,
          timeValues: [],
          intents: [pointIntent('departure-deadline', 'NOT_AFTER', at(60))],
        },
      ],
      transports: [
        {
          id: 'edge-outgoing',
          fromNodeId: 'node-connection',
          toNodeId: 'node-after',
          fixedService: false,
          timeValues: [
            value(
              'outgoing-estimated-departure',
              'ESTIMATED',
              'DEPARTURE',
              at(70),
            ),
          ],
        },
      ],
    });
    expect(risk).toMatchObject({
      kind: 'PROTECTED_TIME_INFEASIBLE',
      sourceTransportEdgeId: 'edge-outgoing',
    });
    expect(risk?.evidenceRefs).toContain(
      'temporal:outgoing-estimated-departure',
    );
  });

  it('prefers node ACTUAL over incoming transport ESTIMATED evidence', () => {
    const scenario = boundaryInput({
      incomingArrival: at(70),
      fixedPlannedDeparture: at(60),
    });
    const [risk] = evaluateExecutionRisks({
      ...scenario,
      nodes: scenario.nodes.map((node) =>
        node.id === 'node-connection'
          ? {
              ...node,
              timeValues: [
                value('node-actual-arrival', 'ACTUAL', 'ARRIVAL', at(40)),
              ],
            }
          : node,
      ),
    });
    expect(risk).toBeUndefined();
  });

  it('prefers incoming transport ACTUAL over node ESTIMATED evidence', () => {
    const scenario = boundaryInput({
      incomingArrival: at(65),
      incomingArrivalLayer: 'ACTUAL',
      fixedPlannedDeparture: at(60),
    });
    const [risk] = evaluateExecutionRisks({
      ...scenario,
      nodes: scenario.nodes.map((node) =>
        node.id === 'node-connection'
          ? {
              ...node,
              timeValues: [
                value('node-estimated-arrival', 'ESTIMATED', 'ARRIVAL', at(40)),
              ],
            }
          : node,
      ),
    });
    expect(risk).toMatchObject({
      kind: 'FIXED_SERVICE_MISSED',
      sourceTransportEdgeId: 'edge-incoming',
    });
    expect(risk?.evidenceRefs).toContain('temporal:incoming-arrival');
  });

  it('deterministically prefers direct node evidence over transport evidence at the same layer', () => {
    const scenario = boundaryInput({
      incomingArrival: at(65),
      fixedPlannedDeparture: at(60),
    });
    const withNodeEvidence = {
      ...scenario,
      nodes: scenario.nodes.map((node) =>
        node.id === 'node-connection'
          ? {
              ...node,
              timeValues: [
                value('node-estimated-arrival', 'ESTIMATED', 'ARRIVAL', at(40)),
              ],
            }
          : node,
      ),
    };
    expect(evaluateExecutionRisks(withNodeEvidence)).toEqual(
      evaluateExecutionRisks({
        ...withNodeEvidence,
        transports: [...withNodeEvidence.transports].reverse(),
      }),
    );
    expect(evaluateExecutionRisks(withNodeEvidence)).toEqual([]);
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

  it('treats a locked NOT_BEFORE estimate as executable risk and ACTUAL as infeasible', () => {
    const lockedIntent = {
      id: 'locked-lower-bound',
      kind: 'POINT_TIME',
      pointKind: 'DEPARTURE',
      operator: 'NOT_BEFORE',
      instant: at(60),
      durationSeconds: null,
      locked: true,
    } as const;
    const scenario = (layer: 'ESTIMATED' | 'ACTUAL') =>
      evaluateExecutionRisks({
        nodes: [
          {
            id: 'node-a',
            sequence: 0,
            position: 0,
            timeValues: [
              value(`${layer}-departure`, layer, 'DEPARTURE', at(50)),
            ],
            intents: [lockedIntent],
          },
        ],
        transports: [],
      })[0];
    expect(scenario('ESTIMATED')).toMatchObject({
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
      requiresRouteReevaluation: false,
    });
    expect(scenario('ACTUAL')).toMatchObject({
      kind: 'PROTECTED_TIME_INFEASIBLE',
      severity: 'INFEASIBLE',
      requiresRouteReevaluation: true,
    });
  });

  it('distinguishes recoverable early and infeasible late EXACT estimates', () => {
    const evaluate = (current: Date) =>
      evaluateExecutionRisks({
        nodes: [
          {
            id: 'node-a',
            sequence: 0,
            position: 0,
            timeValues: [
              value('estimated-departure', 'ESTIMATED', 'DEPARTURE', current),
            ],
            intents: [pointIntent('exact', 'EXACT', at(60))],
          },
        ],
        transports: [],
      })[0];
    expect(evaluate(at(50))).toMatchObject({
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
    });
    expect(evaluate(at(70))).toMatchObject({
      kind: 'PROTECTED_TIME_INFEASIBLE',
      severity: 'INFEASIBLE',
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

function boundaryInput(options: {
  incomingArrival: Date;
  incomingArrivalLayer?: 'ESTIMATED' | 'ACTUAL';
  fixedPlannedDeparture?: Date;
  fixedEstimatedDeparture?: Date;
  minimum?: number;
}): ExecutionRiskEvaluationInput {
  return {
    nodes: [
      {
        id: 'node-before',
        sequence: 0,
        position: 0,
        timeValues: [],
        intents: [],
      },
      {
        id: 'node-connection',
        sequence: 0,
        position: 1,
        timeValues: [],
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
      },
      {
        id: 'node-after',
        sequence: 0,
        position: 2,
        timeValues: [],
        intents: [],
      },
    ],
    transports: [
      {
        id: 'edge-incoming',
        fromNodeId: 'node-before',
        toNodeId: 'node-connection',
        fixedService: false,
        timeValues: [
          value(
            'incoming-arrival',
            options.incomingArrivalLayer ?? 'ESTIMATED',
            'ARRIVAL',
            options.incomingArrival,
          ),
        ],
      },
      ...(options.fixedPlannedDeparture === undefined
        ? []
        : [
            {
              id: 'edge-fixed',
              fromNodeId: 'node-connection',
              toNodeId: 'node-after',
              fixedService: true,
              timeValues: [
                value(
                  'fixed-planned-departure',
                  'PLANNED',
                  'DEPARTURE',
                  options.fixedPlannedDeparture,
                ),
                ...(options.fixedEstimatedDeparture === undefined
                  ? []
                  : [
                      value(
                        'fixed-estimated-departure',
                        'ESTIMATED',
                        'DEPARTURE',
                        options.fixedEstimatedDeparture,
                      ),
                    ]),
              ],
            },
          ]),
    ],
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
