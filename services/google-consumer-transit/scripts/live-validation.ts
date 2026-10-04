import { observeLiveBrowser } from './live-browser-observer.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { GoogleConsumerExperimentalRouteProvider } from '../../../packages/providers/src/google-consumer-transit-route-provider.js';
import { readConfig } from '../src/config.js';
import { parseQuery, queryInstant, type Query } from '../src/contract.js';
import { buildServer } from '../src/server.js';

if (process.env.GOOGLE_TRANSIT_LIVE_ACK !== 'personal-development')
  throw new Error(
    'Live validation requires explicit personal-development scope acknowledgement',
  );
const date = process.env.GOOGLE_TRANSIT_LIVE_DATE;
if (!date)
  throw new Error('GOOGLE_TRANSIT_LIVE_DATE must be an explicit absolute date');
const token = randomBytes(32).toString('hex');
const config = readConfig({
  ...process.env,
  APP_ENV: process.env.APP_ENV ?? 'test',
  ENABLE_GOOGLE_CONSUMER_TRANSIT: 'true',
  LOCAL_TRANSIT_API_TOKEN: token,
});
const observer = observeLiveBrowser();
const app = buildServer(config);
const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
const scenarios = [
  {
    id: 'rail',
    origin: {
      label: 'Sapporo Station',
      latitude: 43.068661,
      longitude: 141.350755,
    },
    destination: {
      label: 'Otaru Station',
      latitude: 43.197305,
      longitude: 140.993625,
    },
    time: '10:00',
  },
  {
    id: 'tokyo',
    origin: {
      label: 'Tokyo Station query point',
      latitude: 35.681236,
      longitude: 139.767125,
    },
    destination: {
      label: 'Shinjuku Station query point',
      latitude: 35.690921,
      longitude: 139.700258,
    },
    time: '10:00',
  },
  {
    id: 'kansai',
    origin: {
      label: 'Osaka Station query point',
      latitude: 34.702485,
      longitude: 135.495951,
    },
    destination: {
      label: 'Kyoto Station query point',
      latitude: 34.985849,
      longitude: 135.758767,
    },
    time: '10:00',
  },
  {
    id: 'mixed',
    origin: {
      label: 'Hotel Mahoroba',
      latitude: 42.4930624,
      longitude: 141.1419064,
    },
    destination: {
      label: 'The Lake View Toya Nonokaze Resort',
      latitude: 42.565637,
      longitude: 140.8222622,
    },
    time: '15:00',
  },
];
const summaries: unknown[] = [];
let blocked = false;
let stopped = false;
let stopReason: string | null = null;
try {
  for (const scenario of scenarios.filter(
    (s) =>
      !process.env.GOOGLE_TRANSIT_LIVE_SCENARIO ||
      s.id === process.env.GOOGLE_TRANSIT_LIVE_SCENARIO,
  )) {
    for (const timeMode of (['DEPART_AT', 'ARRIVE_BY'] as const).filter(
      (m) =>
        !process.env.GOOGLE_TRANSIT_LIVE_MODE ||
        m === process.env.GOOGLE_TRANSIT_LIVE_MODE,
    )) {
      if (stopped) break;
      const query = parseQuery({
        ...scenario,
        date,
        timezone: 'Asia/Tokyo',
        timeMode,
        time: process.env.GOOGLE_TRANSIT_LIVE_TIME ?? scenario.time,
      });
      observer.setExpectedQuery(query);
      let responseBody: Record<string, unknown> | undefined;
      let calls = 0;
      const provider = new GoogleConsumerExperimentalRouteProvider({
        baseUrl,
        token,
        timeoutMs: 60000,
        fetchImplementation: async (url, init) => {
          calls++;
          const response = await fetch(url, init);
          responseBody = (await response.clone().json()) as Record<
            string,
            unknown
          >;
          return response;
        },
      });
      const instant = new Date(queryInstant(query));
      const started = Date.now();
      const result = await provider.queryRoutes({
        origin: {
          placeId: 'live-origin',
          name: query.origin.label,
          latitude: query.origin.latitude,
          longitude: query.origin.longitude,
        },
        destination: {
          placeId: 'live-destination',
          name: query.destination.label,
          latitude: query.destination.latitude,
          longitude: query.destination.longitude,
        },
        earliestDeparture: timeMode === 'DEPART_AT' ? instant : null,
        latestArrival: timeMode === 'ARRIVE_BY' ? instant : null,
        preference: { type: timeMode, instant, timeZone: query.timezone },
      });
      const error = responseBody?.error as
        { code?: string; stage?: string } | undefined;
      const summary = {
        scenario: scenario.id,
        query: query as Query,
        status: result.status,
        errorCode: error?.code ?? null,
        errorStage: error?.stage ?? null,
        httpCalls: calls,
        elapsedMs: Date.now() - started,
        fetchedAt: responseBody?.fetchedAt ?? null,
        evidence: responseBody?.evidence ?? null,
        ...(result.status === 'SUCCESS'
          ? {
              candidateCount: result.candidates.length,
              candidates: result.candidates.map((c) => ({
                id: c.candidateId,
                departure: c.departure.instant.toISOString(),
                arrival: c.arrival.instant.toISOString(),
                durationSeconds: c.durationSeconds,
                fare: c.fare,
                legs: c.legs.map((l) => ({
                  mode: l.mode,
                  from: l.from,
                  to: l.to,
                  departure: l.departure?.instant.toISOString() ?? null,
                  arrival: l.arrival?.instant.toISOString() ?? null,
                  durationSeconds: l.durationSeconds,
                  serviceLabel: l.serviceLabel,
                  fixedService: l.fixedService,
                })),
              })),
            }
          : {}),
      };
      summaries.push(summary);
      process.stdout.write(
        JSON.stringify({
          scenario: scenario.id,
          mode: timeMode,
          status: result.status,
          errorCode: error?.code ?? null,
          errorStage: error?.stage ?? null,
        }) + '\n',
      );
      if (result.status !== 'SUCCESS') {
        blocked = error?.code === 'UPSTREAM_BLOCKED';
        stopped = true;
        stopReason = error?.code ?? result.status;
      }
      // Low-frequency serial validation; no retries. Eight target operations maximum, two modes across four scenarios.
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
} finally {
  await app.close();
  observer.restore();
  const directory = new URL(
    '../../../artifacts/google-consumer-transit/',
    import.meta.url,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL('live-summary.json', directory),
    JSON.stringify(
      {
        implementation: 'REBUILT_COMPATIBLE_IMPLEMENTATION',
        recordedAt: new Date().toISOString(),
        diagnostics: observer.diagnostics,
        blocked,
        stopReason,
        summaries,
      },
      null,
      2,
    ),
  );
}
if (
  blocked ||
  summaries.some((v) => (v as { status: string }).status !== 'SUCCESS')
)
  process.exitCode = 1;
