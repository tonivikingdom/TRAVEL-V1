import { createHash } from 'node:crypto';

import type {
  GroundTransitLegRecord,
  GroundTransitRepository,
} from '@travel/application';
import {
  assessGroundTransitOperational,
  advanceGroundTransitAttentionState,
  decideGroundTransitObservationOrdering,
  GROUND_TRANSIT_POLICY,
  matchGroundTransitIdentity,
  resolveGroundTransitProviderState,
  type GroundTransitBaseline,
  type GroundTransitObservation,
  type GroundTransitChangeKind,
  type GroundTransitAttentionState,
  type GroundTransitOperationalAssessment,
} from '@travel/domain';

import {
  Prisma,
  type GroundTransitLegExecution,
  type PrismaClient,
} from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;
type LegRow = GroundTransitLegExecution & {
  readonly _count: { readonly observations: number };
};

export class PrismaGroundTransitRepository implements GroundTransitRepository {
  constructor(private readonly client: PrismaClient) {}

  async listOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }) {
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: { version: true },
    });
    if (trip === null) return null;
    const rows = await this.client.groundTransitLegExecution.findMany({
      where: { tripId: input.tripId },
      include: { _count: { select: { observations: true } } },
      orderBy: [{ createdAt: 'asc' }, { legIndex: 'asc' }, { id: 'asc' }],
    });
    const currentEdges = await this.client.transportEdge.findMany({
      where: {
        tripId: input.tripId,
        source: 'ADOPTED_ROUTE',
        adoptedRoute: { status: 'ACTIVE' },
        mode: { in: ['RAIL', 'BUS'] },
      },
      select: { id: true, adoptedRouteId: true, provider: true, mode: true },
    });
    const currentIds = new Set(currentEdges.map((edge) => edge.id));
    const persistedIds = new Set(rows.map((row) => row.transportEdgeId));
    const hydrated = await Promise.all(
      rows.map(async (row) =>
        toRecord(
          row,
          currentIds.has(row.transportEdgeId),
          await operationalContext(this.client, row),
        ),
      ),
    );
    return {
      tripVersion: trip.version,
      legs: [
        ...hydrated,
        ...currentEdges
          .filter((edge) => !persistedIds.has(edge.id))
          .map((edge) => unknownLegacyRecord(input.tripId, edge)),
      ],
    };
  }

  async findCurrentOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly transportEdgeId: string;
  }) {
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: { id: true },
    });
    if (trip === null) return null;
    const row = await this.client.groundTransitLegExecution.findFirst({
      where: { tripId: input.tripId, transportEdgeId: input.transportEdgeId },
      include: { _count: { select: { observations: true } } },
    });
    const edge = await this.client.transportEdge.findFirst({
      where: {
        id: input.transportEdgeId,
        tripId: input.tripId,
        source: 'ADOPTED_ROUTE',
        ...(row === null ? {} : { adoptedRouteId: row.adoptedRouteId }),
        adoptedRoute: { status: 'ACTIVE' },
        mode: { in: ['RAIL', 'BUS'] },
      },
      select: { id: true, adoptedRouteId: true, provider: true, mode: true },
    });
    if (edge === null) return null;
    return row === null
      ? unknownLegacyRecord(input.tripId, edge)
      : toRecord(row, true, await operationalContext(this.client, row));
  }

  async commitObservation(
    input: Parameters<GroundTransitRepository['commitObservation']>[0],
  ) {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await transaction.$queryRaw<readonly { id: string }[]>`
        SELECT "id" FROM "Trip" WHERE "id"=${input.tripId}::uuid
          AND "ownerUserId"=${input.ownerUserId}::uuid FOR UPDATE`;
      if (trip.length === 0) return { status: 'NOT_FOUND' as const, leg: null };
      const row = await transaction.groundTransitLegExecution.findUnique({
        where: { transportEdgeId: input.transportEdgeId },
        include: { _count: { select: { observations: true } } },
      });
      if (row === null || row.tripId !== input.tripId) {
        return { status: 'NOT_FOUND' as const, leg: null };
      }
      const edge = await transaction.transportEdge.findFirst({
        where: {
          id: input.transportEdgeId,
          tripId: input.tripId,
          adoptedRouteId: row.adoptedRouteId,
          source: 'ADOPTED_ROUTE',
          adoptedRoute: { status: 'ACTIVE' },
        },
        select: { id: true, fromNodeId: true, toNodeId: true },
      });
      if (edge === null) return { status: 'NOT_FOUND' as const, leg: null };
      if (input.expectedCapabilityRevision !== undefined) {
        const capability =
          await transaction.tripAssistanceCapability.findUnique({
            where: {
              tripId_kind: {
                tripId: input.tripId,
                kind: 'GROUND_TRANSIT_MONITORING',
              },
            },
            select: { state: true, revision: true },
          });
        if (
          capability?.state !== 'ENABLED' ||
          capability.revision !== input.expectedCapabilityRevision
        ) {
          return {
            status: 'CAPABILITY_CHANGED' as const,
            leg: toRecord(row, true),
          };
        }
      }
      const baseline = parseBaseline(row);
      if (baseline === null) {
        return {
          status: 'IDENTITY_UNKNOWN' as const,
          leg: toRecord(row, true),
        };
      }
      const identity = matchGroundTransitIdentity(baseline, input.observation);
      if (identity !== 'MATCHED') {
        return { status: identity, leg: toRecord(row, true) };
      }
      const facts = serializableObservation(input.observation);
      const factsHash = createHash('sha256')
        .update(canonicalJson(facts))
        .digest('hex');
      const ordering = decideGroundTransitObservationOrdering({
        previousFetchedAt: row.latestFetchedAt,
        previousObservationIdentity: row.latestObservationId,
        previousFactsHash: row.latestObservationHash,
        incomingFetchedAt: input.observation.fetchedAt,
        incomingObservationIdentity: input.observation.observationIdentity,
        incomingFactsHash: factsHash,
      });
      if (ordering !== 'APPLIED') {
        return {
          status: ordering,
          leg: toRecord(row, true, await operationalContext(transaction, row)),
        };
      }
      const duplicateIdentity =
        await transaction.groundTransitObservation.findFirst({
          where: {
            legExecutionId: row.id,
            observationIdentity: input.observation.observationIdentity,
          },
          select: { factsHash: true, fetchedAt: true },
        });
      if (duplicateIdentity !== null) {
        return {
          status:
            duplicateIdentity.factsHash === factsHash &&
            duplicateIdentity.fetchedAt.getTime() ===
              input.observation.fetchedAt.getTime()
              ? ('IDEMPOTENT' as const)
              : ('OBSERVATION_CONFLICT' as const),
          leg: toRecord(row, true, await operationalContext(transaction, row)),
        };
      }
      const savedObservation =
        await transaction.groundTransitObservation.create({
          data: {
            legExecutionId: row.id,
            observationIdentity: input.observation.observationIdentity,
            fetchedAt: input.observation.fetchedAt,
            factsHash,
            facts: facts as unknown as Prisma.InputJsonValue,
          },
        });
      const temporalChanged =
        row.serviceClass === 'FIXED_SERVICE'
          ? await writeFixedServiceTimes(
              transaction,
              row.transportEdgeId,
              input.observation,
              savedObservation.id,
              input.now,
            )
          : false;
      if (temporalChanged) {
        await transaction.trip.update({
          where: { id: input.tripId },
          data: { version: { increment: 1 } },
        });
      }
      const boardingArrival = await transaction.temporalValue.findFirst({
        where: {
          nodeId: edge.fromNodeId,
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
        },
        select: { instant: true },
      });
      const actualServiceDeparture = await transaction.temporalValue.findFirst({
        where: {
          transportEdgeId: edge.id,
          layer: 'ACTUAL',
          pointKind: 'DEPARTURE',
        },
        select: { instant: true },
      });
      const downstream = await transaction.transportEdge.findFirst({
        where: {
          tripId: input.tripId,
          fromNodeId: edge.toNodeId,
          fixedService: true,
        },
        include: { temporalValues: true },
      });
      const fixedDeparture =
        downstream === null
          ? null
          : ((['ACTUAL', 'ESTIMATED', 'PLANNED'] as const)
              .map(
                (layer) =>
                  downstream.temporalValues.find(
                    (value) =>
                      value.layer === layer && value.pointKind === 'DEPARTURE',
                  )?.instant ?? null,
              )
              .find((value) => value !== null) ?? null);
      const plannedArrival = baseline.plannedArrival;
      const estimatedArrival = input.observation.estimatedArrival;
      const minimumTransfer =
        input.observation.minimumTransferSeconds ??
        baseline.minimumTransferSeconds;
      const consequentialDeviation =
        fixedDeparture !== null &&
        plannedArrival !== null &&
        estimatedArrival !== null &&
        estimatedArrival.getTime() - plannedArrival.getTime() >=
          GROUND_TRANSIT_POLICY.minimumDeviationSeconds * 1_000 &&
        (minimumTransfer === null ||
          estimatedArrival.getTime() + minimumTransfer * 1_000 >
            fixedDeparture.getTime());
      const previousObservation = parseObservation(row.latestObservation);
      const operational = assessGroundTransitOperational({
        baseline,
        previousObservation,
        latestObservation: input.observation,
        now: input.now,
        state: row.state,
        current: true,
        availableAtBoarding: boardingArrival?.instant ?? null,
        actualServiceDeparture: actualServiceDeparture?.instant ?? null,
        downstreamProtectedDeparture: fixedDeparture,
      });
      const entryIntoFailure =
        row.state === 'NO_LONGER_FEASIBLE'
          ? await transaction.groundTransitStateTransition.findFirst({
              where: {
                legExecutionId: row.id,
                toState: 'NO_LONGER_FEASIBLE',
              },
              orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
              select: { fromState: true },
            })
          : null;
      const providerState = resolveGroundTransitProviderState({
        previous: row.state,
        noLongerFeasible:
          operational.disposition === 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
        beforeFailureState: entryIntoFailure?.fromState ?? null,
      });
      const updated = await transaction.groundTransitLegExecution.update({
        where: { id: row.id },
        data: {
          latestFetchedAt: input.observation.fetchedAt,
          latestObservationId: input.observation.observationIdentity,
          latestObservationHash: factsHash,
          // Denormalized current snapshot also carries an internal presentation
          // watermark. Canonical provider facts/history/hash remain untouched.
          latestObservation: {
            ...facts,
            __groundTransitAttention: advanceGroundTransitAttentionState({
              previous: parseAttentionState(row.latestObservation),
              previousObservation,
              observation: input.observation,
              baseline,
            }),
          } as unknown as Prisma.InputJsonValue,
          state: providerState,
          deviationCount: consequentialDeviation ? row.deviationCount + 1 : 0,
          deviationStartedAt: consequentialDeviation
            ? (row.deviationStartedAt ?? input.observation.fetchedAt)
            : null,
          nextCheckAt: new Date(
            input.now.getTime() + GROUND_TRANSIT_POLICY.monitorIntervalMs,
          ),
        },
        include: { _count: { select: { observations: true } } },
      });
      if (updated.state !== row.state) {
        await transaction.groundTransitStateTransition.create({
          data: {
            legExecutionId: row.id,
            fromState: row.state,
            toState: updated.state,
            source: 'PROVIDER_OBSERVATION',
            evidenceRef:
              `ground-transit-observation:${input.observation.observationIdentity}`.slice(
                0,
                300,
              ),
            occurredAt: input.now,
          },
        });
      }
      return {
        status: 'APPLIED' as const,
        leg: toRecord(updated, true, {
          previousObservation,
          availableAtBoarding: boardingArrival?.instant ?? null,
          actualServiceDeparture: actualServiceDeparture?.instant ?? null,
          downstreamProtectedDeparture: fixedDeparture,
        }),
      };
    });
  }

  async recordProviderFailure(
    input: Parameters<GroundTransitRepository['recordProviderFailure']>[0],
  ): Promise<'CURRENT' | 'CAPABILITY_CHANGED' | 'NOT_FOUND'> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await transaction.$queryRaw<readonly { id: string }[]>`
        SELECT "id" FROM "Trip" WHERE "id"=${input.tripId}::uuid
          AND "ownerUserId"=${input.ownerUserId}::uuid FOR UPDATE`;
      if (trip.length === 0) return 'NOT_FOUND';
      const row = await transaction.groundTransitLegExecution.findUnique({
        where: { transportEdgeId: input.transportEdgeId },
        select: { id: true, tripId: true, adoptedRouteId: true },
      });
      if (row === null || row.tripId !== input.tripId) return 'NOT_FOUND';
      const edge = await transaction.transportEdge.findFirst({
        where: {
          id: input.transportEdgeId,
          tripId: input.tripId,
          adoptedRouteId: row.adoptedRouteId,
          source: 'ADOPTED_ROUTE',
          adoptedRoute: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (edge === null) return 'NOT_FOUND';
      if (input.expectedCapabilityRevision !== undefined) {
        const capability =
          await transaction.tripAssistanceCapability.findUnique({
            where: {
              tripId_kind: {
                tripId: input.tripId,
                kind: 'GROUND_TRANSIT_MONITORING',
              },
            },
            select: { state: true, revision: true },
          });
        if (
          capability?.state !== 'ENABLED' ||
          capability.revision !== input.expectedCapabilityRevision
        )
          return 'CAPABILITY_CHANGED';
      }
      return 'CURRENT';
    });
  }

  async recordOperationalPresentation(
    input: Parameters<
      GroundTransitRepository['recordOperationalPresentation']
    >[0],
  ): Promise<'CURRENT' | 'OBSOLETE' | 'CAPABILITY_CHANGED'> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await transaction.$queryRaw<readonly { id: string }[]>`
        SELECT "id" FROM "Trip" WHERE "id"=${input.tripId}::uuid
          AND "ownerUserId"=${input.ownerUserId}::uuid FOR UPDATE`;
      if (trip.length === 0) return 'OBSOLETE';
      if (input.expectedCapabilityRevision !== undefined) {
        const capability =
          await transaction.tripAssistanceCapability.findUnique({
            where: {
              tripId_kind: {
                tripId: input.tripId,
                kind: 'GROUND_TRANSIT_MONITORING',
              },
            },
            select: { state: true, revision: true },
          });
        if (
          capability?.state !== 'ENABLED' ||
          capability.revision !== input.expectedCapabilityRevision
        )
          return 'CAPABILITY_CHANGED';
      }
      const leg = await transaction.groundTransitLegExecution.findUnique({
        where: { transportEdgeId: input.transportEdgeId },
        select: {
          id: true,
          tripId: true,
          adoptedRouteId: true,
          latestObservationId: true,
          latestFetchedAt: true,
          latestObservation: true,
        },
      });
      if (
        leg === null ||
        leg.tripId !== input.tripId ||
        leg.latestObservationId !== input.observationIdentity ||
        leg.latestFetchedAt?.getTime() !== input.fetchedAt.getTime()
      )
        return 'OBSOLETE';
      const edge = await transaction.transportEdge.findFirst({
        where: {
          id: input.transportEdgeId,
          tripId: input.tripId,
          adoptedRouteId: leg.adoptedRouteId,
          source: 'ADOPTED_ROUTE',
          adoptedRoute: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (edge === null) return 'OBSOLETE';
      const prefix = `ground-transit-observation:${leg.id}:`;
      const groupKey = `${prefix}${input.fetchedAt.toISOString()}`;
      const current = await transaction.notificationEvent.findFirst({
        where: {
          ownerUserId: input.ownerUserId,
          presentationGroupKey: groupKey,
          presentationActive: true,
        },
      });
      const shouldPresent = input.assessment.requiresUserAttention;
      const quietCurrent =
        !shouldPresent &&
        !input.assessment.persistentAttentionActive &&
        !input.relatedRiskActive &&
        input.assessment.disposition === 'CONTINUE_CURRENT_PLAN';
      if (current !== null || shouldPresent || quietCurrent) {
        await transaction.notificationEvent.updateMany({
          where: {
            ownerUserId: input.ownerUserId,
            presentationGroupKey: {
              startsWith: prefix,
              ...(quietCurrent ? {} : { not: groupKey }),
            },
            presentationActive: true,
          },
          data: { presentationActive: false },
        });
      }
      if (!shouldPresent) return 'CURRENT';
      const summary = operationalSummary(
        input.assessment.changeKinds,
        input.assessment.requiredAction,
        input.hasDownstreamImpact,
        parseObservation(leg.latestObservation),
      );
      if (summary.length === 0)
        throw new Error(
          'Ground transit attention requires a non-empty summary',
        );
      if (current !== null) {
        const priorKinds = Array.isArray(current.changeKinds)
          ? current.changeKinds.filter(
              (value): value is string => typeof value === 'string',
            )
          : [];
        const kinds = [
          ...new Set([...priorKinds, ...input.assessment.changeKinds]),
        ].sort(compareText);
        const priorSummary = current.summary ?? current.body;
        const joined = (
          priorSummary.includes(summary)
            ? priorSummary
            : `${priorSummary}；${summary}`
        ).slice(0, 500);
        await transaction.notificationEvent.update({
          where: { id: current.id },
          data: {
            changeKinds: kinds,
            summary: joined,
            body: joined,
            priority:
              current.priority === 'STRONG' ||
              input.assessment.notificationPriority === 'STRONG'
                ? 'STRONG'
                : 'NORMAL',
            hasDownstreamImpact:
              current.hasDownstreamImpact || input.hasDownstreamImpact,
          },
        });
        await markAttentionPresented(transaction, leg, input.assessment);
        return 'CURRENT';
      }
      await transaction.notificationEvent.upsert({
        where: {
          ownerUserId_dedupeKey: {
            ownerUserId: input.ownerUserId,
            dedupeKey: groupKey,
          },
        },
        create: {
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
          kind: 'GROUND_TRANSIT_IMPORTANT_CHANGE',
          dedupeKey: groupKey,
          title:
            input.assessment.notificationPriority === 'STRONG'
              ? '地面交通重要运行变化'
              : '地面交通运行信息更新',
          body: summary,
          summary,
          changeKinds: [...input.assessment.changeKinds],
          hasDownstreamImpact: input.hasDownstreamImpact,
          priority: input.assessment.notificationPriority ?? 'NORMAL',
          occurredAt: input.now,
          presentationGroupKey: groupKey,
          presentationActive: true,
        },
        update: {},
      });
      await markAttentionPresented(transaction, leg, input.assessment);
      return 'CURRENT';
    });
  }

  async ensureEligibleMonitoring(now: Date): Promise<number> {
    const capabilities = await this.client.tripAssistanceCapability.findMany({
      where: { kind: 'GROUND_TRANSIT_MONITORING', state: 'ENABLED' },
      select: { tripId: true, ownerUserId: true, revision: true },
    });
    let enqueued = 0;
    for (const capability of capabilities) {
      const scheduled = await this.client.$transaction(async (transaction) => {
        await lockOwner(transaction, capability.ownerUserId);
        const currentCapability =
          await transaction.tripAssistanceCapability.findUnique({
            where: {
              tripId_kind: {
                tripId: capability.tripId,
                kind: 'GROUND_TRANSIT_MONITORING',
              },
            },
            select: { state: true, revision: true },
          });
        if (
          currentCapability?.state !== 'ENABLED' ||
          currentCapability.revision !== capability.revision
        )
          return 0;
        const due = await transaction.groundTransitLegExecution.findMany({
          where: {
            tripId: capability.tripId,
            serviceClass: { not: null },
            OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
          },
          include: { _count: { select: { observations: true } } },
        });
        const edges = await transaction.transportEdge.findMany({
          where: {
            id: { in: due.map((row) => row.transportEdgeId) },
            tripId: capability.tripId,
            source: 'ADOPTED_ROUTE',
            adoptedRoute: { status: 'ACTIVE' },
          },
          select: { id: true, adoptedRouteId: true },
        });
        const currentEdges = new Set(
          edges.map((edge) => `${edge.id}:${edge.adoptedRouteId}`),
        );
        const dueRouteIds = [
          ...new Set(
            due
              .filter(
                (row) =>
                  currentEdges.has(
                    `${row.transportEdgeId}:${row.adoptedRouteId}`,
                  ) && isWithinMonitoringWindow(parseBaseline(row), now),
              )
              .map((row) => row.adoptedRouteId),
          ),
        ];
        let count = 0;
        for (const adoptedRouteId of dueRouteIds) {
          const pending = await transaction.job.findFirst({
            where: {
              type: 'GROUND_TRANSIT_MONITOR',
              payloadRef: adoptedRouteId,
              capabilityRevision: capability.revision,
              status: { in: ['QUEUED', 'RUNNING'] },
              cancelRequested: false,
            },
            select: { id: true },
          });
          if (pending !== null) continue;
          const bucket = Math.floor(
            now.getTime() / GROUND_TRANSIT_POLICY.monitorIntervalMs,
          );
          const uniqueKey = `GROUND_TRANSIT_MONITOR:${adoptedRouteId}:${capability.revision}:${bucket}`;
          const job = await transaction.job.createMany({
            data: [
              {
                type: 'GROUND_TRANSIT_MONITOR',
                runAt: now,
                maxAttempts: 3,
                uniqueKey,
                payloadRef: adoptedRouteId,
                capabilityRevision: capability.revision,
              },
            ],
            skipDuplicates: true,
          });
          count += job.count;
        }
        return count;
      });
      enqueued += scheduled;
    }
    return enqueued;
  }

  async listJobLegs(input: {
    readonly adoptedRouteId: string;
    readonly capabilityRevision: number;
    readonly now: Date;
  }) {
    const route = await this.client.adoptedRoute.findFirst({
      where: { id: input.adoptedRouteId, status: 'ACTIVE' },
      select: { tripId: true, id: true },
    });
    if (route === null) return [];
    const capability = await this.client.tripAssistanceCapability.findUnique({
      where: {
        tripId_kind: {
          tripId: route.tripId,
          kind: 'GROUND_TRANSIT_MONITORING',
        },
      },
      select: { state: true, revision: true, ownerUserId: true },
    });
    if (
      capability?.state !== 'ENABLED' ||
      capability.revision !== input.capabilityRevision
    )
      return [];
    const rows = await this.client.groundTransitLegExecution.findMany({
      where: {
        tripId: route.tripId,
        adoptedRouteId: route.id,
        serviceClass: { not: null },
        OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: input.now } }],
      },
      include: { _count: { select: { observations: true } } },
      orderBy: [{ legIndex: 'asc' }, { id: 'asc' }],
    });
    const edges = await this.client.transportEdge.findMany({
      where: {
        id: { in: rows.map((row) => row.transportEdgeId) },
        tripId: route.tripId,
        adoptedRouteId: route.id,
        source: 'ADOPTED_ROUTE',
        adoptedRoute: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    const current = new Set(edges.map((edge) => edge.id));
    return rows
      .filter(
        (row) =>
          current.has(row.transportEdgeId) &&
          isWithinMonitoringWindow(parseBaseline(row), input.now),
      )
      .map((row) => ({
        ownerUserId: capability.ownerUserId,
        leg: toRecord(row, true),
      }));
  }

  async recordDerivedLocationTransition(
    input: Parameters<
      GroundTransitRepository['recordDerivedLocationTransition']
    >[0],
  ): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await transaction.$queryRaw<readonly { id: string }[]>`
        SELECT "id" FROM "Trip" WHERE "id"=${input.tripId}::uuid
          AND "ownerUserId"=${input.ownerUserId}::uuid FOR UPDATE`;
      if (trip.length === 0) return;
      const capability = await transaction.tripAssistanceCapability.findUnique({
        where: {
          tripId_kind: { tripId: input.tripId, kind: 'LOCATION_ASSISTANCE' },
        },
        select: { state: true, revision: true },
      });
      if (
        capability?.state !== 'ENABLED' ||
        capability.revision !== input.expectedLocationCapabilityRevision
      )
        return;
      const edges = await transaction.transportEdge.findMany({
        where: {
          tripId: input.tripId,
          source: 'ADOPTED_ROUTE',
          adoptedRoute: { status: 'ACTIVE' },
          OR: [{ fromNodeId: input.nodeId }, { toNodeId: input.nodeId }],
        },
        select: { id: true, fromNodeId: true, toNodeId: true },
      });
      for (const edge of edges) {
        const leg = await transaction.groundTransitLegExecution.findUnique({
          where: { transportEdgeId: edge.id },
          select: { id: true, state: true },
        });
        if (leg === null) continue;
        const next =
          edge.toNodeId === input.nodeId && input.transition === 'ARRIVAL'
            ? 'ARRIVED_PENDING_HANDOFF'
            : edge.toNodeId === input.nodeId &&
                input.transition === 'DEPARTURE' &&
                leg.state === 'ARRIVED_PENDING_HANDOFF'
              ? 'COMPLETED'
              : edge.fromNodeId === input.nodeId &&
                  input.transition === 'DEPARTURE' &&
                  leg.state === 'PENDING'
                ? 'IN_PROGRESS'
                : null;
        if (next !== null) {
          await transaction.groundTransitLegExecution.update({
            where: { id: leg.id },
            data: { state: next },
          });
          await transaction.groundTransitStateTransition.create({
            data: {
              legExecutionId: leg.id,
              fromState: leg.state,
              toState: next,
              source: 'LOCATION_ASSISTANCE',
              evidenceRef: `node:${input.nodeId}`,
              occurredAt: input.observedAt,
            },
          });
        }
      }
    });
  }
}

interface OperationalContext {
  readonly previousObservation: GroundTransitObservation | null;
  readonly availableAtBoarding: Date | null;
  readonly actualServiceDeparture: Date | null;
  readonly downstreamProtectedDeparture: Date | null;
}

async function operationalContext(
  client: PrismaClient | Transaction,
  row: LegRow,
): Promise<OperationalContext> {
  const previous =
    row.latestFetchedAt === null
      ? null
      : await client.groundTransitObservation.findFirst({
          where: {
            legExecutionId: row.id,
            fetchedAt: { lt: row.latestFetchedAt },
          },
          orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
          select: { facts: true },
        });
  const edge = await client.transportEdge.findUnique({
    where: { id: row.transportEdgeId },
    select: { fromNodeId: true, toNodeId: true },
  });
  if (edge === null)
    return {
      previousObservation: parseObservation(previous?.facts ?? null),
      availableAtBoarding: null,
      actualServiceDeparture: null,
      downstreamProtectedDeparture: null,
    };
  const [boarding, departure, downstream] = await Promise.all([
    client.temporalValue.findFirst({
      where: { nodeId: edge.fromNodeId, pointKind: 'ARRIVAL', layer: 'ACTUAL' },
      select: { instant: true },
    }),
    client.temporalValue.findFirst({
      where: {
        transportEdgeId: row.transportEdgeId,
        pointKind: 'DEPARTURE',
        layer: 'ACTUAL',
      },
      select: { instant: true },
    }),
    client.transportEdge.findFirst({
      where: {
        tripId: row.tripId,
        fromNodeId: edge.toNodeId,
        fixedService: true,
      },
      include: { temporalValues: true },
    }),
  ]);
  const protectedDeparture =
    downstream === null
      ? null
      : ((['ACTUAL', 'ESTIMATED', 'PLANNED'] as const)
          .map(
            (layer) =>
              downstream.temporalValues.find(
                (value) =>
                  value.layer === layer && value.pointKind === 'DEPARTURE',
              )?.instant ?? null,
          )
          .find((value) => value !== null) ?? null);
  return {
    previousObservation: parseObservation(previous?.facts ?? null),
    availableAtBoarding: boarding?.instant ?? null,
    actualServiceDeparture: departure?.instant ?? null,
    downstreamProtectedDeparture: protectedDeparture,
  };
}

function toRecord(
  row: LegRow,
  current: boolean,
  context?: OperationalContext,
): GroundTransitLegRecord {
  return {
    id: row.id,
    tripId: row.tripId,
    transportEdgeId: row.transportEdgeId,
    adoptedRouteId: row.adoptedRouteId,
    legIndex: row.legIndex,
    provider: row.provider,
    mode: row.mode as 'RAIL' | 'BUS',
    serviceClass: row.serviceClass,
    serviceIdentityKey: row.serviceIdentityKey,
    baseline: parseBaseline(row),
    state: row.state,
    latestObservation: parseObservation(row.latestObservation),
    attentionState: parseAttentionState(row.latestObservation),
    latestFetchedAt: row.latestFetchedAt,
    observationCount: row._count.observations,
    current,
    previousObservation: context?.previousObservation ?? null,
    availableAtBoarding: context?.availableAtBoarding ?? null,
    actualServiceDeparture: context?.actualServiceDeparture ?? null,
    downstreamProtectedDeparture: context?.downstreamProtectedDeparture ?? null,
    deviationCount: row.deviationCount,
    deviationStartedAt: row.deviationStartedAt,
  };
}

function unknownLegacyRecord(
  tripId: string,
  edge: {
    readonly id: string;
    readonly adoptedRouteId: string | null;
    readonly provider: string | null;
    readonly mode: string;
  },
): GroundTransitLegRecord {
  return {
    id: edge.id,
    tripId,
    transportEdgeId: edge.id,
    adoptedRouteId: edge.adoptedRouteId!,
    legIndex: 0,
    provider: edge.provider ?? 'UNKNOWN',
    mode: edge.mode as 'RAIL' | 'BUS',
    serviceClass: null,
    serviceIdentityKey: null,
    baseline: null,
    state: 'UNKNOWN',
    latestObservation: null,
    latestFetchedAt: null,
    observationCount: 0,
    current: true,
    deviationCount: 0,
    deviationStartedAt: null,
  };
}

function parseBaseline(
  row: GroundTransitLegExecution,
): GroundTransitBaseline | null {
  if (row.serviceClass === null) return null;
  const value = row.baseline as Record<string, unknown>;
  if (value.schemaVersion !== 'ground-transit-baseline-v1') return null;
  return {
    provider: row.provider,
    mode: row.mode as 'RAIL' | 'BUS',
    serviceClass: row.serviceClass,
    serviceIdentityKey: row.serviceIdentityKey,
    lineRef: stringOrNull(value.lineRef),
    directionRef: stringOrNull(value.directionRef),
    boardingHubRef: stringOrNull(value.boardingHubRef),
    alightingHubRef: stringOrNull(value.alightingHubRef),
    headwayMinSeconds: numberOrNull(value.headwayMinSeconds),
    headwayMaxSeconds: numberOrNull(value.headwayMaxSeconds),
    minimumTransferSeconds: numberOrNull(value.minimumTransferSeconds),
    boardingAccessMinimumSeconds: numberOrNull(
      value.boardingAccessMinimumSeconds,
    ),
    hasOnwardConnection: value.hasOnwardConnection === true,
    plannedDeparture: dateOrNull(value.plannedDeparture),
    plannedArrival: dateOrNull(value.plannedArrival),
  };
}

function parseObservation(
  value: Prisma.JsonValue | null,
): GroundTransitObservation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const item = value as Record<string, unknown>;
  return {
    provider: String(item.provider),
    observationIdentity: String(item.observationIdentity),
    fetchedAt: new Date(String(item.fetchedAt)),
    serviceClass: item.serviceClass as GroundTransitObservation['serviceClass'],
    mode: item.mode as GroundTransitObservation['mode'],
    lineRef: stringOrNull(item.lineRef),
    lineName: stringOrNull(item.lineName),
    directionRef: stringOrNull(item.directionRef),
    directionLabel: stringOrNull(item.directionLabel),
    boardingHubRef: stringOrNull(item.boardingHubRef),
    alightingHubRef: stringOrNull(item.alightingHubRef),
    serviceIdentityKey: stringOrNull(item.serviceIdentityKey),
    scheduledDeparture: dateOrNull(item.scheduledDeparture),
    scheduledArrival: dateOrNull(item.scheduledArrival),
    estimatedDeparture: dateOrNull(item.estimatedDeparture),
    estimatedArrival: dateOrNull(item.estimatedArrival),
    actualDeparture: dateOrNull(item.actualDeparture),
    actualArrival: dateOrNull(item.actualArrival),
    departurePlatform: stringOrNull(item.departurePlatform),
    arrivalPlatform: stringOrNull(item.arrivalPlatform),
    serviceStatus:
      item.serviceStatus as GroundTransitObservation['serviceStatus'],
    boardingTargetServiceability: targetServiceability(
      item.boardingTargetServiceability,
    ),
    alightingTargetServiceability: targetServiceability(
      item.alightingTargetServiceability,
    ),
    currentTerminusRef: stringOrNull(item.currentTerminusRef),
    currentTerminusLabel: stringOrNull(item.currentTerminusLabel),
    operatingFromHubRef: stringOrNull(item.operatingFromHubRef),
    operatingToHubRef: stringOrNull(item.operatingToHubRef),
    headwayMinSeconds: numberOrNull(item.headwayMinSeconds),
    headwayMaxSeconds: numberOrNull(item.headwayMaxSeconds),
    nextDepartureInSeconds: numberOrNull(item.nextDepartureInSeconds),
    minimumTransferSeconds: numberOrNull(item.minimumTransferSeconds),
  };
}

function parseAttentionState(
  value: Prisma.JsonValue | null,
): GroundTransitAttentionState | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const marker = (value as Record<string, unknown>).__groundTransitAttention;
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker))
    return null;
  const item = marker as Record<string, unknown>;
  const platform = (value: unknown): value is string | null =>
    value === null || typeof value === 'string';
  if (
    !platform(item.departurePlatformReference) ||
    !platform(item.arrivalPlatformReference) ||
    !platform(item.presentedDeparturePlatform) ||
    !platform(item.presentedArrivalPlatform) ||
    typeof item.presentedEarlyDeparture !== 'boolean' ||
    !Number.isSafeInteger(item.presentedDelayBand) ||
    (item.presentedDelayBand as number) < 0
  )
    return null;
  return item as unknown as GroundTransitAttentionState;
}

async function markAttentionPresented(
  transaction: Transaction,
  leg: { readonly id: string; readonly latestObservation: Prisma.JsonValue },
  assessment: GroundTransitOperationalAssessment,
): Promise<void> {
  if (assessment.attentionActivationKinds.length === 0) return;
  const state = parseAttentionState(leg.latestObservation);
  const observation = parseObservation(leg.latestObservation);
  if (state === null || observation === null)
    throw new Error('Ground transit attention watermark is unavailable');
  const kinds = assessment.attentionActivationKinds;
  const raw = leg.latestObservation as Record<string, unknown>;
  const next: GroundTransitAttentionState = {
    ...state,
    presentedDeparturePlatform: kinds.includes('DEPARTURE_PLATFORM_CHANGED')
      ? observation.departurePlatform
      : state.presentedDeparturePlatform,
    presentedArrivalPlatform: kinds.includes('ARRIVAL_PLATFORM_CHANGED')
      ? observation.arrivalPlatform
      : state.presentedArrivalPlatform,
    presentedEarlyDeparture:
      kinds.includes('EARLY_DEPARTURE') || state.presentedEarlyDeparture,
    presentedDelayBand: kinds.includes('MATERIAL_DELAY')
      ? Math.max(state.presentedDelayBand, assessment.materialDelayBand)
      : state.presentedDelayBand,
  };
  await transaction.groundTransitLegExecution.update({
    where: { id: leg.id },
    data: {
      latestObservation: {
        ...raw,
        __groundTransitAttention: next,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

function serializableObservation(value: GroundTransitObservation) {
  return {
    provider: value.provider,
    observationIdentity: value.observationIdentity,
    fetchedAt: value.fetchedAt.toISOString(),
    serviceClass: value.serviceClass,
    mode: value.mode,
    lineRef: value.lineRef,
    lineName: value.lineName,
    directionRef: value.directionRef,
    directionLabel: value.directionLabel,
    boardingHubRef: value.boardingHubRef,
    alightingHubRef: value.alightingHubRef,
    serviceIdentityKey: value.serviceIdentityKey,
    scheduledDeparture: value.scheduledDeparture?.toISOString() ?? null,
    scheduledArrival: value.scheduledArrival?.toISOString() ?? null,
    estimatedDeparture: value.estimatedDeparture?.toISOString() ?? null,
    estimatedArrival: value.estimatedArrival?.toISOString() ?? null,
    actualDeparture: value.actualDeparture?.toISOString() ?? null,
    actualArrival: value.actualArrival?.toISOString() ?? null,
    departurePlatform: value.departurePlatform,
    arrivalPlatform: value.arrivalPlatform,
    serviceStatus: value.serviceStatus,
    // Keep the canonical hash of legacy observations unchanged. An absent
    // field and an explicit UNKNOWN/null convey the same normalized fact.
    ...(value.boardingTargetServiceability === 'SERVED' ||
    value.boardingTargetServiceability === 'NOT_SERVED'
      ? { boardingTargetServiceability: value.boardingTargetServiceability }
      : {}),
    ...(value.alightingTargetServiceability === 'SERVED' ||
    value.alightingTargetServiceability === 'NOT_SERVED'
      ? { alightingTargetServiceability: value.alightingTargetServiceability }
      : {}),
    ...(value.currentTerminusRef === null ||
    value.currentTerminusRef === undefined
      ? {}
      : { currentTerminusRef: value.currentTerminusRef }),
    ...(value.currentTerminusLabel === null ||
    value.currentTerminusLabel === undefined
      ? {}
      : { currentTerminusLabel: value.currentTerminusLabel }),
    ...(value.operatingFromHubRef === null ||
    value.operatingFromHubRef === undefined
      ? {}
      : { operatingFromHubRef: value.operatingFromHubRef }),
    ...(value.operatingToHubRef === null ||
    value.operatingToHubRef === undefined
      ? {}
      : { operatingToHubRef: value.operatingToHubRef }),
    headwayMinSeconds: value.headwayMinSeconds,
    headwayMaxSeconds: value.headwayMaxSeconds,
    nextDepartureInSeconds: value.nextDepartureInSeconds,
    minimumTransferSeconds: value.minimumTransferSeconds,
  };
}

async function writeFixedServiceTimes(
  transaction: Transaction,
  transportEdgeId: string,
  observation: GroundTransitObservation,
  observationId: string,
  now: Date,
): Promise<boolean> {
  let changed = false;
  const sourceRef = `ground-transit-observation:${observationId}`;
  for (const pointKind of ['DEPARTURE', 'ARRIVAL'] as const) {
    const instant =
      pointKind === 'DEPARTURE'
        ? (observation.actualDeparture ?? observation.estimatedDeparture)
        : (observation.actualArrival ?? observation.estimatedArrival);
    if (instant === null) {
      const removed = await transaction.temporalValue.deleteMany({
        where: {
          transportEdgeId,
          pointKind,
          layer: 'ESTIMATED',
          sourceKind: 'PROVIDER_OBSERVATION',
        },
      });
      changed ||= removed.count > 0;
      continue;
    }
    const existingActual = await transaction.temporalValue.findUnique({
      where: {
        transportEdgeId_pointKind_layer: {
          transportEdgeId,
          pointKind,
          layer: 'ACTUAL',
        },
      },
    });
    if (existingActual !== null) continue;
    const actual =
      pointKind === 'DEPARTURE'
        ? observation.actualDeparture
        : observation.actualArrival;
    const layer = actual === null ? 'ESTIMATED' : 'ACTUAL';
    const current = await transaction.temporalValue.findUnique({
      where: {
        transportEdgeId_pointKind_layer: { transportEdgeId, pointKind, layer },
      },
    });
    if (
      current !== null &&
      current.instant.getTime() === instant.getTime() &&
      current.sourceKind === 'PROVIDER_OBSERVATION'
    ) {
      continue;
    }
    await transaction.temporalValue.upsert({
      where: {
        transportEdgeId_pointKind_layer: { transportEdgeId, pointKind, layer },
      },
      create: {
        transportEdgeId,
        pointKind,
        layer,
        instant,
        timeZone: 'Etc/UTC',
        sourceKind: 'PROVIDER_OBSERVATION',
        sourceRef,
        observedAt: observation.fetchedAt,
        createdAt: now,
      },
      update: {
        instant,
        timeZone: 'Etc/UTC',
        sourceKind: 'PROVIDER_OBSERVATION',
        sourceRef,
        observedAt: observation.fetchedAt,
      },
    });
    changed = true;
  }
  return changed;
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function targetServiceability(
  value: unknown,
): 'SERVED' | 'NOT_SERVED' | 'UNKNOWN' {
  return value === 'SERVED' || value === 'NOT_SERVED' ? value : 'UNKNOWN';
}

function operationalSummary(
  kinds: readonly GroundTransitChangeKind[],
  action: 'NONE' | 'ROUTE_REEVALUATION_REQUIRED',
  downstream: boolean,
  observation: GroundTransitObservation | null,
): string {
  const labels: Partial<Record<GroundTransitChangeKind, string>> = {
    SERVICE_CANCELLED: '班次已取消',
    EARLY_DEPARTURE: '发车时间提前',
    MATERIAL_DELAY: '预计到达明显延后',
    DEPARTURE_PLATFORM_CHANGED: observation?.departurePlatform
      ? `当前上车站台已变更为 ${observation.departurePlatform.slice(0, 80)}`
      : '上车站台已变化',
    ARRIVAL_PLATFORM_CHANGED: observation?.arrivalPlatform
      ? `当前到站站台已变更为 ${observation.arrivalPlatform.slice(0, 80)}`
      : '到站站台已变化',
    BOARDING_TARGET_NO_LONGER_SERVED: '原上车站不再停靠',
    ALIGHTING_TARGET_NO_LONGER_SERVED: '原下车站不再停靠',
    SERVICE_SHORT_TURNED: '班次运行区间缩短',
    TERMINUS_CHANGED: '班次终点已变化',
    DOWNSTREAM_PROTECTED_CONNECTION_AT_RISK: '后续固定衔接出现风险',
    SERVICE_RESTORED: '原班次已恢复运行',
  };
  return [
    ...kinds.map((kind) => labels[kind] ?? kind),
    ...(downstream ? ['可能影响后续已安排项目'] : []),
    ...(action === 'ROUTE_REEVALUATION_REQUIRED'
      ? ['当前路线需要重新规划']
      : []),
  ]
    .join('；')
    .slice(0, 500);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}
function isWithinMonitoringWindow(
  baseline: GroundTransitBaseline | null,
  now: Date,
): boolean {
  if (
    baseline?.plannedDeparture === null ||
    baseline?.plannedArrival === null ||
    baseline === null
  )
    return false;
  return (
    now.getTime() >=
      baseline.plannedDeparture.getTime() -
        GROUND_TRANSIT_POLICY.monitorLeadMs &&
    now.getTime() <=
      baseline.plannedArrival.getTime() + GROUND_TRANSIT_POLICY.monitorTailMs
  );
}
async function lockOwner(transaction: Transaction, ownerUserId: string) {
  await transaction.$queryRaw`
    SELECT true FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 2))`;
}

/** Shared accepted-leg hydration for locked external execution confirmation. */
export async function readExternalOriginGroundLeg(
  client: PrismaClient | Transaction,
  tripId: string,
  transportEdgeId: string,
): Promise<GroundTransitLegRecord | null> {
  const row = await client.groundTransitLegExecution.findFirst({
    where: { tripId, transportEdgeId },
    include: { _count: { select: { observations: true } } },
  });
  if (row === null) return null;
  const edge = await client.transportEdge.findFirst({
    where: {
      id: transportEdgeId,
      tripId,
      source: 'ADOPTED_ROUTE',
      adoptedRouteId: row.adoptedRouteId,
      adoptedRoute: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
  return toRecord(row, edge !== null, await operationalContext(client, row));
}
