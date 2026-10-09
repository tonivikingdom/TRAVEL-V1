# V1 Real Provider Live Contract Repair

Recommended model: GPT-6.1 Sol / High; actual client subconfiguration cannot be verified. Starting branch/base: `fix/pr53-review-findings`, `9d32c0b23198d35b6f2873d7d9016365f934d635`. Repair branch: `fix/v1-real-provider-contracts`. This is a stacked Draft PR against that base, not main. B/C branches are untouched.

## Zero-request diagnosis and code repair

Four SYNTHETIC regressions failed before the implementation changed: Google Places serialized `placeId`, `name` and `timeZone` into LatLng; NOW driving sent a captured timestamp; explicit past departure was rewritten to NOW; invalid departure was not rejected before dispatch. All four now pass without any live requests.

- **CODE_FIXED — Google Places:** `locationBias.circle.center` contains only latitude/longitude. Full trusted application locations never leak additional fields into the Google request schema.
- **CODE_FIXED — Google NOW driving:** omit `departureTime` when there is no explicit future requirement; retain TRAFFIC_AWARE. Google uses its current-departure semantics. A future independent earliest bound is sent explicitly. DEPART_AT preserves the absolute requested instant; invalid/past instants, invalid zones or an explicit time earlier than the hard earliest bound fail closed instead of being moved to NOW. ARRIVE_BY remains unsupported. Doctor reads its clock per capability/adapter call, including after earlier asynchronous responses.
- **CODE_FIXED — safe diagnosis/selection:** `--only=<capability-id,...>` rejects empty, duplicate and unknown selections before any requests. Default existing nine-capability budget remains; each selected capability dispatches at most once, with no retry. No approval values are changed. The actual repository command is `provider:doctor`, running Node `--use-env-proxy`; no `provider` alias exists.
- **STILL_BLOCKED — trustworthy access legs:** existing 100 m Google / 30 m Baidu exclusion limits and six-decimal coordinate equivalence remain intact, with the old `INVALID_PROVIDER_ENDPOINTS` error retained. A non-equivalent nearby endpoint still fails. No snapped coordinates are rewritten into the requested place. A route needing access-leg evidence requires a separately authorized design, not weaker validation.

Diagnostics contain only closed stages, fixed field paths/codes and explicitly allowed numeric Baidu business statuses. Errors, messages, payloads, locations, request headers, URLs, AKs and secret placeholders are never emitted. Runtime output whitelisting rejects unknown paths/codes and removes extra properties. SYNTHETIC secret-marker regressions cover all four bindings, provider free-text/errors and thrown exceptions. Domain candidate and trusted-endpoint validation are reused by Doctor, not reimplemented.

## Baidu classification

Official reference: [Baidu constants](https://github.com/baidu-maps/webapi-skills/blob/67d85191b91755b447088ee8c492a3fb54d99e8b/skills/baidu-map-webapi/references/constants.md), read through the public GitHub API with no Provider calls. Status 240 is application service disabled; 260 is service name nonexistent/request-version diagnosis; 261 is service retired. Status 3 is key permission verification; 9 is advanced permission verification; 2/8 are request/parse errors; 4/302/401 are quota limits. Authentication/application/IP/SN codes retain fixed authentication labels. HTTP failures cannot be overridden by a business success or disable code. Unknown codes are not printed as arbitrary numbers.

`ADVANCED_PERMISSION_REQUIRED` / `commercialAuthorization=REVIEW_REQUIRED` means entitlement needs account review. It does **not** prove a price, subscription, entitlement or purchase requirement. `NOT_INDICATED` is absence of that signal, not free-use authorization. Production gates remain false. Future driving still requires its separate production approval; an HTTP 200 alone never proves future-prediction entitlement.

The earlier five Baidu route responses were recorded only as HTTP 200 / API_NOT_ENABLED, without their numeric codes. They cannot now be retrospectively identified as 240 rather than 260/261. **PROVIDER_PERMISSION_REQUIRED remains a possible account prerequisite, not a verified common root cause.** All five are STILL_BLOCKED pending code/account/service verification; none was requested again in this task.

## Controlled live acceptance — 2026-10-08

Before dispatch: exact base verified, all four bindings SET, Node 24.19.0 / pnpm 11.19.0, frozen install and tests passed, HTTPS proxy/CA set and the three server hosts listed. Platform readiness metadata remains unknown; SET/allowlist evidence alone is not claimed as successful secret substitution. Actual HTTP/contract results below provide the operation-specific evidence.

Command: `CI=true pnpm provider:doctor --live --only=google-places,google-walking,google-driving,baidu-place`.

**Exactly four dispatched Provider requests, one per capability, no retries, no additional diagnostic requests; zero browser SDK requests.** Previous baseline acceptance (nine requests) is historical comparison, not rerun here. No database, snapshot, Preview, Adopt, execution or production mutation is part of Doctor.

| Capability                                                           | Before                  | This task                                   | HTTP                | Interpretation                                                                                                                                         |
| -------------------------------------------------------------------- | ----------------------- | ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google Places                                                        | 400 / PROVIDER_ERROR    | CODE_FIXED / LIVE_CONTRACT_PASS             | 200                 | Response shape, coordinates, region and identity accepted. Network/authentication succeeded for this operation.                                        |
| Google WALKING                                                       | 200 / CONTRACT_MISMATCH | STILL_BLOCKED / CONTRACT_MISMATCH           | 200                 | Route/leg shape and endpoint parsing passed; ENDPOINT_BINDING / OFFSET_LIMIT_EXCEEDED. Does not prove valid access legs.                               |
| Google DRIVING                                                       | 400 / PROVIDER_ERROR    | NOW request CODE_FIXED; route STILL_BLOCKED | 200                 | The 400 is resolved; same endpoint-offset rejection.                                                                                                   |
| Baidu Place                                                          | 200 / CONTRACT_MISMATCH | STILL_BLOCKED / CONTRACT_MISMATCH           | 200                 | RESPONSE_SHAPE / response / INVALID_SHAPE: body did not parse as JSON. Place fields, coordinate conversion, region and authentication were not proven. |
| Baidu WALKING / current DRIVING / TRANSIT / CYCLING / FUTURE DRIVING | 200 / API_NOT_ENABLED   | STILL_BLOCKED, not retested                 | Historical 200 only | Numeric code/account root cause unavailable; no new request authorized or sent.                                                                        |

The Google route duration and final Domain acceptance were not reached in these live responses because binding failed first. HTTP connectivity and partial response structure are different from whole response validity, Adapter acceptance and production authorization. Baidu's non-JSON HTTP 200 cannot establish whether the body came from the Provider or an intermediary. No raw body was retained or output. Do not label it a coordinate bug, invalid Key or entitlement success without evidence.

Sanitized artifact: [live acceptance JSON](assets/real-provider-contracts/live-acceptance.json). It contains only fixed diagnostics, status/counts, binding SET flags, all-false gates and required host names. No Key, URL, header, location or raw response is present. Evidence belongs to the implementation in this repair PR; no implementation changes followed the four-call acceptance.

## Actual validation

| Check                                               | Result                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Frozen install / Prisma validate and generate       | PASS                                                                              |
| Format / diff check / lint / full typecheck / build | PASS                                                                              |
| Unit                                                | 1,137 PASS                                                                        |
| Focused provider/Doctor/endpoint regressions        | 157 PASS, including unchanged strict endpoint assertions                          |
| PostgreSQL 17                                       | 687 PASS: 106 persistence + 581 API, isolated task-owned DB                       |
| Clean migration deploy                              | 27 existing migrations PASS                                                       |
| Config-only selected Doctor                         | PASS, all four SET, 0 requests                                                    |
| Controlled live Doctor                              | 4 requests; 1 LIVE_CONTRACT_PASS, 3 CONTRACT_MISMATCH; exit 1 correctly preserved |

Unit, integration and build subprocesses unset all four actual Provider bindings, so real credentials do not enter test fixtures or compiled client bundles. API integration retains owner isolation, Query/Preview footprints, adoption/Undo and concurrency assertions. Schema/migration/HTTP API delta **0/0/0**; migration count remains **27**, inherited from the base. No dependency/lockfile, B/C branch, production approval or deployment change. No broader Web/UI/Provider integration is claimed.

## Follow-up priorities and stop

1. Preserve the accepted Google Places schema and NOW fix. Real results do not close F-05/F-06 or approve storage/attribution/deletion/pricing/production use.
2. Investigate the Baidu non-JSON response through an independently authorized safe diagnostic task. This task has exhausted its four-call budget; no guess or retry was used.
3. Verify the five Baidu route numeric business codes and account/service/version prerequisites in a separately authorized task; do not uniformly prescribe paid permission from historical HTTP 200.
4. Design trusted access-leg evidence if ordinary snapped routes are needed. No arbitrary endpoint-radius expansion, coordinate fabrication or Domain guard removal.

Keep Draft, no merge/deployment/automatic approval. Final GitHub CI is reported in the PR and delivery message rather than embedding a self-referential HEAD here.
