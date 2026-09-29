import { randomUUID } from 'node:crypto';

/** Synthetic-only P5E2 cross-layer check inside verify-compose's isolated project. */
export async function verifyGroundTransitChain({
  apiJson,
  composeQuiet,
  waitFor,
  databaseUser,
  databaseName,
}) {
  const sql = async (query) =>
    (
      await composeQuiet(
        'exec',
        '--no-TTY',
        'postgres',
        'psql',
        '-tA',
        '-U',
        databaseUser,
        '-d',
        databaseName,
        '-c',
        query,
      )
    ).trim();
  const departure = new Date(Date.now() + 8 * 60_000);
  const date = departure.toISOString().slice(0, 10);
  let trip = await apiJson('/trips', 'POST', {
    name: 'SYNTHETIC P5E2 ground execution',
    planningAnchorDate: date,
    defaultPeopleCount: 1,
  });
  trip = await apiJson(`/trips/${trip.id}/commands`, 'POST', {
    baseTripVersion: trip.version,
    command: {
      type: 'ADD_PLACE_VISIT',
      targetDay: { type: 'NEW', localDate: date, sequence: 0 },
      position: 0,
      place: {
        type: 'CUSTOM',
        name: 'SYNTHETIC_P5E2_GROUND_ORIGIN',
        latitude: 35.6762,
        longitude: 139.6503,
      },
    },
  });
  trip = await apiJson(`/trips/${trip.id}/commands`, 'POST', {
    baseTripVersion: trip.version,
    command: {
      type: 'ADD_PLACE_VISIT',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: trip.days[0].dayOccurrenceId,
      },
      position: 1,
      place: {
        type: 'CUSTOM',
        name: 'SYNTHETIC_P5E2_GROUND_DESTINATION',
        latitude: 35.6895,
        longitude: 139.6917,
      },
    },
  });
  const [from, to] = trip.days[0].nodes;
  const query = await apiJson(`/trips/${trip.id}/routes/query`, 'POST', {
    basisVersion: trip.version,
    fromNodeId: from.id,
    toNodeId: to.id,
    hint: {
      type: 'DEPART_AT',
      instant: departure.toISOString(),
      timeZone: 'Asia/Tokyo',
    },
  });
  if (query.candidates.length !== 1 || query.candidates[0].legs.length !== 2)
    throw new Error('P5E2 synthetic route did not normalize two ground legs');
  const preview = await apiJson(`/trips/${trip.id}/previews`, 'POST', {
    basisVersion: trip.version,
    candidateSnapshotId: query.candidates[0].candidateSnapshotId,
  });
  if (!preview.adoptable)
    throw new Error('P5E2 synthetic Preview is not adoptable');
  const adopted = await apiJson(
    `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
    'POST',
    { baseTripVersion: trip.version, idempotencyKey: randomUUID() },
  );
  const initial = await apiJson(
    `/trips/${trip.id}/execution/ground-transit`,
    'GET',
  );
  if (
    initial.legs.length !== 2 ||
    initial.legs.some(
      (leg) =>
        !leg.current || leg.baseline === null || leg.observationCount !== 0,
    )
  )
    throw new Error('P5E2 Adopt did not freeze both ground leg baselines');
  if (
    !initial.legs.some((leg) => leg.serviceClass === 'HIGH_FREQUENCY') ||
    !initial.legs.some((leg) => leg.serviceClass === 'FIXED_SERVICE')
  )
    throw new Error('P5E2 service classes were not preserved');

  for (const kind of [
    'LOCATION_ASSISTANCE',
    'AUTO_RECORD',
    'GROUND_TRANSIT_MONITORING',
  ]) {
    await apiJson(`/trips/${trip.id}/assistance/${kind}`, 'POST', {
      action: 'ENABLE',
      baseCapabilityRevision: 0,
      idempotencyKey: randomUUID(),
    });
  }
  const arrival = await apiJson(
    `/trips/${trip.id}/execution/location`,
    'POST',
    {
      latitude: 35.67620011,
      longitude: 139.65030013,
      accuracyMeters: 10,
      observedAt: new Date().toISOString(),
    },
  );
  if (arrival.status !== 'CONFIRMED_ARRIVAL' || !arrival.recorded)
    throw new Error('P5E2 reliable location did not record origin arrival');
  const riskCount = await sql(
    `SELECT count(*) FROM "ExecutionRisk" WHERE "tripId"='${trip.id}' AND "sourceTransportEdgeId"='${highFrequencyEdge(initial)}' AND "status"='OPEN';`,
  );
  if (Number(riskCount) < 1)
    throw new Error(
      'P5E2 headway/transfer minimum did not enter existing ExecutionRisk',
    );
  const reminderCount = await sql(
    `SELECT count(*) FROM "NotificationEvent" WHERE "tripId"='${trip.id}' AND "kind"='EXECUTION_RISK' AND "presentationActive"=TRUE;`,
  );
  if (Number(reminderCount) !== 1)
    throw new Error('P5E2 risk did not produce one active presentation');
  await waitFor(
    'P5E2 durable ground monitor retry and accepted observations',
    async () => {
      const evidence = await sql(
        `SELECT (SELECT count(*) FROM "Job" WHERE "type"='GROUND_TRANSIT_MONITOR' AND "payloadRef"='${adopted.operationReceipt.adoptedRouteId}' AND "attempts">=2) || ':' || (SELECT count(*) FROM "GroundTransitObservation" o JOIN "GroundTransitLegExecution" l ON l."id"=o."legExecutionId" WHERE l."tripId"='${trip.id}');`,
      );
      const [retried, observed] = evidence.split(':').map(Number);
      return retried >= 1 && observed >= 2;
    },
    120_000,
  );
  const afterWorker = await apiJson(
    `/trips/${trip.id}/execution/ground-transit`,
    'GET',
  );
  if (afterWorker.legs.some((leg) => leg.observationCount < 1))
    throw new Error(
      'P5E2 worker failed to record both normalized observations',
    );
  const high = afterWorker.legs.find(
    (leg) => leg.serviceClass === 'HIGH_FREQUENCY',
  );
  if (
    high.safety.headwayWaitReserveSeconds !== 300 ||
    high.safety.transferMinimumSeconds !== 300 ||
    high.safety.totalSystemMinimumSeconds !== 600
  )
    throw new Error(
      'P5E2 3–5 minute headway + transfer safety was not applied',
    );
  const refreshed = await apiJson(
    `/trips/${trip.id}/execution/ground-transit/${high.transportEdgeId}/refresh`,
    'POST',
    {},
  );
  if (
    refreshed.status !== 'APPLIED' ||
    refreshed.leg.safety.headwayWaitReserveSeconds !== 120 ||
    refreshed.leg.safety.totalSystemMinimumSeconds !== 420
  )
    throw new Error(
      'P5E2 fresh next-departure did not replace the 5-minute reserve',
    );
  const remainingRiskCount = await sql(
    `SELECT count(*) FROM "ExecutionRisk" WHERE "tripId"='${trip.id}' AND "sourceTransportEdgeId"='${high.transportEdgeId}' AND "status"='OPEN';`,
  );
  if (remainingRiskCount !== '0')
    throw new Error('P5E2 fresh realtime reserve did not resolve the old risk');
  const sourceFacts = await sql(
    `SELECT count(*) FROM "TemporalValue" WHERE "transportEdgeId"='${high.transportEdgeId}' AND "sourceKind"='PROVIDER_OBSERVATION';`,
  );
  if (sourceFacts !== '0')
    throw new Error(
      'P5E2 high-frequency next departure was misrepresented as a selected ACTUAL service',
    );
  const historyCount = await sql(
    `SELECT count(*) FROM "GroundTransitStateTransition" s JOIN "GroundTransitLegExecution" l ON l."id"=s."legExecutionId" WHERE l."tripId"='${trip.id}';`,
  );
  if (Number(historyCount) < 2)
    throw new Error('P5E2 initial state history was not retained');
  return {
    tripId: trip.id,
    legCount: initial.legs.length,
    durableRetry: true,
    riskCount: Number(riskCount),
    headwayReserveSeconds: high.safety.headwayWaitReserveSeconds,
    realtimeReserveSeconds: refreshed.leg.safety.headwayWaitReserveSeconds,
  };
}

function highFrequencyEdge(result) {
  return result.legs.find((leg) => leg.serviceClass === 'HIGH_FREQUENCY')
    ?.transportEdgeId;
}
