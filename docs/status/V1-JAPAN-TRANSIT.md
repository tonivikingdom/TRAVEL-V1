# V1 Japan Transit — PR #41 continuation

Recommendation: GPT-5.6 Sol / High; fallback available coding model / High. Actual runtime selection is unknown; no model switch is claimed. Raise effort for time/provenance/concurrency issues.

**PARTIAL overall; scoped Japan live acceptance PASS. Production release is not approved.** Existing [Draft PR #41](https://github.com/tonivikingdom/TRAVEL-V1/pull/41), branch `feat/google-consumer-transit-cloud-dev`. Starting remote HEAD `1f297d924d5869c6f7730e30aa0fd809d2f9132f`; integration base `13e5b1d7aa95bd461f33d4fb0b74e0efbb61fb3b`. Published normal merge `8ea3ea19965d9720cc1f1c8871290c347759e545`, no conflicts or unmerged A/C commits. Local merge `2582092` and repair `5b82175` remain archived. CLI push 401/503 required the authenticated GitHub object/ref tools; identical Git trees were verified before fast-forward publication, no force push. Execution HEAD `09996070d08bfe5bf0035fbf0ae22d6605d4ef45`. Migration **26**, schema/migration delta **0/0**. Final HEAD/CI are recorded in PR and delivery reply, avoiding self-referential commits.

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

**Those original six city/rail PASS are preserved unchanged.** Earlier pre-provenance mixed bus/rail/walking and10→11 runs remain investigation only. The table also preserves the earlier503 failure rather than replacing it with later success. Initial ledger:22 completed operations plus0–1 unknown interrupted operation, upper bound23. After the execution-HEAD CI completed/success, four new serial operations passed; known completed total26, conservative upper bound27. No automatic retries.

## Resumed fresh live acceptance — after green execution HEAD CI

All queries remain **2026-10-06 Asia/Tokyo**, using fresh anonymous contexts, unchanged 45s service deadline and exact response provenance. Four operations only; no six-case rerun or automatic retry. Each context closed and browser disconnected.

| Scenario                                         | Mode/time       | Result                                                                                                                                                                 |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noboribetsu Onsen Hotel Mahoroba → Toya Nonokaze | DEPART_AT 15:00 | PASS,6 candidates; first15:12:06→17:26:10,7 legs WALKING/BUS/WALKING/RAIL/WALKING/BUS/WALKING. Services 登別苫小牧線, Hokuto 16, 洞爺湖線.                             |
| Same, independent fresh Travel query             | ARRIVE_BY 15:00 | PASS,4 candidates; selected12:30:06→14:48:27,7 mixed legs. Fresh Query→Snapshot→Preview→explicit Adopt→Undo passed; actual loopback HTTP on both hops, Provider HTTP1. |
| Sapporo→Otaru, compare preserved10:00            | DEPART_AT 11:00 | PASS,6 candidates; first11:00→11:41 instead of10:00→10:41.                                                                                                             |
| Same, compare preserved10:00 deadline            | ARRIVE_BY 11:00 | PASS,6 candidates; first10:00→10:41 instead of09:10→09:45. All arrivals satisfy requested ceiling.                                                                     |

Fresh Travel Query/Preview leave version3 and original plan unchanged; explicit Adopt/Undo produce4/5 and restore2 original nodes/identities. Every live candidate Snapshot matches the new query. Walking clocks remain null; six known transit time points become PLANNED facts with original live fetchedAt, not ACTUAL. Post-run read-only PostgreSQL audit confirms4 snapshots,1 Preview,2 explicit operation receipts,0 authoring receipts and0 ExecutionEvents. No replay or synthetic route substitution. Exact sidecar query echo rounds coordinates through the existing unmodified adapter.

The new PASS does not erase the previously observed Google directions503, establish long-running reliability, prove fares/timetables against operators or close supplier/legal gates. No further live requests were made after these four operations.

## Travel chain and ownership

Unmodified `GoogleConsumerExperimentalRouteProvider` validated each final live success through real loopback sidecar HTTP, including exact query echo and existing candidate contracts. Failure becomes PROVIDER_UNAVAILABLE, never empty/no routes.

Tokyo candidates in both modes then passed **CAPTURED_LIVE_REPLAY** through actual Travel HTTP/isolated PostgreSQL: Query → immutable Snapshot → Preview → explicit Adopt → Undo; six/four candidates, original fetchedAt retained, versions3→4→5, no ExecutionEvent, no Google calls. Replay is separate from the resumed fresh ARRIVE_BY live sidecar→Travel E2E above. An incomplete acceptance reconstruction was rejected PREVIEW_STALE for missing canonical leg refs; harness now reconstructs the unmodified adapter's ref convention. No production guard changed.

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

Execution HEAD: frozen install (432 supply-chain entries), Prisma generate/validate, format/lint/typecheck/build all PASS. Unit **896** including sidecar **75**, PostgreSQL **672** (106+566), Chromium **281**, synthetic browser harness and repeated captured replay both modes PASS locally. First PostgreSQL run had1 disk-full53100 failure/671PASS during Docker work; after own resource cleanup the complete unchanged suite reran672PASS. Populated migrate deploy:26/no pending; clean CI deploy26. No dependency-policy or TLS relaxation. The local workspace-only domain dependency must match the lock importer; no remote dependency upgrade or policy relaxation.

New all-intercepted **SYNTHETIC browser harness** covers both modes, stale request rejection, unchanged time/no extra response and cleanup, zero live requests. Verify CI runs it after browser installation, followed by the unchanged full Chromium/WebKit Web suite. No removed assertion/skip. Main midnight, failure hardening, authoring, Impact and controlled-replanning source remain unchanged.

Local Compose/P5B were attempted: earlier missing session CA and registry503; resume Compose stopped at build/install, while P5B built images then failed container creation with no space left on device. Only own generated images were cleaned. Temporary BuildKit read-only CA trust kept strict TLS; no tracked deployment change. Local Docker outcomes remain BLOCKED, not PASS. Runtime recovery preserved existing work/evidence; unrelated test-generated Place Search PNGs were restored.

Execution CI [37197631628](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/37197631628): **verify, Compose verification, P5B acceptance all completed/success** on0999607. CI confirms896 Unit,672 PostgreSQL,281 Chromium+281 WebKit (562), synthetic browser harness,26 clean migrations and5-user/200-request P5B with0 isolation failure/unexpected5xx/network failure. These jobs do no Google live. The four live operations were then executed on this validated source. Final evidence/documentation commit CI must also be completed/success; final SHA/run are recorded in PR #41 and delivery reply rather than a self-referential commit.

## Main change observed before final evidence publication

Final fetch observed main `47c4af9a6dda9d4858e138463478b88dc8f35524` (`feat(providers): add regional Baidu and Google routing foundation`), superseding13e5b1d after the execution/live acceptance. PR #41 feature branch remains based on the authorized13e5b1d integration; no automatic merge/rebase or unmerged A/C branch was imported. Branch production source still matches that integration base. Final PR CI may test GitHub's merge ref against the new main; its exact checkout/base and results are recorded separately in PR/delivery. The resumed fresh live chain proves the existing adapter on0999607, not live Region Router dispatch. Region/Japan injection remains an integration requirement owned by A. Both branches still have26 migrations.

## Remaining gates

Final-provenance mixed rail/bus/walking in both modes, both-mode time-shift comparison and fresh ARRIVE_BY Query/Preview/Adopt/Undo now **PASS** within these scenarios. Historical fresh DEPART_AT E2E remains historical; this resumed batch does not claim a new DEPART_AT full chain. Upstream503 reliability, visible-calendar-month restriction, real cross-midnight route, actual restriction/no-routes/schema-drift observations, broader coverage and long-running stability remain **OPEN/PARTIAL**.

**F-05/F-06 OPEN:** anonymous Consumer access is not official Routes API entitlement, supplier storage/retention/TTL/deletion/attribution rights, quota/pricing/coverage guarantees or production approval. Public Maps terms fetch returned503 in the interrupted attempt; no account-specific permission established. Existing Travel snapshot TTL preserves observed timestamps but does not establish supplier retention permission. Real operator timetable/fare truth remains open.

Keep Open/Draft; no Ready/merge/production deploy, paid provider/purchase, A/C changes or next task. Stop for human review after evidence and final CI.
