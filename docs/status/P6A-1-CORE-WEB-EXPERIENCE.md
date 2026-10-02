# P6A-1 — Formal Web core experience

Recommended model: GPT-6 Sol / High per the handoff. The exposed runtime identifies GPT-6; the exact Sol variant/effort is not verifiable. Starting main: `d5350fc051bd4a3ff7b50c1aae5605007e0a3ab2` (PR #39 merged). Branch: `feat/p6a-1-core-web-experience`. Draft only; no deployment or next batch.

## Materials and implementation

The seven-file handoff was extracted; all six manifest entries matched their recorded sizes/SHA256. `CODEX_TASK.md` was read in full, the original HTML was inspected, and all three reference images were opened. The HTML's memory-only state, default 10:30 and fixed candidates were not carried into the product. The two issue screenshots showed the hotel 13:00 arrival / next 10:45 departure conflict, missing arrival/departure/dwell fields, and an overflowing time control/decorative handle. The direction image informed the quiet blue/white layout, not unapproved navigation/uploads/features.

`apps/web` is an independent, small TypeScript/Vite client. It is not Debug Web, an iframe, or a second trip database. Desktop has dates/timeline/side detail; mobile has date chips/timeline/native modal bottom sheet. Generated transfers belonging to one selected route are folded into transport details; modified stops remain accessible. Arrangement counts refer to the visible places/activities, not hidden transfer nodes. Native dialog supplies focus containment/background inertness; close restores focus, body scrolling is locked, header drag has close/bounce thresholds, inputs/links do not initiate drag. Forms preserve failed/unsaved edits and distinguish saving one form from saving all forms.

### Interface mapping

| User task               | Reused server authority                                      | Client adaptation                                                                                                                            |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                   | Magic Link request/consume, revocable session, logout        | Fragment token is removed from URL; only session credential in sessionStorage                                                                |
| Existing trips / days   | `GET /trips`, `GET /trips/:id`, `TripView`                   | Owner-scoped dates, place/free-action cards, transport summary; no IDs exposed                                                               |
| Time display            | `POST /trips/:id/schedule/evaluate`                          | Effective arrival/departure with layer/date/IANA zone; Provider vehicle ACTUAL labeled separately; same-layer dwell; unknown remains unknown |
| Important times / dwell | Existing `SET_TIME_INTENT`, `SET_MIN_DWELL`, remove commands | Full local datetime and explicit/known event timezone; independent requirements stay separate                                                |
| Notes                   | Existing locked Trip command machinery                       | Narrow additive `SET_NODE_NOTE` command; same owner/Trip/version transaction; generated edits become protected                               |
| Routes                  | Existing Query → snapshot → Preview → explicit Adopt         | Real origin/destination/version/time hint; query/preview internal; user sees proposal/consequences and selects “使用这条路线”                |
| Undo                    | Existing receipt/idempotency/version/fact guards             | “撤销刚才的路线修改”; neutral state-update explanation rather than claiming Provider refresh proves user execution                           |
| Maps/navigation         | Trusted stored positions / selected candidate endpoints      | Coordinate-only official external URLs, no fake place IDs, notes, credentials, guessed positions or schematic routes                         |

The one server adaptation edits an existing note field without schema/migration changes. No route/Undo/execution policy was relaxed. Query still rejects negative dwell; shortening an explicit minimum requires accepted server adjustments. UI defaults to the known departure / arrival-plus-dwell floor, without a global walking buffer or double-counted candidate access legs. A focused PostgreSQL regression verifies the reported 13:00/10:45 issue, one-hour dwell, unaccepted shortening rejection, persisted notes, edited-version Adopt rejection and foreign-owner rejection.

## Data and map boundaries

Trip read/edit, schedule, route Query/Preview/Adopt/Undo use real API contracts and PostgreSQL. Browser contract tests use explicitly SYNTHETIC data; a separate real HTTP + PostgreSQL + Chromium chain verifies notes after reload and explicit route adoption/Undo. Route Provider data in that chain is SYNTHETIC, not real timetable/fare validation. Production or paid Providers were not connected or called.

External place/navigation/route-query links are implemented using reliable coordinates. Opening them does not create an execution event, request GPS, query a Provider in the background, or adopt a route. Generic Google transit URLs may recalculate and do not preserve the selected service/date/fare. Apple Maps has an optional iPhone/iPad link using the compatible HTTPS Map Links form; this is not native-app delivery or a claimed Unified Maps deep-link implementation.

**Embedded place/route maps: PARTIAL.** No authorized embedded map Provider/configuration/license or route geometry was found. The UI offers honest external exits; no photo/placeholder/polyline pretends to be a map. The missing map configuration was raised while independent development continued. Official Google Maps URLs, Apple Unified Maps/Map Links and Codex frontend-reference URLs returned HTTP 403 in this cloud network; live external map rendering was not verified. URL construction/target safety was tested separately.

## Verification evidence

- Frozen pnpm 11.19.0 install; Prisma generate/validate; format, lint, full typecheck, Unit, build: passed. Node 24.19.0.
- Unit: **735 passed**. PostgreSQL 17 integration: **102 persistence + 479 API = 581 passed**. Existing migration/route/execution/history/owner-isolation regressions retained.
- A separate empty task-owned PostgreSQL database applied all **24 migrations** successfully. No schema or migration file changed; migration count remains 24.
- Chromium browser contract suite: **21 passed**, covering time fields/requirements, note reload/failure, long/short drag, native modal focus/scroll, query/preview/explicit adoption, delayed responses, Maps link targets/no execution writes, preserved conflicts, 320/375/390/430 widths, landscape/enlarged text, ARRIVE_BY, offline/core-service failure conceals stale read-only detail while preserving drafts; recovery, expired session and independent form drafts.
- Real PostgreSQL + HTTP + Chromium: passed. Note persists after page reload; Query/Preview leave Trip version unchanged; explicit Adopt +1; Undo +1; active/undone routes checked in PostgreSQL.
- API liveness/readiness, Worker heartbeat and Debug Web runtime smoke: passed.
- Compose: passed, including Flight/Ground Transit/external-origin/suffix chains, explicit Adopt/Undo, Worker lease/outage/recovery/shutdown, PostgreSQL persistence and object storage. P5B: **PASS — 5 users, 200 requests, 0 isolation failures, 0 unexpected 5xx, 0 network failures**.
- Local WebKit installation was attempted using all official Playwright download mirrors; each was blocked with HTTP 403. **Cloud WebKit not verified.** CI runs both Chromium and WebKit independently. No real iPhone/Safari/OS soft-keyboard test or native app claim. Reduced viewport/landscape and input/focus tests do not replace device acceptance.

Docker first encountered an unwritable default config directory, then disk exhaustion from repeated build contexts. Recovery used a writable task-owned Docker config and removed only this task's failed build container/intermediate images. Existing databases/user data were retained; only disposable, inactive synthetic CI image caches and this task's obsolete images were removed. Format/lint/typecheck/Unit/build and browser checks were rerun after recovery. Cloud Compose requires a task-local host-network/proxy build override outside Git; TLS verification remains enabled and the repository acceptance scripts are unchanged.

## Review screenshots

All data shown is labeled SYNTHETIC; no credentials/private production content appears.

- [Mobile day, real PostgreSQL](assets/p6a-1/postgres-mobile-day.png)
- [Desktop day, real PostgreSQL](assets/p6a-1/postgres-desktop-day.png)
- [Mobile after explicit adoption](assets/p6a-1/postgres-mobile-adopted.png)
- [Place detail](assets/p6a-1/mobile-place.png)
- [Route candidates](assets/p6a-1/mobile-candidates.png)
- [Chosen route detail](assets/p6a-1/mobile-route.png)
- [Conflicting selected route](assets/p6a-1/mobile-conflict.png)
- [320px expanded editor](assets/p6a-1/mobile-narrow.png)
- [Desktop layout](assets/p6a-1/desktop-day.png)

## Stopping point

Draft PR and its actual CI results. Inline map configuration, real Provider capability verification and real-device Safari/keyboard acceptance remain explicit gaps. No new feature navigation, attachments, automatic Query/Preview/Adopt, GPS collection, native application, staging/production deployment or next batch. F-05/F-06 remain OPEN; F-07/F-08 remain CLOSED.
