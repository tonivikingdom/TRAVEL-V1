import { request as httpRequest } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import { GoogleConsumerExperimentalRouteProvider } from '../../../packages/providers/src/google-consumer-transit-route-provider.js';
import { readConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import {
  TransitError,
  errorStatuses,
  type ErrorCode,
} from '../src/contract.js';
import type { TransitClient } from '../src/browser.js';
import { query, syntheticResult } from './fixtures.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const token = 'SYNTHETIC_LOCAL_TEST_TOKEN_32_CHARS';
const config: Config = readConfig({
  APP_ENV: 'test',
  LOCAL_TRANSIT_API_TOKEN: token,
  ENABLE_GOOGLE_CONSUMER_TRANSIT: 'true',
});
const headers = { authorization: `Bearer ${token}` };
function fake(): TransitClient {
  return {
    search: vi.fn(async (q) => syntheticResult(q)),
    close: vi.fn(async () => {}),
  };
}
describe('SYNTHETIC loopback service protections', () => {
  it.each(['staging', 'production', 'unknown'])(
    'rejects environment %s',
    (APP_ENV) =>
      expect(() =>
        readConfig({ APP_ENV, LOCAL_TRANSIT_API_TOKEN: token }),
      ).toThrow(),
  );
  it.each(['0.0.0.0', 'localhost', '::'])(
    'rejects bind %s',
    (GOOGLE_TRANSIT_HOST) =>
      expect(() =>
        readConfig({ LOCAL_TRANSIT_API_TOKEN: token, GOOGLE_TRANSIT_HOST }),
      ).toThrow(),
  );
  it('rejects missing token, expanded concurrency and malformed switches', () => {
    expect(() => readConfig({})).toThrow();
    expect(() =>
      readConfig({
        LOCAL_TRANSIT_API_TOKEN: token,
        MAX_CONCURRENT_SEARCHES: '2',
      }),
    ).toThrow();
    expect(() =>
      readConfig({
        LOCAL_TRANSIT_API_TOKEN: token,
        ENABLE_GOOGLE_CONSUMER_TRANSIT: 'yes',
      }),
    ).toThrow();
  });
  it('health and disabled/auth requests never access Google', async () => {
    const client = fake();
    const app = buildServer({ ...config, enabled: false }, client);
    try {
      expect((await app.inject('/health')).json()).toMatchObject({
        enabled: false,
        supportedTimeModes: ['DEPART_AT', 'ARRIVE_BY'],
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/transit/search',
            payload: query,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/transit/search',
            headers,
            payload: query,
          })
        ).statusCode,
      ).toBe(503);
      expect(client.search).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('does not advertise or silently convert a disabled mode', async () => {
    const client = fake();
    const app = buildServer(
      { ...config, supportedModes: ['DEPART_AT'] },
      client,
    );
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/transit/search',
            headers,
            payload: { ...query, timeMode: 'ARRIVE_BY' },
          })
        ).statusCode,
      ).toBe(422);
      expect(client.search).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('validates input, has no cache, and preserves modes independently', async () => {
    const client = fake();
    const app = buildServer(config, client);
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/transit/search',
            headers,
            payload: { ...query, date: '2026-02-30' },
          })
        ).statusCode,
      ).toBe(400);
      for (const timeMode of ['DEPART_AT', 'ARRIVE_BY', 'DEPART_AT']) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/transit/search',
              headers,
              payload: { ...query, timeMode },
            })
          ).json().requestedQuery.timeMode,
        ).toBe(timeMode);
      }
      expect(client.search).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
  it('rejects the second operation immediately, then releases the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = deferred();
    const client = fake();
    client.search = vi.fn(async (q) => {
      entered.resolve();
      await gate;
      return syntheticResult(q);
    });
    const app = buildServer(config, client);
    try {
      const first = app.inject({
        method: 'POST',
        url: '/v1/transit/search',
        headers,
        payload: query,
      });
      await entered.promise;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/transit/search',
            headers,
            payload: query,
          })
        ).json().error.code,
      ).toBe('BUSY');
      release();
      expect((await first).statusCode).toBe(200);
      expect((await app.inject('/health')).json().busy).toBe(false);
    } finally {
      release();
      await app.close();
    }
  });
  it('deadline aborts operation, waits for cleanup and releases lock', async () => {
    let cleaned = false;
    const client = fake();
    client.search = vi.fn(async (_q, signal) => {
      try {
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
        return syntheticResult();
      } finally {
        cleaned = true;
      }
    });
    const app = buildServer({ ...config, timeoutMs: 10 }, client);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/transit/search',
        headers,
        payload: query,
      });
      expect(response.json().error.code).toBe('UPSTREAM_TIMEOUT');
      expect(cleaned).toBe(true);
      expect((await app.inject('/health')).json().busy).toBe(false);
    } finally {
      await app.close();
    }
  });
  it.each(Object.entries(errorStatuses) as [ErrorCode, number][])(
    'preserves error %s at HTTP %s and releases lock',
    async (code, status) => {
      const client = fake();
      client.search = vi.fn(async () => {
        throw new TransitError(code);
      });
      const app = buildServer(config, client);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/transit/search',
          headers,
          payload: query,
        });
        expect(response.statusCode).toBe(status);
        expect(response.json().error.code).toBe(code);
        expect((await app.inject('/health')).json().busy).toBe(false);
      } finally {
        await app.close();
      }
    },
  );
  it('a real HTTP client disconnect cancels work and frees the lock', async () => {
    const entered = deferred(),
      cancelled = deferred();
    const client = fake();
    client.search = vi.fn(async (_q, signal) => {
      entered.resolve();
      await new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled.resolve();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
      return syntheticResult();
    });
    const app = buildServer(config, client);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const req = httpRequest(new URL('/v1/transit/search', address), {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
      });
      req.on('error', () => {});
      req.end(JSON.stringify(query));
      await entered.promise;
      req.destroy();
      await cancelled.promise;
      await vi.waitFor(async () =>
        expect((await app.inject('/health')).json().busy).toBe(false),
      );
    } finally {
      await app.close();
    }
  });
  it('original Travel adapter consumes real loopback HTTP with SYNTHETIC data', async () => {
    const client = fake(),
      app = buildServer(config, client);
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const provider = new GoogleConsumerExperimentalRouteProvider({
        baseUrl,
        token,
        timeoutMs: 1000,
      });
      const result = await provider.queryRoutes({
        origin: {
          placeId: 'synthetic-origin',
          name: query.origin.label,
          latitude: 43,
          longitude: 141,
        },
        destination: {
          placeId: 'synthetic-destination',
          name: query.destination.label,
          latitude: 44,
          longitude: 142,
        },
        earliestDeparture: new Date('2026-10-05T01:00:00.000Z'),
        latestArrival: null,
        preference: {
          type: 'DEPART_AT',
          instant: new Date('2026-10-05T01:00:00.000Z'),
          timeZone: 'Asia/Tokyo',
        },
      });
      expect(result).toMatchObject({
        status: 'SUCCESS',
        candidates: [
          { fare: null, legs: [{ mode: 'RAIL', fixedService: true }] },
        ],
      });
      expect(client.search).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
