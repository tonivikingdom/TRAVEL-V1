import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type ManagedPrismaClient } from '../src/index.js';
import { archiveRouteEdges } from '../src/prisma-route-adoption.js';
import { lockExternalRouteMutationRows } from '../src/prisma-external-route-state.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

describe('external adoption FK child insertion serialization on PostgreSQL 17', () => {
  let managed: ManagedPrismaClient;
  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });
  afterAll(async () => {
    await managed.close();
  });

  it.each(['transport', 'node'] as const)(
    'locks %s parent before archival/deletion so a new ACTUAL cannot be cascaded without evidence',
    async (target) => {
      const user = await managed.client.user.create({
        data: {
          email: `external-lock-${randomUUID()}@synthetic.example.test`,
          normalizedEmail: `external-lock-${randomUUID()}@synthetic.example.test`,
        },
      });
      const trip = await managed.client.trip.create({
        data: {
          ownerUserId: user.id,
          name: 'SYNTHETIC FK lock fixture',
          planningAnchorDate: new Date('2030-01-01'),
          defaultPeopleCount: 1,
        },
      });
      const day = await managed.client.dayOccurrence.create({
        data: {
          tripId: trip.id,
          localDate: new Date('2030-01-01'),
          sequence: 0,
        },
      });
      const places = await Promise.all(
        [0, 1].map((i) =>
          managed.client.place.create({
            data: {
              ownerUserId: user.id,
              name: `SYNTHETIC lock ${i}`,
              latitude: 35 + i,
              longitude: 139 + i,
            },
          }),
        ),
      );
      const nodes = await Promise.all(
        places.map((place, i) =>
          managed.client.itineraryNode.create({
            data: {
              tripId: trip.id,
              dayOccurrenceId: day.id,
              kind: 'PLACE_VISIT',
              position: i,
              placeId: place.id,
            },
          }),
        ),
      );
      const edge = await managed.client.transportEdge.create({
        data: {
          tripId: trip.id,
          fromNodeId: nodes[0]!.id,
          toNodeId: nodes[1]!.id,
          mode: 'RAIL',
          fixedService: true,
          source: 'MANUAL',
        },
      });
      await managed.client.temporalValue.create({
        data: {
          transportEdgeId: edge.id,
          layer: 'ACTUAL',
          pointKind: 'DEPARTURE',
          instant: new Date('2030-01-01T10:00:00Z'),
          timeZone: 'UTC',
          sourceKind: 'PROVIDER_OBSERVATION',
          sourceRef: 'SYNTHETIC existing provider fact',
        },
      });
      const writer = new Client({ connectionString: databaseUrl });
      await writer.connect();
      let pending: Promise<{ code?: string }> | undefined;
      try {
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid as number;
        await managed.client.$transaction(async (tx) => {
          await lockExternalRouteMutationRows(
            tx,
            trip.id,
            [nodes[1]!.id],
            [edge.id],
          );
          // This writer bypasses the application owner lock to exercise the
          // actual database FK serialization boundary, not just version fencing.
          pending = writer
            .query(
              `INSERT INTO "TemporalValue" ("id",${target === 'transport' ? '"transportEdgeId"' : '"nodeId"'},"layer","pointKind","instant","timeZone","sourceKind","updatedAt") VALUES ($1,$2,'ACTUAL','ARRIVAL','2030-01-01T10:30:00Z','UTC','PROVIDER_OBSERVATION',CURRENT_TIMESTAMP)`,
              [randomUUID(), target === 'transport' ? edge.id : nodes[1]!.id],
            )
            .then(
              () => ({}),
              (error: { code: string }) => ({ code: error.code }),
            );
          let waiting = false;
          for (let attempt = 0; attempt < 200; attempt++) {
            const rows = await tx.$queryRawUnsafe<
              { wait_event_type: string | null }[]
            >('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', pid);
            if (rows[0]?.wait_event_type === 'Lock') {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(waiting).toBe(true);
          const current = await tx.transportEdge.findMany({
            where: { id: edge.id },
            include: { temporalValues: true, dayProjections: true },
          });
          await archiveRouteEdges(
            tx,
            current,
            new Date('2030-01-01T10:31:00Z'),
          );
          if (target === 'node')
            await tx.itineraryNode.delete({ where: { id: nodes[1]!.id } });
        });
        expect(await pending).toEqual({ code: '23503' });
        const history =
          await managed.client.transportEdgeHistory.findUniqueOrThrow({
            where: { originalTransportEdgeId: edge.id },
            include: { temporalValues: true },
          });
        expect(history.temporalValues).toHaveLength(1);
        expect(history.temporalValues[0]).toMatchObject({
          layer: 'ACTUAL',
          pointKind: 'DEPARTURE',
          sourceRef: 'SYNTHETIC existing provider fact',
          instant: new Date('2030-01-01T10:00:00Z'),
        });
        expect(
          await managed.client.transportEdge.findUnique({
            where: { id: edge.id },
          }),
        ).toBeNull();
      } finally {
        if (pending) await pending;
        await writer.end();
        await managed.client.user.delete({ where: { id: user.id } });
      }
    },
  );
});
