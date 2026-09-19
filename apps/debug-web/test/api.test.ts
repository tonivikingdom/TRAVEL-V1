import { describe, expect, it, vi } from 'vitest';

import { ApiClient, DebugApiError, parseErrorResponse } from '../src/api.js';

describe('debug-web API client', () => {
  it('parses a typed ApiErrorResponse without losing VERSION_CONFLICT', async () => {
    const error = await parseErrorResponse(
      new Response(
        JSON.stringify({
          error: {
            code: 'VERSION_CONFLICT',
            message: 'stale version',
            requestId: 'request-1',
            retryable: false,
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    expect(error).toMatchObject({
      kind: 'API',
      status: 409,
      code: 'VERSION_CONFLICT',
      requestId: 'request-1',
      retryable: false,
    });
  });

  it('distinguishes an unstructured HTTP failure', async () => {
    const error = await parseErrorResponse(
      new Response('gateway', { status: 502 }),
    );
    expect(error).toMatchObject({ kind: 'HTTP', status: 502, code: null });
  });

  it('distinguishes network failure and sends bearer credentials', async () => {
    const network = new ApiClient({
      credential: () => 'SYNTHETIC_CREDENTIAL',
      fetchImpl: vi.fn(async () => {
        throw new TypeError('network down');
      }) as typeof fetch,
    });
    await expect(network.get('/trips')).rejects.toMatchObject({
      kind: 'NETWORK',
      status: null,
    });

    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer SYNTHETIC_CREDENTIAL',
        );
        return new Response(JSON.stringify({ trips: [] }), { status: 200 });
      },
    ) as typeof fetch;
    const client = new ApiClient({
      credential: () => 'SYNTHETIC_CREDENTIAL',
      fetchImpl,
    });
    await expect(client.get('/trips')).resolves.toEqual({ trips: [] });
  });

  it('does not retry a mutation after a failure', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'VERSION_CONFLICT',
              message: 'stale',
              requestId: 'request-2',
              retryable: false,
            },
          }),
          { status: 409 },
        ),
    ) as typeof fetch;
    const client = new ApiClient({ credential: () => null, fetchImpl });
    await expect(client.post('/trips/1/commands', {})).rejects.toBeInstanceOf(
      DebugApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
