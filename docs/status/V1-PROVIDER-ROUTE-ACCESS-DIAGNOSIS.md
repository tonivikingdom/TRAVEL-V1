# V1 Provider Route Access & Baidu Response Diagnosis

Starting branch/base: `fix/v1-real-provider-contracts`, `b5523548340d421443afeb1c99dcc6d3afb26f59`. Investigation branch: `investigate/v1-provider-route-access`. Recommended model follows the previous user setting, GPT-6.1 Sol / High; actual client subconfiguration is not verifiable. No escalation or model switch is claimed. This task is a stacked Draft PR, not a main integration or deployment. B/C branches remain untouched.

## Zero-request implementation matrix

| Boundary                                            | Existing evidence                                                                                                                                  | Outcome in this task                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Google Places                                       | Adapter outputs `provider=google`, `externalId`/`providerPlaceRef` from the returned Google `id`, WGS84 coordinates; timezone remains unknown      | Reused in SYNTHETIC identity characterization                             |
| Explicit selection                                  | Application HMAC binds the returned candidate to owner/Trip/expiry; authoring receives `baseTripVersion`                                           | Existing protection retained                                              |
| Stored identity                                     | Current selection issues CUSTOM Place authoring and writes attribution/Provider ID only into a note; it does not propagate typed Provider identity | Gap documented; notes are never parsed as trusted evidence                |
| Route input                                         | `RouteProviderLocationInput` carries internal opaque `placeId`, name, coordinates and timezone; Query drops node Provider metadata                 | Internal `placeId` must never be treated as a Google Place ID             |
| Google request                                      | Current adapter uses coordinate waypoints                                                                                                          | Unchanged; no unverified Place ID override added                          |
| Endpoint binding                                    | Requested Place and Provider road endpoint must be equivalent at six decimals, within existing exclusion limits, distinct and correctly oriented   | All guards retained, including 100 m Google / 30 m Baidu exclusion limits |
| Response diagnosis                                  | Doctor previously retained HTTP and JSON-parse outcome only                                                                                        | Closed content/transport/intermediary evidence added in Doctor only       |
| Schema, Domain, Application runtime, API, UI, gates | No reliable access-leg contract presently available                                                                                                | No changes; minimum follow-up design below                                |

The first five new Doctor assertions failed on the starting implementation, then passed after diagnostic wiring. Study tests exercise actual Google Places normalization, existing signed selection and the current route adapter: internal IDs and runtime-injected foreign Provider refs never become Google Place ID waypoints, and Place-ID-looking metadata cannot bypass nearby/over-limit/reversed/collapsed endpoint rejection.

## Google official contract and minimum design

Official Google API definitions, pinned to [`e63fb893d2fd6767bc9ca4116401f2d1e9202db3`](https://github.com/googleapis/googleapis/tree/e63fb893d2fd6767bc9ca4116401f2d1e9202db3):

- [`Waypoint`](https://github.com/googleapis/googleapis/blob/e63fb893d2fd6767bc9ca4116401f2d1e9202db3/google/maps/routing/v2/waypoint.proto): `location_type` is a **oneof** of Location / POI Place ID / address / navigation token. REST uses `placeId`, not an internal UUID, resource display name or a simultaneous coordinate-plus-ID pair.
- [`Place`](https://github.com/googleapis/googleapis/blob/e63fb893d2fd6767bc9ca4116401f2d1e9202db3/google/maps/places/v1/place.proto): `id` is the unique Provider identifier; `name` is the separate `places/{place_id}` resource name. Moved-place fields show that identity can need revalidation rather than being treated as permanent.
- [`RouteLeg`](https://github.com/googleapis/googleapis/blob/e63fb893d2fd6767bc9ca4116401f2d1e9202db3/google/maps/routing/v2/route.proto): start/end locations can differ from the requested origin/destination and lie on a road. A Place ID waypoint therefore cannot, by itself, prove a complete connection to the requested Place.

The present contract does not safely carry the full identity/provenance into Route Query. No production Place ID dispatch or Domain expansion is implemented here. A minimum separately authorized follow-up would:

1. Retain typed **server-sourced** Google selection identity alongside its exact selected WGS84 location. Reuse existing node Provider columns if proven sufficient; do not trust note text, a string prefix, a client-supplied Provider name, a raw GPS point or an external-origin hub ref as a Google Place ID. The selection HMAC/owner/Trip/expiry and explicit authoring version checks remain mandatory. Coordinate/name edits must invalidate or reverify the association rather than leave an old ID silently attached.
2. Add an optional trusted identity to the Application Provider port, sourced from the current owned node/place, never reconstructed by Web. Bind node ID, internal Place ID, Provider/ref, coordinates/coordinate version, region, timezone, Trip/version and a canonical planning-facts identity. Validate before dispatch and again under the existing locked snapshot persistence/version boundary; changes reject rather than mixing evidence.
3. Allow Google `placeId` only for verified Google identity in JAPAN/GLOBAL_OTHER under current region policy. Mainland/uncertain/cross-region/foreign Provider IDs fail closed. A fallback coordinate waypoint must retain current endpoint guards. Unknown timezone stays unknown. External origins continue their existing trusted-origin contract; a hub ID is not a Place ID.
4. Keep requested Place and returned road endpoint as distinct evidence. First test whether genuine Place ID waypoints improve entrance selection **without** changing endpoint acceptance. Non-equivalent endpoints remain blocked even when a Provider accepted the ID; the response does not itself echo enough identity/connection evidence to authorize rewriting.
5. If reliable access is needed, introduce the smallest reviewed access-evidence contract: immutable requested-location snapshot, returned road endpoint, Provider route/observation association, and an independently evidenced connection with its own endpoints, mode, geometry when available, duration and validity. Only complete verified access can be represented using real candidate legs and included in total timing. Missing entrance/link/duration evidence remains unsupported. No fabricated WALKING segment, guessed seconds, coordinate substitution, new arrival fact or automatic Adopt.

Items 1–5 are **design proposals, not delivered capabilities**. Exact schema/port changes require a separate review; no migration is justified or added by this investigation. A Provider POI center is not automatically a verified entrance. No larger acceptance radius or removal of #54 protections is proposed.

## Baidu direction/v2 permission contract

Official Baidu references, pinned to [`67d85191b91755b447088ee8c492a3fb54d99e8b`](https://github.com/baidu-maps/webapi-skills/tree/67d85191b91755b447088ee8c492a3fb54d99e8b):

- [`walking_route_planning`](https://github.com/baidu-maps/webapi-skills/blob/67d85191b91755b447088ee8c492a3fb54d99e8b/skills/baidu-map-webapi/references/walking_route_planning.md): GET direction/v2/walking, service `direction_v2_walking`; server AK, optional SN/IP account checks, explicit input/output coordinate systems, JSON output. Optional POI UID may improve routing but is not an access-proof exemption.
- [`constants`](https://github.com/baidu-maps/webapi-skills/blob/67d85191b91755b447088ee8c492a3fb54d99e8b/skills/baidu-map-webapi/references/constants.md): 240 means an APP service is disabled; 3 is permission verification; 9 is advanced permission; 203 is APP type; 210/211 IP/SN verification; 260 nonexistent service/request-version diagnosis; 261 retired service. HTTP 200 does not replace this business status.
- [`future_driving_route`](https://github.com/baidu-maps/webapi-skills/blob/67d85191b91755b447088ee8c492a3fb54d99e8b/skills/baidu-map-webapi/references/capabilities/future_driving_route.md): future driving requires independently enabled advanced permission and a valid specified future time within seven days. Neither current driving nor walking proves this permission. No future-driving request or gate change occurs here.

Public documentation is not account entitlement. Only walking is eligible for one request in this task; no result is generalized to driving/transit/cycling/future driving. There is no purchase, billing/resource creation, SN bypass or account modification.

## Strictly sanitized response evidence

`scripts/provider-response-diagnostics.ts`, consumed by the existing Doctor, returns only:

- Content-Type category: JSON / HTML / XML / TEXT / OTHER / MISSING. Header parameters and values are discarded.
- Body category: JSON / HTML / XML / EMPTY / OTHER. JSON means parseable JSON, not a valid Provider response; HTML/XML are fixed signature classifications, not validated documents.
- Target: EXPECTED_HTTPS_TARGET / UNEXPECTED_TARGET / UNVERIFIABLE, based on exact allowed HTTPS host/path, response URL, no embedded userinfo and no redirects. This verifies transport metadata only. It does not prove which party authored the body or authenticated the AK.
- Fixed intermediary signal: PROXY_POLICY_DENIED / GATEWAY_ERROR_SIGNAL / INTERMEDIARY_HEADER_PRESENT / NO_FIXED_SIGNAL. A signal is a hint, not a proven intermediary root cause; absence does not prove direct Provider delivery.
- Source remains **PROVIDER_OR_INTERMEDIARY_UNVERIFIED**. In the proxy-backed environment, URL matching and HTTP 200 alone cannot distinguish Provider and intermediary content.

Only Content-Type and Via presence are consulted; no full header enumeration. Runtime whitelisting strips extra properties and rejects unknown labels. No raw body/HTML/prefix, URL/query/AK, header values, cookies, secret placeholders, private locations or Provider free-text message are emitted or retained. Tests inject those markers into all response forms and unexpected fields. Existing allowed numerical Baidu business-status classification remains separate.

## Actual validation and request budget

The budget was at most one Baidu Place, one Baidu WALKING and one Google WALKING using an already verified Place ID pair, no retries or additional Places calls. **Actual Provider requests: 2**, one Baidu Place and one Baidu WALKING. Google WALKING: 0; all other capabilities: 0. No implementation change followed these calls; subsequent changes are fixture assertions and delivery documentation/artifact only.

Google live eligibility: **SKIPPED / NO_TRUSTED_PLACE_ID_PAIR**. Prior sanitized acceptance retained PASS/stages but no ID/location/provenance pair; current selection/Route port cannot reconstruct it. Synthetic IDs, note strings and public example IDs are not real evidence. No extra Places request is made to obtain an ID.

Before dispatch: Node 24.19.0 / pnpm 11.19.0, frozen install, Mock/whitelist checks, full lint/typecheck/Unit/build, isolated PostgreSQL, format and config-only Doctor passed. Four bindings SET, proxy/CA SET, required Baidu HTTPS host listed. Runtime readiness observations remain unknown; no enforced/ready metadata claim is inferred. Actual HTTP evidence is operation-specific.

Command, executed once: `CI=true pnpm provider:doctor --live --only=baidu-place,baidu-walking`. The existing one-attempt-per-capability guard remains. Exit 1 correctly reports unresolved capabilities, not a failed regression suite. No raw response was retained. Safe artifact: [live diagnosis JSON](assets/provider-route-access/live-diagnosis.json).

| Capability                         | Network / HTTP                                | Response contract                                                          | Location binding / formal Adapter               | Conclusion                                                                                                        |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Baidu Place                        | Response received, 200; EXPECTED_HTTPS_TARGET | Content-Type XML; body XML signature; JSON parse rejected. NO_FIXED_SIGNAL | Not reached / not accepted                      | STILL_BLOCKED — JSON output contract not met                                                                      |
| Baidu WALKING                      | Response received, 200; EXPECTED_HTTPS_TARGET | Content-Type/body JSON; allowed business status **240**, API_NOT_ENABLED   | Route fields/binding not reached / not accepted | ACCOUNT_ACTION_REQUIRED — verify and, if authorized, enable the specific walking service for the bound server APP |
| Google WALKING / verified Place ID | Skipped, 0 requests                           | No trusted existing ID/location pair                                       | Not tested; no adapter change                   | STILL_BLOCKED — identity propagation/access evidence design required                                              |

**CODE_FIXED** here means the Doctor can safely distinguish body format, transport target, business status and intermediary hints. It does not mean either remaining Provider capability is now accepted. Place still explicitly requests `output=json` with no callback; a regression verifies that an XML response is rejected without retry, JSONP fallback or guessed XML business code. No endpoint/version/coordinate or AK root cause is assigned without further evidence.

For both responses the source remains PROVIDER_OR_INTERMEDIARY_UNVERIFIED. There was no fixed gateway/policy denial signal; that does not prove no intermediary was involved. HTTP 200 and target matching do not prove the AK authenticated, the account is entitled, location binding passed or a route is adoptable. Walking's observed 240 is the service-disabled business signal and a narrowly scoped account action, not proof of all API permissions or a commercial purchase requirement. Do not generalize to the other four routes. Future driving retains separate advanced approval, untested and unchanged.

| Validation                                                       | Actual result                                  |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Frozen install / Prisma generate and validate                    | PASS                                           |
| Format / lint / full typecheck / build / diff check              | PASS                                           |
| Unit                                                             | 1,184 PASS                                     |
| Focused diagnostic/identity/strict endpoint/provider regressions | 179 PASS                                       |
| PostgreSQL 17                                                    | 687 PASS: 106 persistence + 581 API            |
| Clean migrate deploy                                             | 27 existing migrations PASS                    |
| Config-only Doctor                                               | Four SET, 0 requests; gates unchanged/FALSE    |
| Live selected Doctor                                             | 2 attempts, no retry; unresolved results above |

Test/build subprocesses unset the four real Provider bindings; fixtures are SYNTHETIC and the PostgreSQL DB is task-owned. Schema/migration/HTTP API delta **0/0/0**, 27 inherited migrations. Production adapters, Application runtime, Domain, Web/UI, existing guards, dependencies, lockfile and B/C branches are unchanged. Final exact-HEAD GitHub CI is reported in the PR/delivery rather than creating a self-referential commit.

Follow-up order: verify the account's walking service checkbox/APP type/IP or SN requirements using account evidence; independently diagnose Place's unexpected XML while preserving safe response handling and checking request/version/proxy behavior; then review typed Google identity propagation and actual access evidence before another authorized real Google test. These are follow-up recommendations, not automatic authorization or a prescription to purchase a service. No more requests are made in this task.

F-05/F-06 remain OPEN. Production approvals and deployment remain unchanged; keep Draft and stop after delivery.
