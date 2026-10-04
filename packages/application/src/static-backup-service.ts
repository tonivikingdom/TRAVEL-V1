import type {
  BackupFlight,
  BackupLocation,
  FlightMovementView,
  GenerateStaticBackupRequest,
  SavedBackupFlightInput,
  StaticBackupView,
  TripView,
} from '@travel/contracts';
import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';

export interface StaticBackupRepository {
  latest(
    ownerUserId: string,
    tripId: string,
  ): Promise<{ backup: StaticBackupView | null } | null>;
  generate(
    ownerUserId: string,
    tripId: string,
    input: GenerateStaticBackupRequest,
  ): Promise<StaticBackupView>;
}
export class StaticBackupService {
  constructor(private readonly repository: StaticBackupRepository) {}
  private check(actor: Actor, tripId: string, write = false) {
    authorize(
      actor,
      write ? 'WRITE_PRIVATE_RESOURCE' : 'READ_PRIVATE_RESOURCE',
      { kind: 'PRIVATE_RESOURCE', ownerUserId: actor.userId },
    );
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        tripId,
      )
    )
      throw new ApplicationError('VALIDATION_ERROR', '旅行编号无效。', 400);
  }
  async latest(actor: Actor, tripId: string) {
    this.check(actor, tripId);
    const result = await this.repository.latest(actor.userId, tripId);
    if (!result) throw new ApplicationError('NOT_FOUND', '旅行不存在。', 404);
    return result;
  }
  async generate(
    actor: Actor,
    tripId: string,
    input: GenerateStaticBackupRequest,
  ) {
    this.check(actor, tripId, true);
    if (
      !input ||
      !Number.isSafeInteger(input.baseTripVersion) ||
      input.baseTripVersion < 1 ||
      typeof input.idempotencyKey !== 'string' ||
      !/^[0-9a-z-]{16,80}$/iu.test(input.idempotencyKey)
    )
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '备份版本或重试标识无效。',
        400,
      );
    return this.repository.generate(actor.userId, tripId, input);
  }
}
// Field-by-field whitelist. Never spread stored Provider JSON or an aggregate.
export function projectStaticBackup(
  trip: TripView,
  flights: readonly SavedBackupFlightInput[],
  id: string,
  generatedAt: string,
): StaticBackupView {
  const location = (p: {
    name: string;
    address?: string | null;
    latitude: number | null;
    longitude: number | null;
  }): BackupLocation => ({
    name: p.name,
    address: p.address ?? null,
    latitude: p.latitude,
    longitude: p.longitude,
  });
  const point = (p: { instant: string; timeZone: string } | null) =>
    p ? { instant: p.instant, timeZone: p.timeZone } : null;
  const planned = (
    values: TripView['days'][number]['nodes'][number]['timeValues'],
  ) =>
    values
      .filter((v) => v.layer === 'PLANNED')
      .map((v) => ({
        instant: v.instant,
        timeZone: v.timeZone,
        pointKind: v.pointKind,
      }));
  const movement = (m: FlightMovementView): FlightMovementView => ({
    airportName: m.airportName,
    airportIata: m.airportIata,
    airportIcao: m.airportIcao,
    timeZone: m.timeZone,
    scheduledLocal: m.scheduledLocal,
    scheduledUtc: m.scheduledUtc,
    revisedLocal: m.revisedLocal,
    revisedUtc: m.revisedUtc,
    predictedLocal: m.predictedLocal,
    predictedUtc: m.predictedUtc,
    runwayLocal: m.runwayLocal,
    runwayUtc: m.runwayUtc,
    terminal: m.terminal,
    gate: m.gate,
    checkInDesk: m.checkInDesk,
    baggageBelt: m.baggageBelt,
  });
  const flight = (
    f: SavedBackupFlightInput['selectedSnapshot'],
  ): BackupFlight => ({
    flightNumber: f.displayFlightNumber,
    serviceDate: f.serviceDate,
    fetchedAt: f.fetchedAt,
    departure: movement(f.departure),
    arrival: movement(f.arrival),
  });
  return {
    schema: 'travel-static-backup-v1',
    id,
    tripId: trip.id,
    tripVersion: trip.version,
    generatedAt,
    name: trip.name,
    peopleCount: trip.defaultPeopleCount,
    effectiveStartDate: trip.effectiveStartDate,
    effectiveEndDate: trip.effectiveEndDate,
    days: trip.days.map((d) => ({
      dayOccurrenceId: d.dayOccurrenceId,
      sequence: d.sequence,
      localDate: d.localDate,
      transportProjections: d.transportProjections.map((p) => ({
        transportEdgeId: p.transportEdgeId,
        dayOccurrenceId: p.dayOccurrenceId,
        role: p.role,
      })),
      nodes: d.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        position: n.position,
        place: n.place ? location(n.place) : null,
        note: n.note,
        requirements: n.timeIntents.map((i) => ({
          kind: i.kind,
          pointKind: i.pointKind,
          operator: i.operator,
          instant: i.instant,
          timeZone: i.timeZone,
          durationSeconds: i.durationSeconds,
          locked: i.locked,
        })),
        plannedTimes: planned(n.timeValues),
      })),
    })),
    transports: trip.connections.flatMap((c) =>
      c.transport
        ? [
            {
              id: c.transport.id,
              fromNodeId: c.fromNodeId,
              toNodeId: c.toNodeId,
              mode: c.transport.mode,
              serviceLabel: c.transport.serviceLabel,
              note: c.transport.note,
              plannedTimes: planned(c.transport.timeValues),
            },
          ]
        : [],
    ),
    routes: (trip.savedRoutes ?? []).map((r) => ({
      transportEdgeIds: [...r.transportEdgeIds],
      legs: r.legs.map((l) => ({
        mode: l.mode,
        from: location(l.from),
        to: location(l.to),
        departure: point(l.departure),
        arrival: point(l.arrival),
        durationSeconds: l.durationSeconds,
        serviceLabel: l.serviceLabel,
        fixedService: l.fixedService,
      })),
    })),
    flights: flights
      .filter((f) =>
        trip.connections.some(
          (c) =>
            c.transport?.id === f.transportEdgeId &&
            c.transport.mode === 'FLIGHT',
        ),
      )
      .map((f) => ({
        transportEdgeId: f.transportEdgeId,
        selectedSnapshot: flight(f.selectedSnapshot),
        savedSnapshot: flight(f.savedSnapshot),
      })),
  };
}
