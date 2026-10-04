// SYNTHETIC positional arrays and normalized values. Never evidence of a Google query.
import { PROVIDER, type Query, type SearchResult } from '../src/contract.js';
import type { PageEvidence } from '../src/parser.js';
export const query: Query = {
  origin: { label: 'SYNTHETIC Origin', latitude: 43, longitude: 141 },
  destination: { label: 'SYNTHETIC Destination', latitude: 44, longitude: 142 },
  date: '2026-10-05',
  time: '10:00',
  timezone: 'Asia/Tokyo',
  timeMode: 'DEPART_AT',
};
export const evidence: PageEvidence = {
  modeVisible: true,
  dateVisible: true,
  timeVisible: true,
  pageStateMatches: true,
  timezoneMatches: true,
  text: '10:00 AM 10:30 AM SYNTHETIC Line',
  noRoutesVisible: false,
};
const list = (length: number) => Array<unknown>(length).fill(null);
function time(epoch: number) {
  return [
    epoch,
    'Asia/Tokyo',
    epoch === 1791162000 ? '10:00 AM' : '10:30 AM',
    0,
    0,
  ];
}
export function rawFixture(
  departure = 1791162000,
  arrival = 1791163800,
): unknown[] {
  const endpoint = (latitude: number, longitude: number) => {
    const place = list(24);
    place[0] = [null, null, [null, null, latitude, longitude]];
    return [place];
  };
  const stop = (
    label: string,
    latitude: number,
    longitude: number,
    dep: number | null,
    arr: number | null,
  ) => {
    const s = list(11);
    s[0] = label;
    s[4] = [null, null, latitude, longitude];
    s[2] = arr === null ? null : time(arr);
    s[3] = dep === null ? null : time(dep);
    return s;
  };
  const summary = list(15);
  summary[3] = [arrival - departure];
  summary[5] = [time(departure), time(arrival)];
  summary[11] = null;
  const legSummary = list(15);
  legSummary[3] = [arrival - departure];
  legSummary[14] = [
    [4, null, [3, 'rail2.png', null, 'Train']],
    [5, ['SYNTHETIC Line']],
  ];
  const transit = [
    stop('SYNTHETIC Origin', 43, 141, departure, null),
    stop('SYNTHETIC Destination', 44, 142, null, arrival),
  ];
  const leg = [legSummary, null, null, null, null, transit];
  return [
    [[endpoint(43, 141), endpoint(44, 142)], [[summary, [[null, [leg]]]]]],
    null,
    null,
    null,
    null,
    null,
    null,
  ];
}
export const raw = () => JSON.stringify(rawFixture());
export function syntheticResult(q: Query = query): SearchResult {
  return {
    status: 'OK',
    provider: PROVIDER,
    queryVerified: true,
    requestedQuery: q,
    fetchedAt: '2026-10-03T00:00:00.000Z',
    candidateCount: 1,
    cacheHit: false,
    evidence: {
      modeVisible: true,
      dateVisible: true,
      timeVisible: true,
      pageStateMatches: true,
      timezoneMatches: true,
      selectedResponseIndex: 0,
      responseCount: 1,
    },
    candidates: [
      {
        id: 'SYNTHETIC-candidate',
        sourceIndex: 0,
        departureTime: {
          localDateTime: '2026-10-05T10:00:00',
          timezone: 'Asia/Tokyo',
          utc: '2026-10-05T01:00:00.000Z',
        },
        arrivalTime: {
          localDateTime: '2026-10-05T10:30:00',
          timezone: 'Asia/Tokyo',
          utc: '2026-10-05T01:30:00.000Z',
        },
        durationSeconds: 1800,
        fare: null,
        legs: [
          {
            mode: 'TRAIN',
            from: {
              name: q.origin.label,
              latitude: q.origin.latitude,
              longitude: q.origin.longitude,
            },
            to: {
              name: q.destination.label,
              latitude: q.destination.latitude,
              longitude: q.destination.longitude,
            },
            departureTime: {
              localDateTime: '2026-10-05T10:00:00',
              timezone: 'Asia/Tokyo',
              utc: '2026-10-05T01:00:00.000Z',
            },
            arrivalTime: {
              localDateTime: '2026-10-05T10:30:00',
              timezone: 'Asia/Tokyo',
              utc: '2026-10-05T01:30:00.000Z',
            },
            durationSeconds: 1800,
            lineName: null,
            serviceName: null,
          },
        ],
      },
    ],
  };
}
