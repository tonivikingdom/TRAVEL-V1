# P5E2 Batch 5B1 — Ephemeral External-Origin Route Query Foundation

Starting main: `99599e3809a1c77963ce301f37cd9b5c054676ec`. Branch:
`feature/p5e2-external-origin-route-query`. Recommended model: GPT-6 Sol / High;
Astra / High only for an architectural blocker. This batch stops at a Draft PR.

Batch 5B1 allows a CURRENT durable external execution origin to act as an ephemeral
Route Provider origin without materializing an itinerary node.

Query and CandidateSnapshot are planning evidence only and do not change the formal Trip.

External-origin Preview/Adopt/materialization remain intentionally unsupported pending
Batch 5B2 route-anchor semantics.

## Authorization and requests

`POST /trips/:tripId/execution/external-origins/:externalOriginId/routes/query`
accepts `{ basisVersion, toNodeId, hint? }`. Extra client origin/location metadata is
rejected. Existing `POST /trips/:id/routes/query` and its node-origin contract remain
unchanged, including confirmed-node suffix authorization.

The shared pure `resolveExternalOriginRouteQueryAuthorization` policy is used by
Application Query, locked snapshot persistence, and Handoff. It requires a user-owned
ARRIVED/CURRENT origin, ACTIVE source AdoptedRoute, the exact current source edge
owned by that route, and the source route's original anchorTo destination. Invalid
metadata, inconsistent execution frontier, SUPERSEDED, DEPARTED, INVALIDATED and
CONFLICT cannot authorize planning. Provider recovery alone does not revoke a
confirmed user arrival. Provider ACTUAL and GPS proximity never authorize arrival.

Query checks owner/version/currentness before calling the Provider. After its response,
owner advisory lock and Trip row lock protect a fresh read of execution context, source
route/edge, destination, version, and the immutable origin metadata. A race returns
VERSION_CONFLICT and inserts no snapshots. Provider calls stay outside transactions.

The origin name/coordinates/timezone come only from durable E. Provider `placeId` is an
opaque internal query-location ID, so it may contain externalOriginId without a Place
row. The trusted E timezone is validated at consumption. Query hints must match it.
The hard earliest departure is server now, raised by a later DEPART_AT; ARRIVE_BY keeps
that floor and tightens the destination arrival deadline. Existing destination/downstream
schedule requirements still apply. Schedule evaluation starts at the real destination D and
retains downstream nodes/edges and user hard windows; abandoned source-corridor vehicle
ACTUAL and fixed-service anchors cannot constrain E. This is a read-only projection,
not a fictional E itinerary node. E inherits no old-node dwell. Validation, ranking,
fare checks, provider-zone checks and expiry reuse the node query implementation.

Handoff is read-only: READY now means either legacy `query` or additive `externalQuery`
is present. A confirmed external origin exposes `CONFIRMED_EXTERNAL_EXECUTION_ORIGIN`,
`query = null`, and `{ externalOriginId, basisVersion, toNodeId, hint }` in externalQuery.
It calls no Route Provider and writes nothing. Clients must explicitly submit Query.

## Snapshot persistence and compatibility

Migration `20261001090000_p5e2_external_origin_route_query` adds exactly one migration:
21 → 22. No historical migration is edited. `RouteQueryOriginKind` distinguishes
ITINERARY_NODE and EXTERNAL_EXECUTION_ORIGIN. Legacy rows default to ITINERARY_NODE;
legacy fromNodeId and all hash/receipt semantics are preserved. The origin-shape CHECK
requires exactly one origin: a node FK, or an external origin ID plus copied JSON.
There is no external-origin FK and no fake node reference.

`external-route-origin-v1` copies externalOriginId, provider/hub identities, name,
coordinates, IANA timezone, arrivedAt, source route/edge/leg/observation IDs and accepted
observation identity/fetchedAt/factsHash. `external-route-candidate-v1` hashes that evidence,
origin kind, trip/version/destination, provider/observedAt and candidate facts separately
from the unchanged legacy hash algorithm. Application snapshot reads expose a discriminated
origin. Both Preview boundaries return PREVIEW_UNSUPPORTED for external snapshots.
A defensive itinerary-origin check in existing Adopt validation prevents any external
snapshot reaching the legacy hash path; no external Adopt or Undo architecture is added.

Query creates only CandidateSnapshots. Trip.version, ExternalExecutionOrigin, execution
facts, Place, itinerary/day IDs, TemporalValue, TransportEdge, AdoptedRoute, Preview and
OperationReceipt remain unchanged. External snapshots do not change origin currentness.

## Validation

The focused PostgreSQL/API regressions cover successful Query and zero formal Trip writes;
read-only Handoff; external Preview rejection; currentness/status/source/destination refusal;
departure before and during Provider; supersession/route/edge/metadata changes without version
increment to independently test locked proof; E→F rollover; recovery; owner/admin isolation;
server time floors and destination deadlines. Domain tests cover the pure policy and metadata
validation. A fixed legacy digest from the 5A hash implementation and key-order independent
external evidence hashes verify compatibility. Migration tests apply clean 22 migrations and
compare populated 21→22 histories, including v2/v3/v4 receipts, unchanged legacy snapshot facts
and external execution/audit evidence; ambiguous origin shapes are rejected by PostgreSQL.

Compose extends the explicit synthetic chain through confirmation, read-only READY Handoff,
explicit external Query, durable snapshots, controlled Preview refusal, explicit departure,
and rejected departed-origin Query with no additional snapshot. Provider vehicle arrival
without user confirmation still creates zero external origins.

Cloud validation completed on PostgreSQL **17.11** with Node **24.19.0** and pnpm
**11.19.0**:

- Frozen install and Prisma generate/validate: PASS.
- Format/check, lint, full typecheck, API/Worker/Debug Web build: PASS.
- Unit: **53 files / 621 tests PASS**, including existing Worker regressions.
- Focused new PostgreSQL/API regressions: **29/29 PASS**.
- Full PostgreSQL integration: **28 files / 404 tests PASS** (Persistence 19/79,
  API 9/325), retaining node Query/Preview/Adopt/Undo, FULL_CORRIDOR/SUFFIX,
  historical-reference protection, v2/v3/v4, external E→F lifecycle and owner isolation.
- Clean database: all **22 migrations PASS**, also verified with Prisma migrate deploy.
- Populated database: **21→22 PASS**, preserving prior snapshots/previews/routes,
  v2/v3/v4 receipts, external execution/audit and Ground Transit histories.
- Compose: PASS, including API/Worker health, delivery/retry/lease recovery,
  outage/recovery/SIGTERM, existing confirmed-node suffix Adopt/Undo, external Query
  with no materialization, controlled Preview rejection and departed-origin refusal.
- P5B: **5 users / 200 requests PASS**, **0 isolation failures**, **0 unexpected 5xx**,
  **0 network failures**; median 372.04 ms, p95 645.75 ms, maximum 667.87 ms.

Cloud logs are retained outside Git under `/workspace/cloud-setup/5b1-*.log`.
Independent final-HEAD GitHub CI results (verify, Compose verification, P5B acceptance)
will be recorded in the Draft PR and final report. The PR remains Draft for review.

## Scope

No external Preview semantics, Adopt, E node/Place materialization, source edge archival,
new route, delta v5 or external Undo. No GPS auto-confirm, arbitrary coordinate routing,
mid-edge/onboard routing, real Hub Resolver, paid provider, automatic Query/Preview/Adopt,
formal UI, Push, staging or production. F-05/F-06/F-07/F-08 remain open.
