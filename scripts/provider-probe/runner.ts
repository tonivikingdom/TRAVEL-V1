import { buildJapanScenarioQueries } from './scenarios/japan-core.js';
import type {
  ProbeScenario,
  ProviderProbeAdapter,
  ProviderProbeRun,
} from './types.js';

export interface ProbeRunnerOptions {
  readonly mode: 'quick' | 'full';
  readonly scenarios: readonly ProbeScenario[];
  readonly now?: Date;
}

export async function runProviderProbe(
  adapter: ProviderProbeAdapter,
  options: ProbeRunnerOptions,
): Promise<ProviderProbeRun> {
  const startedAt = (options.now ?? new Date()).toISOString();
  const health = await adapter.healthCheck();
  if (health.status !== 'PASS') {
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      mode: options.mode,
      provider: adapter.id,
      displayName: adapter.displayName,
      health,
      capabilityDiscovery: null,
      results: [],
      requestCount: 1,
    };
  }
  const capabilityDiscovery = await adapter.capabilities();
  if (capabilityDiscovery.status !== 'SUCCESS') {
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      mode: options.mode,
      provider: adapter.id,
      displayName: adapter.displayName,
      health,
      capabilityDiscovery,
      results: [],
      requestCount: 2,
    };
  }
  const queries = options.scenarios.flatMap((scenario) =>
    buildJapanScenarioQueries(
      scenario,
      options.mode,
      capabilityDiscovery.capabilities.arriveBy === true,
      options.now ?? new Date(),
    ).map((query) => ({ scenario, query })),
  );
  const results = [];
  for (const { scenario, query } of queries) {
    results.push(
      await adapter.route(scenario, query, capabilityDiscovery.capabilities),
    );
  }
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    mode: options.mode,
    provider: adapter.id,
    displayName: adapter.displayName,
    health,
    capabilityDiscovery,
    results,
    requestCount: 2 + queries.length,
  };
}
