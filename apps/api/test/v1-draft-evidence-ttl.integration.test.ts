import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RouteProviderResult } from '@travel/application';
import type { RoutePreviewView, TripView } from '@travel/contracts';
import { SyntheticRouteProvider } from '@travel/providers';
import {
  adoptionFootprint,
  setSyntheticSnapshotExpiry,
} from './helpers/adoption-evidence-ttl.js';
import {
  draftEvidence,
  draftPlanningApi,
  withHeldDraftLock,
} from './helpers/draft-evidence-ttl.js';
import { bearer, replanningHarness } from './helpers/replanning-acceptance.js';

const requestAt = new Date('2030-10-01T09:59:01Z');
const expiry = new Date('2030-10-01T09:59:02Z');
const expired = new Date('2030-10-01T09:59:03Z');
const later = new Date('2030-10-01T10:08:00Z');
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('Task-isolated TEST_DATABASE_URL is required');

function candidate(
  trip: TripView,
  validUntil: Date | null,
  id = 'SYNTHETIC:draft-TTL',
): Extract<RouteProviderResult, { status: 'SUCCESS' }>['candidates'][number] {
  const location = (index: number) => ({
    name: trip.days[0]!.nodes[index]!.place!.name,
    latitude: trip.days[0]!.nodes[index]!.place!.latitude,
    longitude: trip.days[0]!.nodes[index]!.place!.longitude,
    providerPlaceRef: null,
  });
  const departure = {
    instant: new Date('2030-10-01T10:00:00Z'),
    timeZone: 'Asia/Tokyo',
  };
  const arrival = {
    instant: new Date('2030-10-01T11:00:00Z'),
    timeZone: 'Asia/Tokyo',
  };
  return {
    candidateId: id,
    provider: 'SYNTHETIC',
    providerCandidateRef: null,
    observedAt: requestAt,
    validUntil,
    departure,
    arrival,
    durationSeconds: 3600,
    fare: null,
    legs: [
      {
        mode: 'TRANSIT',
        from: location(0),
        to: location(1),
        departure,
        arrival,
        durationSeconds: 3600,
        fixedService: false,
        serviceLabel: 'SYNTHETIC aggregate',
        providerRef: null,
      },
    ],
  };
}

describe('ITINERARY_NODE draft evidence TTL with real PostgreSQL', () => {
  for (const phase of ['query', 'preview'] as const) {
    const kinds =
      phase === 'query'
        ? (['snapshot', 'provider'] as const)
        : (['snapshot', 'provider', 'preview'] as const);
    for (const timing of ['owner', 'Trip', 'insert'] as const) {
      it.each(kinds)(
        `${phase} ${timing} crossing %s TTL rejects and rolls back the complete footprint`,
        async (kind) => {
          const h = replanningHarness(databaseUrl);
          let api: ReturnType<typeof draftPlanningApi> | undefined;
          let now = requestAt;
          try {
            h.setNow(requestAt);
            const owner = await h.identity();
            const trip = await h.seed(owner);
            let advance = false;
            api = draftPlanningApi(
              h.managed,
              () => now,
              new SyntheticRouteProvider(() => ({
                status: 'SUCCESS',
                candidates: [
                  candidate(trip, kind === 'provider' ? expiry : null),
                ],
              })),
              {
                snapshotTtlSeconds:
                  phase === 'query' && kind === 'snapshot' ? 1 : 900,
                previewTtlSeconds: kind === 'preview' ? 1 : 600,
                afterSnapshot: () => {
                  if (advance && phase === 'query') now = expired;
                },
                afterPreview: () => {
                  if (advance && phase === 'preview') now = expired;
                },
              },
            );
            const post = (url: string, payload: object) =>
              api!.inject({
                method: 'POST',
                url,
                headers: bearer(owner),
                payload,
              });
            const query = () =>
              post(`/trips/${trip.id}/routes/query`, {
                basisVersion: trip.version,
                fromNodeId: trip.days[0]!.nodes[0]!.id,
                toNodeId: trip.days[0]!.nodes[1]!.id,
                hint: {
                  type: 'DEPART_AT',
                  instant: '2030-10-01T10:00:00Z',
                  timeZone: 'Asia/Tokyo',
                },
                travelMode: 'TRANSIT',
              });
            let snapshotId = '';
            if (phase === 'preview') {
              const response = await query();
              expect(response.statusCode, response.body).toBe(200);
              snapshotId = response.json().candidates[0].candidateSnapshotId;
              if (kind === 'snapshot')
                await setSyntheticSnapshotExpiry(
                  h.managed,
                  snapshotId,
                  expiry,
                  null,
                );
            }
            const before = await adoptionFootprint(
              h.managed,
              trip.id,
              owner.id,
            );
            const request = () =>
              phase === 'query'
                ? query()
                : post(`/trips/${trip.id}/previews`, {
                    basisVersion: trip.version,
                    candidateSnapshotId: snapshotId,
                  });
            advance = timing === 'insert';
            const response =
              timing === 'insert'
                ? await request()
                : await withHeldDraftLock(
                    h.managed,
                    owner.id,
                    trip.id,
                    timing,
                    request,
                    () => {
                      now = expired;
                    },
                  );
            const after = await adoptionFootprint(h.managed, trip.id, owner.id);
            await draftEvidence(
              `itinerary-${phase}-${timing}-${kind}`,
              before,
              after,
              {
                requestAt: requestAt.toISOString(),
                expiresAt: expiry.toISOString(),
                finalClock: now.toISOString(),
                httpStatus: response.statusCode,
                errorCode: response.json().error?.code ?? null,
              },
            );
            expect(response.statusCode, response.body).toBe(
              phase === 'query' ? 404 : 409,
            );
            expect(response.json().error.code).toBe(
              phase === 'query' ? 'NO_MATCHING_CANDIDATE' : 'PREVIEW_STALE',
            );
            expect(after).toEqual(before);
          } finally {
            await api?.close();
            await h.close();
          }
        },
      );
    }
  }

  it.each(['owner', 'insert'] as const)(
    'mixed candidates at %s: filter before inserts or roll back the whole inserted batch',
    async (timing) => {
      const h = replanningHarness(databaseUrl);
      let api: ReturnType<typeof draftPlanningApi> | undefined;
      let now = requestAt;
      try {
        const owner = await h.identity();
        const trip = await h.seed(owner);
        api = draftPlanningApi(
          h.managed,
          () => now,
          new SyntheticRouteProvider(() => ({
            status: 'SUCCESS',
            candidates: [
              candidate(trip, expiry, 'SYNTHETIC:short'),
              candidate(trip, later, 'SYNTHETIC:long'),
            ],
          })),
          {
            afterSnapshot: () => {
              if (timing === 'insert') now = expired;
            },
          },
        );
        const before = await adoptionFootprint(h.managed, trip.id, owner.id);
        const request = () =>
          api!.inject({
            method: 'POST',
            url: `/trips/${trip.id}/routes/query`,
            headers: bearer(owner),
            payload: {
              basisVersion: trip.version,
              fromNodeId: trip.days[0]!.nodes[0]!.id,
              toNodeId: trip.days[0]!.nodes[1]!.id,
              hint: {
                type: 'DEPART_AT',
                instant: '2030-10-01T10:00:00Z',
                timeZone: 'Asia/Tokyo',
              },
              travelMode: 'TRANSIT',
            },
          });
        const response =
          timing === 'insert'
            ? await request()
            : await withHeldDraftLock(
                h.managed,
                owner.id,
                trip.id,
                'owner',
                request,
                () => {
                  now = expired;
                },
              );
        if (timing === 'insert') {
          expect(response.statusCode, response.body).toBe(404);
          expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
            before,
          );
        } else {
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().candidates).toHaveLength(1);
          expect(response.json().candidates[0].candidateId).toBe(
            'SYNTHETIC:long',
          );
          const rows = await h.client.routeCandidateSnapshot.findMany({
            where: { tripId: trip.id },
          });
          expect(rows).toHaveLength(1);
          expect(rows[0]!.id).toBe(
            response.json().candidates[0].candidateSnapshotId,
          );
          expect(rows[0]!.expiresAt > now).toBe(true);
          const after = await adoptionFootprint(h.managed, trip.id, owner.id);
          expect({ ...after, snapshots: before.snapshots }).toEqual(before);
        }
      } finally {
        await api?.close();
        await h.close();
      }
    },
  );

  it.each(['query', 'preview'] as const)(
    'strict <= boundary for %s with null Provider TTL',
    async (phase) => {
      for (const offset of [-1, 0, 1]) {
        const h = replanningHarness(databaseUrl);
        let api: ReturnType<typeof draftPlanningApi> | undefined;
        let now = requestAt;
        try {
          const owner = await h.identity();
          const trip = await h.seed(owner);
          api = draftPlanningApi(
            h.managed,
            () => now,
            new SyntheticRouteProvider(() => ({
              status: 'SUCCESS',
              candidates: [candidate(trip, null)],
            })),
            {
              snapshotTtlSeconds: 1,
            },
          );
          const post = (url: string, payload: object) =>
            api!.inject({
              method: 'POST',
              url,
              headers: bearer(owner),
              payload,
            });
          const query = () =>
            post(`/trips/${trip.id}/routes/query`, {
              basisVersion: trip.version,
              fromNodeId: trip.days[0]!.nodes[0]!.id,
              toNodeId: trip.days[0]!.nodes[1]!.id,
              hint: {
                type: 'DEPART_AT',
                instant: '2030-10-01T10:00:00Z',
                timeZone: 'Asia/Tokyo',
              },
              travelMode: 'TRANSIT',
            });
          let snapshotId = '';
          if (phase === 'preview')
            snapshotId = (await query()).json().candidates[0]
              .candidateSnapshotId;
          const before = await adoptionFootprint(h.managed, trip.id, owner.id);
          const response = await withHeldDraftLock(
            h.managed,
            owner.id,
            trip.id,
            'Trip',
            () =>
              phase === 'query'
                ? query()
                : post(`/trips/${trip.id}/previews`, {
                    basisVersion: trip.version,
                    candidateSnapshotId: snapshotId,
                  }),
            () => {
              now = new Date(expiry.getTime() + offset);
            },
          );
          expect(response.statusCode, response.body).toBe(
            offset < 0
              ? phase === 'query'
                ? 200
                : 201
              : phase === 'query'
                ? 404
                : 409,
          );
          if (offset >= 0)
            expect(
              await adoptionFootprint(h.managed, trip.id, owner.id),
            ).toEqual(before);
        } finally {
          await api?.close();
          await h.close();
        }
      }
    },
  );

  it('post-Provider I/O fresh Clock rejects expired Provider evidence without persistence', async () => {
    const h = replanningHarness(databaseUrl);
    let api: ReturnType<typeof draftPlanningApi> | undefined;
    let now = requestAt;
    try {
      const owner = await h.identity();
      const trip = await h.seed(owner);
      api = draftPlanningApi(
        h.managed,
        () => now,
        new SyntheticRouteProvider(() => {
          now = expired;
          return { status: 'SUCCESS', candidates: [candidate(trip, expiry)] };
        }),
      );
      const before = await adoptionFootprint(h.managed, trip.id, owner.id);
      const response = await api.inject({
        method: 'POST',
        url: `/trips/${trip.id}/routes/query`,
        headers: bearer(owner),
        payload: {
          basisVersion: trip.version,
          fromNodeId: trip.days[0]!.nodes[0]!.id,
          toNodeId: trip.days[0]!.nodes[1]!.id,
          hint: {
            type: 'DEPART_AT',
            instant: '2030-10-01T10:00:00Z',
            timeZone: 'Asia/Tokyo',
          },
          travelMode: 'TRANSIT',
        },
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
        before,
      );
    } finally {
      await api?.close();
      await h.close();
    }
  });

  it('valid null Provider TTL supports Query → Preview → Adopt → receipt replay → Undo', async () => {
    const h = replanningHarness(databaseUrl);
    try {
      h.setNow(requestAt);
      const owner = await h.identity();
      const trip = await h.seed(owner);
      h.setResult({ status: 'SUCCESS', candidates: [candidate(trip, null)] });
      const before = await adoptionFootprint(h.managed, trip.id, owner.id);
      const snapshotId = await h.candidate(owner, trip);
      const response = await h.preview(owner, trip, snapshotId);
      expect(response.statusCode, response.body).toBe(201);
      const preview = response.json<RoutePreviewView>();
      const key = randomUUID();
      expect(
        (await h.client.trip.findUniqueOrThrow({ where: { id: trip.id } }))
          .version,
      ).toBe(before.trip.version);
      const adopted = await h.adopt(owner, trip, preview, key);
      expect(adopted.statusCode, adopted.body).toBe(200);
      const recorded = adopted.json();
      h.setNow(expiry);
      const replay = await h.adopt(owner, trip, preview, key);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().operationReceipt.id).toBe(
        recorded.operationReceipt.id,
      );
      const undone = await h.undo(owner, recorded);
      expect(undone.statusCode, undone.body).toBe(200);
    } finally {
      await h.close();
    }
  });
});
