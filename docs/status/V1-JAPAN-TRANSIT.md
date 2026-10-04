# V1 Japan Transit — PR #41 continuation

Recommendation: GPT-5.6 Sol / High; fallback available coding model / High. Actual runtime selection is unknown; no model switch is claimed. Raise effort for time/provenance/concurrency issues.

**PARTIAL; not V1 release ready.** Existing [Draft PR #41](https://github.com/tonivikingdom/TRAVEL-V1/pull/41), branch `feat/google-consumer-transit-cloud-dev`. Starting remote HEAD `1f297d924d5869c6f7730e30aa0fd809d2f9132f`; integration base `13e5b1d7aa95bd461f33d4fb0b74e0efbb61fb3b`. Normal merge `25820925b058c05caa389648aac80c6c92fb952b`, no conflicts or unmerged A/C commits. Migration **26**, schema/migration delta **0/0**. Final HEAD/CI are recorded in PR and delivery reply, avoiding self-referential commits.

## Audit and existing repair

Old branch contained the browser service, unchanged Travel adapter, historical four service-level successes and DEPART_AT live Adopt/Undo. Latest historical ARRIVE_BY Travel attempt timed out at response-verification. A fresh baseline ARRIVE_BY succeeded; the historical timeout's exact cause remains unconfirmed. Historical PASS does not prove current operation.

Existing unpushed repair was preserved after environment recovery. Fixed date/time sleeps and retry-poll sleeps are replaced by actual applied date state and bounded response/DOM notifications. Revision tracking prevents a lost update between inspection and subscription. Responses remain available when unchanged time input emits no new response. Context cleanup, single concurrency/BUSY, 12s UI/verification waits, 45s total deadline, body/count limits, bearer auth, loopback and disabled defaults remain.

Investigation found that retaining every response could accept an earlier-date ARRIVE_BY response: its clock labels matched and arrival preceded the deadline. That run is explicitly **INVALID_RESPONSE_PROVENANCE**, never final PASS. Repair passively matches the page-emitted directions request's exact mode/date/time in the observed `19m3/1e/2e/3j` time structure before reading its response. This does not generate a private request. Unknown structures fail closed. UI mode/date/time, page state, timezone, endpoints, all-candidate UTC constraints, leg ordering/duration and visible-route evidence still must agree. No arbitrary date filtering or weakened production Preview/Domain guard.

The verified matrix later encountered directions HTTP503 and missing Directions main, originally surfaced as a time-mode timeout. The final added regression confirms that an observed upstream HTTP failure retains `UPSTREAM_ERROR`, not NO_ROUTES or merely UI timeout. Challenge detection/cancellation retain their precedence. Exact upstream503 cause is unknown; no CAPTCHA/account block/policy denial is inferred.

## Preserved current live evidence

Queries on **2026-10-06 Asia/Tokyo**. Anonymous fresh contexts; planned operations serial, at least 15s apart. Coordinates are explicit acceptance query points, not new geocoding claims. [Sanitized evidence](japan-transit-v1-evidence.json) contains every candidate, absolute clocks, legs/services, adapter status, applied state and context cleanup. Times are planned transit facts, not vehicle ACTUAL or user execution.

| Query                                                                  | Mode/time       | Final provenance-verified result                      |
| ---------------------------------------------------------------------- | --------------- | ----------------------------------------------------- |
| Sapporo Station → Otaru Station                                        | DEPART_AT 10:00 | PASS, 6 candidates                                    |
| Same                                                                   | ARRIVE_BY 10:00 | PASS, 6 candidates                                    |
| Tokyo Station query point → Shinjuku Station query point               | DEPART_AT 10:00 | PASS, 6 candidates, walking/rail/walking              |
| Same                                                                   | ARRIVE_BY 10:00 | PASS, 4 candidates                                    |
| Osaka Station query point → Kyoto Station query point                  | DEPART_AT 10:00 | PASS, 4 candidates, rail/walking                      |
| Same                                                                   | ARRIVE_BY 10:00 | PASS, 5 candidates; alternate three-transit-leg route |
| Hotel Mahoroba, Noboribetsu Onsen → The Lake View Toya Nonokaze Resort | DEPART_AT 15:00 | BLOCKED, directions503/no reliable result             |
| Same                                                                   | ARRIVE_BY 15:00 | NOT_RUN after preceding failure                       |

**DEPART_AT and ARRIVE_BY live PASS for those six city/rail operations; overall PARTIAL.** Earlier pre-provenance mixed bus/rail/walking results and 10→11 time contrast remain investigation only. Final-provenance mixed and shifted-clock acceptance remain open. Initial ledger: 22 completed operations plus 0–1 unknown interrupted operation, upper bound23. No automatic retries. New resumed acceptance is recorded separately after execution-HEAD CI; no new live PASS is predeclared.

## Travel chain and ownership

Unmodified `GoogleConsumerExperimentalRouteProvider` validated each final live success through real loopback sidecar HTTP, including exact query echo and existing candidate contracts. Failure becomes PROVIDER_UNAVAILABLE, never empty/no routes.

Tokyo candidates in both modes then passed **CAPTURED_LIVE_REPLAY** through actual Travel HTTP/isolated PostgreSQL: Query → immutable Snapshot → Preview → explicit Adopt → Undo; six/four candidates, original fetchedAt retained, versions3→4→5, no ExecutionEvent, no Google calls. Replay is not fresh live sidecar→Travel E2E. An incomplete acceptance reconstruction was rejected PREVIEW_STALE for missing canonical leg refs; harness now reconstructs the unmodified adapter's ref convention. No production guard changed.

B does not implement Japan detection/Region Router/Baidu/global Google fallback. A must inject this Japan transit capability through its own router; existing experimental global ROUTE_PROVIDER ownership is not expanded. No Place Search/Mini Map/navigation/Web change. Staging/production prohibition remains.

Travel API/contract/Domain delta **0/0/0**; schema/migration delta **0/0**. Sidecar remains `POST /v1/transit/search`, compatible success/error contract unchanged. Query is explicit Provider I/O; Preview is read-only; Adopt/Undo only run with explicit isolated acceptance acknowledgement.

## Cloud operation/errors

[README](../../services/google-consumer-transit/README.md) and [.env.dev.example](../../services/google-consumer-transit/.env.dev.example): `pnpm --filter @travel/google-consumer-transit dev`, or build then `start`; 127.0.0.1:8787, dedicated ≥32-character bearer token, disabled default, Chromium, 45000ms deadline, concurrency1. `GET /health` does no Google/browser I/O; search requires auth. No unauthenticated public service.

| Category                                         | Existing compatible code             | Travel                |
| ------------------------------------------------ | ------------------------------------ | --------------------- |
| No routes with verified empty body + UI evidence | NO_ROUTES                            | NO_MATCHING_CANDIDATE |
| Unsupported query/mode                           | UNSUPPORTED_QUERY / UNSUPPORTED_MODE | UNSUPPORTED_QUERY     |
| Access restricted                                | UPSTREAM_BLOCKED                     | PROVIDER_UNAVAILABLE  |
| Timeout                                          | UPSTREAM_TIMEOUT                     | PROVIDER_UNAVAILABLE  |
| Browser failure                                  | BROWSER_UNAVAILABLE                  | PROVIDER_UNAVAILABLE  |
| Parse failure/mismatched evidence                | SCHEMA_CHANGED / REQUEST_MISMATCH    | PROVIDER_UNAVAILABLE  |
| Upstream HTTP/network failure                    | UPSTREAM_ERROR                       | PROVIDER_UNAVAILABLE  |
| Capacity                                         | BUSY/429                             | PROVIDER_UNAVAILABLE  |

These are explanatory categories, not renamed contract codes. Unknown fields stay null; no raw upstream error/URL/header disclosure. Fresh contexts do not use personal profiles/Cookies/login.

## Validation/resume

Resume: frozen install completed (cached installation also passed all 432 supply-chain policy entries), Prisma generate/validate and format passed. Final Unit **896 PASS**, including sidecar **75** and the added503 regression. Synthetic browser harness passed on installed Chromium. Full typecheck/build/PostgreSQL/Chromium are running; exact execution HEAD CI including WebKit/Compose/P5B is still required. Preserved pre-resume PostgreSQL672 (106+566), Chromium281 and clean26 migrations are historical until rerun; no old result substitutes for final HEAD. The local workspace-only domain dependency must match the lock importer; no remote dependency upgrade or policy relaxation.

New all-intercepted **SYNTHETIC browser harness** covers both modes, stale request rejection, unchanged time/no extra response and cleanup, zero live requests. Verify CI runs it after browser installation, followed by the unchanged full Chromium/WebKit Web suite. No removed assertion/skip. Main midnight, failure hardening, authoring, Impact and controlled-replanning source remain unchanged.

Local Compose/P5B previously attempted: missing session CA, then Docker registry503 after temporary BuildKit read-only CA trust. Strict TLS kept; no tracked Dockerfile/Compose change. Rerun and final CI status must be recorded, not assumed. Runtime exec-server interruption prevented initial document/commit/CI; this resume preserves work and archives original evidence before pushing. Test-generated unrelated Place Search PNGs were restored.

## Remaining gates

Mixed rail/bus/walking final live, final-provenance time-shift comparison, fresh live Travel E2E, upstream503 reliability, visible-calendar-month restriction, real cross-midnight route, actual restriction/no-routes/schema-drift observations and long-running stability remain **OPEN/PARTIAL/BLOCKED** until separately evidenced.

**F-05/F-06 OPEN:** anonymous Consumer access is not official Routes API entitlement, supplier storage/retention/TTL/deletion/attribution rights, quota/pricing/coverage guarantees or production approval. Public Maps terms fetch returned503 in the interrupted attempt; no account-specific permission established. Existing Travel snapshot TTL preserves observed timestamps but does not establish supplier retention permission. Real operator timetable/fare truth remains open.

Keep Open/Draft; no Ready/merge/production deploy, paid provider/purchase, A/C changes or next task. Stop for human review after evidence and final CI.
