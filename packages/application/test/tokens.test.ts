import { describe, expect, it } from 'vitest';

import {
  createOpaqueToken,
  deriveMagicLinkToken,
  digestOpaqueToken,
} from '../src/index.js';

describe('opaque credentials', () => {
  it('creates high-entropy URL-safe values and stores only a SHA-256 digest shape', () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();

    expect(first.raw).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).not.toContain(first.raw);
    expect(second.raw).not.toBe(first.raw);
    expect(digestOpaqueToken(first.raw)).toBe(first.digest);
  });
});

describe('derived Magic Link credentials', () => {
  it('derives the same token for the same delivery request generation', () => {
    const key = 'SYNTHETIC_TEST_KEY_0123456789abcdef0123456789';
    const id = '11111111-1111-4111-8111-111111111111';
    const first = deriveMagicLinkToken(key, id, 1);
    const retry = deriveMagicLinkToken(key, id, 1);

    expect(first).toEqual(retry);
    expect(first.raw).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.digest).toBe(digestOpaqueToken(first.raw));
  });

  it('uses delivery identity and key as domain-separated inputs', () => {
    const key = 'SYNTHETIC_TEST_KEY_0123456789abcdef0123456789';
    expect(
      deriveMagicLinkToken(key, '11111111-1111-4111-8111-111111111111', 1).raw,
    ).not.toBe(
      deriveMagicLinkToken(key, '22222222-2222-4222-8222-222222222222', 1).raw,
    );
  });

  it('rotates the token when the persisted generation advances', () => {
    const key = 'SYNTHETIC_TEST_KEY_0123456789abcdef0123456789';
    const id = '11111111-1111-4111-8111-111111111111';

    expect(deriveMagicLinkToken(key, id, 2).raw).not.toBe(
      deriveMagicLinkToken(key, id, 1).raw,
    );
  });
});
