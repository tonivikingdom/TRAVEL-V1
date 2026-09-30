import { randomUUID } from 'node:crypto';

/** Synthetic-only P5E2 cross-layer check inside verify-compose's isolated project. */
export async function verifyGroundTransitChain({
  apiJson,
  apiPort,
  composeQuiet,
  waitFor,
  databaseUser,
  databaseName,
  expectOperationalDisruption = false,
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
  const departure = new Date(Date.now() + 4 * 60_000);
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(departure);
  const datePart = (type) =>
    dateParts.find((part) => part.type === type)?.value;
  const date = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
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
      'P5E2 headway minimum did not enter existing ExecutionRisk',
    );
  const reminderCount = await sql(
    `SELECT count(*) FROM "NotificationEvent" n JOIN "ExecutionRisk" r ON n."dedupeKey" LIKE 'execution-risk:' || r."id"::text || ':%' WHERE r."tripId"='${trip.id}' AND r."sourceTransportEdgeId"='${highFrequencyEdge(initial)}' AND n."presentationActive"=TRUE;`,
  );
  if (Number(reminderCount) !== 1)
    throw new Error(
      `P5E2 ground risk did not produce one active presentation (count=${reminderCount})`,
    );
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
  if (expectOperationalDisruption) {
    const fixed = afterWorker.legs.find(
      (leg) => leg.serviceClass === 'FIXED_SERVICE',
    );
    if (
      fixed?.state !== 'NO_LONGER_FEASIBLE' ||
      fixed.operational.disposition !== 'CURRENT_PLAN_NO_LONGER_FEASIBLE' ||
      fixed.operational.requiredAction !== 'ROUTE_REEVALUATION_REQUIRED' ||
      !fixed.operational.changeKinds.includes('SERVICE_CANCELLED')
    ) {
      throw new Error(
        'P5E2 Batch 2 cancellation did not invalidate the adopted fixed service',
      );
    }
    const activePresentations = await sql(
      `SELECT count(*) FROM "NotificationEvent" WHERE "tripId"='${trip.id}' AND "presentationGroupKey" LIKE 'ground-transit-observation:${fixed.id}:%' AND "presentationActive"=TRUE AND "priority"='STRONG' AND "changeKinds" ? 'SERVICE_CANCELLED';`,
    );
    if (activePresentations !== '1')
      throw new Error(
        `P5E2 disruption did not aggregate into one STRONG presentation (${activePresentations})`,
      );
    const stableTopology = await sql(
      `SELECT (SELECT count(*) FROM "AdoptedRoute" WHERE "id"='${adopted.operationReceipt.adoptedRouteId}' AND "status"='ACTIVE') || ':' || (SELECT count(*) FROM "TransportEdge" WHERE "id"='${fixed.transportEdgeId}') || ':' || (SELECT count(*) FROM "RoutePreview" WHERE "tripId"='${trip.id}');`,
    );
    if (stableTopology !== '1:1:1')
      throw new Error(
        `P5E2 disruption changed the formal route topology (${stableTopology})`,
      );
    const replay = await apiJson(
      `/trips/${trip.id}/execution/ground-transit/${fixed.transportEdgeId}/refresh`,
      'POST',
      {},
    );
    if (
      replay.status !== 'APPLIED' ||
      replay.leg.operational.disposition !== 'CONTINUE_CURRENT_PLAN' ||
      !replay.leg.operational.changeKinds.includes('SERVICE_RESTORED')
    )
      throw new Error(
        'P5E2 trusted correction did not restore current assessment',
      );
    const residualRisk = await sql(
      `SELECT count(*) FROM "ExecutionRisk" WHERE "tripId"='${trip.id}' AND "sourceTransportEdgeId"='${fixed.transportEdgeId}' AND "status"='OPEN' AND "fingerprint" IN (SELECT "fingerprint" FROM "ExecutionRisk" WHERE "tripId"='${trip.id}' AND "kind"='PROTECTED_TIME_INFEASIBLE');`,
    );
    if (residualRisk !== '0')
      throw new Error(
        'P5E2 service recovery left the cancellation risk active',
      );
    const observations = await sql(
      `SELECT count(*) FROM "GroundTransitObservation" WHERE "legExecutionId"='${fixed.id}';`,
    );
    if (Number(observations) < 2)
      throw new Error('P5E2 recovery discarded prior observation history');
    const activeAfter = await sql(
      `SELECT count(*) FROM "NotificationEvent" WHERE "tripId"='${trip.id}' AND "presentationGroupKey" LIKE 'ground-transit-observation:${fixed.id}:%' AND "presentationActive"=TRUE;`,
    );
    if (activeAfter !== '1')
      throw new Error(
        'P5E2 recovery left stale operational presentations active',
      );
  }
  const high = afterWorker.legs.find(
    (leg) => leg.serviceClass === 'HIGH_FREQUENCY',
  );
  if (
    high.safety.boarding.headwayWaitReserveSeconds !== 300 ||
    high.safety.boarding.totalSystemMinimumSeconds !== 300 ||
    high.safety.transferToNext?.transferMinimumSeconds !== 300 ||
    high.safety.transferToNext?.totalSystemMinimumSeconds !== 300
  )
    throw new Error(
      'P5E2 headway and onward transfer boundaries were not separated',
    );
  const refreshed = await apiJson(
    `/trips/${trip.id}/execution/ground-transit/${high.transportEdgeId}/refresh`,
    'POST',
    {},
  );
  if (
    refreshed.status !== 'APPLIED' ||
    refreshed.leg.safety.boarding.headwayWaitReserveSeconds !== 120 ||
    refreshed.leg.safety.boarding.totalSystemMinimumSeconds !== 120 ||
    refreshed.leg.safety.transferToNext?.totalSystemMinimumSeconds !== 300
  )
    throw new Error(
      `P5E2 fresh next-departure did not replace the 5-minute reserve: ${JSON.stringify({ status: refreshed.status, freshness: refreshed.leg.safety.boarding.realtimeFreshness, boarding: refreshed.leg.safety.boarding.totalSystemMinimumSeconds, transfer: refreshed.leg.safety.transferToNext?.totalSystemMinimumSeconds })}`,
    );
  const remainingRiskCount = await sql(
    `SELECT count(*) FROM "ExecutionRisk" WHERE "tripId"='${trip.id}' AND "sourceTransportEdgeId"='${high.transportEdgeId}' AND "status"='OPEN';`,
  );
  if (remainingRiskCount !== '0')
    throw new Error('P5E2 fresh realtime reserve did not resolve the old risk');
  const refreshReplay = await apiJson(
    `/trips/${trip.id}/execution/ground-transit/${high.transportEdgeId}/refresh`,
    'POST',
    {},
  );
  if (refreshReplay.status !== 'IDEMPOTENT')
    throw new Error('P5E2 same provider observation was not idempotent');
  const persistedObservationCount = await sql(
    `SELECT count(*) FROM "GroundTransitObservation" WHERE "legExecutionId"='${high.id}';`,
  );
  if (Number(persistedObservationCount) !== high.observationCount + 1)
    throw new Error('P5E2 provider replay duplicated an observation');
  const activeGroundReminders = await sql(
    `SELECT count(*) FROM "NotificationEvent" n JOIN "ExecutionRisk" r ON n."dedupeKey" LIKE 'execution-risk:' || r."id"::text || ':%' WHERE r."tripId"='${trip.id}' AND r."sourceTransportEdgeId"='${high.transportEdgeId}' AND n."presentationActive"=TRUE;`,
  );
  if (activeGroundReminders !== reminderCount)
    throw new Error('P5E2 provider replay duplicated the ground reminder');

  await apiJson(`/trips/${trip.id}/execution/location`, 'POST', {
    latitude: 35.68,
    longitude: 139.661,
    accuracyMeters: 10,
    observedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  const departureDecision = await apiJson(
    `/trips/${trip.id}/execution/location`,
    'POST',
    {
      latitude: 35.6815,
      longitude: 139.668,
      accuracyMeters: 10,
      observedAt: new Date(Date.now() + 2_000).toISOString(),
    },
  );
  if (
    departureDecision.status !== 'CONFIRMED_DEPARTURE' ||
    !departureDecision.recorded
  )
    throw new Error('P5E2 reliable movement did not confirm origin departure');
  const inProgress = await apiJson(
    `/trips/${trip.id}/execution/ground-transit`,
    'GET',
  );
  if (
    inProgress.legs.find((leg) => leg.id === high.id)?.state !== 'IN_PROGRESS'
  )
    throw new Error('P5E2 departure context did not advance the ground leg');
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
  const handoffChain = expectOperationalDisruption
    ? await verifyHandoffReplacement({
        apiJson,
        apiPort,
        composeQuiet,
        sql,
        waitFor,
        date,
      })
    : null;
  return {
    tripId: trip.id,
    legCount: initial.legs.length,
    durableRetry: true,
    providerReplay: true,
    derivedInProgress: true,
    riskCount: Number(riskCount),
    headwayReserveSeconds: high.safety.boarding.headwayWaitReserveSeconds,
    realtimeReserveSeconds:
      refreshed.leg.safety.boarding.headwayWaitReserveSeconds,
    ...(handoffChain === null ? {} : { handoffChain }),
  };
}

async function verifyHandoffReplacement({
  apiJson: adminApiJson,
  apiPort,
  composeQuiet,
  sql,
  waitFor,
  date,
}) {
  const email = 'synthetic-compose-handoff@synthetic.example.test';
  await adminApiJson('/admin/invitations', 'POST', { email });
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const requested = await fetch(`${baseUrl}/auth/magic-link/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (requested.status !== 202)
    throw new Error('P5E2 handoff synthetic login request failed');
  let token;
  await waitFor(
    'P5E2 handoff synthetic Magic Link',
    async () => {
      const captured = await composeQuiet(
        'exec',
        '--no-TTY',
        'worker',
        'cat',
        '/tmp/travel-mail-capture/messages.ndjson',
      );
      const message = captured
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .reverse()
        .find((entry) => entry.recipient === email);
      token =
        message === undefined
          ? undefined
          : new URL(message.magicLink).hash.match(
              /^#token=([A-Za-z0-9_-]{40,100})$/u,
            )?.[1];
      return token !== undefined;
    },
    30_000,
  );
  const consumed = await fetch(`${baseUrl}/auth/magic-link/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  token = undefined;
  if (!consumed.ok)
    throw new Error('P5E2 handoff synthetic Magic Link consume failed');
  const credential = (await consumed.json()).credential;
  if (typeof credential !== 'string')
    throw new Error('P5E2 handoff synthetic session missing');
  const apiJson = async (pathname, method, body) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        `P5E2 handoff ${method} ${pathname} failed: ${response.status} ${payload?.error?.code ?? 'UNKNOWN'}`,
      );
    return payload;
  };
  let trip = await apiJson('/trips', 'POST', {
    name: 'SYNTHETIC P5E2 handoff replacement',
    planningAnchorDate: date,
    defaultPeopleCount: 1,
  });
  for (const [index, name] of [
    'SYNTHETIC_HANDOFF_FROM',
    'SYNTHETIC_P5E2_GROUND_DESTINATION',
  ].entries()) {
    trip = await apiJson(`/trips/${trip.id}/commands`, 'POST', {
      baseTripVersion: trip.version,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay:
          index === 0
            ? { type: 'NEW', localDate: date, sequence: 0 }
            : {
                type: 'EXISTING',
                dayOccurrenceId: trip.days[0].dayOccurrenceId,
              },
        position: index,
        place: {
          type: 'CUSTOM',
          name,
          latitude: index === 0 ? 35.6762 : 35.6895,
          longitude: index === 0 ? 139.6503 : 139.6917,
        },
      },
    });
  }
  const [from, to] = trip.days[0].nodes;
  const initialQuery = await apiJson(`/trips/${trip.id}/routes/query`, 'POST', {
    basisVersion: trip.version,
    fromNodeId: from.id,
    toNodeId: to.id,
    hint: {
      type: 'DEPART_AT',
      instant: new Date(Date.now() + 8 * 60_000).toISOString(),
      timeZone: 'Asia/Tokyo',
    },
  });
  const firstPreview = await apiJson(`/trips/${trip.id}/previews`, 'POST', {
    basisVersion: trip.version,
    candidateSnapshotId: initialQuery.candidates[0].candidateSnapshotId,
  });
  const firstAdopt = await apiJson(
    `/trips/${trip.id}/previews/${firstPreview.previewId}/adopt`,
    'POST',
    {
      baseTripVersion: trip.version,
      idempotencyKey: randomUUID(),
    },
  );
  const legs = await apiJson(
    `/trips/${trip.id}/execution/ground-transit`,
    'GET',
  );
  const fixed = legs.legs.find((leg) => leg.serviceClass === 'FIXED_SERVICE');
  if (!fixed) throw new Error('P5E2 handoff route lacks fixed service');
  await apiJson(
    `/trips/${trip.id}/assistance/GROUND_TRANSIT_MONITORING`,
    'POST',
    {
      action: 'ENABLE',
      baseCapabilityRevision: 0,
      idempotencyKey: randomUUID(),
    },
  );
  await waitFor(
    'P5E2 handoff worker cancellation',
    async () => {
      const current = await apiJson(
        `/trips/${trip.id}/execution/ground-transit`,
        'GET',
      );
      return (
        current.legs.find((leg) => leg.id === fixed.id)?.operational
          .requiredAction === 'ROUTE_REEVALUATION_REQUIRED'
      );
    },
    120_000,
  );
  const before = await sql(
    `SELECT (SELECT count(*) FROM "RouteCandidateSnapshot" WHERE "tripId"='${trip.id}') || ':' || (SELECT count(*) FROM "RoutePreview" WHERE "tripId"='${trip.id}') || ':' || (SELECT count(*) FROM "AdoptedRoute" WHERE "tripId"='${trip.id}' AND "status"='ACTIVE');`,
  );
  const handoff = await apiJson(
    `/trips/${trip.id}/execution/ground-transit/${fixed.transportEdgeId}/route-reevaluation`,
    'GET',
  );
  if (
    handoff.readiness !== 'READY' ||
    handoff.query?.fromNodeId !== from.id ||
    handoff.query?.toNodeId !== to.id ||
    handoff.query?.hint?.type !== 'DEPART_AT' ||
    handoff.query?.hint?.timeZone !== 'Asia/Tokyo'
  )
    throw new Error(
      `P5E2 handoff did not prepare the current route query: ${JSON.stringify(handoff)}`,
    );
  const after = await sql(
    `SELECT (SELECT count(*) FROM "RouteCandidateSnapshot" WHERE "tripId"='${trip.id}') || ':' || (SELECT count(*) FROM "RoutePreview" WHERE "tripId"='${trip.id}') || ':' || (SELECT count(*) FROM "AdoptedRoute" WHERE "tripId"='${trip.id}' AND "status"='ACTIVE');`,
  );
  if (before !== after)
    throw new Error(
      'P5E2 handoff automatically queried, previewed, or adopted',
    );
  const alternatives = await apiJson(
    `/trips/${trip.id}/routes/query`,
    'POST',
    handoff.query,
  );
  if (alternatives.candidates.length === 0)
    throw new Error('P5E2 explicit handoff Query returned no candidates');
  const nextPreview = await apiJson(`/trips/${trip.id}/previews`, 'POST', {
    basisVersion: handoff.query.basisVersion,
    candidateSnapshotId: alternatives.candidates[0].candidateSnapshotId,
  });
  if (!nextPreview.adoptable)
    throw new Error('P5E2 explicit replacement Preview is blocked');
  const beforeAdopt = await sql(
    `SELECT "status" FROM "AdoptedRoute" WHERE "id"='${firstAdopt.operationReceipt.adoptedRouteId}';`,
  );
  if (beforeAdopt !== 'ACTIVE')
    throw new Error('P5E2 Preview unexpectedly replaced the route');
  const replacement = await apiJson(
    `/trips/${trip.id}/previews/${nextPreview.previewId}/adopt`,
    'POST',
    {
      baseTripVersion: handoff.query.basisVersion,
      idempotencyKey: randomUUID(),
    },
  );
  const routeStates = await sql(
    `SELECT (SELECT "status" FROM "AdoptedRoute" WHERE "id"='${firstAdopt.operationReceipt.adoptedRouteId}') || ':' || (SELECT "status" FROM "AdoptedRoute" WHERE "id"='${replacement.operationReceipt.adoptedRouteId}');`,
  );
  if (routeStates !== 'REPLACED:ACTIVE')
    throw new Error(
      `P5E2 explicit replacement did not preserve lifecycle (${routeStates})`,
    );
  const oldHandoff = await apiJson(
    `/trips/${trip.id}/execution/ground-transit/${fixed.transportEdgeId}/route-reevaluation`,
    'GET',
  );
  if (oldHandoff.readiness === 'READY')
    throw new Error('P5E2 replaced route still offers READY handoff');
  return {
    tripId: trip.id,
    readiness: handoff.readiness,
    routeStates,
    automaticPlanning: false,
  };
}

function highFrequencyEdge(result) {
  return result.legs.find((leg) => leg.serviceClass === 'HIGH_FREQUENCY')
    ?.transportEdgeId;
}
