# P5E2 Batch 5A — External Transit Hub Execution Origin Foundation

- Recommended model: GPT-6 Sol / High; backup GPT-6 Astra / High if concurrent transactions, migration or execution evidence cannot be resolved reliably. Actual client model configuration is unconfirmed.
- Starting main: `a7055bf753741769a4459946abe00a2375eb9079` (merged Batch 4).
- Branch: `feature/p5e2-external-transit-hub-execution-origin`, created from clean local HEAD equal to origin/main and the official baseline.
- Delivery: new Draft PR after cloud acceptance; no Ready, merge or production deployment.

## Product boundary

An external hub candidate is a provider operational fact; it is not user location.

Only explicit user confirmation creates a durable external execution origin in Batch 5A.

Confirming an external execution origin does not modify the Trip itinerary or start Route Query/Preview/Adopt.

Batch 5A implements MANUAL confirmation and departure only. There is no E→D route query, external-origin snapshot/preview/adoption, Place or ItineraryNode materialization, coordinate routing, GPS confirmation, real hub lookup or paid transit provider. F-05/F-06/F-07/F-08 remain open. Formal clients, Push, staging and production remain outside this batch.

## Trusted candidate

`resolveExternalTransitHubIdentity` is a pure Domain policy. Only a current adopted ground leg with accepted operational evidence requiring ROUTE_REEVALUATION_REQUIRED can supply a candidate. Relevant evidence is SERVICE_SHORT_TURNED, TERMINUS_CHANGED, or an unserved alighting target with an explicit new terminus. Ordinary delay or platform change does not qualify.

Equal currentTerminusRef/operatingToHubRef yields that identity; one present reference is sufficient. Different references produce EXTERNAL_HUB_IDENTITY_CONFLICT. A label is only a resolver hint. The planned alighting reference and an exact provider/reference already represented by the Trip are excluded. No fuzzy names or coordinate proximity map E to an itinerary node.

The provider-neutral `GroundTransitHubResolver` port returns RESOLVED, NOT_FOUND, AMBIGUOUS or UNAVAILABLE. RESOLVED requires matching provider/reference, nonblank canonical identity/name, finite bounded coordinates and valid IANA timezone. All metadata comes from the resolver; there is no timezone or coordinate fallback. Provider responses are projected into the approved metadata fields before persistence.

The Dev/Test resolver knows only `SYNTHETIC / synthetic:short-terminus`, returning `synthetic:hub:short-terminus`, Synthetic Short Terminus, latitude 35.705, longitude 139.705 and Asia/Tokyo. Factory activation requires development/test plus SYNTHETIC_CI_ONLY. Production and staging use an unconfigured resolver returning UNAVAILABLE; no metadata is fabricated.

`candidateRef` is SHA-256 over an explicit versioned JSON array binding trip/version, source route/edge/leg, accepted observation row/identity/fetchedAt/factsHash, provider/reference and all resolved hub metadata. It is deterministic for unchanged facts, and is not an authorization token.

## Durable storage and audit

One migration: `prisma/migrations/20260930130000_p5e2_external_execution_origin/migration.sql`. Total migration count: **21** (20 existing plus one new).

`ExternalExecutionOrigin` stores owner/trip, TRANSIT_HUB kind, source adopted route/edge/ground leg/accepted observation IDs, observation identity/time/hash, provider/reference/canonical reference, name/coordinates/timezone, ARRIVED/DEPARTED/INVALIDATED status and arrival/departure/invalidation/create/update times. Source evidence identifiers intentionally have no route, edge or observation foreign keys. Ownership uses the composite Trip/owner relation. Normal Trip/account deletion owns these records; replacing a route or recovering provider service does not cascade user execution evidence or acquire a new historical Restrict dependency.

`ExternalExecutionOriginReceipt` is immutable transition audit and owner-scoped idempotency storage: origin/trip/owner, ARRIVAL or DEPARTURE transition, key, request hash, server occurrence time, resulting version and exact public response snapshot. No external event is inserted into node-bound ExecutionEvent. Existing ExecutionEvent, AdoptedRoute, TransportEdge and planning snapshot relations are unchanged. Coordinates and status/timestamp lifecycle have storage CHECK constraints.

One persisted ARRIVED origin per Trip is enforced under the existing owner advisory lock and Trip row lock. Concurrent same-key requests replay one receipt; different-key attempts fail with a version or external-origin conflict. A superseded ARRIVED record is retained and must be explicitly closed through departure before another ARRIVED record can be created. No partial unique index or additional migration is used.

## APIs and transactions

| API                                                                            | Behavior                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| GET `/trips/:tripId/execution/ground-transit/:transportEdgeId/external-origin` | Owner-only, read-only candidate/current-origin view; no candidate table |
| POST same path plus `/confirm`                                                 | Only baseTripVersion, candidateRef and idempotencyKey accepted          |
| POST `/trips/:tripId/execution/external-origins/:externalOriginId/depart`      | Only baseTripVersion and idempotencyKey accepted                        |

Confirmation rejects client coordinates, identities, names, timezone and arrivedAt. The server records arrivedAt using its clock. Inside owner/Trip locks it checks owner, receipt/replay, version, current source leg/route, accepted current observation, re-resolved hub metadata and candidateRef, then the one-ARRIVED invariant. Changes return VERSION_CONFLICT, EXTERNAL_ORIGIN_CANDIDATE_STALE or EXTERNAL_ORIGIN_CONFLICT before writes. The successful transaction creates the origin and audit receipt and increments Trip.version once.

Departure requires an owner-scoped ARRIVED origin, records server departedAt, changes status to DEPARTED, creates its transition receipt and increments Trip.version once. Same-key/same-hash replay returns the saved result; changed payload gives IDEMPOTENCY_CONFLICT. Locks and transactional writes prevent partial state. Confirmation and departure do not rewrite the source ground leg into a fabricated arrival/completion state.

`resolveExternalExecutionOriginCurrentness` is pure Domain policy: CURRENT, DEPARTED, SUPERSEDED or CONFLICT. Later active durable itinerary ExecutionEvents or a newer external visit supersede the old origin without editing its history. Multiple ARRIVED rows or inconsistent execution frontier are CONFLICT. Undone execution events do not count. Provider recovery and vehicle observations are not user departure or supersession evidence.

The read view prefers the single ARRIVED record over departed history when arrival timestamps tie at storage precision. UUID ordering cannot hide an open origin; a regression explicitly constructs that order.

An external arrival/departure also fences an older confirmed itinerary-node origin in the shared Batch 4 policy, including locked snapshot and Adopt validation. A later independently confirmed itinerary arrival can become the node origin again. FULL_CORRIDOR and ordinary adjacent planning retain their existing semantics.

## Handoff and non-mutation

Existing route reevaluation adds externalOriginStatus. An external candidate requiring confirmation yields ORIGIN_UNRESOLVED/query=null. A CURRENT confirmed E also yields query=null with EXTERNAL_ORIGIN_ROUTE_PLANNING_NOT_SUPPORTED. Resolver conflict/unavailability remains unresolved and does not imply recovery. Confirmed user history survives provider recovery. Batch 5A does not turn E into a RouteQuery endpoint; an origin record ID is not an itinerary node ID.

Across candidate GET, confirm and departure, observed mutation counts for itinerary nodes, Places, TransportEdges, CandidateSnapshots, Previews and AdoptedRoutes are **0**. Only execution origin/receipt rows and the successful mutation's Trip version/update time change. Candidate and Handoff reads write nothing. Provider vehicle ACTUAL and reliable/raw GPS produce zero external origin rows without explicit manual confirmation.

## Regression coverage

- Domain: identity combinations/conflict, planned and exact represented hubs, delay/cancellation/vehicle-only facts, invalid resolver coordinates/timezone/identity/name, departed/later durable execution/newer visit/current-origin conflict.
- Application/Provider: deterministic hash binding, accepted-evidence prerequisite, unavailable/ambiguous/not-found distinction, synthetic metadata and production fail-closed factory.
- PostgreSQL HTTP: candidate read-only and metadata; confirmation/departure and replay; idempotency conflict; concurrent same/different-key confirmations; stale observation/recovery/resolver metadata/version; unsafe resolver metadata; vehicle ACTUAL/GPS-only; later real itinerary event; provider recovery; owner/admin isolation; client metadata denial; old node-origin fencing; E used directly as route endpoint rejected without writes.
- PostgreSQL migration: all 21 migrations from empty; 20-migration populated baseline upgraded with full contents of 17 existing tables unchanged, including route receipts, user ExecutionEvent/ACTUAL, capabilities and Ground Transit observation/state history. Source evidence FK targets are checked explicitly.
- Existing P4/P5/P5E1/P5E2 suites retain FULL_CORRIDOR/SUFFIX, confirmed-node authorization, historical anchor/reference safeguards, v2/v3/v4, Undo/idempotency/concurrency, monitoring/capability/observation order/recovery and owner isolation.
- Compose extends the existing chain: explicit initial Query/Preview/Adopt, real Worker accepted short-turn E with vehicle ACTUAL, read-only resolved candidate and zero auto-created origin, explicit manual confirm, unchanged itinerary/route/planning, unresolved handoff, explicit departure. Initial route construction is explicit fixture setup; no E→D query is issued. Existing Batch 4 suffix/Undo acceptance remains present.

## Cloud acceptance

First acceptance environment: Node 24.19.0, pnpm 11.19.0, PostgreSQL 17.11 and Docker Compose. Only isolated synthetic databases are used; credentials, build/network configuration and raw logs stay outside Git.

Frozen install, Prisma generate/validate, format/check, lint, full typecheck and build: PASS. Unit: **51 files / 600 tests PASS**. PostgreSQL 17 full integration: **27 files / 367 tests PASS** (Persistence 18/77, API 9/290). This includes 21 new external-origin HTTP cases and two new migration cases. Clean migration: all 21 applied; populated migration: 17 existing tables preserved. Worker focused regressions: **4 files / 18 tests PASS**. API/Worker builds pass and their actual health/lifecycle is checked by Compose. Debug Web built and its preview returned HTTP 200.

Final Compose revalidation: **PASS**, including the Worker short-turn E candidate, vehicle-ACTUAL negative check, explicit ARRIVED/DEPARTED lifecycle, zero itinerary/planning mutation, existing suffix/Undo, delivery/retry/lease recovery, database outage/recovery and Worker shutdown/restart. Final P5B: **5 users / 200 requests PASS**, zero isolation failures, unexpected 5xx or network failures (median 395.76 ms, p95 647.56 ms, max 661.04 ms).

Cloud acceptance is complete before creation of the new Draft PR. Independent GitHub CI must complete verify, Compose verification and P5B acceptance on the submitted HEAD; its run URL/results are recorded in the PR description and final task report. Automatic Query/Preview/Adopt: NO. Real paid provider: NO. Production deployment: NO. Keep Draft and stop for review.
