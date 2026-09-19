import { describe, expect, it } from 'vitest';

import { hashRouteAdoptionRequest } from '../src/route-snapshot.js';

const basis = {
  tripId: '00000000-0000-4000-8000-000000000001',
  previewId: '00000000-0000-4000-8000-000000000002',
  baseTripVersion: 7,
} as const;

describe('route adoption request hashing', () => {
  it('keeps an empty P5C adjustment list compatible with legacy adoption retries', () => {
    expect(
      hashRouteAdoptionRequest({ ...basis, acceptedUserAdjustments: [] }),
    ).toBe(hashRouteAdoptionRequest(basis));
  });

  it('binds an accepted user dwell adjustment into the idempotency hash', () => {
    expect(
      hashRouteAdoptionRequest({
        ...basis,
        acceptedUserAdjustments: [
          {
            intentId: '00000000-0000-4000-8000-000000000003',
            nodeId: '00000000-0000-4000-8000-000000000004',
            fromDurationSeconds: 3_000,
            toDurationSeconds: 2_700,
          },
        ],
      }),
    ).not.toBe(hashRouteAdoptionRequest(basis));
  });
});
