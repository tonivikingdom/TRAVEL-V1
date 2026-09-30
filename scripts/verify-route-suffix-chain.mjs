import { randomUUID } from 'node:crypto';

/** Explicit synthetic HTTP actions; never invoked by a monitoring/handoff policy. */
export async function verifyRouteSuffixChain({
  apiJson: adminJson,
  apiPort,
  composeQuiet,
  waitFor,
  databaseUser,
  databaseName,
}) {
  // The earlier ground scenario owns today's date for the admin. Use a real
  // invited synthetic owner so this execution fixture keeps its local date.
  const email = 'synthetic-compose-suffix@synthetic.example.test';
  const request = async (credential, pathname, method, body) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
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
        `P5E2 4A ${method} ${pathname}: ${response.status} ${payload?.error?.code ?? 'UNKNOWN'}`,
      );
    return payload;
  };
  await adminJson('/admin/invitations', 'POST', { email });
  await request(null, '/auth/magic-link/request', 'POST', { email });
  let token;
  await waitFor('P5E2 4A synthetic owner Worker delivery', async () => {
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
  if (typeof session.credential !== 'string')
    throw new Error('P5E2 4A synthetic owner session missing');
  const apiJson = (pathname, method, body) =>
    request(session.credential, pathname, method, body);
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
  const assert = (condition, message) => {
    if (!condition) throw new Error(`P5E2 4A ${message}`);
  };
  const zone = 'Asia/Tokyo';
  const departure = new Date(Date.now() - 15 * 60_000);
  const arrival = new Date(departure.getTime() + 30 * 60_000);
  const date = (instant) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  let trip = await apiJson('/trips', 'POST', {
    name: 'SYNTHETIC P5E2 suffix foundation',
    planningAnchorDate: date(departure),
    defaultPeopleCount: 1,
  });
  for (const [index, name] of [
    'SYNTHETIC SUFFIX A',
    'SYNTHETIC_P5E2_SUFFIX_DESTINATION',
  ].entries()) {
    trip = await apiJson(`/trips/${trip.id}/commands`, 'POST', {
      baseTripVersion: trip.version,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay:
          index === 0 || date(departure) !== date(arrival)
            ? {
                type: 'NEW',
                localDate: date(index === 0 ? departure : arrival),
                sequence: index,
              }
            : {
                type: 'EXISTING',
                dayOccurrenceId: trip.days[0].dayOccurrenceId,
              },
        position: index === 0 || date(departure) !== date(arrival) ? 0 : 1,
        place: {
          type: 'CUSTOM',
          name,
          latitude: 35.67 + index * 0.03,
          longitude: 139.65 + index * 0.03,
        },
      },
    });
  }
  const [a, d] = trip.days.flatMap((day) => day.nodes);
  const query = await apiJson(`/trips/${trip.id}/routes/query`, 'POST', {
    basisVersion: trip.version,
    fromNodeId: a.id,
    toNodeId: d.id,
    hint: {
      type: 'DEPART_AT',
      instant: departure.toISOString(),
      timeZone: zone,
    },
  });
  const firstPreview = await apiJson(`/trips/${trip.id}/previews`, 'POST', {
    basisVersion: trip.version,
    candidateSnapshotId: query.candidates[0].candidateSnapshotId,
  });
  assert(
    firstPreview.changeSummary.routeCorridor.replacementScope ===
      'FULL_CORRIDOR',
    'full query compatibility',
  );
  const first = await apiJson(
    `/trips/${trip.id}/previews/${firstPreview.previewId}/adopt`,
    'POST',
    { baseTripVersion: trip.version, idempotencyKey: randomUUID() },
  );
  trip = first.trip;
  const originalNodes = trip.days
    .flatMap((day) => day.nodes)
    .map((node) => node.id);
  assert(originalNodes.length === 4, 'source corridor must be A B C D');
  const b = trip.days.flatMap((day) => day.nodes)[1];
  const prefix = trip.connections.find(
    (connection) => connection.fromNodeId === a.id,
  ).transport;
  const oldSuffixIds = trip.connections
    .filter((connection) => connection.fromNodeId !== a.id)
    .map((connection) => connection.transport.id)
    .sort();
  const originalPlacements = await sql(
    `SELECT jsonb_agg(jsonb_build_array(n."id",n."dayOccurrenceId",n."position") ORDER BY o."sequence",n."position") FROM "ItineraryNode" n JOIN "DayOccurrence" o ON o."id"=n."dayOccurrenceId" WHERE n."tripId"='${trip.id}';`,
  );
  const recordedArrival = query.candidates[0].legs[0].arrival;
  for (const subject of [
    { type: 'TRANSPORT', transportEdgeId: prefix.id },
    { type: 'NODE', nodeId: b.id },
  ]) {
    trip = await apiJson(`/trips/${trip.id}/temporal-values`, 'POST', {
      baseTripVersion: trip.version,
      subject,
      value: {
        layer: 'ACTUAL',
        pointKind: 'ARRIVAL',
        instant: recordedArrival.instant,
        timeZone: zone,
        sourceKind: 'USER_VALUE',
      },
    });
  }
  // Explicit test fixture completion evidence, not inferred from Provider/GPS.
  await sql(
    `UPDATE "GroundTransitLegExecution" SET "state"='COMPLETED' WHERE "transportEdgeId"='${prefix.id}';`,
  );
  const prefixFacts = await sql(
    `SELECT jsonb_build_object('edge',to_jsonb(e),'values',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v."id") FROM "TemporalValue" v WHERE v."transportEdgeId"=e."id"),'leg',(SELECT to_jsonb(l) FROM "GroundTransitLegExecution" l WHERE l."transportEdgeId"=e."id")) FROM "TransportEdge" e WHERE e."id"='${prefix.id}';`,
  );
  const next = await apiJson(`/trips/${trip.id}/routes/query`, 'POST', {
    basisVersion: trip.version,
    fromNodeId: b.id,
    toNodeId: d.id,
    hint: {
      type: 'DEPART_AT',
      instant: new Date().toISOString(),
      timeZone: recordedArrival.timeZone,
    },
  });
  const preview = await apiJson(`/trips/${trip.id}/previews`, 'POST', {
    basisVersion: trip.version,
    candidateSnapshotId: next.candidates[0].candidateSnapshotId,
  });
  assert(
    preview.adoptable &&
      preview.changeSummary.routeCorridor.replacementScope === 'SUFFIX',
    'suffix Preview adoptable',
  );
  assert(
    !preview.changeSummary.nodesToRemove.some((node) => node.nodeId === b.id),
    'origin cannot be removed',
  );
  assert(
    JSON.stringify(
      [...preview.changeSummary.willReplaceTransportEdgeIds].sort(),
    ) === JSON.stringify(oldSuffixIds),
    'replacement set must exclude prefix',
  );
  const second = await apiJson(
    `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
    'POST',
    { baseTripVersion: trip.version, idempotencyKey: randomUUID() },
  );
  const r1 = first.operationReceipt.adoptedRouteId,
    r2 = second.operationReceipt.adoptedRouteId;
  assert(
    (await sql(
      `SELECT (SELECT "status" FROM "AdoptedRoute" WHERE "id"='${r1}') || ':' || (SELECT "status" FROM "AdoptedRoute" WHERE "id"='${r2}');`,
    )) === 'REPLACED:ACTIVE',
    'Adopt lifecycle',
  );
  assert(
    (await sql(
      `SELECT count(*) FROM "TransportEdgeHistory" WHERE "tripId"='${trip.id}' AND "originalTransportEdgeId" IN (${oldSuffixIds.map((id) => `'${id}'`).join(',')});`,
    )) === '2',
    'archive only old suffix',
  );
  assert(
    second.trip.connections.some(
      (connection) =>
        connection.transport?.id === prefix.id &&
        connection.transport.adoptedRouteId === r1,
    ),
    'prefix current identity preserved',
  );
  const readPrefix = () =>
    sql(
      `SELECT jsonb_build_object('edge',to_jsonb(e),'values',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v."id") FROM "TemporalValue" v WHERE v."transportEdgeId"=e."id"),'leg',(SELECT to_jsonb(l) FROM "GroundTransitLegExecution" l WHERE l."transportEdgeId"=e."id")) FROM "TransportEdge" e WHERE e."id"='${prefix.id}';`,
    );
  assert(
    (await readPrefix()) === prefixFacts,
    'prefix facts changed during Adopt',
  );
  const undoKey = randomUUID();
  const undone = await apiJson(
    `/trips/${trip.id}/operations/${second.operationReceipt.id}/undo`,
    'POST',
    { baseTripVersion: second.trip.version, idempotencyKey: undoKey },
  );
  assert(
    undone.trip.version === second.trip.version + 1,
    'Undo version increment',
  );
  assert(
    JSON.stringify(
      undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
    ) === JSON.stringify(originalNodes),
    'original corridor identity restored',
  );
  assert(
    JSON.stringify(
      undone.trip.connections
        .map((connection) => connection.transport.id)
        .sort(),
    ) === JSON.stringify([prefix.id, ...oldSuffixIds].sort()),
    'old suffix IDs restored',
  );
  assert(
    (await readPrefix()) === prefixFacts,
    'prefix ACTUAL changed during Undo',
  );
  assert(
    (await sql(
      `SELECT jsonb_agg(jsonb_build_array(n."id",n."dayOccurrenceId",n."position") ORDER BY o."sequence",n."position") FROM "ItineraryNode" n JOIN "DayOccurrence" o ON o."id"=n."dayOccurrenceId" WHERE n."tripId"='${trip.id}';`,
    )) === originalPlacements,
    'node placements restored',
  );
  assert(
    (await sql(
      `SELECT (SELECT "status" FROM "AdoptedRoute" WHERE "id"='${r1}') || ':' || (SELECT "status" FROM "AdoptedRoute" WHERE "id"='${r2}');`,
    )) === 'ACTIVE:UNDONE',
    'Undo lifecycle',
  );
  assert(
    (await sql(
      `SELECT count(*) FROM "TransportEdgeHistory" WHERE "tripId"='${trip.id}';`,
    )) === '0',
    'histories consumed',
  );
  const replay = await apiJson(
    `/trips/${trip.id}/operations/${second.operationReceipt.id}/undo`,
    'POST',
    { baseTripVersion: second.trip.version, idempotencyKey: undoKey },
  );
  assert(
    replay.operationReceipt.id === undone.operationReceipt.id &&
      replay.trip.version === undone.trip.version,
    'Undo replay',
  );
  return {
    adopt: 'PASS',
    undo: 'PASS',
    preservedPrefix: true,
    automaticQuery: false,
    automaticPreview: false,
    automaticAdopt: false,
  };
}
