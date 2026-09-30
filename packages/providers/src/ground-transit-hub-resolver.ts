import type { GroundTransitHubResolver } from '@travel/application';
export class UnconfiguredGroundTransitHubResolver implements GroundTransitHubResolver {
  async resolveHub(): Promise<{ status: 'UNAVAILABLE' }> {
    return { status: 'UNAVAILABLE' };
  }
}
/** Explicit Dev/Test metadata; never a production fallback. */
export class SyntheticGroundTransitHubResolver implements GroundTransitHubResolver {
  async resolveHub(
    input: Parameters<GroundTransitHubResolver['resolveHub']>[0],
  ): ReturnType<GroundTransitHubResolver['resolveHub']> {
    if (
      input.provider !== 'SYNTHETIC' ||
      input.providerHubRef !== 'synthetic:short-terminus'
    )
      return { status: 'NOT_FOUND' };
    return {
      status: 'RESOLVED',
      hub: {
        provider: 'SYNTHETIC',
        providerHubRef: 'synthetic:short-terminus',
        canonicalHubRef: 'synthetic:hub:short-terminus',
        name: 'Synthetic Short Terminus',
        latitude: 35.705,
        longitude: 139.705,
        timeZone: 'Asia/Tokyo',
      },
    };
  }
}
export function createGroundTransitHubResolver(
  env: Readonly<Record<string, string | undefined>>,
): GroundTransitHubResolver {
  return ['development', 'test'].includes(env.APP_ENV ?? '') &&
    env.SYNTHETIC_CI_ONLY === 'true'
    ? new SyntheticGroundTransitHubResolver()
    : new UnconfiguredGroundTransitHubResolver();
}
