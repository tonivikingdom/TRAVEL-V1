import { ExecutionRiskService, type Actor } from '@travel/application';
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
    const delayed = snapshot({ status: 'DELAYED' });
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
    const first = snapshot();
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
    });
    const second = snapshot();
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
    const changed = snapshot();
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
