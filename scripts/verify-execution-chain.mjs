import { randomUUID } from 'node:crypto';

/** Real HTTP, PostgreSQL and Worker acceptance in the isolated Compose project. */
export async function verifyExecutionChain({
  baseUrl,
  adminCredential,
  composeQuiet,
  waitFor,
  databaseUser,
  databaseName,
  scheduledUtc,
}) {
  const email = 'synthetic-compose-execution@synthetic.example.test';
  const request = async (credential, path, method = 'GET', body) => {
    const response = await fetch(`${baseUrl}${path}`, {
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
    if (!response.ok) {
      throw new Error(
        `F-09 ${method} ${path}: ${response.status} ${payload?.error?.code ?? 'UNKNOWN'}`,
      );
    }
    return payload;
  };
  const sql = async (statement) =>
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
        statement,
      )
    ).trim();
  await request(adminCredential, '/admin/invitations', 'POST', { email });
  await request(null, '/auth/magic-link/request', 'POST', { email });
  let token;
  await waitFor('F-09 real Worker magic-link delivery', async () => {
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
  const credential = session.credential;
  if (typeof credential !== 'string')
    throw new Error('F-09 session credential missing');
  const me = await request(credential, '/me');
  if (me.email !== email) throw new Error('F-09 owner identity mismatch');

  const serviceDate = scheduledUtc.slice(0, 10);
  let trip = await request(credential, '/trips', 'POST', {
    name: 'SYNTHETIC F-09 execution chain',
    planningAnchorDate: serviceDate,
    defaultPeopleCount: 1,
  });
  const places = [
    { name: 'SYNTHETIC HND airport', latitude: 35.5494, longitude: 139.7798 },
    { name: 'SYNTHETIC CTS airport', latitude: 42.793, longitude: 141.666 },
    {
      name: 'SYNTHETIC protected connection',
      latitude: 42.8,
      longitude: 141.68,
    },
  ];
  for (const [index, place] of places.entries()) {
    trip = await request(credential, `/trips/${trip.id}/commands`, 'POST', {
      baseTripVersion: trip.version,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay:
          index === 0
            ? { type: 'NEW', localDate: serviceDate, sequence: 0 }
            : {
                type: 'EXISTING',
                dayOccurrenceId: trip.days[0].dayOccurrenceId,
              },
        position: index,
        place: { type: 'CUSTOM', ...place },
      },
    });
  }
  const [airport, arrival, onward] = trip.days[0].nodes;
  const setEdge = async (fromNodeId, toNodeId, mode, fixedService) => {
    trip = await request(credential, `/trips/${trip.id}/commands`, 'POST', {
      baseTripVersion: trip.version,
      command: {
        type: 'SET_MANUAL_TRANSPORT',
        fromNodeId,
        toNodeId,
        mode,
        fixedService,
      },
    });
  };
  // Keep the synthetic flight leg outside P5D1's fixed-service target list so
  // the nearest protected execution target is the downstream rail connection.
  await setEdge(airport.id, arrival.id, 'FLIGHT', false);
  await setEdge(arrival.id, onward.id, 'RAIL', true);
  const flightEdge = trip.connections.find(
    (connection) => connection.fromNodeId === airport.id,
  )?.transport;
  const railEdge = trip.connections.find(
    (connection) => connection.fromNodeId === arrival.id,
  )?.transport;
  if (!flightEdge?.id || !railEdge?.id)
    throw new Error('F-09 transport setup failed');
  const search = await request(credential, '/flights/search', 'POST', {
    flightNumber: 'SY53',
    date: serviceDate,
  });
  const candidate = search.flights?.[0];
  if (candidate?.rawStatus !== 'SYNTHETIC_CI_ONLY')
    throw new Error('F-09 synthetic provider boundary missing');
  const adopted = await request(
    credential,
    `/trips/${trip.id}/flights/adopt`,
    'POST',
    {
      baseTripVersion: trip.version,
      transportEdgeId: flightEdge.id,
      flight: candidate,
    },
  );
  trip = await request(credential, `/trips/${trip.id}`);
  const bindingId = adopted.flightBinding.id;
  // The untouched plan has a 50-minute connection; the synthetic +45-minute
  // arrival revision leaves five minutes and makes the downstream risk new.
  const protectedDeparture = new Date(
    new Date(scheduledUtc).getTime() + 2 * 60 * 60_000 + 50 * 60_000,
  ).toISOString();
  trip = await request(
    credential,
    `/trips/${trip.id}/temporal-values`,
    'POST',
    {
      baseTripVersion: trip.version,
      subject: { type: 'TRANSPORT', transportEdgeId: railEdge.id },
      value: {
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: protectedDeparture,
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    },
  );
  const enable = async (path) =>
    request(credential, path, 'POST', {
      action: 'ENABLE',
      baseCapabilityRevision: 0,
      idempotencyKey: randomUUID(),
    });
  await enable(`/trips/${trip.id}/assistance/LOCATION_ASSISTANCE`);
  await enable(`/trips/${trip.id}/assistance/AUTO_RECORD`);
  await enable(`/trips/${trip.id}/flights/${bindingId}/assistance`);
  const forbidden = await fetch(`${baseUrl}/trips/${trip.id}`, {
    headers: { authorization: `Bearer ${adminCredential}` },
  });
  if (forbidden.status !== 404)
    throw new Error('F-09 ADMIN crossed owner boundary');

  const observation = {
    latitude: 35.5494,
    longitude: 139.7798,
    accuracyMeters: 10,
    observedAt: new Date().toISOString(),
  };
  const location = await request(
    credential,
    `/trips/${trip.id}/execution/location`,
    'POST',
    observation,
  );
  if (
    location.status !== 'CONFIRMED_ARRIVAL' ||
    location.evidence?.reliability !== 'SUFFICIENT' ||
    !location.recorded
  ) {
    throw new Error(
      'F-09 airport arrival lacked sufficient persisted evidence',
    );
  }
  if (!location.airportTriggerAttempted)
    throw new Error('F-09 airport trigger not attempted');
  const eventId = location.event.id;
  const eventEvidence = await sql(
    `SELECT "evidenceReliability" || ':' || "evidencePolicyVersion" FROM "ExecutionEvent" WHERE "id"='${eventId}';`,
  );
  if (eventEvidence !== 'SUFFICIENT:execution-location-v2')
    throw new Error('F-09 evidence not persisted');
  const actualCount = await sql(
    `SELECT count(*) FROM "TemporalValue" WHERE "nodeId"='${airport.id}' AND "layer"='ACTUAL' AND "pointKind"='ARRIVAL';`,
  );
  if (actualCount !== '1') throw new Error('F-09 ACTUAL arrival missing');

  await waitFor(
    'F-09 Worker enrollment of durable FLIGHT_MONITOR job',
    async () =>
      Number(
        await sql(
          `SELECT count(*) FROM "Job" WHERE "type"='FLIGHT_MONITOR' AND "payloadRef"='${bindingId}' AND "status"='QUEUED';`,
        ),
      ) > 0,
  );
  // Move one genuine scheduled job into the present in this isolated CI database.
  // The Worker still claims, retries and completes the durable Job normally.
  await sql(
    `UPDATE "FlightMonitorState" SET "lastSuccessfulMonitorRefreshAt"=CURRENT_TIMESTAMP - INTERVAL '31 minutes' WHERE "flightBindingId"='${bindingId}';`,
  );
  await sql(
    `UPDATE "Job" SET "runAt"=CURRENT_TIMESTAMP WHERE "id"=(SELECT "id" FROM "Job" WHERE "type"='FLIGHT_MONITOR' AND "payloadRef"='${bindingId}' AND "status"='QUEUED' ORDER BY "runAt" ASC LIMIT 1);`,
  );
  await waitFor(
    'F-09 durable retry then accepted Worker observation',
    async () => {
      const result = await sql(
        `SELECT count(*) FROM "Job" WHERE "type"='FLIGHT_MONITOR' AND "payloadRef"='${bindingId}' AND "status"='SUCCEEDED' AND "attempts">=2;`,
      );
      return Number(result) > 0;
    },
  );
  const after = await request(
    credential,
    `/trips/${trip.id}/flights/${bindingId}/assistance`,
  );
  if (after.state !== 'ENABLED')
    throw new Error('F-09 monitoring stopped unexpectedly');
  const disposition = await sql(
    `SELECT "status" FROM "FlightBinding" WHERE "id"='${bindingId}';`,
  );
  if (disposition !== 'DELAYED')
    throw new Error('F-09 delayed observation not accepted');
  const riskCount = Number(
    await sql(
      `SELECT count(*) FROM "ExecutionRisk" WHERE "tripId"='${trip.id}' AND "sourceTransportEdgeId"='${flightEdge.id}' AND "resolvedAt" IS NULL;`,
    ),
  );
  if (riskCount < 1)
    throw new Error('F-09 downstream ExecutionRisk not created');
  const notificationRows = Number(
    await sql(
      `SELECT count(*) FROM "NotificationEvent" WHERE "ownerUserId"='${me.id}' AND "presentationGroupKey" LIKE 'flight-observation:${bindingId}:%';`,
    ),
  );
  const visible = await request(credential, '/notifications');
  const activeForBinding = visible.notifications.filter(
    (item) => item.flightBindingId === bindingId || item.tripId === trip.id,
  );
  if (
    notificationRows < 2 ||
    activeForBinding.length !== 1 ||
    !activeForBinding[0].hasDownstreamImpact
  ) {
    throw new Error(
      'F-09/F-12 expected separate internal facts and one active reminder',
    );
  }
  if (!activeForBinding[0].body.includes('后续已安排项目'))
    throw new Error('F-12 consequence clause missing');
  const replay = await request(
    credential,
    `/trips/${trip.id}/execution/location`,
    'POST',
    observation,
  );
  if (replay.status !== 'NO_CHANGE')
    throw new Error('F-09 location replay changed decision');
  if (
    (await sql(
      `SELECT count(*) FROM "ExecutionEvent" WHERE "id"='${eventId}' AND "undoneAt" IS NULL;`,
    )) !== '1'
  ) {
    throw new Error('F-09 location event replayed');
  }
  await sql(
    `UPDATE "Job" SET "runAt"=CURRENT_TIMESTAMP WHERE "id"=(SELECT "id" FROM "Job" WHERE "type"='FLIGHT_MONITOR' AND "payloadRef"='${bindingId}' AND "status"='QUEUED' ORDER BY "runAt" ASC LIMIT 1);`,
  );
  await waitFor(
    'F-09 idempotent provider observation replay',
    async () =>
      Number(
        await sql(
          `SELECT count(*) FROM "Job" WHERE "type"='FLIGHT_MONITOR' AND "payloadRef"='${bindingId}' AND "status"='SUCCEEDED';`,
        ),
      ) >= 2,
  );
  const remainingActive = Number(
    await sql(
      `SELECT count(*) FROM "NotificationEvent" WHERE "presentationGroupKey" LIKE 'flight-observation:${bindingId}:%' AND "presentationActive"=TRUE;`,
    ),
  );
  if (remainingActive !== 1)
    throw new Error('F-12 provider observation replay duplicated reminder');
  const rawEvidence = await sql(
    `SELECT count(*) FROM information_schema.columns WHERE table_name='ExecutionEvent' AND column_name IN ('latitude','longitude');`,
  );
  if (rawEvidence !== '0')
    throw new Error('F-09 raw coordinates persisted in evidence schema');
  process.stdout.write(
    'F-09 full chain passed: HTTP owner, PostgreSQL evidence/ACTUAL/risk, durable Worker retry, synthetic flight observation, one active reminder, replay isolation.\n',
  );
}
