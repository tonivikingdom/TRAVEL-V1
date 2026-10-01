import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type ManagedPrismaClient } from '../src/index.js';
import { archiveRouteEdges } from '../src/prisma-route-adoption.js';
import {
  lockExternalGroundTransitExecutionRows,
  lockExternalRouteMutationRows,
} from '../src/prisma-external-route-state.js';

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

  it.each(['observation', 'transition'] as const)(
    'serializes a raw %s FK insert until the R2 Undo teardown commits',
    async (target) => {
      const user = await managed.client.user.create({
        data: {
          email: `external-ground-lock-${randomUUID()}@synthetic.example.test`,
          normalizedEmail: `external-ground-lock-${randomUUID()}@synthetic.example.test`,
        },
      });
      const writer = new Client({ connectionString: databaseUrl });
      await writer.connect();
      let pending: Promise<unknown> | undefined;
      let routeId: string | undefined;
      try {
        const trip = await managed.client.trip.create({
          data: {
            ownerUserId: user.id,
            name: 'SYNTHETIC R2 ground FK lock',
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
        const nodes = [];
        for (let i = 0; i < 2; i++) {
          const place = await managed.client.place.create({
            data: {
              ownerUserId: user.id,
              name: `SYNTHETIC ground lock ${i}`,
              latitude: 35 + i,
              longitude: 139 + i,
            },
          });
          nodes.push(
            await managed.client.itineraryNode.create({
              data: {
                tripId: trip.id,
                dayOccurrenceId: day.id,
                kind: 'PLACE_VISIT',
                position: i,
                placeId: place.id,
              },
            }),
          );
        }
        const snapshot = await managed.client.routeCandidateSnapshot.create({
          data: {
            ownerUserId: user.id,
            tripId: trip.id,
            basisVersion: trip.version,
            fromNodeId: nodes[0]!.id,
            toNodeId: nodes[1]!.id,
            provider: 'SYNTHETIC',
            observedAt: new Date('2030-01-01T10:00:00Z'),
            candidatePayload: {},
            candidateHash: 'a'.repeat(64),
            createdAt: new Date('2030-01-01T10:00:00Z'),
            queryTimeCondition: {},
            expiresAt: new Date('2030-01-01T11:00:00Z'),
          },
        });
        const preview = await managed.client.routePreview.create({
          data: {
            ownerUserId: user.id,
            tripId: trip.id,
            basisVersion: trip.version,
            candidateSnapshotId: snapshot.id,
            candidateHash: snapshot.candidateHash,
            policyVersion: 'route-adoption-preview-v3',
            createdAt: new Date('2030-01-01T10:00:00Z'),
            previewPayload: {},
            expiresAt: snapshot.expiresAt,
          },
        });
        const route = await managed.client.adoptedRoute.create({
          data: {
            tripId: trip.id,
            anchorFromNodeId: nodes[0]!.id,
            anchorToNodeId: nodes[1]!.id,
            sourcePreviewId: preview.id,
            candidateSnapshotId: snapshot.id,
            candidateHash: snapshot.candidateHash,
            policyVersion: preview.policyVersion,
          },
        });
        routeId = route.id;
        const edge = await managed.client.transportEdge.create({
          data: {
            tripId: trip.id,
            fromNodeId: nodes[0]!.id,
            toNodeId: nodes[1]!.id,
            mode: 'RAIL',
            fixedService: false,
            source: 'ADOPTED_ROUTE',
            provider: 'SYNTHETIC',
            adoptedRouteId: route.id,
          },
        });
        const leg = await managed.client.groundTransitLegExecution.create({
          data: {
            tripId: trip.id,
            adoptedRouteId: route.id,
            transportEdgeId: edge.id,
            legIndex: 0,
            provider: 'SYNTHETIC',
            mode: 'RAIL',
            baseline: {},
            stateTransitions: {
              create: {
                toState: 'PENDING',
                source: 'ROUTE_ADOPT',
                evidenceRef: `adopted-route:${route.id}`,
                occurredAt: new Date('2030-01-01T10:00:00Z'),
              },
            },
          },
        });
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid as number;
        const childId = randomUUID();
        await managed.client.$transaction(async (tx) => {
          await lockExternalGroundTransitExecutionRows(tx, trip.id, route.id);
          pending =
            target === 'observation'
              ? writer.query(
                  `INSERT INTO "GroundTransitObservation"
                ("id","legExecutionId","observationIdentity","fetchedAt","factsHash","facts")
                VALUES ($1,$2,'SYNTHETIC raw observation','2030-01-01T10:01:00Z',$3,'{}'::jsonb)`,
                  [childId, leg.id, 'b'.repeat(64)],
                )
              : writer.query(
                  `INSERT INTO "GroundTransitStateTransition"
                ("id","legExecutionId","fromState","toState","source","evidenceRef","occurredAt")
                VALUES ($1,$2,'PENDING','IN_PROGRESS','LOCATION','SYNTHETIC raw location','2030-01-01T10:01:00Z')`,
                  [childId, leg.id],
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
          expect(
            await tx.groundTransitObservation.count({
              where: { legExecutionId: leg.id },
            }),
          ).toBe(0);
          expect(
            await tx.groundTransitStateTransition.count({
              where: { legExecutionId: leg.id },
            }),
          ).toBe(1);
          // Exercise the lock's validation-to-teardown interval. Historical legs
          // intentionally survive route Undo; no evidence is cascade-deleted.
          await tx.adoptedRoute.update({
            where: { id: route.id },
            data: { status: 'UNDONE' },
          });
          await tx.transportEdge.delete({ where: { id: edge.id } });
          expect(
            await tx.groundTransitObservation.count({
              where: { legExecutionId: leg.id },
            }),
          ).toBe(0);
          expect(
            await tx.groundTransitStateTransition.count({
              where: { legExecutionId: leg.id },
            }),
          ).toBe(1);
        });
        await pending;
        expect(
          await managed.client.transportEdge.findUnique({
            where: { id: edge.id },
          }),
        ).toBeNull();
        expect(
          await managed.client.adoptedRoute.findUnique({
            where: { id: route.id },
          }),
        ).toMatchObject({ status: 'UNDONE' });
        if (target === 'observation')
          expect(
            await managed.client.groundTransitObservation.findUnique({
              where: { id: childId },
            }),
          ).toMatchObject({ legExecutionId: leg.id });
        else
          expect(
            await managed.client.groundTransitStateTransition.findUnique({
              where: { id: childId },
            }),
          ).toMatchObject({ legExecutionId: leg.id, toState: 'IN_PROGRESS' });
      } finally {
        if (pending) await pending;
        await writer.end();
        if (routeId)
          await managed.client.adoptedRoute.delete({ where: { id: routeId } });
        await managed.client.user.delete({ where: { id: user.id } });
      }
    },
  );
});
