import type { ProbeScenario, RouteProbeQuery } from '../types.js';

export const japanCoreScenarios: readonly ProbeScenario[] = [
  {
    id: 'cts-sapporo',
    suiteId: 'japan-core',
    name: '新千岁机场 → 札幌站',
    origin: { name: '新千岁机场', lat: 42.7752, lng: 141.6923 },
    destination: { name: '札幌站', lat: 43.068611, lng: 141.350833 },
  },
  {
    id: 'cts-daiichi-takimotokan',
    suiteId: 'japan-core',
    name: '新千岁机场 → 第一滝本館',
    origin: { name: '新千岁机场', lat: 42.7752, lng: 141.6923 },
    destination: { name: '第一滝本館', lat: 42.4758, lng: 141.1057 },
  },
  {
    id: 'noboribetsu-daiichi-takimotokan',
    suiteId: 'japan-core',
    name: '登别站 → 第一滝本館',
    origin: { name: '登别站', lat: 42.452083, lng: 141.180444 },
    destination: { name: '第一滝本館', lat: 42.4758, lng: 141.1057 },
  },
  {
    id: 'noboribetsu-onsen-toyako-onsen',
    suiteId: 'japan-core',
    name: '第一滝本館 → 洞爷湖温泉',
    origin: { name: '第一滝本館', lat: 42.4758, lng: 141.1057 },
    destination: { name: '洞爷湖温泉', lat: 42.565716, lng: 140.821508 },
  },
  {
    id: 'kix-shirahama',
    suiteId: 'japan-core',
    name: '关西空港 → 白滨住宿区域',
    origin: { name: '关西国际机场', lat: 34.4347, lng: 135.2442 },
    destination: { name: '白良滨住宿区域', lat: 33.6824092, lng: 135.3443425 },
  },
];

export function buildJapanScenarioQueries(
  scenario: ProbeScenario,
  mode: 'quick' | 'full',
  arriveBySupported: boolean,
  now: Date,
): readonly RouteProbeQuery[] {
  const departure = nextJapanDateAt(now, 9);
  const queries: RouteProbeQuery[] = [
    {
      origin: scenario.origin,
      destination: scenario.destination,
      mode: 'DEPART_AT',
      instant: departure.toISOString(),
      timeZone: 'Asia/Tokyo',
    },
  ];
  if (arriveBySupported) {
    queries.push({
      origin: scenario.origin,
      destination: scenario.destination,
      mode: 'ARRIVE_BY',
      instant: nextJapanDateAt(now, 20).toISOString(),
      timeZone: 'Asia/Tokyo',
    });
  }
  if (mode === 'full') {
    queries.push({
      origin: scenario.origin,
      destination: scenario.destination,
      mode: 'DEPART_AT',
      instant: nextJapanDateAt(now, 14).toISOString(),
      timeZone: 'Asia/Tokyo',
    });
  }
  return queries;
}

function nextJapanDateAt(now: Date, hour: number): Date {
  const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(future);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return new Date(
    `${value.year}-${value.month}-${value.day}T${String(hour).padStart(2, '0')}:00:00+09:00`,
  );
}
