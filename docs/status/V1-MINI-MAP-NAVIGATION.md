# V1 Mini Map & External Navigation — Regional Integration

Recommended model GPT-5.6 Sol / High; fallback available Sol / High. Runtime selection is unconfirmed. Elevate only for unresolved authority, credential or coordinate correctness dependencies.

Original C starting main: `13e5b1d7aa95bd461f33d4fb0b74e0efbb61fb3b`. Original reviewed C HEAD: `3dbfa5c88fb795c2c57312a50fd352873f3d0efc`. **Integration base: `47c4af9a6dda9d4858e138463478b88dc8f35524`**. Branch `feat/v1-mini-map-navigation`; [PR #51](https://github.com/tonivikingdom/TRAVEL-V1/pull/51) stays Draft.

Main was fetched and matched the authorized SHA. Merge `bfb9a2c` preserves both parents, with **no conflicts**, no whole-file ours/theirs replacement. All A foundation changes are inherited unchanged. Additional C API/schema/migration delta **0/0/0**, migration total **26**. No paid/live Provider call, account provisioning, billing, deployment or PR #41 change.

## One authority and the composition boundary

```text
A: classifyProviderRegion → mapProviderProjection
     ↓ existing owned read-only API
RegionalMapCapabilityView (region/provider/coordinates/WGS84)
     ↓ RegionalMapComposition
MapAdapter registry (GOOGLE / BAIDU)
     ↓ SDK lifecycle + official external URLs
Place / Transport Mini Map and existing map callers
```

**Region Policy inherited from A. No duplicate region logic.** Production Web does not import A's classifier/boundary geometry, classify China/Japan, or use language, IP, timezone or names to choose a provider. It indexes adapters directly by the API's provider. Runtime checks verify coordinates, ownership context and capability agreement, not geography. Node test helpers load A's actual policy outside the Web production graph to verify Mainland/Japan/global/HK/Macau/Taiwan and uncertain boundaries.

GET `/trips/:tripId/places/:nodeId/provider-capability` is A's existing owner-scoped API; no new endpoint/DTO. Its projection identifies routing/map policy, **not SDK readiness or entitlement**. The server re-reads the owned Place. Web compares its returned WGS84 coordinates exactly with the saved node and suppresses actions on mismatch, unresolved region/provider, 401/403/404 or auxiliary outage. A foreign/admin-like owner cannot use the endpoint to access another owner's Place.

Each Place node is read separately, including same-coordinate transport endpoints. Reads are de-duplicated by node within the current owner/Trip/version. The initial preload queue uses four concurrent ordinary application requests; opening a detail awaits its required nodes independently. This is not a Provider query/billing policy. Place resolution awaits its required node, not an unrelated failed/slow capability. Transport requires both endpoints to agree on region/provider/coordinate system; unsupported pairs, including Japan/global pairs, degrade to text with no stitching. A saved boarding point must match a verified owned node's coordinates; an unmatched saved leg remains readable but its navigation is unavailable.

Scope changes abort pending reads/mounts, dispose sessions and invalidate old links, including after an SDK failure. Late responses cannot repopulate a switched Trip/owner or a closed drawer. Backup view clears live map capability scope and starts no map/planning request. Map actions never Query/Preview/Adopt/Undo, author, generate execution facts or mutate Trip/version.

## Production adapters and browser configuration

`GoogleMapAdapter` and `BaiduMapAdapter` own SDK mount/reset/zoom/disposal and provider-specific URLs. `MapSdkLoader` uses fixed HTTPS SDK destinations, de-duplicates concurrent loads, bounds loading to 12 seconds, sanitizes errors and permits a later explicit retry after failure. It is called only for an approved mounted map, never at page bootstrap. One cancelled consumer does not cancel another map's shared load.

Production always installs `RegionalMapComposition`. Existing `placeMap`/`navigation` helpers delegate it; missing capability never reaches the inherited Google/Apple fallback. Apple helper remains legacy-only for isolated compatibility, and no Apple action is rendered as a formal Region Provider.

Browser configuration is an explicit `VITE_*_MAPS_*` allowlist, independent from A's server REST config. **Neither `GOOGLE_SERVER_API_KEY` nor `BAIDU_SERVER_API_KEY` is a browser SDK key**. A production Vite build test injects SYNTHETIC server REST secrets and browser keys into a temporary environment, verifies REST markers absent from HTML/JS, browser keys independent, and all DEV map harness code absent.

| Browser setting                   | Google                                       | Baidu                                                                           |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Public, domain-restricted SDK key | `VITE_GOOGLE_MAPS_BROWSER_KEY`               | `VITE_BAIDU_MAPS_BROWSER_KEY`                                                   |
| Explicit SDK load enable          | `VITE_GOOGLE_MAPS_EMBED_ENABLED=true`        | `VITE_BAIDU_MAPS_EMBED_ENABLED=true`                                            |
| Account/SDK entitlement review    | `VITE_GOOGLE_MAPS_ENTITLEMENT_APPROVED=true` | `VITE_BAIDU_MAPS_ENTITLEMENT_APPROVED=true`                                     |
| Storage/retention review          | `VITE_GOOGLE_MAPS_STORAGE_APPROVED=true`     | `VITE_BAIDU_MAPS_STORAGE_APPROVED=true`                                         |
| Attribution review                | `VITE_GOOGLE_MAPS_ATTRIBUTION_APPROVED=true` | `VITE_BAIDU_MAPS_ATTRIBUTION_APPROVED=true`                                     |
| Coordinate acceptance             | canonical WGS84                              | `VITE_BAIDU_MAPS_COORDINATES_APPROVED=true` plus approved conversion capability |

Default: all keys/gates missing, fail closed. These settings implement review boundaries; booleans do not prove authorization or account entitlement. No browser key was supplied/approved here. SDK assets/attribution retain their own styling: shared icon rules and synthetic SVG sizing do not restyle provider SVGs. No geolocation permission or raw Provider response is consumed.

## Coordinate and real SDK status

| Capability               | Implementation/evidence                                                                                                        | Real status                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Google                   | WGS84 Pin(s), native map pan/zoom, zoom/reset controls, cleanup and loader tested with SYNTHETIC SDK contracts                 | **PARTIAL / UNCONFIGURED**; no authorized browser key or actual SDK acceptance |
| Baidu                    | WebGL adapter accepts only explicit BD09LL output from an approved conversion capability; loader contract tested synthetically | **PARTIAL / UNCONFIGURED; reverse coordinate capability BLOCKED**              |
| A coordinate conversion  | Existing BD09→GCJ02→WGS84 inherited unchanged                                                                                  | Does not provide WGS84→BD09LL for the embedded map                             |
| Baidu reverse conversion | `BaiduCoordinateCapability` integration requirement; no production converter injected                                          | No copied/invented reverse mathematics and no accuracy PASS                    |

Baidu key/gates alone cannot bypass the missing converter; the SDK is not loaded in that state. The conversion stub used by tests is explicitly SYNTHETIC, not real coordinate acceptance. No real SDK/roads/stations, native-app handoff, account license or geographic accuracy is claimed PASS.

## External map/navigation

Official documentation was read in this integration task:

- [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started) and [Maps JS loading](https://developers.google.com/maps/documentation/javascript/load-maps-js-api).
- [Baidu Web URI](https://lbsyun.baidu.com/docs/webapi?title=mapadjustment/uri/web), [WebGL display](https://lbsyun.baidu.com/index.php?title=jspopularGL/guide/show) and [coordinate guidance](https://lbsyun.baidu.com/index.php?title=jspopularGL/guide/coorinfo).

Google uses documented search/directions URLs with `api=1`, exact WGS84 and no key. Navigation uses `dir_action=navigate`; endpoint viewing does not start navigation. No current-position permission is requested; selecting a starting point/native navigation belongs to the external product.

Baidu marker/direction URI explicitly declares `coord_type=wgs84`, `output=html` and required source `webapp.travelv1.travel`; the external product handles coordinates, so no reverse math is needed for these URLs. A single Place has “在地图中查看”. Official Web direction requires an explicit origin; when navigation origin is unknown the navigation action is locally unavailable, with explanatory text. It never guesses location or supplies a destination as origin. Transport viewing may supply its two reliable, compatible endpoints; external lookup is not saved route geometry or evidence of a current service/fare. URI generation is documented and synthetic-tested; actual Baidu/Google/native-app handoff remains **PARTIAL / unverified**.

## Detail, failure and interaction behavior

Names/addresses/times/endpoints/notes remain readable outside the map. Missing coordinates show “地图位置暂不可用”; unresolved capability shows local regional unavailability; missing key shows “地图尚未配置，仍可使用外部地图”. Script rejection/timeout/failed mount shows “地图暂时无法加载”, retaining safe regional external actions. No auxiliary map failure marks the entire App/core Trip unavailable. Core outage still invalidates live maps/links and retains unrelated unsaved drafts under the existing guard.

Maps show only reliable saved Pins. No guessed polyline, address geocoding, discovery, GPS tracking, turn-by-turn implementation, camera persistence or Map Tab. The existing 44px handle/dismiss threshold, dirty guards, authoring, Place Search drafts and VisualViewport fitting are retained. Map viewport pan/pinch belongs to the adapter; handle-started drag owns drawer dismiss. Container/controls use labels, text and at least 44px controls; 320/375/390/430, large text, desktop and reachable forms are covered. Desktop WebKit/constructed pointer events are not physical iPhone acceptance.

## Integrated validation

Final integrated-source local results and exact final HEAD CI are recorded in [Draft PR #51](https://github.com/tonivikingdom/TRAVEL-V1/pull/51). [Current branch CI](https://github.com/tonivikingdom/TRAVEL-V1/actions?query=branch%3Afeat%2Fv1-mini-map-navigation) is authoritative. **Old CI 37195668032 is not integrated evidence.** The final handoff requires verify (both engines), Compose verification and P5B acceptance completed/success.

- Frozen install, Prisma generate/validate, format/lint/typecheck/build: PASS. Full Unit: **915 PASS**. Real PostgreSQL: **680 PASS** (106 persistence + 574 API).
- Local Compose: **PASS** after the documented environment correction. P5B: **PASS**, five SYNTHETIC users, 200 requests, zero isolation failures, zero unexpected 5xx/network failures (p95 547.71ms).
- Full local Chromium: **327 PASS**. Full WebKit is also required locally and in final-HEAD CI; its completed totals/results are recorded in the linked PR so this document does not substitute a previous-head run for final evidence.
- New Unit: **35** regional composition, node scope, loader, SDK lifecycle/coordinates, config/key and actual production-bundle boundary cases.
- New browser: **26 per engine**; six regional Place projections, uncertainty, independent auxiliary errors, async note protection, unconfigured/failed SDK, script fixture, same-coordinate endpoint failure, cross-region rejection, viewport/gesture/enlarged/desktop and core outage after SDK failure. Prior 20 Mini Map cases and A/B behavior regressions remain active.
- PostgreSQL reuses A's real owner-private capability matrix (including admin isolation and zero-write assertions) and the unchanged 18 failure/concurrency cases. No persistence/HTTP business assertion is weakened.
- Migration clean deploy/status and final CI must still show **26**, no schema/history edits.

Nonpassing initial checks are not final evidence: Node test helper's direct backend TypeScript import crossed the composite project boundary; it now loads A's source in the Node test runner without adding it to production Web. Vitest's NODE_ENV=test caused the production-bundle test to build DEV code; the test explicitly uses production NODE_ENV. The original broad test API interceptor also caught `/maps/api/js`; the SDK fixture now intercepts only the App origin's API and fixed provider URLs. No live request/assertion bypass was used. All complete checks below use frozen final runtime source.

Local verification environment: system Chromium and actual Playwright WebKit run here. WebKit uses previously extracted host libraries; `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` bypasses only the host dependency probe, not browser launch or assertions. CI uses its normal browser/dependency installation without that setting. Initial local parallel Docker/vfs builds exhausted temporary disk space, causing PostgreSQL initialization to fail (`No space left on device`). Unused task images/build cache were reclaimed and local full Node 24 build targets serialized. The environment-only Docker override supplies the managed proxy CA; repository Dockerfile/Compose/workflow stay unchanged. The failed attempts are not counted as passing Compose evidence.

## Refreshed visual evidence

All final evidence is **SYNTHETIC**, through A's projection API fixture and the production regional composition. `SYNTHETIC_REGIONAL` only substitutes the SDK mount, retaining actual adapter URL behavior and API selection. `SYNTHETIC_SDK` intercepts the production loader's script with a contract stub. Both are DEV-only and absent from production output. Blocks are illustrative, not real roads/stations; there are no REAL PROVIDER screenshots. Regional fixtures deliberately retain Japanese-language labels while varying canonical coordinates, demonstrating that labels/language never select the region; fixture text is not geographic accuracy evidence.

| Evidence                      | Artifact                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Japan Place / zoom            | [Place](assets/v1-mini-map/mobile-place-map.png), [Zoom](assets/v1-mini-map/mobile-place-map-zoom.png)                                 |
| Mainland Place                | [Baidu selection](assets/v1-mini-map/mobile-mainland-place.png)                                                                        |
| Map failure / loader failure  | [Map failure](assets/v1-mini-map/mobile-place-map-failure.png), [SDK failure](assets/v1-mini-map/mobile-sdk-load-failure.png)          |
| Saved Transport / no geometry | [Transport](assets/v1-mini-map/mobile-transport-map.png), [No geometry](assets/v1-mini-map/mobile-transport-no-geometry.png)           |
| Narrow widths / large text    | [320](assets/v1-mini-map/mobile-320.png), [390](assets/v1-mini-map/mobile-390.png), [Enlarged](assets/v1-mini-map/mobile-enlarged.png) |
| Desktop                       | [Place](assets/v1-mini-map/desktop-place.png), [Transport](assets/v1-mini-map/desktop-transport.png)                                   |
| Remote review                 | [RGB JPEG contact sheet](assets/v1-mini-map/review-contact-sheet.jpg)                                                                  |

All **12 final PNGs** and the JPEG were refreshed and actually opened/visually checked. The contact sheet is **RGB JPEG, 1600×3380, quality 88, 545,773 bytes**, preserving screenshot proportions and per-cell titles. Narrow and enlarged layouts preserve text/controls, both endpoint Pins have no invented polyline, and SDK failure retains navigation/text/forms. No screenshot is described as actual Google/Baidu SDK acceptance.

## Remaining limitations / stop point

Google browser SDK is UNCONFIGURED/PARTIAL. Baidu browser SDK is UNCONFIGURED/PARTIAL and WGS84→BD09LL capability/accuracy remains BLOCKED pending A/approved integration. Real keys/account/domain restrictions, SDK authentication behavior, licenses/storage/attribution, actual map geography and native handoff need separate acceptance. F-05/F-06 and Google Transit remain OPEN/PARTIAL. No provider is purchased/enabled here.

Physical iPhone/iOS Safari/native touch/pinch/actual keyboard remain unverified. Hotel-only shortcut stays BLOCKED; no complete offline shell/editing/background sync or backup history manager. Region Place Search UI and Japan Transit remain outside C. Keep #51 Draft, no Ready/merge/deploy/PR #41 change or next batch. Stop for human review after exact final-HEAD CI success.
