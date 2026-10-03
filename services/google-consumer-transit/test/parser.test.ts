import { describe, it, expect } from 'vitest';
import { parseQuery, queryInstant, TransitError } from '../src/contract.js';
import {
  parseResponse,
  selectResponse,
  slot,
  verifyResponse,
} from '../src/parser.js';
import { blockedPage, pageStateMatches } from '../src/browser.js';
import { query, evidence, raw, rawFixture } from './fixtures.js';
describe('SYNTHETIC schema and semantic guards', () => {
  it('parses nullable fare and verified transit slots', () => {
    const result = parseResponse(raw());
    expect(result.candidates[0]).toMatchObject({
      durationSeconds: 1800,
      fare: null,
      legs: [{ mode: 'TRAIN', lineName: 'SYNTHETIC Line' }],
    });
    expect(() => verifyResponse(result, query, evidence)).not.toThrow();
  });
  it('ignores a wrong first response and selects a later valid response', () => {
    expect(
      selectResponse(
        [JSON.stringify(rawFixture(1791075600, 1791077400)), raw()],
        query,
        evidence,
      ).index,
    ).toBe(1);
  });
  it.each([
    'modeVisible',
    'dateVisible',
    'timeVisible',
    'pageStateMatches',
    'timezoneMatches',
  ] as const)('rejects missing page verification %s', (key) => {
    expect(() =>
      verifyResponse(parseResponse(raw()), query, {
        ...evidence,
        [key]: false,
      }),
    ).toThrow('REQUEST_MISMATCH');
  });
  it('rejects wrong coordinates and timezone without rewriting the query', () => {
    expect(() =>
      verifyResponse(
        parseResponse(raw()),
        { ...query, origin: { ...query.origin, latitude: 43.01 } },
        evidence,
      ),
    ).toThrow('REQUEST_MISMATCH');
    expect(() =>
      verifyResponse(
        parseResponse(raw()),
        { ...query, timezone: 'UTC' },
        evidence,
      ),
    ).toThrow('REQUEST_MISMATCH');
  });
  it('validates every candidate for each time mode, with inclusive boundaries', () => {
    const parsed = parseResponse(raw());
    expect(() => verifyResponse(parsed, query, evidence)).not.toThrow();
    expect(() =>
      verifyResponse(parsed, { ...query, time: '10:01' }, evidence),
    ).toThrow('REQUEST_MISMATCH');
    expect(() =>
      verifyResponse(
        parsed,
        { ...query, time: '10:30', timeMode: 'ARRIVE_BY' },
        evidence,
      ),
    ).not.toThrow();
    expect(() =>
      verifyResponse(parsed, { ...query, timeMode: 'ARRIVE_BY' }, evidence),
    ).toThrow('REQUEST_MISMATCH');
    const outlier = {
      ...parsed.candidates[0]!,
      arrivalTime: {
        ...parsed.candidates[0]!.arrivalTime,
        utc: '2026-10-05T03:00:00.000Z',
      },
    };
    expect(() =>
      verifyResponse(
        { ...parsed, candidates: [parsed.candidates[0]!, outlier] },
        { ...query, time: '10:30', timeMode: 'ARRIVE_BY' },
        evidence,
      ),
    ).toThrow('REQUEST_MISMATCH');
  });
  it('uses absolute instants across midnight and host timezones', () => {
    const q = {
      ...query,
      date: '2026-10-06',
      time: '00:10',
      timeMode: 'ARRIVE_BY' as const,
    };
    const arrival = queryInstant(q) / 1000,
      departure = arrival - 1800;
    const parsed = parseResponse(
      JSON.stringify(rawFixture(departure, arrival)),
    );
    expect(parsed.candidates[0]!.departureTime.localDateTime).toBe(
      '2026-10-05T23:40:00',
    );
    expect(() => verifyResponse(parsed, q, evidence)).not.toThrow();
  });
  it.each(['2026-02-30', '2026-13-01', 'not-a-date'])(
    'rejects invalid date %s',
    (date) =>
      expect(() => parseQuery({ ...query, date })).toThrow('VALIDATION_ERROR'),
  );
  it.each(['25:00', '9:00', '00:60'])('rejects invalid time %s', (time) =>
    expect(() => parseQuery({ ...query, time })).toThrow('VALIDATION_ERROR'),
  );
  it('rejects DST gaps and ambiguities instead of silently choosing', () => {
    expect(() =>
      parseQuery({
        ...query,
        date: '2026-03-08',
        time: '02:30',
        timezone: 'America/New_York',
      }),
    ).toThrow('VALIDATION_ERROR');
    expect(() =>
      parseQuery({
        ...query,
        date: '2026-11-01',
        time: '01:30',
        timezone: 'America/New_York',
      }),
    ).toThrow('VALIDATION_ERROR');
  });
  it.each(['NOW', 'LAST_TRANSIT'])('does not support %s', (timeMode) =>
    expect(() => parseQuery({ ...query, timeMode })).toThrow(
      'UNSUPPORTED_MODE',
    ),
  );
  it('distinguishes schema changes, mismatch, and verified empty results', () => {
    expect(() => selectResponse(['{}'], query, evidence)).toThrow(
      'SCHEMA_CHANGED',
    );
    expect(() =>
      selectResponse([raw()], { ...query, time: '11:00' }, evidence),
    ).toThrow('REQUEST_MISMATCH');
    const empty = rawFixture();
    (empty[0] as unknown[])[1] = [];
    expect(() =>
      selectResponse([JSON.stringify(empty)], query, evidence),
    ).toThrow('REQUEST_MISMATCH');
    expect(() =>
      selectResponse([JSON.stringify(empty)], query, {
        ...evidence,
        noRoutesVisible: true,
      }),
    ).toThrow('NO_ROUTES');
    expect(() =>
      selectResponse([JSON.stringify(empty)], query, {
        ...evidence,
        noRoutesVisible: true,
        modeVisible: false,
      }),
    ).toThrow('REQUEST_MISMATCH');
  });
  it('fails closed on duration mutations and missing stops', () => {
    const broken = rawFixture();
    const summary = slot(broken, [0, 1, 0, 0]) as unknown[];
    summary[3] = [1];
    expect(() => parseResponse(JSON.stringify(broken))).toThrow(
      'SCHEMA_CHANGED',
    );
    const noStop = rawFixture();
    (slot(noStop, [0, 1, 0, 1, 0, 1, 0, 5]) as unknown[])[0] = null;
    expect(() => parseResponse(JSON.stringify(noStop))).toThrow(
      'SCHEMA_CHANGED',
    );
  });
  it('recognizes challenges/login gates without treating the ordinary sign-in link as a gate', () => {
    expect(blockedPage('https://www.google.com/maps/', 'Sign in')).toBe(false);
    expect(blockedPage('https://www.google.com/sorry/', '')).toBe(true);
    expect(
      blockedPage(
        'https://www.google.com/maps/',
        'Our systems have detected unusual traffic',
      ),
    ).toBe(true);
    expect(blockedPage('https://accounts.google.com/', '')).toBe(true);
  });
  it('requires the exact time mode and wall clock in UI-derived page state', () => {
    const url =
      'https://www.google.com/maps/dir/example/data=!6e0!7e2!8j1791194400!3e3';
    expect(pageStateMatches(url, query)).toBe(true);
    expect(pageStateMatches(url, { ...query, timeMode: 'ARRIVE_BY' })).toBe(
      false,
    );
  });
  it('preserves classified error statuses', () =>
    expect(new TransitError('UPSTREAM_BLOCKED').statusCode).toBe(502));
});
