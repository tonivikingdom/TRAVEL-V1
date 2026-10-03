# Google Consumer Experimental Transit Service

Personal / Experimental sidecar for Toni's low-frequency Japan public-transit searches.

This is **not** Google Maps Platform, an official Google Transit API, or a production provider. It drives the anonymous Google Maps Consumer web UI in a service-owned Chromium process, captures the private `/maps/preview/directions` response, and converts its undocumented positional arrays into a Travel-owned JSON schema. Google can change or block this behavior at any time.

## Safety boundary

- One user and one concurrent Google operation. A second operation receives HTTP `429 BUSY`; it is not queued.
- The server refuses any bind other than `127.0.0.1`.
- The provider defaults to disabled. Disabled search/import requests do not start Chromium or access Google.
- Every protected endpoint requires `Authorization: Bearer <token>`.
- One service-owned Chrome process is reused; every request gets a fresh BrowserContext and Page. User Chrome processes and profiles are never touched.
- CAPTCHA, login gates, or clear blocking return `UPSTREAM_BLOCKED`. There is no stealth, proxy rotation, fingerprint spoofing, login bypass, or CAPTCHA bypass.
- Query verification checks origin, destination, date, time, `DEPART_AT`, returned itinerary timing, and rendered page markers. The first directions response is not automatically trusted.
- Schema Sentinel fails closed on positional schema drift. Google arrays never leave this adapter.
- Raw responses, cookies, authorization headers, `pb`, and tokens are not logged. Optional debug captures are bounded and stored only under gitignored `artifacts/debug-captures/`.

## Setup

Requirements are the repository baseline: Node.js 24 and pnpm 11, plus installed Google Chrome.

```powershell
pnpm install
pnpm local-api:generate-token
```

The token command creates `services/google-consumer-transit/.env` only when it does not already exist. It does not print the complete token or overwrite an existing file. Add the remaining local settings to that untracked file:

```dotenv
ENABLE_GOOGLE_CONSUMER_TRANSIT=true
GOOGLE_TRANSIT_HEADLESS=true
```

Start the service:

```powershell
pnpm --filter @travel/google-consumer-transit dev
```

The default address is `http://127.0.0.1:8787`.

## HTTP API

`GET /health` is unauthenticated and never accesses Google:

```json
{
  "status": "OK",
  "provider": "GOOGLE_CONSUMER_EXPERIMENTAL",
  "enabled": true,
  "busy": false,
  "version": "0.1.0",
  "supportedTimeModes": ["DEPART_AT"]
}
```

`POST /v1/transit/search` accepts:

```json
{
  "origin": {
    "label": "Hotel Mahoroba",
    "latitude": 42.4930624,
    "longitude": 141.1419064
  },
  "destination": {
    "label": "洞爷湖景乃之风",
    "latitude": 42.565637,
    "longitude": 140.8222622
  },
  "date": "2026-09-23",
  "time": "15:00",
  "timezone": "Asia/Tokyo",
  "timeMode": "DEPART_AT"
}
```

`POST /v1/transit/import` keeps the PoC reverse-import path:

```json
{ "url": "https://www.google.com/maps/dir/...!6e0!7e2!8j...!3e3!5i1" }
```

Both endpoints return Travel-owned `TransitSearchResult` data with absolute UTC plus local date/time/timezone, all candidates, legs, verified transit endpoints, intermediate stops, fare, warnings, timing metrics, and `cacheHit`. Import additionally returns `selectedCandidateId`.

Only `DEPART_AT` is enabled. `ARRIVE_BY`, `NOW`, and `LAST_TRANSIT` return `UNSUPPORTED_MODE`; they are never silently replaced with departure mode.

## Commands

```powershell
pnpm --filter @travel/google-consumer-transit typecheck
pnpm --filter @travel/google-consumer-transit test
pnpm --filter @travel/google-consumer-transit build
pnpm --filter @travel/google-consumer-transit test:live
```

`test:live` performs five low-frequency real-browser checks: three direct searches and selected-route imports for indexes 1 and 0. It writes only a gitignored summary; raw Google responses are not committed.

## Configuration

See `.env.example`. Important settings:

- `ENABLE_GOOGLE_CONSUMER_TRANSIT=false`: kill switch, disabled by default.
- `LOCAL_TRANSIT_API_TOKEN`: local bearer token.
- `GOOGLE_TRANSIT_HOST=127.0.0.1`: V1 rejects other hosts.
- `GOOGLE_TRANSIT_HEADLESS=true`: set false only for local debugging.
- `MAX_CONCURRENT_SEARCHES=1`: V1 rejects other values.
- `GOOGLE_TRANSIT_CACHE_TTL_MS=300000`: small in-memory repeat-query cache; maximum accepted value is ten minutes.
- `DEBUG_TRANSIT_CAPTURE=false`: bounded raw-response capture, off by default.

## Known limitations

- Private endpoint and undocumented positional arrays have no compatibility promise.
- `lineShortName` remains `null` because no distinct stable field is verified.
- Walking endpoint coordinates and transit-leg distance remain `null`; only unambiguous values are returned.
- Cache is process-local and intentionally short-lived.
- This sidecar only searches and normalizes candidates. It does not create Events, mutate Schedules, adopt a route, create Bookings, or write Trip data.

## Future personal remote access

A future private-only shape may be:

```text
Travel Client → Tailscale private tailnet → Windows PC → Tailscale Serve → 127.0.0.1:8787
```

This project does not install or configure Tailscale, Tailscale Funnel, Cloudflare Tunnel, DDNS, router port forwarding, or any public listener.

For a commercial or multi-user product, replace this entire sidecar with an appropriately licensed provider instead of extending the Consumer integration.
