import { randomUUID } from 'node:crypto';
import {
  RoutePreviewService,
  RouteQueryService,
  TripService,
  type Actor,
} from '@travel/application';
import type { TripView } from '@travel/contracts';
import {
  createPrismaClient,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import {
  createDevelopmentSyntheticGroundTransitRouteProvider,
  createDevelopmentSyntheticRouteProvider,
} from '@travel/providers';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  fixtureLocalDate,
  syntheticExternalWindow,
  syntheticRouteDay,
} from '../../../scripts/synthetic-route-day.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

describe('Compose SYNTHETIC midnight fixtures with real PostgreSQL and Preview guards', () => {
  let db: ManagedPrismaClient;
  let actor: Actor;
  let trips: TripService;
  let repository: PrismaTripRepository;
  beforeAll(() => {
    db = createPrismaClient(databaseUrl);
  });
  beforeEach(async () => {
    const email = `synthetic-midnight-${randomUUID()}@synthetic.example.test`;
    const user = await db.client.user.create({
      data: { email, normalizedEmail: email },
    });
    actor = { userId: user.id, email, role: 'USER', status: 'ACTIVE' };
    repository = new PrismaTripRepository(db.client);
    trips = new TripService(repository);
  });
  afterEach(async () => {
    await db.client.user.delete({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await db.close();
  });

  async function endpoints(
    fromDate: string,
    toDate = fromDate,
    external = false,
  ) {
    let trip = await trips.createTrip(actor, {
      name: 'SYNTHETIC midnight acceptance',
      planningAnchorDate: fromDate,
      defaultPeopleCount: 1,
    });
    for (const position of [0, 1]) {
      const newDay = position === 0 || fromDate !== toDate;
      trip = await trips.executeCommand(actor, trip.id, trip.version, {
        type: 'ADD_PLACE_VISIT',
        targetDay: newDay
          ? {
              type: 'NEW',
              localDate: position === 0 ? fromDate : toDate,
              sequence: position,
            }
          : {
              type: 'EXISTING',
              dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
            },
        position: newDay ? 0 : 1,
        place: {
          type: 'CUSTOM',
          name:
            position === 0
              ? 'SYNTHETIC origin'
              : external
                ? 'SYNTHETIC_P5E2_EXTERNAL_DESTINATION'
                : 'SYNTHETIC_P5E2_GROUND_DESTINATION',
          latitude: 35.68 + position * 0.001,
          longitude: 139.76,
        },
      });
    }
    return trip;
  }

  async function preview(
    trip: TripView,
    now: Date,
    departure: Date,
    timeZone: string,
    external = false,
  ) {
    const planning = new PrismaRoutePlanningRepository(db.client);
    const clock = { now: () => now };
    const query = new RouteQueryService(
      repository,
      external
        ? createDevelopmentSyntheticRouteProvider(clock.now)
        : createDevelopmentSyntheticGroundTransitRouteProvider(clock.now),
      planning,
      { candidateSnapshotTtlSeconds: 600, clock },
    );
    const service = new RoutePreviewService(repository, planning, {
      previewTtlSeconds: 600,
      clock,
    });
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const response = await query.queryRoutes(actor, trip.id, {
      basisVersion: trip.version,
      fromNodeId: from!.id,
      toNodeId: to!.id,
      hint: { type: 'DEPART_AT', instant: departure.toISOString(), timeZone },
    });
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]!.legs).toHaveLength(external ? 1 : 2);
    return service.createPreview(actor, trip.id, {
      basisVersion: trip.version,
      candidateSnapshotId: response.candidates[0]!.candidateSnapshotId,
    });
  }

  it.each([
    '2030-10-01T14:28:00Z',
    '2030-10-01T14:40:00Z',
    '2030-10-01T14:59:59Z',
    '2030-10-01T15:00:01Z',
  ])(
    'allows both day-bounded operational and handoff fixtures at %s without execution writes',
    async (instant) => {
      const now = new Date(instant);
      const day = syntheticRouteDay(now);
      const trip = await endpoints(day.localDate);
      for (const minutes of [4, 8]) {
        const result = await preview(
          trip,
          now,
          new Date(now.getTime() + minutes * 60_000),
          day.timeZone,
        );
        expect(result.adoptable).toBe(true);
        expect(
          (await db.client.trip.findUniqueOrThrow({ where: { id: trip.id } }))
            .version,
        ).toBe(trip.version);
        expect(
          await db.client.executionEvent.count({ where: { tripId: trip.id } }),
        ).toBe(0);
      }
    },
  );

  it.each([
    ['2030-10-01T14:28:00Z', 'ENDPOINT_DAY_MISMATCH'],
    ['2030-10-01T14:40:00Z', 'CROSS_DAY_TRANSFER_LOCATION'],
  ])(
    'still rejects the original unbounded Tokyo fixture at %s with %s',
    async (instant, reason) => {
      const now = new Date(instant!);
      const departure = new Date(now.getTime() + 4 * 60_000);
      const trip = await endpoints(fixtureLocalDate(departure, 'Asia/Tokyo'));
      await expect(
        preview(trip, now, departure, 'Asia/Tokyo'),
      ).rejects.toMatchObject({
        code: 'PREVIEW_UNSUPPORTED',
        message: reason,
      });
    },
  );

  it.each(['2030-10-01T14:59:59Z', '2030-10-01T15:00:01Z'])(
    'allows intentional single-leg Tokyo cross-day endpoints with a shared arrival deadline at %s',
    async (instant) => {
      const now = new Date(instant);
      const window = syntheticExternalWindow(now);
      let trip = await endpoints(window.fromDate, window.toDate, true);
      const destination = trip.days.flatMap((day) => day.nodes)[1]!;
      trip = await trips.executeCommand(actor, trip.id, trip.version, {
        type: 'SET_TIME_INTENT',
        nodeId: destination.id,
        pointKind: 'ARRIVAL',
        operator: 'NOT_AFTER',
        instant: window.arrival.toISOString(),
        timeZone: window.timeZone,
        locked: true,
      });
      expect(trip.days).toHaveLength(2);
      expect(
        (await preview(trip, now, window.departure, window.timeZone, true))
          .adoptable,
      ).toBe(true);
    },
  );
});
