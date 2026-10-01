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
  const afterConfirmation = await footprint();
  const after = JSON.parse(afterConfirmation);
  const previous = JSON.parse(before);
  assert(
    JSON.stringify({ ...after, version: previous.version }) ===
      JSON.stringify(previous),
    'confirmation mutated itinerary/Place/route/planning data',
  );
  const handoffAfter = await apiJson(`${base}/route-reevaluation`, 'GET');
  assert(
    handoffAfter.readiness === 'READY' &&
      handoffAfter.originBasis === 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN' &&
      handoffAfter.sourceTransportEdgeId ===
        result.origin.sourceTransportEdgeId &&
      handoffAfter.adoptedRouteId === result.origin.sourceAdoptedRouteId &&
      handoffAfter.query === null &&
      handoffAfter.externalQuery?.externalOriginId === result.origin.id,
    'confirmed E did not expose externalQuery',
  );
  assert(
    (await sql(
      `SELECT count(*) FROM "GroundTransitLegExecution" WHERE "id"='${result.origin.sourceGroundTransitLegExecutionId}' AND "transportEdgeId"='${handoffAfter.sourceTransportEdgeId}' AND "adoptedRouteId"='${handoffAfter.adoptedRouteId}';`,
    )) === '1',
    'external Handoff source leg provenance invalid',
  );
  assert((await footprint()) === afterConfirmation, 'handoff wrote data');
  const { externalOriginId, ...externalRequest } = handoffAfter.externalQuery;
  const externalPath = `/trips/${trip.id}/execution/external-origins/${externalOriginId}/routes/query`;
  // An explicit user planning request for a future departure: Preview must
  // reject candidates whose departure has already passed by its own server now.
  const queried = await apiJson(externalPath, 'POST', {
    ...externalRequest,
    hint: {
      type: 'DEPART_AT',
      instant: new Date(Date.now() + 5 * 60_000).toISOString(),
      timeZone: result.origin.timeZone,
    },
  });
  assert(
    queried.candidates.length > 0 &&
      queried.externalOriginId === result.origin.id,
    'external Query returned no snapshots',
  );
  const afterQuery = JSON.parse(await footprint());
  const snapshotCount = afterQuery.snapshots;
  afterQuery.snapshots = after.snapshots;
  assert(
    JSON.stringify(afterQuery) === JSON.stringify(after),
    'Query changed formal Trip data',
  );
  assert(
    (await sql(
      `SELECT count(*) FROM "RouteCandidateSnapshot" WHERE "id"='${queried.candidates[0].candidateSnapshotId}' AND "originKind"='EXTERNAL_EXECUTION_ORIGIN' AND "fromNodeId" IS NULL AND "fromExternalOriginId"='${result.origin.id}' AND "externalOriginSnapshot"->>'timeZone'='Asia/Tokyo';`,
    )) === '1',
    'external snapshot origin shape invalid',
  );
  const externalCandidate = queried.candidates[0];
  const firstEndpoint = externalCandidate.legs[0].from;
  assert(
    firstEndpoint.latitude === result.origin.latitude &&
      firstEndpoint.longitude === result.origin.longitude,
    'synthetic candidate does not start at trusted external E',
  );
  assert(
    (await sql(
      `SELECT count(*) FROM "RouteCandidateSnapshot" s JOIN "ItineraryNode" n ON n."id"=s."toNodeId" JOIN "Place" p ON p."id"=n."placeId" WHERE s."id"='${externalCandidate.candidateSnapshotId}' AND (s."candidatePayload"->'legs'->-1->'to'->>'latitude')::numeric=p."latitude" AND (s."candidatePayload"->'legs'->-1->'to'->>'longitude')::numeric=p."longitude";`,
    )) === '1',
    'synthetic candidate does not end at trusted itinerary D',
  );
  const beforePreview = await footprint();
  const externalPreview = await apiJson(`/trips/${trip.id}/previews`, 'POST', {
    basisVersion: result.resultingTripVersion,
    candidateSnapshotId: queried.candidates[0].candidateSnapshotId,
  });
  const plan = externalPreview.changeSummary.externalOriginReplacement;
  assert(
    externalPreview.status === 'ADOPT_UNSUPPORTED' &&
      externalPreview.adoptable === false,
    'external Preview must remain non-adoptable',
  );
  assert(
    plan?.replacementScope === 'EXTERNAL_ORIGIN' &&
      plan.externalOriginId === result.origin.id &&
      plan.sourceTransportEdgeId === edgeId &&
      plan.sourceGroundTransitLegExecutionId ===
        result.origin.sourceGroundTransitLegExecutionId &&
      plan.sourceAdoptedRouteId === result.origin.sourceAdoptedRouteId,
    'external plan source provenance invalid',
  );
  assert(
    plan.sourceDivergenceNodeId === a.id &&
      JSON.stringify(plan.preservedPrefixNodeIds) === JSON.stringify([a.id]) &&
      plan.preservedPrefixTransportEdgeIds.length === 0 &&
      JSON.stringify(plan.replacementTransportEdgeIds) ===
        JSON.stringify([edgeId]),
    'first-edge external plan must permit a one-node prefix',
  );
  assert(
    plan.materializedOrigin.ref === 'EXTERNAL_ORIGIN' &&
      plan.materializedOrigin.nodeId === null &&
      plan.materializedOrigin.action === 'CREATE' &&
      plan.materializedOrigin.evidence === 'USER_CONFIRMED' &&
      plan.materializedOrigin.temporalValues.length === 0 &&
      plan.materializedOrigin.executionEvents.length === 0 &&
      plan.materializedOrigin.providerHubRef === result.origin.providerHubRef,
    'future E materialization plan invalid',
  );
  assert(
    externalPreview.changeSummary.routeCorridor === undefined &&
      externalPreview.changeSummary.proposedSegments[0].fromRef ===
        'EXTERNAL_ORIGIN' &&
      externalPreview.changeSummary.proposedSegments.at(-1).toRef === 'TO_NODE',
    'external endpoints masqueraded as ordinary nodes',
  );
  assert(
    externalPreview.changeSummary.archivableProviderActualTransportEdgeIds.includes(
      edgeId,
    ) &&
      !externalPreview.changeSummary.protectedBlockingTransportEdgeIds.includes(
        edgeId,
      ),
    'vehicle ACTUAL was incorrectly protected in external Preview',
  );
  const afterPreview = JSON.parse(await footprint());
  const beforePlan = JSON.parse(beforePreview);
  assert(
    afterPreview.previews === beforePlan.previews + 1,
    'Preview did not create exactly one planning row',
  );
  afterPreview.previews = beforePlan.previews;
  assert(
    JSON.stringify(afterPreview) === JSON.stringify(beforePlan),
    'Preview changed formal Trip',
  );
  const fetchedPreview = await apiJson(
    `/trips/${trip.id}/previews/${externalPreview.previewId}`,
    'GET',
  );
  assert(
    fetchedPreview.status === 'ADOPT_UNSUPPORTED',
    'external GET was superseded by node policy',
  );
  const beforeAdopt = await footprint();
  const rejection = await fetch(
    `http://127.0.0.1:${apiPort}/trips/${trip.id}/previews/${externalPreview.previewId}/adopt`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        baseTripVersion: result.resultingTripVersion,
        idempotencyKey: randomUUID(),
      }),
    },
  );
  assert(
    rejection.status === 422 &&
      (await rejection.json()).error?.code === 'PREVIEW_UNSUPPORTED',
    'external Adopt did not return controlled unsupported',
  );
  assert(
    (await footprint()) === beforeAdopt,
    'rejected external Adopt wrote data',
  );
  previous.previews = beforePlan.previews + 1;
  previous.snapshots = snapshotCount;

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
  const rejectedQuery = await fetch(
    `http://127.0.0.1:${apiPort}${externalPath}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...externalRequest,
        basisVersion: departed.resultingTripVersion,
      }),
    },
  );
  assert(
    rejectedQuery.status === 422 &&
      (await rejectedQuery.json()).error?.code === 'ROUTE_QUERY_UNSUPPORTED',
    'departed E Query was authorized',
  );
  const final = JSON.parse(await footprint());
  assert(final.snapshots === snapshotCount, 'departed Query wrote snapshots');
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
    previewMutationCount: 1,
    formalTripPreviewMutations: 0,
    externalReplacementScope: 'EXTERNAL_ORIGIN',
    oneNodeFirstEdgePrefix: true,
    providerActualArchivable: true,
    adoptMutationCount: 0,
    externalRouteQuery: true,
    externalSnapshotCount: queried.candidates.length,
    externalPreview: 'ADOPT_UNSUPPORTED',
    externalAdopt: 'PREVIEW_UNSUPPORTED',
    departedExternalQuery: 'ROUTE_QUERY_UNSUPPORTED',
    automaticQuery: false,
    automaticPreview: false,
    automaticAdopt: false,
  };
}
