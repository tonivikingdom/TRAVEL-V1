import { randomUUID } from 'node:crypto';

import type { TripCommandInput } from '@travel/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TripService } from '../src/trip-service.js';
import type {
  RepositoryTripCommand,
  TripAggregateRecord,
  TripMutationResult,
  TripRepository,
} from '../src/trip-ports.js';

const ownerUserId = randomUUID();
const tripId = randomUUID();
const actor = {
  userId: ownerUserId,
  email: 'synthetic-trip@synthetic.example.test',
  role: 'USER' as const,
  status: 'ACTIVE' as const,
};

describe('TripService', () => {
  let repository: TripRepository;
  let service: TripService;

  beforeEach(() => {
    repository = {
      create: vi.fn(async (input) => emptyTrip(input)),
      listOwned: vi.fn(async () => []),
      findOwnedById: vi.fn(async () => null),
      updateMetadata: vi.fn(async (): Promise<TripMutationResult> => ({
        status: 'NOT_FOUND',
      })),
      executeCommand: vi.fn(async (): Promise<TripMutationResult> => ({
        status: 'NOT_FOUND',
      })),
      setTemporalValue: vi.fn(async (): Promise<TripMutationResult> => ({
        status: 'NOT_FOUND',
      })),
      setSystemDwellSuggestion: vi.fn(
        async (): Promise<TripMutationResult> => ({ status: 'NOT_FOUND' }),
      ),
      listTransportHistoryOwned: vi.fn(async () => null),
    };
    service = new TripService(repository);
  });

  it('creates an empty Trip without a range, ownership, or projected Day', async () => {
    const result = await service.createTrip(actor, {
      name: ' SYNTHETIC P2A ',
      planningAnchorDate: '2030-10-01',
      defaultPeopleCount: 2,
    });
    expect(result).toMatchObject({
      name: 'SYNTHETIC P2A',
      planningAnchorDate: '2030-10-01',
      effectiveStartDate: null,
      effectiveEndDate: null,
      version: 1,
      days: [],
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId, defaultPeopleCount: 2 }),
    );
  });

  it.each(['2030-02-30', '2030-1-01', '2030-10-01T00:00:00Z', 'not-a-date'])(
    'rejects a non-canonical or invalid natural day: %s',
    async (date) => {
      await expect(
        service.createTrip(actor, {
          name: 'SYNTHETIC',
          planningAnchorDate: date,
          defaultPeopleCount: 1,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400 });
    },
  );

  it('projects every DateOwnership including a middle day with no nodes', async () => {
    const firstOccurrenceId = randomUUID();
    const middleOccurrenceId = randomUUID();
    const lastOccurrenceId = randomUUID();
    vi.mocked(repository.findOwnedById).mockResolvedValue({
      ...emptyTrip({
        ownerUserId,
        name: 'SYNTHETIC projection',
        planningAnchorDate: utcDate('2030-10-01'),
        defaultPeopleCount: 1,
      }),
      effectiveStartDate: utcDate('2030-10-01'),
      effectiveEndDate: utcDate('2030-10-03'),
      ownedDates: [
        utcDate('2030-10-01'),
        utcDate('2030-10-02'),
        utcDate('2030-10-03'),
      ],
      dayOccurrences: [
        dayOccurrence('2030-10-01', 0, firstOccurrenceId, [
          freeAction(firstOccurrenceId, 0),
        ]),
        dayOccurrence('2030-10-02', 1, middleOccurrenceId, []),
        dayOccurrence('2030-10-03', 2, lastOccurrenceId, [
          freeAction(lastOccurrenceId, 0),
        ]),
      ],
    });
    const result = await service.getTrip(actor, tripId);
    expect(result.days.map((day) => [day.localDate, day.nodes.length])).toEqual(
      [
        ['2030-10-01', 1],
        ['2030-10-02', 0],
        ['2030-10-03', 1],
      ],
    );
  });

  it('normalizes a FREE_ACTION without inventing a Place', async () => {
    let received: RepositoryTripCommand | undefined;
    vi.mocked(repository.executeCommand).mockImplementation(async (input) => {
      received = input.command;
      return { status: 'SUCCESS', trip: emptyTripForId() };
    });
    const command: TripCommandInput = {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'NEW',
        localDate: '2030-10-01',
        sequence: 0,
      },
      position: 0,
      note: '  SYNTHETIC free time  ',
    };
    await service.executeCommand(actor, tripId, 1, command);
    expect(received).toMatchObject({
      type: 'ADD_FREE_ACTION',
      position: 0,
      note: 'SYNTHETIC free time',
    });
    expect(received).not.toHaveProperty('place');
  });

  it('projects ACTIVE, MISSING, NOT_APPLICABLE, and runtime-origin connections', async () => {
    const occurrenceId = randomUUID();
    const first = placeVisit(occurrenceId, 0, 'A');
    const second = placeVisit(occurrenceId, 1, 'B');
    const free = freeAction(occurrenceId, 2);
    const third = placeVisit(occurrenceId, 3, 'C');
    const fourth = placeVisit(occurrenceId, 4, 'D');
    vi.mocked(repository.findOwnedById).mockResolvedValue({
      ...emptyTripForId(),
      effectiveStartDate: utcDate('2030-10-01'),
      effectiveEndDate: utcDate('2030-10-01'),
      ownedDates: [utcDate('2030-10-01')],
      dayOccurrences: [
        dayOccurrence('2030-10-01', 0, occurrenceId, [
          first,
          second,
          free,
          third,
          fourth,
        ]),
      ],
      transportEdges: [manualTransport(first.id, second.id)],
    });

    const result = await service.getTrip(actor, tripId);
    expect(result.connections.map((connection) => connection.state)).toEqual([
      'ACTIVE',
      'NOT_APPLICABLE',
      'RUNTIME_ORIGIN_REQUIRED',
      'MISSING',
    ]);
    expect(result.connections[0]?.transport).toMatchObject({
      mode: 'RAIL',
      fixedService: false,
    });
  });

  it('keeps fixedService independent from transport mode', async () => {
    let received: RepositoryTripCommand | undefined;
    vi.mocked(repository.executeCommand).mockImplementation(async (input) => {
      received = input.command;
      return { status: 'SUCCESS', trip: emptyTripForId() };
    });
    await service.executeCommand(actor, tripId, 1, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: randomUUID(),
      toNodeId: randomUUID(),
      mode: 'RAIL',
      fixedService: false,
    });
    expect(received).toMatchObject({ mode: 'RAIL', fixedService: false });
  });

  it('accepts only resolved instants with an explicit offset and IANA zone', async () => {
    const subject = { type: 'NODE' as const, nodeId: randomUUID() };
    vi.mocked(repository.setTemporalValue).mockResolvedValue({
      status: 'SUCCESS',
      trip: emptyTripForId(),
    });
    await service.setResolvedTemporalValue(actor, tripId, 1, subject, {
      layer: 'PLANNED',
      pointKind: 'ARRIVAL',
      instant: '2030-10-01T10:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      sourceKind: 'USER_VALUE',
    });
    expect(repository.setTemporalValue).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          instant: new Date('2030-10-01T02:00:00.000Z'),
          timeZone: 'Asia/Shanghai',
        }),
      }),
    );

    await expect(
      service.setResolvedTemporalValue(actor, tripId, 2, subject, {
        layer: 'ACTUAL',
        pointKind: 'ARRIVAL',
        instant: '2030-10-01T10:00:00',
        timeZone: 'Asia/Shanghai',
        sourceKind: 'USER_VALUE',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCENARIO' });
  });

  it.each([
    '2030-02-30T10:00:00Z',
    '2030-02-29T10:00:00Z',
    '2030-01-01T10:00:00+15:00',
    '2030-01-01T10:00:00.1234Z',
  ])(
    'rejects invalid or over-precise resolved instants: %s',
    async (instant) => {
      await expect(
        service.setResolvedTemporalValue(
          actor,
          tripId,
          1,
          { type: 'NODE', nodeId: randomUUID() },
          {
            layer: 'PLANNED',
            pointKind: 'ARRIVAL',
            instant,
            timeZone: 'Asia/Shanghai',
            sourceKind: 'USER_VALUE',
          },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(repository.setTemporalValue).not.toHaveBeenCalled();
    },
  );

  it('validates and persists a POINT_TIME intent separately from TemporalValue', async () => {
    let received: RepositoryTripCommand | undefined;
    vi.mocked(repository.executeCommand).mockImplementation(async (input) => {
      received = input.command;
      return { status: 'SUCCESS', trip: emptyTripForId() };
    });
    await service.executeCommand(actor, tripId, 1, {
      type: 'SET_TIME_INTENT',
      nodeId: randomUUID(),
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T20:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    expect(received).toMatchObject({
      type: 'SET_TIME_INTENT',
      operator: 'NOT_AFTER',
      instant: new Date('2030-10-01T12:00:00.000Z'),
      locked: true,
    });
    expect(repository.setTemporalValue).not.toHaveBeenCalled();
  });

  it('rejects an unresolved time intent before persistence', async () => {
    await expect(
      service.executeCommand(actor, tripId, 1, {
        type: 'SET_TIME_INTENT',
        nodeId: randomUUID(),
        pointKind: 'ARRIVAL',
        operator: 'EXACT',
        instant: '2030-10-01T20:00:00',
        timeZone: 'Asia/Shanghai',
        locked: false,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCENARIO' });
    expect(repository.executeCommand).not.toHaveBeenCalled();
  });

  it('validates a positive minimum dwell and lock metadata', async () => {
    vi.mocked(repository.executeCommand).mockResolvedValue({
      status: 'SUCCESS',
      trip: emptyTripForId(),
    });
    await service.executeCommand(actor, tripId, 1, {
      type: 'SET_MIN_DWELL',
      nodeId: randomUUID(),
      durationSeconds: 2_400,
      locked: false,
    });
    await expect(
      service.executeCommand(actor, tripId, 1, {
        type: 'SET_MIN_DWELL',
        nodeId: randomUUID(),
        durationSeconds: 0,
        locked: false,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('persists a system dwell suggestion without creating a MIN_DWELL intent', async () => {
    const occurrenceId = randomUUID();
    const node = placeVisit(occurrenceId, 0, 'SYNTHETIC suggestion');
    const now = new Date('2030-01-01T00:00:00Z');
    vi.mocked(repository.setSystemDwellSuggestion!).mockResolvedValue({
      status: 'SUCCESS',
      trip: {
        ...emptyTripForId(),
        version: 2,
        effectiveStartDate: utcDate('2030-10-01'),
        effectiveEndDate: utcDate('2030-10-01'),
        ownedDates: [utcDate('2030-10-01')],
        dayOccurrences: [
          dayOccurrence('2030-10-01', 0, occurrenceId, [
            {
              ...node,
              timeIntents: [],
              systemDwellSuggestion: {
                id: randomUUID(),
                tripId,
                nodeId: node.id,
                durationSeconds: 3_600,
                source: 'SYSTEM_SUGGESTION',
                createdAt: now,
                updatedAt: now,
              },
            },
          ]),
        ],
      },
    });

    const result = await service.setSystemDwellSuggestion(
      actor,
      tripId,
      1,
      node.id,
      3_600,
    );

    expect(result.days[0]?.nodes[0]).toMatchObject({
      timeIntents: [],
      systemDwellSuggestion: {
        durationSeconds: 3_600,
        source: 'SYSTEM_SUGGESTION',
      },
    });
  });

  it('evaluates a basis version read-only and keeps all time layers visible', async () => {
    const occurrenceId = randomUUID();
    const node = placeVisit(occurrenceId, 0, 'SYNTHETIC evaluation');
    const now = new Date('2030-01-01T00:00:00.000Z');
    const trip = {
      ...emptyTripForId(),
      version: 4,
      effectiveStartDate: utcDate('2030-10-01'),
      effectiveEndDate: utcDate('2030-10-01'),
      ownedDates: [utcDate('2030-10-01')],
      dayOccurrences: [
        dayOccurrence('2030-10-01', 0, occurrenceId, [
          {
            ...node,
            timeValues: [
              temporalValue('planned', 'PLANNED', '10:00'),
              temporalValue('estimated', 'ESTIMATED', '10:10'),
            ],
            timeIntents: [
              {
                id: randomUUID(),
                tripId,
                nodeId: node.id,
                kind: 'POINT_TIME' as const,
                pointKind: 'ARRIVAL' as const,
                operator: 'NOT_AFTER' as const,
                instant: new Date('2030-10-01T10:05:00.000Z'),
                timeZone: 'UTC',
                durationSeconds: null,
                locked: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ]),
      ],
    };
    vi.mocked(repository.findOwnedById).mockResolvedValue(trip);

    const projection = await service.evaluateSchedule(actor, tripId, 4);
    expect(projection).toMatchObject({
      tripId,
      basisVersion: 4,
      nodes: [
        {
          status: 'VIOLATED',
          arrival: {
            planned: { id: 'planned' },
            estimated: { id: 'estimated' },
            effective: { value: { id: 'estimated', layer: 'ESTIMATED' } },
          },
        },
      ],
    });
    expect(repository.executeCommand).not.toHaveBeenCalled();
    expect(repository.setTemporalValue).not.toHaveBeenCalled();
  });

  it('rejects schedule evaluation against a stale basis version', async () => {
    vi.mocked(repository.findOwnedById).mockResolvedValue({
      ...emptyTripForId(),
      version: 2,
    });
    await expect(
      service.evaluateSchedule(actor, tripId, 1),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });

  it('uses the same strict parser for observedAt', async () => {
    await expect(
      service.setResolvedTemporalValue(
        actor,
        tripId,
        1,
        { type: 'NODE', nodeId: randomUUID() },
        {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: '2032-02-29T10:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'PROVIDER_OBSERVATION',
          observedAt: '2030-02-30T10:00:00Z',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.setTemporalValue).not.toHaveBeenCalled();
  });

  it.each(['Asia/Tokyo', 'Asia/Shanghai', 'UTC'])(
    'accepts an explicitly supported IANA zone: %s',
    async (timeZone) => {
      vi.mocked(repository.setTemporalValue).mockResolvedValue({
        status: 'SUCCESS',
        trip: emptyTripForId(),
      });
      await service.setResolvedTemporalValue(
        actor,
        tripId,
        1,
        { type: 'NODE', nodeId: randomUUID() },
        {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2032-02-29T10:00:00Z',
          timeZone,
          sourceKind: 'USER_VALUE',
        },
      );
    },
  );

  it.each(['+08:00', 'Not/A_Zone'])(
    'rejects a non-IANA timeZone field: %s',
    async (timeZone) => {
      await expect(
        service.setResolvedTemporalValue(
          actor,
          tripId,
          1,
          { type: 'NODE', nodeId: randomUUID() },
          {
            layer: 'PLANNED',
            pointKind: 'ARRIVAL',
            instant: '2032-02-29T10:00:00Z',
            timeZone,
            sourceKind: 'USER_VALUE',
          },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(repository.setTemporalValue).not.toHaveBeenCalled();
    },
  );

  it.each(['DERIVED', 'SYSTEM_SUGGESTION'] as const)(
    'rejects %s as an ACTUAL source before persistence',
    async (sourceKind) => {
      await expect(
        service.setResolvedTemporalValue(
          actor,
          tripId,
          1,
          { type: 'NODE', nodeId: randomUUID() },
          {
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: '2032-02-29T10:00:00Z',
            timeZone: 'UTC',
            sourceKind,
          },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(repository.setTemporalValue).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid custom Place coordinates before persistence', async () => {
    await expect(
      service.executeCommand(actor, tripId, 1, {
        type: 'ADD_PLACE_VISIT',
        targetDay: {
          type: 'NEW',
          localDate: '2030-10-01',
          sequence: 0,
        },
        position: 0,
        place: {
          type: 'CUSTOM',
          name: 'SYNTHETIC invalid',
          latitude: 91,
          longitude: 121,
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.executeCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['VERSION_CONFLICT', 'VERSION_CONFLICT'],
    ['DATE_OWNED', 'DATE_OWNED'],
    ['FACT_PROTECTED', 'FACT_PROTECTED'],
    ['NOT_FOUND', 'NOT_FOUND'],
  ] as const)(
    'maps repository %s without leaking database errors',
    async (status, code) => {
      vi.mocked(repository.executeCommand).mockResolvedValue({ status });
      await expect(
        service.executeCommand(actor, tripId, 1, {
          type: 'ADD_FREE_ACTION',
          targetDay: {
            type: 'NEW',
            localDate: '2030-10-01',
            sequence: 0,
          },
          position: 0,
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it('rejects a non-active actor before repository access', async () => {
    await expect(
      service.listTrips({ ...actor, status: 'DISABLED' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.listOwned).not.toHaveBeenCalled();
  });
});

function emptyTrip(input: {
  readonly ownerUserId: string;
  readonly name: string;
  readonly planningAnchorDate: Date;
  readonly defaultPeopleCount: number;
}): TripAggregateRecord {
  const timestamp = new Date('2030-01-01T00:00:00.000Z');
  return {
    id: tripId,
    ...input,
    version: 1,
    effectiveStartDate: null,
    effectiveEndDate: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ownedDates: [],
    dayOccurrences: [],
    transportEdges: [],
  };
}

function emptyTripForId(): TripAggregateRecord {
  return emptyTrip({
    ownerUserId,
    name: 'SYNTHETIC',
    planningAnchorDate: utcDate('2030-10-01'),
    defaultPeopleCount: 1,
  });
}

function dayOccurrence(
  localDate: string,
  sequence: number,
  id: string,
  nodes: TripAggregateRecord['dayOccurrences'][number]['nodes'],
) {
  const timestamp = new Date('2030-01-01T00:00:00.000Z');
  return {
    id,
    tripId,
    localDate: utcDate(localDate),
    sequence,
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes,
  };
}

function freeAction(dayOccurrenceId: string, position: number) {
  const timestamp = new Date('2030-01-01T00:00:00.000Z');
  return {
    id: randomUUID(),
    tripId,
    dayOccurrenceId,
    kind: 'FREE_ACTION' as const,
    position,
    place: null,
    note: null,
    source: 'USER_PLANNED' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    timeValues: [],
    timeIntents: [],
  };
}

function placeVisit(dayOccurrenceId: string, position: number, name: string) {
  const timestamp = new Date('2030-01-01T00:00:00.000Z');
  return {
    id: randomUUID(),
    tripId,
    dayOccurrenceId,
    kind: 'PLACE_VISIT' as const,
    position,
    place: {
      id: randomUUID(),
      ownerUserId,
      name,
      latitude: 31.2304,
      longitude: 121.4737,
      address: null,
      createdAt: timestamp,
    },
    note: null,
    source: 'USER_PLANNED' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    timeValues: [],
    timeIntents: [],
  };
}

function manualTransport(fromNodeId: string, toNodeId: string) {
  const timestamp = new Date('2030-01-01T00:00:00.000Z');
  return {
    id: randomUUID(),
    tripId,
    fromNodeId,
    toNodeId,
    mode: 'RAIL' as const,
    fixedService: false,
    serviceLabel: null,
    note: null,
    source: 'MANUAL' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    timeValues: [],
  };
}

function temporalValue(
  id: string,
  layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL',
  time: string,
) {
  const now = new Date('2030-01-01T00:00:00.000Z');
  return {
    id,
    layer,
    pointKind: 'ARRIVAL' as const,
    instant: new Date(`2030-10-01T${time}:00.000Z`),
    timeZone: 'UTC',
    sourceKind: 'USER_VALUE' as const,
    sourceRef: null,
    observedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
