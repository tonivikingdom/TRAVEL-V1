import { describe, expect, it } from 'vitest';

import { sanitizeEvidence } from './report.js';

describe('provider probe report safety', () => {
  it('redacts secrets and authentication-shaped fields recursively', () => {
    const secret = 'SYNTHETIC_SECRET_VALUE';
    expect(
      sanitizeEvidence(
        {
          headers: { 'X-TripGo-Key': secret },
          nested: `key=${secret}`,
          safe: 'kept',
        },
        [secret],
      ),
    ).toEqual({
      headers: '[REDACTED]',
      nested: 'key=[REDACTED]',
      safe: 'kept',
    });
  });
});
