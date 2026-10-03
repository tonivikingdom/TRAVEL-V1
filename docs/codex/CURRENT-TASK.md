# CURRENT TASK — PR #46 Compose midnight fixture repair

## Execution recommendation
- Model: GPT-5.6 Sol
- Thinking: High

## Scope
Continue only the existing Place Search branch and Draft PR #46.

- Branch: `feat/place-search-geocoding`
- Reviewed product HEAD before this task: `9ee71c4cf7fb1858fc2c4207dfc0396a9f57a253`
- Starting main: `77b37ac1931b5ffe653bc147eebf90949258e94c`
- Migration total must remain **26**.

Do not merge, deploy, modify PR #41, or start another phase.

## Review result
Place Search itself is not the current blocker. The final-head verify and P5B jobs passed, including Unit 768, PostgreSQL 619, Chromium 152 and WebKit 152. Schema/migration delta is 0/0.

The blocking failure is Compose. The existing synthetic Ground Transit acceptance derives a departure from wall-clock `now + 4 minutes` in Asia/Tokyo and then uses a roughly 30-minute route. Near local midnight, that synthetic route crosses the itinerary day boundary and the existing Preview protections correctly reject it with endpoint/day or cross-day-transfer errors.

This is a nondeterministic acceptance fixture problem. Do **not** weaken Preview/domain protection to make CI green.

## Required repair
First reproduce/confirm the failing Compose path and identify the exact wall-clock-derived fixture(s).

Make the synthetic Compose Ground Transit scenario deterministic with respect to itinerary-local calendar day.

Preferred characteristics:
- use a fixed or safely day-bounded synthetic instant/date appropriate to the fixture;
- keep the entire scenario semantically on the intended DayOccurrence unless the test explicitly intends cross-day behavior;
- do not depend on the CI runner's current local/UTC time being far from Tokyo midnight;
- preserve the operational-change assertions the fixture was originally intended to verify.

Audit the same Compose Ground Transit chain for other `Date.now()` / current-time-derived route timestamps that can cross a local day boundary. Fix only equivalent acceptance-fixture nondeterminism.

Do not broadly rewrite Compose or route tests.

## Hard boundaries
Do not:
- weaken ENDPOINT_DAY_MISMATCH, CROSS_DAY_TRANSFER_LOCATION or other Preview guards;
- change route/Adopt/Undo production semantics;
- change Place Search production behavior merely to solve this blocker;
- add schema/migration;
- change migration total from 26;
- hide the failure by retrying until the clock moves;
- skip/disable the Ground Transit scenario;
- loosen assertions/timeouts as a substitute for deterministic fixture data.

The diagnostic-only Compose additions from PR #46 may remain if useful, but remove noisy/debug-only output if it no longer has durable value.

## Place Search review boundaries to preserve
Keep:
- search/cancel = zero Trip writes;
- explicit candidate selection required before authoring;
- signed owner/Trip-bound candidate evidence;
- candidates without reliable coordinates cannot be added;
- Provider outage degrades only search and keeps saved-place fallback;
- Geoapify remains disabled by default;
- no real/paid Provider call;
- F-05 and real Provider acceptance remain OPEN/PARTIAL;
- schema/migration delta 0/0.

## Regression and validation
Add or adjust a focused regression/acceptance assertion proving the synthetic Ground Transit fixture is stable around the Tokyo day boundary. If practical, test representative instants immediately before/after local midnight without changing production clock semantics.

Then run the full final-head validation:
- frozen install
- Prisma generate/validate
- format/lint/typecheck/build
- Unit
- PostgreSQL integration
- Chromium
- WebKit via final CI
- Compose verification
- P5B

The new HEAD's Compose job must pass. An older green run or a manual retry outside the boundary is not sufficient evidence.

## Delivery
Update the existing PR #46 only.

Update `docs/status/PLACE-SEARCH-GEOCODING-FOUNDATION.md` with:
- root cause;
- exact fixture repair;
- proof production Preview guards were unchanged;
- focused boundary regression;
- final full validation.

After success, replace this active task with a short **RESOLVED** summary containing the new HEAD and evidence.

Final report:
- new HEAD;
- exact files changed for the repair;
- focused midnight-boundary test result;
- Unit/PostgreSQL/Chromium/WebKit totals;
- Compose/P5B;
- migration total 26;
- final CI URL;
- PR remains Draft;
- real Geoapify/F-05 still OPEN/PARTIAL.

Stop for human review. Do not merge.
