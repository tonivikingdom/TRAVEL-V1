# V1 Mini Map & External Navigation

Recommended model: GPT-5.6 Sol / High; fallback: available Sol / High. Adapter boundaries and touch/failure regressions justify High; escalate only for an unresolved policy or persistence dependency. Runtime model selection is unconfirmed.

Starting main: `13e5b1d7aa95bd461f33d4fb0b74e0efbb61fb3b`. Branch: `feat/v1-mini-map-navigation`. Migration total **26**. API / schema / migration delta **0 / 0 / 0**. No dependency, lockfile, deployment, Domain or Provider changes. Delivery is a **Draft PR**, not a production map launch.

## Reuse and ownership

| Capability                                                       | Starting fact                       | This delivery                                                                    |
| ---------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| Saved Place coordinates, name/address and itinerary endpoints    | Present                             | Reused without inference or rewriting                                            |
| Saved selected transport legs and proven leg/edge correspondence | Present                             | Reused for boarding navigation; no guessed boarding point                        |
| Coordinate validation and external Google/optional Apple links   | Present in `maps.ts`                | Validation extracted unchanged; existing callers delegate the configured adapter |
| Interactive embedded map                                         | Absent                              | Read-only container, lifecycle, loading/error and gesture shell added            |
| Region Map capability                                            | Absent on starting main             | Explicit `MapAdapter` composition point; no CN/overseas branch                   |
| Reliable route geometry                                          | Absent from current Trip projection | Two endpoint Pins; no line drawn between them                                    |
| Map persistence / new API                                        | Not needed                          | None                                                                             |
| Real SDK, region policy and billing/keys                         | Owned by A / not supplied here      | **Integration required**, no live/paid calls                                     |

## Adapter boundary and production state

`map-adapter.ts` defines `MapRequest`, saved `MapPoint`, `MapNavigationOptions`, `MapSession` and `MapAdapter`. `configureMapAdapter(...)` is the production composition point; `regionMapAdapter()` supplies the capability. A owns regional selection, SDK/key/authorization, coordinate-system conversion, attribution, provider policy and external URLs. The shell contains no China detector, default region rule, geocoder or SDK URL.

A configured adapter receives only reliable saved coordinates/display names and explicitly supplied origin/mode for inherited navigation callers. No user location, token, session, notes, provider response or credentials are passed. URL output must be HTTPS without embedded username/password. Invalid output or synchronous policy failure suppresses only that action.

**Production remains unconfigured**: the detail says “内嵌地图尚未接入”; no fake roads or interactive production SDK are claimed. Existing external Google/optional Apple compatibility remains until A installs its adapter. Once configured, existing `placeMap`/`navigation` callers, including Today, saved legs and materials, delegate it rather than choosing Google/Apple themselves. A configured Place/Transport Mini Map replaces duplicate top-level legacy links. This preserves old behavior without establishing a new regional policy.

`SyntheticMapAdapter` is DEV/TEST ONLY, explicitly enabled with `?mapHarness=SYNTHETIC`. It renders labeled illustrative blocks and saved-coordinate Pins; **blocks are not actual roads, stations or geography**. The SVG, external `.invalid` URLs and entry flag are eliminated from the production bundle. HTTPS `.invalid` actions are intercepted in browser tests; no real provider or tile call occurs. This proves interaction and layout, not real geographic detail or provider availability.

## Place, transport and failure semantics

Place retains name, reliable address, time requirements and editable notes outside the map. Transport retains textual endpoints and selected segments. Two reliable itinerary endpoints are displayed together; there is no guessed transit polyline. Saved boarding navigation uses `selectedLegForEdge`'s existing proven correspondence. Without a saved boarding point the action is accurately labeled “导航到起点”. A missing destination can retain a known-origin action; a missing origin never substitutes the destination.

Invalid/missing coordinates show “地图位置暂不可用” without starting the SDK. Loading shows “正在加载地图…”. Rejection, synchronous mount failure or a **12-second** unresolved mount shows “地图暂时无法加载”, preserving details/forms and safe adapter external actions. There is no global service-unavailable state on a map failure.

Replacement and close abort the map and dispose pointer listeners/session. A late completion destroys its session instead of reviving a closed/replaced drawer. Zoom/reset/pan are local view state only; no storage, Trip command, planning request, authoring receipt or execution event.

## Interaction and accessibility

The existing drawer implementation, 44px dedicated handle, 110px threshold, VisualViewport handling and discard guard are unchanged. Map viewport pointer-down does not bubble into the drawer gesture; viewport `touch-action: none` gives the adapter responsibility for pan/pinch. SDK content owns the map gesture, while handle-started drag keeps the original dismiss/draft protection. Body forms and scrolling remain separate; no full-screen map or Map Tab.

Controls are at least 44px, labeled in text, and keyboard reachable. Synthetic keyboard arrows pan; plus/minus zoom; reset restores the view. The container has a region label; names/addresses/endpoints remain text, not solely Pins. Rounded containers use symmetric padding, wrapped labels and the existing safe-area-aware drawer. Widths 320/375/390/430, 24px root font, long unbroken addresses and desktop are covered. No geolocation permission is requested.

## Validation

Final local validation and exact final-HEAD CI results are recorded in the Draft PR. [CI runs for this branch](https://github.com/tonivikingdom/TRAVEL-V1/actions?query=branch%3Afeat%2Fv1-mini-map-navigation) provide the authoritative HEAD/job status. Required CI jobs are **verify** (including Chromium and WebKit), **Compose verification**, and **P5B acceptance**; final handoff must wait for all three to succeed.

- Frozen install, Prisma generate/validate, format, lint, typecheck and build are run on the final source.
- Unit: **840 passed** (19 new adapter/coordinate cases).
- PostgreSQL: **672 passed** (106 persistence + 566 API) on an isolated PostgreSQL 17 SYNTHETIC database; clean deploy found/applied **26** migrations. All 18 inherited failure/concurrency regressions remain unchanged.
- Browser: **20 new cases per engine**, covering Place, Transport, external actions, missing endpoints, errors, bounded loading, stale mount cleanup, actual mouse/pointer pan, constructed two-pointer pinch/cancel, handle drag, dirty note close/replacement guard, zero writes, widths, enlarged text and desktop. The standard full suite contains **301 cases per engine**; final results are recorded in the Draft PR checks.
- Local Compose and P5B passed again after the final navigation delegation. Final HEAD CI repeats the complete standard checks.

Initial runs are not passing evidence: one incorrect old DB password, missing local WebKit libraries and one existing ADMIN Preview case's 400/404 failure. The unchanged ADMIN case passed alone and the entire PostgreSQL suite subsequently passed. Two early browser runs were invalidated by our source editing during Vite HMR; all final checks use frozen source. The first Compose run exhausted Docker VFS disk; identified idle synthetic build images/caches were reclaimed and Compose passed. No assertion was weakened or test skipped for success.

Local WebKit uses installed/extracted libraries in its own browser bundle. Playwright's separate `ldconfig` probe does not see the locally installed GLES library, so only that local host-preflight probe is disabled; WebKit actually launches and executes all assertions. Final CI installs normal system dependencies and uses the unchanged standard host checks. No repository CI change or disabled browser test.

## Visual review

All evidence is **SYNTHETIC**. The original PNGs and RGB JPEG contact sheet are opened and inspected before commit. JPEG is 1600 × 2480, quality 88, below 5 MiB; screenshot proportions and panel titles are retained.

| Evidence                         | Artifact                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Place Pin / zoom / SDK failure   | [Place](assets/v1-mini-map/mobile-place-map.png), [Zoom](assets/v1-mini-map/mobile-place-map-zoom.png), [Failure](assets/v1-mini-map/mobile-place-map-failure.png) |
| Selected transport / no geometry | [Transport](assets/v1-mini-map/mobile-transport-map.png), [No geometry](assets/v1-mini-map/mobile-transport-no-geometry.png)                                       |
| Narrow mobile / enlarged text    | [320](assets/v1-mini-map/mobile-320.png), [390](assets/v1-mini-map/mobile-390.png), [Enlarged](assets/v1-mini-map/mobile-enlarged.png)                             |
| Desktop                          | [Place](assets/v1-mini-map/desktop-place.png), [Transport](assets/v1-mini-map/desktop-transport.png)                                                               |
| Contact sheet                    | [JPEG](assets/v1-mini-map/review-contact-sheet.jpg)                                                                                                                |

## Remaining integration requirements and limitations

A must supply/install the approved Region Map adapter and verify Google/Baidu SDK authorization, regional coordinates, actual roads/stations/attribution, keys, quota/billing and safe external URL policy. No real account entitlement, region/provider behavior or tile geography is accepted here. Embedded production map is **PARTIAL / integration pending**. F-05/F-06 and Google Transit remain OPEN/PARTIAL under their existing gates.

Physical iPhone, actual iOS Safari, native multi-touch/pinch, soft keyboard and external native-app handoff are **not verified**. Constructed pointer events and desktop WebKit are not physical-device acceptance. No turn-by-turn navigation, location tracking, discovery, itinerary editing, offline map, persisted camera, inferred geometry, map selection, region routing, Place Search Provider or Japan Transit implementation.

Keep Draft. No merge, deploy, A/B/PR #41 modification or next phase.
