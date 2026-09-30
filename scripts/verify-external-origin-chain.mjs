import { randomUUID } from 'node:crypto';
/** All confirmations are explicit synthetic HTTP actions. Monitoring never confirms. */
export async function verifyExternalOriginChain({
  apiJson: adminJson,
  apiPort,
  composeQuiet,
  waitFor,
  databaseUser,
  databaseName,
}) {
  const email = 'synthetic-compose-external-origin@synthetic.example.test';
  const request = async (credential, path, method, body) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
      method,
      headers: {
        ...(credential === null
          ? {}
          : { authorization: `Bearer ${credential}` }),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        `P5E2 5A ${method} ${path}: ${response.status} ${payload?.error?.code}`,
      );
    return payload;
  };
  await adminJson('/admin/invitations', 'POST', { email });
  await request(null, '/auth/magic-link/request', 'POST', { email });
  let token;
  await waitFor('P5E2 5A synthetic owner Worker delivery', async () => {
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
      .find((item) => item.recipient === email);
    token =
      message === undefined
        ? undefined
        : new URL(message.magicLink).hash.match(
            /^#token=([A-Za-z0-9_-]{40,100})$/u,
          )?.[1];
    return token !== undefined;
  });
  const session = await request(null, '/auth/magic-link/consume', 'POST', {
    token,
  });
  token = undefined;
  const apiJson = (path, method, body) =>
    request(session.credential, path, method, body);
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
  const assert = (value, message) => {
    if (!value) throw new Error(`P5E2 5A ${message}`);
  };
  const departure = new Date(Date.now() - 15 * 60_000);
  const zone = 'Asia/Tokyo';
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(departure);
  let trip = await apiJson('/trips', 'POST', {
    name: 'SYNTHETIC P5E2 external hub execution',
    planningAnchorDate: date,
    defaultPeopleCount: 1,
  });
  for (const [position, name] of [
    'SYNTHETIC EXTERNAL A',
    'SYNTHETIC_P5E2_EXTERNAL_DESTINATION',
  ].entries()) {
    trip = await apiJson(`/trips/${trip.id}/commands`, 'POST', {
      baseTripVersion: trip.version,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay:
          position === 0
            ? { type: 'NEW', localDate: date, sequence: 0 }
            : {
                type: 'EXISTING',
                dayOccurrenceId: trip.days[0].dayOccurrenceId,
              },
        position,
        place: {
          type: 'CUSTOM',
          name,
          latitude: 35.67 + position * 0.03,
          longitude: 139.65 + position * 0.03,
        },
      },
    });
  }
  const [a, d] = trip.days[0].nodes;
  const initial = await apiJson(`/trips/${trip.id}/routes/query`, 'POST', {
    basisVersion: trip.version,
    fromNodeId: a.id,
    toNodeId: d.id,
    hint: {
      type: 'DEPART_AT',
      instant: departure.toISOString(),
      timeZone: zone,
    },
  });
  const preview = await apiJson(`/trips/${trip.id}/previews`, 'POST', {
    basisVersion: trip.version,
    candidateSnapshotId: initial.candidates[0].candidateSnapshotId,
  });
  const adopted = await apiJson(
    `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
    'POST',
    { baseTripVersion: trip.version, idempotencyKey: randomUUID() },
  );
  trip = adopted.trip;
  const edgeId = trip.connections[0].transport.id;
  const base = `/trips/${trip.id}/execution/ground-transit/${edgeId}`;
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
    'P5E2 5A Worker accepted short-turn E',
    async () => {
      const execution = await apiJson(
        `/trips/${trip.id}/execution/ground-transit`,
        'GET',
      );
      return execution.legs.some(
        (leg) =>
          leg.transportEdgeId === edgeId &&
          leg.operational.changeKinds.includes('SERVICE_SHORT_TURNED'),
      );
    },
    120_000,
  );
  trip = await apiJson(`/trips/${trip.id}`, 'GET');
  const footprint = () =>
    sql(
      `SELECT jsonb_build_object('version',(SELECT "version" FROM "Trip" WHERE "id"='${trip.id}'),'nodes',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n."id") FROM "ItineraryNode" n WHERE n."tripId"='${trip.id}'),'places',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p."id") FROM "Place" p WHERE p."ownerUserId"=(SELECT "ownerUserId" FROM "Trip" WHERE "id"='${trip.id}')),'edges',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e."id") FROM "TransportEdge" e WHERE e."tripId"='${trip.id}'),'routes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r."id") FROM "AdoptedRoute" r WHERE r."tripId"='${trip.id}'),'snapshots',(SELECT count(*) FROM "RouteCandidateSnapshot" WHERE "tripId"='${trip.id}'),'previews',(SELECT count(*) FROM "RoutePreview" WHERE "tripId"='${trip.id}'));`,
    );
  const before = await footprint();
  const candidate = await apiJson(`${base}/external-origin`, 'GET');
  assert(
    candidate.availability === 'CONFIRMATION_REQUIRED' &&
      candidate.candidate?.providerHubRef === 'synthetic:short-terminus' &&
      candidate.candidate?.timeZone === 'Asia/Tokyo',
    'trusted E candidate missing',
  );
  assert((await footprint()) === before, 'candidate GET wrote planning data');
  assert(
    (await sql(
      `SELECT count(*) FROM "GroundTransitObservation" WHERE "legExecutionId" IN (SELECT "id" FROM "GroundTransitLegExecution" WHERE "transportEdgeId"='${edgeId}') AND "facts"->>'currentTerminusRef'='synthetic:short-terminus' AND "facts"->>'actualArrival' IS NOT NULL;`,
    )) === '1',
    'negative fixture requires accepted vehicle arrival at external terminus',
  );
  assert(
    (await sql(
      `SELECT count(*) FROM "ExternalExecutionOrigin" WHERE "tripId"='${trip.id}';`,
    )) === '0',
    'provider/resolver must never create user origin',
  );
  const handoffBefore = await apiJson(`${base}/route-reevaluation`, 'GET');
  assert(
    handoffBefore.query === null &&
      handoffBefore.readiness === 'ORIGIN_UNRESOLVED',
    'unconfirmed E enabled Query',
  );
  const result = await apiJson(`${base}/external-origin/confirm`, 'POST', {
    baseTripVersion: trip.version,
    candidateRef: candidate.candidate.candidateRef,
    idempotencyKey: randomUUID(),
  });
  assert(
    result.origin.status === 'ARRIVED' &&
      result.origin.currentness === 'CURRENT' &&
      result.resultingTripVersion === trip.version + 1,
    'manual E confirmation failed',
  );
  const after = JSON.parse(await footprint());
  const previous = JSON.parse(before);
  after.version = previous.version;
  assert(
    JSON.stringify(after) === JSON.stringify(previous),
    'confirmation mutated itinerary/Place/route/planning data',
  );
  const handoffAfter = await apiJson(`${base}/route-reevaluation`, 'GET');
  assert(
    handoffAfter.query === null &&
      handoffAfter.reasonCodes.includes(
        'EXTERNAL_ORIGIN_ROUTE_PLANNING_NOT_SUPPORTED',
      ),
    'confirmed E enabled external planning',
  );
  const departed = await apiJson(
    `/trips/${trip.id}/execution/external-origins/${result.origin.id}/depart`,
    'POST',
    {
      baseTripVersion: result.resultingTripVersion,
      idempotencyKey: randomUUID(),
    },
  );
  assert(
    departed.origin.status === 'DEPARTED' &&
      departed.origin.currentness === 'DEPARTED' &&
      departed.resultingTripVersion === trip.version + 2,
    'E departure lifecycle failed',
  );
  const final = JSON.parse(await footprint());
  final.version = previous.version;
  assert(
    JSON.stringify(final) === JSON.stringify(previous),
    'departure mutated itinerary/planning',
  );
  return {
    candidateReadOnly: true,
    providerArrivalCreatesOrigin: false,
    confirmation: 'ARRIVED',
    departure: 'DEPARTED',
    itineraryMutationCount: 0,
    placeMutationCount: 0,
    planningMutationCount: 0,
    externalRouteQuery: false,
    automaticQuery: false,
    automaticPreview: false,
    automaticAdopt: false,
  };
}
