import { describe, expect, it } from 'vitest';
import {
  matchesTrustedRouteEndpoint,
  validateExternalRouteCandidateEndpoints,
} from '../src/trusted-route-endpoints.js';
const endpoint = {
  name: 'E',
  providerPlaceRef: null,
  providerHubRef: 'hub:E',
  latitude: 35,
  longitude: 139,
};
describe('trusted route endpoint binding', () => {
  it('prefers comparable place identity', () => {
    expect(
      matchesTrustedRouteEndpoint(
        { ...endpoint, providerPlaceRef: 'X' },
        { ...endpoint, providerPlaceRef: 'E' },
      ),
    ).toBe(false);
    expect(
      matchesTrustedRouteEndpoint(
        { ...endpoint, providerPlaceRef: 'E', providerHubRef: 'X' },
        { ...endpoint, providerPlaceRef: 'E' },
      ),
    ).toBe(true);
  });
  it('rejects conflicting hub identity even with equal coordinates', () => {
    expect(
      matchesTrustedRouteEndpoint(
        { ...endpoint, providerHubRef: 'hub:X' },
        endpoint,
      ),
    ).toBe(false);
  });
  it('accepts exact coordinate fallback without comparable refs', () => {
    expect(
      matchesTrustedRouteEndpoint(
        { ...endpoint, providerHubRef: null },
        endpoint,
      ),
    ).toBe(true);
  });
  it('rejects name-only and proximity matching', () => {
    expect(
      matchesTrustedRouteEndpoint(
        { ...endpoint, providerHubRef: null, latitude: null },
        endpoint,
      ),
    ).toBe(false);
    expect(
      matchesTrustedRouteEndpoint(
        { ...endpoint, providerHubRef: null, latitude: 35.000001 },
        endpoint,
      ),
    ).toBe(false);
  });
  it('requires both first and final endpoints and rejects empty legs', () => {
    expect(
      validateExternalRouteCandidateEndpoints({ legs: [] }, endpoint, endpoint),
    ).toBe(false);
  });
});
