import type {
  RouteProvider,
  RouteProviderQueryInput,
  RouteProviderResult,
} from '@travel/application';

export class UnconfiguredRouteProvider implements RouteProvider {
  async queryRoutes(
    input: RouteProviderQueryInput,
  ): Promise<RouteProviderResult> {
    void input;
    return {
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'ROUTE_PROVIDER_UNCONFIGURED',
    };
  }
}
