# V1 Baidu WALKING contract failure isolation

Date: 2026-10-08. Base branch: `investigate/v1-provider-route-access`, exact base `5060ecea7804b519e9b18d95b742dcf97474f165`. Delivery branch: `fix/v1-baidu-walking-diagnostics`. Draft only; no merge or deployment.

## Before and after

The prior acceptance received HTTP 200, public business status 0 and parseable JSON, but returned CONTRACT_MISMATCH. It had no separate Adapter route-shape, coordinate, endpoint-binding or duration diagnostics. This task does not retroactively infer which guard failed on that response.

`BaiduOrdinaryRouteProvider` now accepts an optional fifth `DiagnosticObserver`, like the Google Adapter. Doctor passes its existing runtime-whitelisted collector. Observable stages are:

- RESPONSE_SHAPE: `response.result.routes` (array, at most five), `response.result.origin/destination` and the mode-specific endpoint objects.
- COORDINATE_PARSE: WALKING's `response.result.origin.originPt/destination.destinationPt`, numeric geographic bounds and the existing BD09-to-WGS84 inverse's output.
- ENDPOINT_BINDING: the unchanged strict shared binding function; only the diagnostic field is remapped to the Baidu path. Fixed failures remain OFFSET_LIMIT_EXCEEDED, COORDINATE_EQUIVALENCE_REQUIRED and ENDPOINT_REVERSED_OR_COLLAPSED.
- RESPONSE_SHAPE: `response.result.routes[].duration`, using the existing safe positive integer / at most 604800 seconds limits.
- DOMAIN_VALIDATION: existing candidate construction; after Adapter success Doctor independently runs the existing Domain candidate and trusted-endpoint validators. Adapter construction PASSED alone is not full Domain acceptance.

HTTP_STATUS and allowed numerical PROVIDER_BUSINESS_STATUS remain Doctor's existing responsibilities. No new free-form fields, raw JSON, coordinates, private names, credential values/placeholders, URLs, Headers, exception messages or response snippets are emitted. Runtime whitelisting strips unexpected properties and rejects unknown vocabulary. Empty routes, unsupported queries and unavailable failures retain the original public return semantics.

## Official contract and coordinate limits

Source: [Baidu's WALKING reference at a fixed official-repository commit](https://github.com/baidu-maps/webapi-skills/blob/67d85191b91755b447088ee8c492a3fb54d99e8b/skills/baidu-map-webapi/references/walking_route_planning.md), linked to the [official API documentation](https://lbs.baidu.com/faq/api?title=webapi/webservice-direction/walking).

The schema documents `result.routes`, `origin.originPt.lat/lng`, `destination.destinationPt.lat/lng` and integer seconds for route duration. Existing request parameters remain `coord_type=wgs84`, `ret_coordtype=bd09ll`, `output=json`. There is no independent response coordinate-system marker. COORDINATE_PARSE PASSED proves numeric parsing and numerical normalization, not that the upstream honored BD09 or that the inverse has official accuracy. A fixture returning WGS84 under the requested BD09 contract fails binding; no guessed coordinate-system fallback is introduced.

Google's 100m and Baidu's 30m limits are exclusion limits, not acceptance radii. Six-decimal coordinate equivalence and collapse/reversal protections are unchanged. No endpoint rewriting, access leg, invented duration, route semantics, Domain, API, production gate or dependency changes. Schema/migration delta 0/0; all 27 migrations unchanged. B/C branches untouched.

## Regression evidence

On the original Adapter, the newly added SYNTHETIC diagnostic suite had **27 failures / 1 pass** because diagnostics were absent. With the observer it has **28 passes**. Cases cover official successful WALKING structure, missing/type-invalid routes, missing endpoints, invalid coordinates, wrong-coordinate-system payload, invalid duration, far/near offsets, collapse, reversal, empty routes and observer-optional failure compatibility.

Doctor-level regressions additionally verify shape/coordinate/binding failure propagation, status 0 separate from contract acceptance, exactly one mock fetch and no secret/private-coordinate leakage. All fixtures are explicitly SYNTHETIC. Prior Google endpoint, Baidu modes and strict binding regressions remain active.

Local validation: frozen install, lint, full typecheck, build and Unit **1215 PASS**; focused suites **102 PASS**. PostgreSQL 17 **687 PASS** (106 persistence + 581 API); clean deploy of all **27 existing migrations PASS**. Final exact-HEAD CI results are recorded in the PR and final delivery once complete. Tests/build unset the four real Provider bindings; the PostgreSQL database is isolated and task-owned.

## One authorized real attempt

After Unit/Lint/Typecheck and config-only Doctor passed, the actual repository script was executed exactly once: `CI=true pnpm provider:doctor --live --only=baidu-walking`. There is no `provider` alias; package.json was not modified to add one. Four bindings SET, proxy/CA SET, Baidu HTTPS target configured. Runtime network observation remained unknown, not claimed enforced/ready. Config-only request count was 0.

[Safe live report](assets/baidu-walking-diagnostics/live-diagnosis.json): **1 dispatched fetch attempt**, no retry and no other capability. Whether the attempt reached Baidu is unknown. No HTTP response/status or business code was obtained. Doctor reports **NETWORK_BLOCKED**, first failure HTTP_STATUS / NETWORK_BLOCKED. RESPONSE_SHAPE, COORDINATE_PARSE, ENDPOINT_BINDING and DOMAIN_VALIDATION were **not reached**. LIVE_CONTRACT_PASS was not achieved. This is not evidence that status 240 returned, that the Key is invalid, or that a specific route guard failed. The earlier status-0 observation is historical only. No extra network/Provider diagnosis requests follow this attempt.

**CODE_FIXED:** granular, closed-vocabulary Adapter diagnosis. **STILL_BLOCKED:** real post-status-0 route failure isolation, due to this attempt not obtaining an HTTP response. **ACCOUNT_ACTION_REQUIRED:** not established by this result; no new console change or purchase is prescribed. Production authorization remains NOT_REVIEWED; F-05/F-06 OPEN.

## Follow-up design if real endpoint binding fails

A future explicitly authorized attempt can now identify the actual failed stage. If it is endpoint binding, the fixed error alone will not prove whether the cause is legitimate snapping, an approximate inverse, or a response coordinate-contract violation. Preserve rejection until reliable provider coordinate/identity provenance and access evidence are established. Keep the requested Place and road endpoint separate; model any trusted access connection and timing explicitly only under a separately reviewed minimal contract. Do not claim POI UID alone proves access, fabricate walking connections, enlarge limits, or replace returned endpoints with the requested Place. No Domain expansion is implemented here.
