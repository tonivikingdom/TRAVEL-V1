import { describe, expect, it } from 'vitest';
import {
  createGroundTransitHubResolver,
  SyntheticGroundTransitHubResolver,
  UnconfiguredGroundTransitHubResolver,
} from '../src/ground-transit-hub-resolver.js';
const input = {
  provider: 'SYNTHETIC',
  providerHubRef: 'synthetic:short-terminus',
  labelHint: 'Client label is not identity',
};
describe('trusted hub resolver boundary', () => {
  it('resolves explicit synthetic metadata deterministically', async () => {
    const resolver = new SyntheticGroundTransitHubResolver();
    expect(await resolver.resolveHub(input)).toEqual(
      await resolver.resolveHub({ ...input, labelHint: 'Another label' }),
    );
    expect(await resolver.resolveHub(input)).toMatchObject({
      status: 'RESOLVED',
      hub: {
        canonicalHubRef: 'synthetic:hub:short-terminus',
        timeZone: 'Asia/Tokyo',
      },
    });
    expect(await resolver.resolveHub({ ...input, provider: 'OTHER' })).toEqual({
      status: 'NOT_FOUND',
    });
  });
  it.each(['production', 'staging', undefined])(
    'does not invent metadata in %s',
    async (APP_ENV) => {
      expect(
        await createGroundTransitHubResolver({
          APP_ENV,
          SYNTHETIC_CI_ONLY: 'true',
        }).resolveHub(input),
      ).toEqual({ status: 'UNAVAILABLE' });
    },
  );
  it('requires explicit synthetic Dev/Test configuration', async () => {
    expect(
      await createGroundTransitHubResolver({ APP_ENV: 'test' }).resolveHub(
        input,
      ),
    ).toEqual({ status: 'UNAVAILABLE' });
    expect(
      await createGroundTransitHubResolver({
        APP_ENV: 'test',
        SYNTHETIC_CI_ONLY: 'true',
      }).resolveHub(input),
    ).toMatchObject({ status: 'RESOLVED' });
    expect(
      await new UnconfiguredGroundTransitHubResolver().resolveHub(),
    ).toEqual({ status: 'UNAVAILABLE' });
  });
});
