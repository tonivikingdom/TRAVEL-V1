import { expect, it, vi } from 'vitest';
import { doctor, classify } from './runner.js';
import { credentials, gates } from './config.js';
const env = Object.fromEntries(
  credentials.map(([, key]) => [key, 'SYNTHETIC_SECRET_DO_NOT_ECHO']),
);
it('configuration only never requests or exposes credentials, and does not mutate gates', async () => {
  const fetcher = vi.fn();
  const configured = { ...env, GOOGLE_ENTITLEMENT_APPROVED: 'true' };
  const before = { ...configured };
  const result = await doctor(configured, false, fetcher);
  expect(result.count).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(configured).toEqual(before);
  expect(result.lines.join('\n')).not.toContain('SYNTHETIC_SECRET_DO_NOT_ECHO');
  for (const [, key] of credentials) expect(env[key]).toBeDefined();
  for (const gate of gates)
    expect(result.lines.some((line) => line.startsWith(gate + ':'))).toBe(true);
});
it('missing secrets make zero requests even in live mode', async () => {
  const fetcher = vi.fn();
  expect((await doctor({}, true, fetcher)).count).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
it('live requests each implemented capability once, sanitizes failures and never retries', async () => {
  const fetcher = vi.fn(async () => {
    throw new Error('SYNTHETIC_SECRET_DO_NOT_ECHO');
  });
  const result = await doctor(env, true, fetcher);
  expect(result.count).toBe(6);
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(
    result.lines.filter((line) => line.endsWith('NETWORK_BLOCKED')),
  ).toHaveLength(6);
  expect(result.lines.join('\n')).not.toContain('SYNTHETIC_SECRET_DO_NOT_ECHO');
});
it.each([
  [
    403,
    { error: { details: [{ reason: 'SERVICE_DISABLED' }] } },
    'API_NOT_ENABLED',
  ],
  [
    403,
    { error: { details: [{ reason: 'BILLING_DISABLED' }] } },
    'BILLING_OR_ENTITLEMENT',
  ],
  [401, {}, 'AUTH_REJECTED'],
  [200, { status: 302 }, 'PROVIDER_ERROR'],
  [200, { status: 0 }, null],
] as const)(
  'classifies %s without outputting provider messages',
  (status, body, result) => {
    expect(classify(status, body)).toBe(result);
  },
);
it('invalid HTTP 200 is contract mismatch; proxy denial is network blocked', async () => {
  for (const status of [200, 403]) {
    const result = await doctor(
      { GOOGLE_SERVER_API_KEY: 'SYNTHETIC' },
      true,
      async () => new Response('SYNTHETIC_SECRET_DO_NOT_ECHO', { status }),
    );
    expect(result.count).toBe(3);
    expect(
      result.lines.filter((l) =>
        l.endsWith(status === 200 ? 'CONTRACT_MISMATCH' : 'NETWORK_BLOCKED'),
      ),
    ).toHaveLength(3);
    expect(result.lines.join('\n')).not.toContain(
      'SYNTHETIC_SECRET_DO_NOT_ECHO',
    );
  }
});

it('tracked template contains every credential and gate, with empty keys and false gates', async () => {
  const { readFile } = await import('node:fs/promises');
  const template = await readFile(
    new URL('../../.env.provider.example', import.meta.url),
    'utf8',
  );
  for (const [, name] of credentials)
    expect(template.split('\n')).toContain(`${name}=`);
  for (const name of gates)
    expect(template.split('\n')).toContain(`${name}=false`);
});
