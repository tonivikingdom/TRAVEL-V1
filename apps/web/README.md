# Formal Web: P6A-1

A separate TypeScript/Vite client for existing owner-scoped trips. Debug Web remains the engineering test surface. No ORM runs in the browser; no trip is stored in localStorage. Session credentials use sessionStorage and the existing revocable Bearer session/Magic Link API.

## Development

Run `pnpm dev:api`, then `pnpm dev:web`. The Web client is at `http://127.0.0.1:5174`. Set `AUTH_MAGIC_LINK_LANDING_URL=http://127.0.0.1:5174/login/magic` on the API/Worker before requesting links. `WEB_API_ORIGIN` changes the development proxy target (default `http://127.0.0.1:3000`); no provider key belongs in a Vite variable. Invitation and email delivery remain existing server responsibilities.

Production hosting is not configured or authorized by this batch. Any eventual hosting must route `/api` to the authenticated API over HTTPS; Vite development proxy is not production infrastructure.

## Checks

- Root format, lint, typecheck, Unit and build include this client.
- `pnpm exec playwright install --with-deps chromium webkit`
- `WEB_TEST_WEBKIT=true pnpm test:web`: browser contract fixtures, clearly SYNTHETIC. Chromium alone is the default for environments lacking WebKit.
- Optional `WEB_TEST_CHROMIUM_PATH=/usr/bin/chromium` uses an installed Chromium. `WEB_TEST_SCREENSHOTS=true` captures review images.
- `pnpm exec tsx --tsconfig scripts/p6a1-browser-tsconfig.json scripts/p6a1-browser-postgres.ts`: actual HTTP/PostgreSQL/browser chain. Requires dev/test `DATABASE_URL` to a separately created local database named `travel_p6a1_browser_*`, with the 24 migrations deployed. Never use production or the integration suite's shared database. This creates synthetic private rows for evidence and stops its local API/Web processes. No real Provider calls.

## Maps boundary

Maps URLs use saved coordinates, with a missing-position state. They never put node IDs, notes, credentials or itinerary details into the URL. Google navigation without an origin lets the external map choose its origin; opening a link never creates execution evidence or adopts a route. Transit URLs may recalculate and do not guarantee date/service/fare preservation.

Embedded map Provider/credentials/license and route geometry are unavailable in the inspected environment. Inline place/route maps are **PARTIAL**, not a claimed implementation. No schematic map or invented polyline substitutes for them. `src/maps.ts` isolates trusted location/URL construction so a separately authorized map component can consume the same positions later. Google place refs are not inferred from arbitrary provider IDs.

## Scope

Existing trips, dates, places/free actions, selected transport, schedule requirements/notes, route search, internal Preview and explicit Adopt, optional supported Undo. No creation workflow, attachments, extra navigation, background queries, GPS tracking or native app. Desktop has a date sidebar and side detail; mobile uses a real modal bottom sheet. API version/idempotency/fact protection remain authoritative.
