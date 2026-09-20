import {
  ExecutionRiskService,
  FlightService,
  type Actor,
  type FlightSnapshotProvider,
} from '@travel/application';
import type { FlightSnapshotView } from '@travel/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  PrismaExecutionRiskRepository,
  PrismaFlightRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P5D2 integration tests');
}

describe('P5D2 flight facts with PostgreSQL', () => {
  let managed: ManagedPrismaClient;
  let fixture: Fixture;
  let actor: Actor;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await managed.client.user.deleteMany({
      where: { normalizedEmail: { startsWith: 'synthetic-p5d2-' } },
    });
    fixture = await createFixture(managed);
    actor = {
      userId: fixture.ownerUserId,
      email: 'synthetic-p5d2-owner@synthetic.example.test',
      role: 'USER',
      status: 'ACTIVE',
    };
  });

  afterAll(async () => {
    await managed.client.user.deleteMany({
      where: { normalizedEmail: { startsWith: 'synthetic-p5d2-' } },
    });
    await managed.close();
  });

  it('adopts PLANNED facts idempotently and increments Trip version only once', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const first = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    expect(first).toMatchObject({
      status: 'SUCCESS',
      resultingTripVersion: 2,
      idempotentReplay: false,
    });
    const replay = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    expect(replay).toMatchObject({
      status: 'SUCCESS',
      resultingTripVersion: 2,
      idempotentReplay: true,
    });
    expect(
      await managed.client.temporalValue.count({
        where: { transportEdgeId: fixture.flightEdgeId, layer: 'PLANNED' },
      }),
    ).toBe(2);
  });

  it('persists revised ESTIMATED evidence and creates a risk from the Flight edge', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    expect(adopted.status).toBe('SUCCESS');
    const delayed = snapshot({
      status: 'DELAYED',
      fetchedAt: '2030-01-01T09:31:00.000Z',
    });
    delayed.arrival = {
      ...delayed.arrival,
      revisedUtc: '2030-01-01T10:45:00.000Z',
      revisedLocal: '2030-01-01T10:45:00Z',
    };
    const refreshed = await repository.refresh({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      flightBindingId:
        adopted.status === 'SUCCESS' ? adopted.binding.id : randomUUID(),
      flight: delayed,
    });
    expect(refreshed).toMatchObject({
      status: 'SUCCESS',
      factsChanged: true,
      resultingTripVersion: 3,
      observationDisposition: 'APPLIED',
    });
    const risks = await new ExecutionRiskService(
      new PrismaTripRepository(managed.client),
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => new Date('2030-01-01T10:46:00Z') },
    ).evaluateTripRisks(actor, fixture.tripId);
    expect(risks.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTransportEdgeId: fixture.flightEdgeId,
        }),
      ]),
    );
  });

  it('creates runway ACTUAL once and reports a later differing runway as conflict', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    const first = snapshot({ fetchedAt: '2030-01-01T09:31:00.000Z' });
    first.arrival = {
      ...first.arrival,
      runwayUtc: '2030-01-01T10:42:00.000Z',
      runwayLocal: '2030-01-01T10:42:00Z',
    };
    const created = await repository.refresh({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      flightBindingId: adopted.binding.id,
      flight: first,
    });
    expect(created).toMatchObject({
      status: 'SUCCESS',
      factsChanged: true,
      actualConflicts: [],
      observationDisposition: 'APPLIED',
    });
    const second = snapshot({ fetchedAt: '2030-01-01T09:32:00.000Z' });
    second.arrival = {
      ...second.arrival,
      runwayUtc: '2030-01-01T10:50:00.000Z',
      runwayLocal: '2030-01-01T10:50:00Z',
    };
    const conflicted = await repository.refresh({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      flightBindingId: adopted.binding.id,
      flight: second,
    });
    expect(conflicted).toMatchObject({
      status: 'SUCCESS',
      factsChanged: false,
      observationDisposition: 'APPLIED',
      actualConflicts: [
        {
          pointKind: 'ARRIVAL',
          existingInstant: '2030-01-01T10:42:00.000Z',
          providerObservedInstant: '2030-01-01T10:50:00.000Z',
        },
      ],
    });
  });

  it('does not overwrite adopted PLANNED facts when provider schedule changes', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    const changed = snapshot({ fetchedAt: '2030-01-01T09:31:00.000Z' });
    changed.arrival = {
      ...changed.arrival,
      scheduledUtc: '2030-01-01T11:00:00.000Z',
      scheduledLocal: '2030-01-01T11:00:00Z',
    };
    await repository.refresh({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      flightBindingId: adopted.binding.id,
      flight: changed,
    });
    const planned = await managed.client.temporalValue.findUniqueOrThrow({
      where: {
        transportEdgeId_pointKind_layer: {
          transportEdgeId: fixture.flightEdgeId,
          pointKind: 'ARRIVAL',
          layer: 'PLANNED',
        },
      },
    });
    expect(planned.instant.toISOString()).toBe('2030-01-01T10:30:00.000Z');
  });

  it('ignores stale metadata, ESTIMATED and runway observations without changing facts', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    const newer = observedSnapshot({
      candidateId: 'aerodatabox:newer-id',
      fetchedAt: '2030-01-01T13:01:00.000Z',
      revisedArrival: '2030-01-01T10:40:00.000Z',
      status: 'DELAYED',
      gate: 'G2',
    });
    expect(
      await repository.refresh({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        flightBindingId: adopted.binding.id,
        flight: newer,
      }),
    ).toMatchObject({
      status: 'SUCCESS',
      resultingTripVersion: 3,
      factsChanged: true,
      observationDisposition: 'APPLIED',
    });

    const stale = observedSnapshot({
      candidateId: 'aerodatabox:stale-id',
      fetchedAt: '2030-01-01T13:00:00.000Z',
      revisedArrival: '2030-01-01T10:20:00.000Z',
      runwayArrival: '2030-01-01T10:25:00.000Z',
      status: 'CANCELLED',
      gate: 'G1',
    });
    const ignored = await repository.refresh({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      flightBindingId: adopted.binding.id,
      flight: stale,
    });

    expect(ignored).toMatchObject({
      status: 'SUCCESS',
      resultingTripVersion: 3,
      factsChanged: false,
      actualConflicts: [],
      observationDisposition: 'STALE_IGNORED',
      binding: {
        providerFlightRef: 'aerodatabox:newer-id',
        status: 'DELAYED',
        lastRefreshedAt: '2030-01-01T13:01:00.000Z',
        latestSnapshot: {
          fetchedAt: '2030-01-01T13:01:00.000Z',
          arrival: { revisedUtc: '2030-01-01T10:40:00.000Z', gate: 'G2' },
        },
      },
    });
    expect(
      await managed.client.temporalValue.findUniqueOrThrow({
        where: {
          transportEdgeId_pointKind_layer: {
            transportEdgeId: fixture.flightEdgeId,
            pointKind: 'ARRIVAL',
            layer: 'ESTIMATED',
          },
        },
      }),
    ).toMatchObject({ instant: new Date('2030-01-01T10:40:00.000Z') });
    expect(
      await managed.client.temporalValue.count({
        where: { transportEdgeId: fixture.flightEdgeId, layer: 'ACTUAL' },
      }),
    ).toBe(0);
    expect(
      await managed.client.transportEdge.findUniqueOrThrow({
        where: { id: fixture.flightEdgeId },
        select: { providerRef: true },
      }),
    ).toEqual({ providerRef: 'aerodatabox:newer-id' });
    expect(
      await managed.client.trip.findUniqueOrThrow({
        where: { id: fixture.tripId },
        select: { version: true },
      }),
    ).toEqual({ version: 3 });
  });

  it('handles equal fetchedAt deterministically as idempotent or stale', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const accepted = observedSnapshot({
      fetchedAt: '2030-01-01T13:01:00.000Z',
      revisedArrival: '2030-01-01T10:40:00.000Z',
      gate: 'G2',
    });
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await repository.refresh({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      flightBindingId: adopted.binding.id,
      flight: accepted,
    });

    expect(
      await repository.refresh({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        flightBindingId: adopted.binding.id,
        flight: accepted,
      }),
    ).toMatchObject({
      status: 'SUCCESS',
      resultingTripVersion: 3,
      factsChanged: false,
      observationDisposition: 'IDEMPOTENT',
    });
    const ambiguous = {
      ...accepted,
      arrival: { ...accepted.arrival, gate: 'G3' },
    };
    expect(
      await repository.refresh({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        flightBindingId: adopted.binding.id,
        flight: ambiguous,
      }),
    ).toMatchObject({
      status: 'SUCCESS',
      resultingTripVersion: 3,
      factsChanged: false,
      observationDisposition: 'STALE_IGNORED',
      binding: { latestSnapshot: { arrival: { gate: 'G2' } } },
    });
  });

  it('accepts a newer metadata-only snapshot without bumping Trip version', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    const metadataOnly = snapshot({
      fetchedAt: '2030-01-01T13:02:00.000Z',
      status: 'BOARDING',
    });
    metadataOnly.departure = { ...metadataOnly.departure, gate: 'G4' };

    expect(
      await repository.refresh({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        flightBindingId: adopted.binding.id,
        flight: metadataOnly,
      }),
    ).toMatchObject({
      status: 'SUCCESS',
      resultingTripVersion: 2,
      factsChanged: false,
      observationDisposition: 'APPLIED',
      binding: {
        status: 'BOARDING',
        lastRefreshedAt: '2030-01-01T13:02:00.000Z',
        latestSnapshot: { departure: { gate: 'G4' } },
      },
    });
  });

  it('keeps the newer observation and risk evidence when concurrent refreshes complete out of order', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    const oldObservation = observedSnapshot({
      fetchedAt: '2030-01-01T13:00:00.000Z',
      revisedArrival: '2030-01-01T10:20:00.000Z',
    });
    const newObservation = observedSnapshot({
      fetchedAt: '2030-01-01T13:01:00.000Z',
      revisedArrival: '2030-01-01T10:40:00.000Z',
    });
    const oldStarted = deferred<void>();
    const oldResponse = deferred<readonly FlightSnapshotView[]>();
    let refreshCalls = 0;
    const provider: FlightSnapshotProvider = {
      search: async () => [],
      refresh: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          oldStarted.resolve();
          return oldResponse.promise;
        }
        return [newObservation];
      },
    };
    const riskService = new ExecutionRiskService(
      new PrismaTripRepository(managed.client),
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => new Date('2030-01-01T13:02:00Z') },
    );
    const service = new FlightService(provider, repository, riskService);

    const oldRequest = service.refresh(
      actor,
      fixture.tripId,
      adopted.binding.id,
    );
    await oldStarted.promise;
    const newResult = await service.refresh(
      actor,
      fixture.tripId,
      adopted.binding.id,
    );
    oldResponse.resolve([oldObservation]);
    const oldResult = await oldRequest;

    expect(newResult.observationDisposition).toBe('APPLIED');
    expect(oldResult).toMatchObject({
      observationDisposition: 'STALE_IGNORED',
      resultingTripVersion: 3,
      changes: { changeTypes: [] },
      riskEvaluation: { evaluationBasisTripVersion: 3 },
    });
    const finalBinding = await managed.client.flightBinding.findUniqueOrThrow({
      where: { id: adopted.binding.id },
    });
    expect(finalBinding.lastRefreshedAt.toISOString()).toBe(
      '2030-01-01T13:01:00.000Z',
    );
    expect(finalBinding.latestSnapshot).toMatchObject({
      fetchedAt: '2030-01-01T13:01:00.000Z',
      arrival: { revisedUtc: '2030-01-01T10:40:00.000Z' },
    });
    expect(
      await managed.client.temporalValue.findUniqueOrThrow({
        where: {
          transportEdgeId_pointKind_layer: {
            transportEdgeId: fixture.flightEdgeId,
            pointKind: 'ARRIVAL',
            layer: 'ESTIMATED',
          },
        },
      }),
    ).toMatchObject({ instant: new Date('2030-01-01T10:40:00.000Z') });
    expect(
      await managed.client.trip.findUniqueOrThrow({
        where: { id: fixture.tripId },
        select: { version: true },
      }),
    ).toEqual({ version: 3 });
    expect(oldResult.riskEvaluation.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTransportEdgeId: fixture.flightEdgeId,
        }),
      ]),
    );
    expect(
      await managed.client.notificationEvent.count({
        where: { ownerUserId: fixture.ownerUserId },
      }),
    ).toBe(1);
  });

  it('rejects an old in-flight refresh after the edge is rebound to another flight', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const original = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (original.status !== 'SUCCESS') throw new Error('adopt failed');
    const replacement = snapshot({
      candidateId: 'aerodatabox:nh99',
      canonicalFlightNumber: 'NH99',
      displayFlightNumber: 'NH 99',
      fetchedAt: '2030-01-01T12:00:00.000Z',
    });
    replacement.departure = movement('HND', '2030-01-01T12:00:00.000Z');
    replacement.arrival = movement('CTS', '2030-01-01T13:30:00.000Z');
    expect(
      await repository.adopt({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        baseTripVersion: 2,
        transportEdgeId: fixture.flightEdgeId,
        flight: replacement,
      }),
    ).toMatchObject({ status: 'SUCCESS', resultingTripVersion: 3 });

    expect(
      await repository.refresh({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        flightBindingId: original.binding.id,
        flight: observedSnapshot({
          fetchedAt: '2030-01-01T13:01:00.000Z',
          revisedArrival: '2030-01-01T10:40:00.000Z',
        }),
      }),
    ).toEqual({ status: 'FLIGHT_MISMATCH' });
    expect(
      await managed.client.flightBinding.findUniqueOrThrow({
        where: { id: original.binding.id },
        select: {
          providerFlightRef: true,
          canonicalFlightNumber: true,
          lastRefreshedAt: true,
        },
      }),
    ).toEqual({
      providerFlightRef: 'aerodatabox:nh99',
      canonicalFlightNumber: 'NH99',
      lastRefreshedAt: new Date('2030-01-01T12:00:00.000Z'),
    });
  });

  it('hides a binding from another owner and rejects concurrent stale replacement', async () => {
    const repository = new PrismaFlightRepository(managed.client);
    const adopted = await repository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot(),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    expect(
      await repository.findOwnedBinding({
        ownerUserId: fixture.otherUserId,
        tripId: fixture.tripId,
        flightBindingId: adopted.binding.id,
      }),
    ).toBeNull();
    const replacements = await Promise.all([
      repository.adopt({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        baseTripVersion: 2,
        transportEdgeId: fixture.flightEdgeId,
        flight: snapshot({ candidateId: 'aerodatabox:replacement-a' }),
      }),
      repository.adopt({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        baseTripVersion: 2,
        transportEdgeId: fixture.flightEdgeId,
        flight: snapshot({ candidateId: 'aerodatabox:replacement-b' }),
      }),
    ]);
    expect(
      replacements.filter((result) => result.status === 'SUCCESS'),
    ).toHaveLength(1);
    expect(
      replacements.filter((result) => result.status === 'VERSION_CONFLICT'),
    ).toHaveLength(1);
  });
});

interface Fixture {
  readonly ownerUserId: string;
  readonly otherUserId: string;
  readonly tripId: string;
  readonly flightEdgeId: string;
}

async function createFixture(managed: ManagedPrismaClient): Promise<Fixture> {
  const ownerUserId = randomUUID();
  const otherUserId = randomUUID();
  const tripId = randomUUID();
  const occurrenceId = randomUUID();
  const originNodeId = randomUUID();
  const connectionNodeId = randomUUID();
  const destinationNodeId = randomUUID();
  const flightEdgeId = randomUUID();
  await managed.client.$transaction(async (transaction) => {
    await transaction.user.createMany({
      data: [
        {
          id: ownerUserId,
          email: 'synthetic-p5d2-owner@synthetic.example.test',
          normalizedEmail: 'synthetic-p5d2-owner@synthetic.example.test',
        },
        {
          id: otherUserId,
          email: 'synthetic-p5d2-other@synthetic.example.test',
          normalizedEmail: 'synthetic-p5d2-other@synthetic.example.test',
        },
      ],
    });
    await transaction.trip.create({
      data: {
        id: tripId,
        ownerUserId,
        name: 'SYNTHETIC P5D2',
        planningAnchorDate: new Date('2030-01-01T00:00:00Z'),
        defaultPeopleCount: 1,
      },
    });
    await transaction.dayOccurrence.create({
      data: {
        id: occurrenceId,
        tripId,
        localDate: new Date('2030-01-01T00:00:00Z'),
        sequence: 0,
      },
    });
    const places = [randomUUID(), randomUUID(), randomUUID()];
    await transaction.place.createMany({
      data: places.map((id, index) => ({
        id,
        ownerUserId,
        name: `SYNTHETIC P5D2 ${index}`,
        latitude: 35 + index,
        longitude: 139 + index,
      })),
    });
    await transaction.itineraryNode.createMany({
      data: [originNodeId, connectionNodeId, destinationNodeId].map(
        (id, position) => ({
          id,
          tripId,
          dayOccurrenceId: occurrenceId,
          kind: 'PLACE_VISIT' as const,
          position,
          placeId: places[position]!,
        }),
      ),
    });
    await transaction.userTimeIntent.create({
      data: {
        tripId,
        nodeId: connectionNodeId,
        kind: 'MIN_DWELL',
        operator: 'MINIMUM',
        durationSeconds: 1_800,
      },
    });
    await transaction.transportEdge.createMany({
      data: [
        {
          id: flightEdgeId,
          tripId,
          fromNodeId: originNodeId,
          toNodeId: connectionNodeId,
          mode: 'FLIGHT',
          fixedService: false,
          source: 'MANUAL',
        },
        {
          id: randomUUID(),
          tripId,
          fromNodeId: connectionNodeId,
          toNodeId: destinationNodeId,
          mode: 'RAIL',
          fixedService: true,
          source: 'MANUAL',
        },
      ],
    });
    const fixed = await transaction.transportEdge.findFirstOrThrow({
      where: { tripId, fromNodeId: connectionNodeId },
    });
    await transaction.temporalValue.create({
      data: {
        transportEdgeId: fixed.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-01-01T11:00:00Z'),
        timeZone: 'UTC',
        sourceKind: 'ADOPTED_TRANSPORT_FACT',
      },
    });
  });
  return { ownerUserId, otherUserId, tripId, flightEdgeId };
}

function snapshot(
  overrides: Partial<FlightSnapshotView> = {},
): FlightSnapshotView & {
  departure: FlightSnapshotView['departure'];
  arrival: FlightSnapshotView['arrival'];
} {
  return {
    provider: 'aerodatabox',
    candidateId: 'aerodatabox:nh53',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2030-01-01',
    status: 'SCHEDULED',
    rawStatus: 'Scheduled',
    airline: { name: 'ANA', iata: 'NH', icao: 'ANA' },
    departure: movement('HND', '2030-01-01T09:00:00.000Z'),
    arrival: movement('CTS', '2030-01-01T10:30:00.000Z'),
    aircraft: null,
    departureDelayMinutes: null,
    arrivalDelayMinutes: null,
    departureDelayBasis: null,
    arrivalDelayBasis: null,
    fetchedAt: '2030-01-01T09:30:00.000Z',
    ...overrides,
  };
}

function observedSnapshot(input: {
  readonly candidateId?: string;
  readonly fetchedAt: string;
  readonly revisedArrival: string;
  readonly runwayArrival?: string;
  readonly status?: FlightSnapshotView['status'];
  readonly gate?: string;
}): ReturnType<typeof snapshot> {
  const result = snapshot({
    candidateId: input.candidateId ?? 'aerodatabox:nh53',
    fetchedAt: input.fetchedAt,
    status: input.status ?? 'DELAYED',
  });
  result.arrival = {
    ...result.arrival,
    revisedUtc: input.revisedArrival,
    revisedLocal: input.revisedArrival,
    runwayUtc: input.runwayArrival ?? null,
    runwayLocal: input.runwayArrival ?? null,
    gate: input.gate ?? null,
  };
  return result;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function movement(iata: string, scheduledUtc: string) {
  return {
    airportName: iata,
    airportIata: iata,
    airportIcao: null,
    timeZone: 'UTC',
    scheduledLocal: scheduledUtc,
    scheduledUtc,
    revisedLocal: null,
    revisedUtc: null,
    predictedLocal: null,
    predictedUtc: null,
    runwayLocal: null,
    runwayUtc: null,
    terminal: null,
    gate: null,
    checkInDesk: null,
    baggageBelt: null,
  };
}
