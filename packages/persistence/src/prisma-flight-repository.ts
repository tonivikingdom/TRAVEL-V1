import type {
  FlightAdoptRepositoryResult,
  FlightRefreshRepositoryResult,
  FlightRepository,
} from '@travel/application';
import type {
  FlightActualConflictView,
  FlightBindingView,
  FlightMovementView,
  FlightSnapshotView,
  TemporalPointKind,
} from '@travel/contracts';

import {
  Prisma,
  type FlightBinding,
  type PrismaClient,
} from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;

export class PrismaFlightRepository implements FlightRepository {
  constructor(private readonly client: PrismaClient) {}

  async adopt(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly transportEdgeId: string;
    readonly flight: FlightSnapshotView;
  }): Promise<FlightAdoptRepositoryResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await lockOwnedTrip(transaction, input);
      if (trip === null) return { status: 'NOT_FOUND' };
      const edge = await transaction.transportEdge.findFirst({
        where: { id: input.transportEdgeId, tripId: input.tripId },
        include: { temporalValues: true, flightBinding: true },
      });
      if (edge === null || edge.mode !== 'FLIGHT') {
        return { status: 'INVALID_TRANSPORT' };
      }
      const sourceRef = plannedSourceRef(input.flight);
      const departure = requiredDate(input.flight.departure.scheduledUtc!);
      const arrival = requiredDate(input.flight.arrival.scheduledUtc!);
      const idempotent =
        edge.flightBinding !== null &&
        sameFlightIdentity(edge.flightBinding, input.flight) &&
        edge.fixedService &&
        edge.serviceLabel === input.flight.displayFlightNumber &&
        edge.provider === 'aerodatabox' &&
        edge.providerRef === input.flight.candidateId &&
        matchingTemporal(
          edge.temporalValues,
          'DEPARTURE',
          'PLANNED',
          departure,
          input.flight.departure.timeZone!,
          sourceRef,
        ) &&
        matchingTemporal(
          edge.temporalValues,
          'ARRIVAL',
          'PLANNED',
          arrival,
          input.flight.arrival.timeZone!,
          sourceRef,
        );
      if (idempotent) {
        return {
          status: 'SUCCESS',
          binding: toView(edge.flightBinding!),
          resultingTripVersion: trip.version,
          idempotentReplay: true,
        };
      }
      if (
        edge.temporalValues.some((value) => value.layer === 'ACTUAL') &&
        (edge.flightBinding === null ||
          !sameFlightIdentity(edge.flightBinding, input.flight))
      ) {
        return { status: 'FACT_PROTECTED' };
      }
      if (trip.version !== input.baseTripVersion) {
        return { status: 'VERSION_CONFLICT' };
      }
      await transaction.transportEdge.update({
        where: { id: edge.id },
        data: {
          fixedService: true,
          serviceLabel: input.flight.displayFlightNumber,
          provider: 'aerodatabox',
          providerRef: input.flight.candidateId,
        },
      });
      if (edge.flightBinding !== null) {
        await transaction.temporalValue.deleteMany({
          where: {
            transportEdgeId: edge.id,
            layer: 'ESTIMATED',
            sourceKind: 'PROVIDER_OBSERVATION',
          },
        });
      }
      await writeTemporal(transaction, {
        transportEdgeId: edge.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: departure,
        timeZone: input.flight.departure.timeZone!,
        sourceRef,
        observedAt: null,
      });
      await writeTemporal(transaction, {
        transportEdgeId: edge.id,
        layer: 'PLANNED',
        pointKind: 'ARRIVAL',
        instant: arrival,
        timeZone: input.flight.arrival.timeZone!,
        sourceRef,
        observedAt: null,
      });
      const binding = await transaction.flightBinding.upsert({
        where: { transportEdgeId: edge.id },
        create: bindingData(input, edge.id),
        update: bindingData(input, edge.id),
      });
      const updatedTrip = await transaction.trip.update({
        where: { id: input.tripId },
        data: { version: { increment: 1 } },
        select: { version: true },
      });
      return {
        status: 'SUCCESS',
        binding: toView(binding),
        resultingTripVersion: updatedTrip.version,
        idempotentReplay: false,
      };
    });
  }

  async findOwnedBinding(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
  }): Promise<FlightBindingView | null> {
    const binding = await this.client.flightBinding.findFirst({
      where: {
        id: input.flightBindingId,
        tripId: input.tripId,
        ownerUserId: input.ownerUserId,
      },
    });
    return binding === null ? null : toView(binding);
  }

  async refresh(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
    readonly flight: FlightSnapshotView;
  }): Promise<FlightRefreshRepositoryResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await lockOwnedTrip(transaction, input);
      if (trip === null) return { status: 'NOT_FOUND' };
      const binding = await transaction.flightBinding.findFirst({
        where: {
          id: input.flightBindingId,
          tripId: input.tripId,
          ownerUserId: input.ownerUserId,
        },
        include: {
          transportEdge: { include: { temporalValues: true } },
        },
      });
      if (binding === null) return { status: 'NOT_FOUND' };
      if (
        binding.transportEdge.mode !== 'FLIGHT' ||
        binding.transportEdge.provider !== 'aerodatabox' ||
        binding.transportEdge.providerRef !== binding.providerFlightRef ||
        (binding.providerFlightRef !== input.flight.candidateId &&
          !sameStableFlightIdentity(
            binding.selectedSnapshot as unknown as FlightSnapshotView,
            input.flight,
          ))
      ) {
        return { status: 'FLIGHT_MISMATCH' };
      }
      let factsChanged = false;
      const actualConflicts: FlightActualConflictView[] = [];
      const sourceRef = `flight-binding:${binding.id}:aerodatabox`;
      for (const [pointKind, movement] of [
        ['DEPARTURE', input.flight.departure],
        ['ARRIVAL', input.flight.arrival],
      ] as const) {
        factsChanged =
          (await applyEstimated(
            transaction,
            binding.transportEdgeId,
            pointKind,
            movement,
            input.flight.fetchedAt,
            sourceRef,
          )) || factsChanged;
        const actual = await applyActual(
          transaction,
          binding.transportEdgeId,
          pointKind,
          movement,
          input.flight.fetchedAt,
          sourceRef,
        );
        factsChanged = actual.changed || factsChanged;
        if (actual.conflict !== null) actualConflicts.push(actual.conflict);
      }
      const updatedBinding = await transaction.flightBinding.update({
        where: { id: binding.id },
        data: {
          latestSnapshot: json(input.flight),
          providerFlightRef: input.flight.candidateId,
          status: input.flight.status,
          lastRefreshedAt: requiredDate(input.flight.fetchedAt),
          displayFlightNumber: input.flight.displayFlightNumber,
        },
      });
      if (binding.providerFlightRef !== input.flight.candidateId) {
        await transaction.transportEdge.update({
          where: { id: binding.transportEdgeId },
          data: { providerRef: input.flight.candidateId },
        });
      }
      const resultingTripVersion = factsChanged
        ? (
            await transaction.trip.update({
              where: { id: input.tripId },
              data: { version: { increment: 1 } },
              select: { version: true },
            })
          ).version
        : trip.version;
      return {
        status: 'SUCCESS',
        binding: toView(updatedBinding),
        resultingTripVersion,
        factsChanged,
        actualConflicts,
      };
    });
  }
}

async function applyEstimated(
  transaction: Transaction,
  transportEdgeId: string,
  pointKind: TemporalPointKind,
  movement: FlightMovementView,
  fetchedAt: string,
  sourceRef: string,
): Promise<boolean> {
  if (movement.revisedUtc === null || movement.timeZone === null) return false;
  return writeTemporalIfChanged(transaction, {
    transportEdgeId,
    layer: 'ESTIMATED',
    pointKind,
    instant: requiredDate(movement.revisedUtc),
    timeZone: movement.timeZone,
    sourceRef,
    observedAt: requiredDate(fetchedAt),
  });
}

async function applyActual(
  transaction: Transaction,
  transportEdgeId: string,
  pointKind: TemporalPointKind,
  movement: FlightMovementView,
  fetchedAt: string,
  sourceRef: string,
): Promise<{
  readonly changed: boolean;
  readonly conflict: FlightActualConflictView | null;
}> {
  if (movement.runwayUtc === null || movement.timeZone === null) {
    return { changed: false, conflict: null };
  }
  const providerInstant = requiredDate(movement.runwayUtc);
  const existing = await transaction.temporalValue.findUnique({
    where: {
      transportEdgeId_pointKind_layer: {
        transportEdgeId,
        pointKind,
        layer: 'ACTUAL',
      },
    },
  });
  if (existing !== null) {
    if (existing.instant.getTime() === providerInstant.getTime()) {
      return { changed: false, conflict: null };
    }
    return {
      changed: false,
      conflict: {
        pointKind,
        existingInstant: existing.instant.toISOString(),
        providerObservedInstant: providerInstant.toISOString(),
        observedAt: requiredDate(fetchedAt).toISOString(),
      },
    };
  }
  await writeTemporal(transaction, {
    transportEdgeId,
    layer: 'ACTUAL',
    pointKind,
    instant: providerInstant,
    timeZone: movement.timeZone,
    sourceRef,
    observedAt: requiredDate(fetchedAt),
  });
  return { changed: true, conflict: null };
}

async function writeTemporalIfChanged(
  transaction: Transaction,
  input: TemporalWrite,
): Promise<boolean> {
  const existing = await transaction.temporalValue.findUnique({
    where: {
      transportEdgeId_pointKind_layer: {
        transportEdgeId: input.transportEdgeId,
        pointKind: input.pointKind,
        layer: input.layer,
      },
    },
  });
  if (
    existing !== null &&
    existing.instant.getTime() === input.instant.getTime() &&
    existing.timeZone === input.timeZone &&
    existing.sourceRef === input.sourceRef
  ) {
    return false;
  }
  await writeTemporal(transaction, input);
  return true;
}

interface TemporalWrite {
  readonly transportEdgeId: string;
  readonly layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL';
  readonly pointKind: TemporalPointKind;
  readonly instant: Date;
  readonly timeZone: string;
  readonly sourceRef: string;
  readonly observedAt: Date | null;
}

async function writeTemporal(transaction: Transaction, input: TemporalWrite) {
  await transaction.temporalValue.upsert({
    where: {
      transportEdgeId_pointKind_layer: {
        transportEdgeId: input.transportEdgeId,
        pointKind: input.pointKind,
        layer: input.layer,
      },
    },
    create: {
      transportEdgeId: input.transportEdgeId,
      layer: input.layer,
      pointKind: input.pointKind,
      instant: input.instant,
      timeZone: input.timeZone,
      sourceKind:
        input.layer === 'PLANNED'
          ? 'ADOPTED_TRANSPORT_FACT'
          : 'PROVIDER_OBSERVATION',
      sourceRef: input.sourceRef,
      observedAt: input.observedAt,
    },
    update: {
      instant: input.instant,
      timeZone: input.timeZone,
      sourceKind:
        input.layer === 'PLANNED'
          ? 'ADOPTED_TRANSPORT_FACT'
          : 'PROVIDER_OBSERVATION',
      sourceRef: input.sourceRef,
      observedAt: input.observedAt,
    },
  });
}

function bindingData(
  input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flight: FlightSnapshotView;
  },
  transportEdgeId: string,
) {
  return {
    ownerUserId: input.ownerUserId,
    tripId: input.tripId,
    transportEdgeId,
    provider: 'aerodatabox',
    providerFlightRef: input.flight.candidateId,
    canonicalFlightNumber: input.flight.canonicalFlightNumber,
    displayFlightNumber: input.flight.displayFlightNumber,
    serviceDate: requiredDate(`${input.flight.serviceDate}T00:00:00Z`),
    selectedSnapshot: json(input.flight),
    latestSnapshot: json(input.flight),
    status: input.flight.status,
    lastRefreshedAt: requiredDate(input.flight.fetchedAt),
  } as const;
}

function sameFlightIdentity(
  binding: {
    readonly providerFlightRef: string;
    readonly canonicalFlightNumber: string;
    readonly serviceDate: Date;
  },
  flight: FlightSnapshotView,
): boolean {
  return (
    binding.providerFlightRef === flight.candidateId &&
    binding.canonicalFlightNumber === flight.canonicalFlightNumber &&
    dateOnly(binding.serviceDate) === flight.serviceDate
  );
}

function sameStableFlightIdentity(
  selected: FlightSnapshotView,
  candidate: FlightSnapshotView,
): boolean {
  return (
    selected.canonicalFlightNumber === candidate.canonicalFlightNumber &&
    selected.serviceDate === candidate.serviceDate &&
    selected.departure.airportIata === candidate.departure.airportIata &&
    selected.arrival.airportIata === candidate.arrival.airportIata &&
    selected.departure.scheduledUtc === candidate.departure.scheduledUtc
  );
}

function matchingTemporal(
  values: readonly {
    readonly pointKind: string;
    readonly layer: string;
    readonly instant: Date;
    readonly timeZone: string;
    readonly sourceRef: string | null;
  }[],
  pointKind: TemporalPointKind,
  layer: 'PLANNED',
  instant: Date,
  timeZone: string,
  sourceRef: string,
): boolean {
  const value = values.find(
    (candidate) =>
      candidate.pointKind === pointKind && candidate.layer === layer,
  );
  return (
    value?.instant.getTime() === instant.getTime() &&
    value.timeZone === timeZone &&
    value.sourceRef === sourceRef
  );
}

async function lockOwner(transaction: Transaction, ownerUserId: string) {
  await transaction.$queryRaw`
    SELECT true AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 2))
  `;
}

async function lockOwnedTrip(
  transaction: Transaction,
  input: { readonly ownerUserId: string; readonly tripId: string },
): Promise<{ readonly id: string; readonly version: number } | null> {
  const rows = await transaction.$queryRaw<
    readonly { readonly id: string; readonly version: number }[]
  >`
    SELECT "id", "version"
    FROM "Trip"
    WHERE "id" = ${input.tripId}::uuid
      AND "ownerUserId" = ${input.ownerUserId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function plannedSourceRef(flight: FlightSnapshotView): string {
  return `aerodatabox:${flight.candidateId}:${flight.serviceDate}`;
}

function requiredDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid normalized date');
  return date;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function json(value: FlightSnapshotView): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function toView(binding: FlightBinding): FlightBindingView {
  return {
    id: binding.id,
    tripId: binding.tripId,
    transportEdgeId: binding.transportEdgeId,
    provider: 'aerodatabox',
    providerFlightRef: binding.providerFlightRef,
    canonicalFlightNumber: binding.canonicalFlightNumber,
    displayFlightNumber: binding.displayFlightNumber,
    serviceDate: dateOnly(binding.serviceDate),
    selectedSnapshot: binding.selectedSnapshot as unknown as FlightSnapshotView,
    latestSnapshot: binding.latestSnapshot as unknown as FlightSnapshotView,
    status: binding.status,
    lastRefreshedAt: binding.lastRefreshedAt.toISOString(),
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}
