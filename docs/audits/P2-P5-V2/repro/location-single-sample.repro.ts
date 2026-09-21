import { decideExecutionLocation } from '../../../../packages/domain/src/execution-location.js';

const result = decideExecutionLocation({
  nodes: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      sequence: 0,
      position: 0,
      latitude: 35.681236,
      longitude: 139.767125,
      targetKind: 'PLACE',
      hasActualArrival: false,
      hasActualDeparture: false,
      executionStatus: null,
    },
  ],
  previousState: null,
  sample: {
    latitude: 35.681236,
    longitude: 139.767125,
    accuracyMeters: 10,
    observedAt: new Date('2030-01-01T01:00:00.000Z'),
  },
  policy: {
    maxReliableAccuracyMeters: 50,
    placeArrivalRadiusMeters: 100,
    transitHubArrivalRadiusMeters: 150,
    airportArrivalRadiusMeters: 300,
    exitHysteresisMeters: 50,
    minimumDepartureSamples: 2,
    maxFutureSkewSeconds: 120,
    maxSampleAgeSeconds: 300,
  },
});

if (result.status !== 'CONFIRMED_ARRIVAL') {
  throw new Error(
    `expected one sample to confirm arrival, got ${result.status}`,
  );
}

process.stdout.write(
  JSON.stringify(
    {
      demonstratedBehavior: 'single reliable point confirms arrival',
      status: result.status,
      nodeId: result.nodeId,
      note: 'This demonstrates current baseline behavior; it is not the proposed remediation.',
    },
    null,
    2,
  ) + '\n',
);
