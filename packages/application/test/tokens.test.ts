import { describe, expect, it } from 'vitest';

import { createOpaqueToken, digestOpaqueToken } from '../src/index.js';

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
