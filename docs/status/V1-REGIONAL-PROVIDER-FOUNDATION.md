# V1 Regional Provider Foundation

Starting main: `13e5b1d7aa95bd461f33d4fb0b74e0efbb61fb3b`; migration total **26**. Recommended model GPT-5.6 Sol / High; actual model subconfiguration is not verifiable from this executor. Foundation only: no paid calls, billing setup, production deployment, Japan sidecar implementation or mini-map UI.

## Implementation matrix

| Category        | Implementation                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reuse         | Existing RouteQueryService, PlaceSearchService, normalized candidates, endpoint/time validation, ranking, snapshot locks, Preview/Adopt/Undo and owner scope           |
| B Router        | One coordinate-based region policy; independent Baidu/Google slots; explicit route intent; owner/Trip-scoped Place Search context; conservative cross-region rejection |
| C Baidu         | Place v2 contextual search and ordinary Direction Lite adapter; response normalization; BD09→GCJ02→WGS84 numerical conversion; additional coordinate approval gate     |
| D Google        | Places Text Search (New) and ordinary Routes computeRoutes adapter; bounded fields and HTTP calls; no Consumer sidecar copy                                            |
| E B/C ownership | B implements/configures Japan Transit slot; C implements map UI using the shared regional capability projection                                                        |

No second Query/risk/replanning engine. The existing Ground Transit alternative service supplies TRANSIT intent while retaining its exact server-reread Handoff locations, version, time bounds and post-response identity checks.

## Region and dispatch policy

Reliable coordinates are **WGS84**, not browser language, timezone, IP, names or locale. `classifyProviderRegion` is the sole classifier; `mapProviderProjection` consumes it. Hong Kong, Macau and Taiwan take GLOBAL_OTHER precedence. Invalid coordinates or locations within one kilometre of a China/Japan boundary return unresolved and fail closed. This is a deterministic V1 routing coverage policy, not a legal boundary authority.

The five boundary geometries are extracted unchanged from Natural Earth's public-domain 1:10m admin-0 GeoJSON. Source: `nvkelso/natural-earth-vector/geojson/ne_10m_admin_0_countries.geojson`, Git blob `5ebc66e25fc1af01edaebe9375c546655e04cf1e`. The initial 1:50m dataset failed a Macau city regression and was replaced before delivery. This finite-resolution dataset cannot prove exact boundary/coastline coverage: unresolved locations require a separately verified location source, never a silent Provider guess.

| Region                                   | Place Search | Ordinary route                                             | Map policy |
| ---------------------------------------- | ------------ | ---------------------------------------------------------- | ---------- |
| MAINLAND_CHINA                           | Baidu        | Baidu                                                      | BAIDU      |
| JAPAN                                    | Google       | Google walking/driving; B's Japan Transit slot for TRANSIT | GOOGLE     |
| GLOBAL_OTHER (including HK/Macau/Taiwan) | Google       | Google                                                     | GOOGLE     |

Japan Transit is an injected `RouteProvider` slot in `createRegionalProviders(env, { japanTransit })` / `RegionalProviderSlots`. Missing slot returns ROUTE_PROVIDER_UNCONFIGURED. No ordinary Google fallback and no experimental sidecar migration. Other unsupported transit modes also return UNSUPPORTED, not fabricated timetables. PR #41 is untouched.

Origin/destination classifications must agree. A MAINLAND_CHINA↔other or JAPAN↔GLOBAL_OTHER route is UNSUPPORTED before any HTTP call. Even Japan/global pairs using Google are conservatively rejected in V1: account-specific cross-border coverage is unverified. No cross-Provider stitching. Ordinary routes within GLOBAL_OTHER are delegated to Google; actual coverage remains Provider/account-dependent.

## Contracts and API wiring

- Existing node/external Query accepts optional `travelMode: WALKING | DRIVING | TRANSIT`. Regional routing requires an explicit intent; legacy synthetic/experimental ports remain compatible. Unknown modes return VALIDATION_ERROR. Node IDs never become external IDs.
- Existing POST `/trips/:tripId/place-search` accepts optional `contextNodeId`. It resolves coordinates from the owned Trip's existing Place node; client-supplied region/coordinates never authorize dispatch. Regional search without reliable context is unavailable; saved-place authoring remains available. The ordinary Web does not yet supply this new regional context: this is an API foundation, not a completed real-search UI rollout.
- New read-only GET `/trips/:tripId/places/:nodeId/provider-capability` returns `RegionalMapCapabilityView`: region/provider kind plus reliable coordinates and WGS84. Missing/foreign node returns 404. This identifies map policy only, **not configured SDK/license/credentials or working map delivery**. C owns map delivery and readiness.
- Place candidates preserve normalized provider ID/ref, coordinates, attribution, and explicit unknown IANA timezone (`null`). No timezone is inferred from region. Existing signed selection evidence remains owner/Trip-bound, zero-write search and explicit selection. The current selection path keeps Provider ID/attribution in the existing source note; no new structured Place metadata storage is invented.
- Route normalization first requires returned endpoint evidence (Google leg locations; Baidu returned BD09 origin/destination converted to WGS84) to match trusted query coordinates exactly through the existing shared endpoint matcher. Missing, contradictory or snapped/non-identical endpoints fail closed; real-world acceptance of this strict boundary remains PARTIAL and is not weakened for Provider convenience. Route normalization exposes only provider-neutral candidate fields. No raw response, geometry, credential, billing data or Provider-specific envelope reaches Domain/Web. Provider candidate references/fare remain null where these APIs do not supply a verified candidate identity/fare.

## Time and coordinate semantics

Existing DEPART_AT/ARRIVE_BY, hard earliest/latest, external server-now floor, timezone authority and all candidate validation remain in RouteQueryService. Ordinary adapters need both endpoint timezones from current server schedule facts or an unambiguous timezone in that owned node’s persisted independent time requirements; no destination/UTC/hint fallback. When no effective zone exists, missing or ambiguous independent requirement zones fail closed. External E continues to use only its trusted copied origin timezone.

Ordinary walking uses Provider duration to construct non-fixed-service **planned** departure/arrival at the authorized departure floor. It is not a timetable, reservation, vehicle ETA/ACTUAL or user execution fact. Google driving forwards DEPART_AT as departureTime with TRAFFIC_AWARE. Baidu driving is supported only at the current departure boundary (30-second request tolerance); future driving is UNSUPPORTED until the relevant API time capability is verified. ARRIVE_BY is UNSUPPORTED in both ordinary adapters; Japan slot may support it through the existing Provider contract. Fractional Google durations round upward to the existing whole-second contract. Query validation still rejects candidates outside bounds.

Baidu Place output is treated as BD09 and numerically converted before exposing WGS84. This is approximate coordinate conversion, **not independently verified surveying accuracy**. Bounds input uses WGS84. Converted output is normalized to six decimal places, matching the existing Place Decimal(9,6) contract. The shared endpoint matcher still requires exact equality; no proximity/name matching is added. A higher-precision external origin that cannot match exactly remains unsupported rather than weakening its evidence boundary. `BAIDU_COORDINATES_APPROVED` is required in addition to the account gates before live Baidu Place/Route calls. Exact response coordinate semantics, border accuracy and navigation usability remain real-provider acceptance prerequisites. No client GPS or user execution evidence is created.

## Configuration and fail-closed rollout

API bootstrap defaults to regional routes and regional Place Search. Independent server-side variables:

| Setting                | Baidu                                             | Google                            |
| ---------------------- | ------------------------------------------------- | --------------------------------- |
| Secret                 | BAIDU_SERVER_API_KEY                              | GOOGLE_SERVER_API_KEY             |
| Call enable            | BAIDU_LIVE_API_ENABLED=true                       | GOOGLE_LIVE_API_ENABLED=true      |
| Account validation     | BAIDU_ENTITLEMENT_APPROVED=true                   | GOOGLE_ENTITLEMENT_APPROVED=true  |
| Storage validation     | BAIDU_STORAGE_APPROVED=true                       | GOOGLE_STORAGE_APPROVED=true      |
| Attribution validation | BAIDU_ATTRIBUTION_APPROVED=true                   | GOOGLE_ATTRIBUTION_APPROVED=true  |
| Coordinate acceptance  | BAIDU_COORDINATES_APPROVED=true (Place and Route) | WGS84 API contract to be verified |

Missing any applicable gate/key disables only that slot. No default live calls or synthetic fallback in staging/production. Gates represent explicit external review; setting a boolean does not itself prove entitlement or authorize paid use. Secrets stay server-side; fixed HTTPS destinations, redirect rejection, timeout, bounded results and sanitized errors. No retries or automatic Query.

Explicit `ROUTE_PROVIDER=synthetic` and synthetic Place Search remain development/test acceptance only, under existing safeguards. The old experimental route config is retained for dev/test compatibility only. Geoapify is legacy dev/test configuration; it cannot override the formal staging/production regional policy. No real Provider is enabled by this PR.

## F-05 and real-provider status

**Baidu F-05 OPEN/PARTIAL; Google F-05 OPEN/PARTIAL; F-06 OPEN.** No account, key, billing or entitlement was supplied or verified. Official documentation HTTP access from this executor failed; no account-specific cross-border/API-time assertion is derived from unavailable pages.

| Review item                          | Baidu                                                                    | Google                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Allowed stored fields / storage      | UNVERIFIED; selected Place and route evidence require explicit approval  | UNVERIFIED; Places/Routes storage restrictions require explicit approval |
| Attribution                          | UNVERIFIED; text field is not proof of compliant display                 | UNVERIFIED; logo/map/display requirements need review                    |
| Retention / TTL                      | UNVERIFIED; existing snapshot TTL is not Provider permission             | UNVERIFIED; caching and retention limits need review                     |
| Deletion                             | UNVERIFIED; DB lifecycle alone does not establish contractual compliance | UNVERIFIED                                                               |
| Quota / pricing                      | UNVERIFIED for the specific account/plan; no paid requests               | UNVERIFIED for the specific account/plan; no paid requests               |
| Entitlement                          | UNVERIFIED                                                               | UNVERIFIED                                                               |
| Coverage / cross-border / time modes | UNVERIFIED; unsupported cases fail closed                                | UNVERIFIED; unsupported cases fail closed                                |

Reference targets for external review: Baidu Web Service Place API / Direction Lite documentation; Google Places Text Search (New), Routes computeRoutes, Maps Platform terms/service-specific policies and the actual account console. Public docs alone cannot close F-05. B owns Japan Transit account/sidecar validation; C owns embedded map compliance/UI. No F-05/F-06 closure or production readiness claim.

## Validation and delivery

All new HTTP fixtures and PostgreSQL acceptance data are explicitly SYNTHETIC. No live Provider calls. New tests cover the dispatch matrix, HK/Macau/Taiwan, invalid geography, independent missing gates, outage, unsupported modes, DEPART_AT/ARRIVE_BY, timezone unknown, normalization, exact owner scope and zero-write read/search/failed Query. The complete local Unit suite passed **861** tests; PostgreSQL 17 passed **680** tests (106 persistence + 574 API), including clean migration-chain and populated migration compatibility checks. Frozen install, Prisma generate/validate, format, lint, typecheck and build passed. The final-HEAD CI checks are linked from the Draft PR; they remain required independently of local results.

Schema/migration delta **0/0**; total **26**. Web UI delta **0**. No mini-map, Japan Transit implementation, paid account, production deployment or next phase. Stop at Draft for review.

| Local verification                       | Actual result                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Frozen install; Prisma generate/validate | PASS                                                                                     |
| Format / lint / full typecheck / build   | PASS                                                                                     |
| Unit                                     | 861 PASS, including 40 regional policy/adapter cases                                     |
| PostgreSQL 17                            | 680 PASS (106 persistence, 574 API)                                                      |
| Chromium                                 | 281 PASS                                                                                 |
| WebKit                                   | Final-HEAD GitHub CI required; not run locally                                           |
| Compose                                  | PASS, including API/Worker, legacy route/external Adopt/Undo, outages and object storage |
| P5B                                      | PASS: 5 users / 200 requests; 0 isolation failures, unexpected 5xx or network failures   |
| Schema / migrations                      | Unchanged; 26 existing migrations                                                        |

Local Docker uses the VFS storage driver on a 32 GB workspace. The first full-image stack attempt exhausted disk before application acceptance. Local acceptance subsequently ran the unchanged Compose/P5B scripts against a temporary thin Node 24.19 runtime with compatible OpenSSL and the exact compiled workspace/dependencies mounted read-only. Only automatic dependency reinstallation was disabled inside this already frozen-installed mount; no business assertion or guard was disabled. Migration used the same Prisma migrate-deploy CLI. Temporary overrides, fixture environment and runtime files are outside Git; repository Docker/CI definitions are unchanged. The Draft PR's final-HEAD CI independently builds and verifies the normal repository images and both browser engines.
