# P5E2 Batch 5A — External Transit Hub Execution Origin Foundation

- Recommended model: GPT-6 Sol / High; backup GPT-6 Astra / High if concurrent transactions, migration or execution evidence cannot be resolved reliably. Actual client model configuration is unconfirmed.
- Starting main: `a7055bf753741769a4459946abe00a2375eb9079` (merged Batch 4).
- Branch: `feature/p5e2-external-transit-hub-execution-origin`, created from clean local HEAD equal to origin/main and the official baseline.
- Delivery: continue [Draft PR #34](https://github.com/tonivikingdom/TRAVEL-V1/pull/34); no new PR, Ready, merge or production deployment. Blocking review repair starts from `a5a499fc8d261193db9d9b4ca20ddda4c548c141`.

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

`ExternalExecutionOriginReceipt` is immutable transition audit and owner-scoped idempotency storage: origin/trip/owner, ARRIVAL, DEPARTURE or INVALIDATION transition, request hash, server occurrence time, resulting version and response snapshot. ARRIVAL/DEPARTURE require a client idempotency key and retain the owner/key unique constraint. INVALIDATION uses a null idempotency key, enum reason SUPERSEDED_BY_LATER_EXECUTION and the triggering new ARRIVAL receipt ID; its immutable snapshot includes the invalidated origin and newly confirmed origin ID. This audit identity is retained without a new historical receipt FK cascade. A storage CHECK distinguishes automatic audit rows from client replay entries. No external event is inserted into node-bound ExecutionEvent. Existing ExecutionEvent, AdoptedRoute, TransportEdge and planning snapshot relations are unchanged. Coordinates and status/timestamp lifecycle have storage CHECK constraints; INVALIDATED requires departedAt=null.

One persisted ARRIVED origin and at most one derived CURRENT origin per Trip are enforced under the existing owner advisory lock and Trip row lock. For each existing ARRIVED record, confirmation recomputes currentness with the shared pure Domain policy inside those locks. CURRENT and CONFLICT reject the new confirmation. SUPERSEDED permits it: before creating F, the same transaction updates E to INVALIDATED with invalidatedAt=server now, preserves arrivedAt/source evidence and departedAt=null, and writes an immutable INVALIDATION audit linked to F's confirmation. It does not invent a departure. Reading a SUPERSEDED row alone still leaves historical persistence unchanged. Concurrent same-key requests replay one receipt; different-key attempts fail with a version or external-origin conflict. The entire E invalidation/F arrival/audit transaction increments Trip.version only once. No partial unique index or additional migration is used; the unpublished 21st migration is amended in place.

## APIs and transactions

| API                                                                            | Behavior                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| GET `/trips/:tripId/execution/ground-transit/:transportEdgeId/external-origin` | Owner-only, read-only candidate/current-origin view; no candidate table |
| POST same path plus `/confirm`                                                 | Only baseTripVersion, candidateRef and idempotencyKey accepted          |
| POST `/trips/:tripId/execution/external-origins/:externalOriginId/depart`      | Only baseTripVersion and idempotencyKey accepted                        |

GET authorizes READ_PRIVATE_RESOURCE; Confirm/Depart authorize WRITE_PRIVATE_RESOURCE. Owner-only access and administrator isolation are unchanged. Confirmation rejects client coordinates, identities, names, timezone and arrivedAt. The server records arrivedAt using its clock. Inside owner/Trip locks it checks owner, receipt/replay, version, current source leg/route, accepted current observation, re-resolved hub metadata and candidateRef, then rechecks existing ARRIVED currentness. Changes return VERSION_CONFLICT, EXTERNAL_ORIGIN_CANDIDATE_STALE or EXTERNAL_ORIGIN_CONFLICT before writes. The successful transaction invalidates only superseded history, creates the new origin and audit receipts, and increments Trip.version once. Replaying it returns the original response without further origin/audit/version writes.

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
- Blocking review repair: the original E→later real itinerary ARRIVAL test now continues through accepted F observation, GET CONFIRMATION_REQUIRED and successful F confirmation. It proves E history is untouched before confirmation, E is then INVALIDATED/SUPERSEDED with unchanged arrival/source evidence and no departure, F is the sole ARRIVED/CURRENT, audit links the triggering receipt, planning data is unchanged, and replay writes nothing. CURRENT and inconsistent-frontier CONFLICT reject F without writes. Same/different-key concurrency produces one F, one invalidation audit and one version increment. Explicit departure/replay still permits F without an invalidation audit. A deliberately unchanged-version fixture removes supersession proof after GET and verifies the locked recheck rejects the old candidate result. Unit coverage verifies READ/WRITE authorization intent.
- PostgreSQL migration: all 21 migrations from empty; 20-migration populated baseline upgraded with full contents of 17 existing tables unchanged, including route receipts, user ExecutionEvent/ACTUAL, capabilities and Ground Transit observation/state history. Source evidence FK targets are checked explicitly.
- Existing P4/P5/P5E1/P5E2 suites retain FULL_CORRIDOR/SUFFIX, confirmed-node authorization, historical anchor/reference safeguards, v2/v3/v4, Undo/idempotency/concurrency, monitoring/capability/observation order/recovery and owner isolation.
- Compose extends the existing chain: explicit initial Query/Preview/Adopt, real Worker accepted short-turn E with vehicle ACTUAL, read-only resolved candidate and zero auto-created origin, explicit manual confirm, unchanged itinerary/route/planning, unresolved handoff, explicit departure. Initial route construction is explicit fixture setup; no E→D query is issued. Existing Batch 4 suffix/Undo acceptance remains present.

## Cloud acceptance

First acceptance environment: Node 24.19.0, pnpm 11.19.0, PostgreSQL 17.11 and Docker Compose. Only isolated synthetic databases are used; credentials, build/network configuration and raw logs stay outside Git.

Frozen install, Prisma generate/validate, format/check, lint, full typecheck and build: PASS. Blocking repair final Unit: **51 files / 601 tests PASS**. PostgreSQL 17 full integration: **27 files / 373 tests PASS** (Persistence 18/77, API 9/296). This includes the 21 foundation HTTP cases plus six repair cases, and two migration cases. Focused repair: **7/7 PASS**, including the extended original later-execution test. The pre-fix PostgreSQL reproduction failed at F confirmation with 409 EXTERNAL_ORIGIN_CONFLICT after GET had returned CONFIRMATION_REQUIRED. Clean migration: all 21 applied on the new isolated repair database; populated migration: 17 existing tables preserved. Existing Worker regressions are included in the Unit suite; API/Worker builds pass and their actual health/lifecycle is checked by Compose. Debug Web build remains green.

Final repair Compose revalidation: **PASS**, including the Worker short-turn E candidate, vehicle-ACTUAL negative check, explicit ARRIVED/DEPARTED lifecycle, zero itinerary/planning mutation, existing suffix/Undo, delivery/retry/lease recovery, database outage/recovery and Worker shutdown/restart. Final repair P5B: **5 users / 200 requests PASS**, zero isolation failures, unexpected 5xx or network failures (median 404.41 ms, p95 620.13 ms, max 634.67 ms).

Repair cloud acceptance is complete before updating the original Draft PR #34. Independent GitHub CI must complete verify, Compose verification and P5B acceptance on the submitted HEAD; its run URL/results are recorded in the PR description and final task report. Automatic Query/Preview/Adopt: NO. E→D Query: NO. Real paid provider: NO. Production deployment: NO. Keep Draft and stop for review.
