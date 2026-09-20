import { TripGoProbeAdapter } from './providers/tripgo.js';
import {
  printHumanReport,
  sanitizeEvidence,
  writeProbeArtifacts,
} from './report.js';
import { runProviderProbe } from './runner.js';
import { japanCoreScenarios } from './scenarios/japan-core.js';
import type { ProviderProbeAdapter } from './types.js';

const options = parseArgs(process.argv.slice(2));
const adapters = registry(process.env.TRIPGO_API_KEY);
const requestedProviders = options.providers.map((id) => {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`Unknown provider adapter: ${id}`);
  }
  return adapter;
});
const scenarios = japanCoreScenarios.filter(
  (scenario) =>
    options.scenario === null ||
    scenario.suiteId === options.scenario ||
    scenario.id === options.scenario,
);
if (scenarios.length === 0) {
  throw new Error(`Unknown scenario or suite: ${options.scenario}`);
}

let failed = false;
for (const adapter of requestedProviders) {
  const run = await runProviderProbe(adapter, {
    mode: options.mode,
    scenarios,
  });
  const sanitized = sanitizeEvidence(run, [process.env.TRIPGO_API_KEY ?? '']);
  if (options.json) {
    console.log(JSON.stringify(sanitized, null, 2));
  } else {
    printHumanReport(sanitized as typeof run);
  }
  if (options.output !== null) {
    const directory = await writeProbeArtifacts(run, options.output, [
      process.env.TRIPGO_API_KEY ?? '',
    ]);
    if (!options.json) console.log(`Artifacts: ${directory}`);
  }
  failed ||=
    run.health.status !== 'PASS' ||
    run.results.some((result) => result.providerStatus !== 'SUCCESS');
}
process.exitCode = failed ? 1 : 0;

function registry(
  apiKey: string | undefined,
): ReadonlyMap<string, ProviderProbeAdapter> {
  return new Map([['tripgo', new TripGoProbeAdapter(apiKey)]]);
}

function parseArgs(args: readonly string[]): {
  readonly providers: readonly string[];
  readonly scenario: string | null;
  readonly mode: 'quick' | 'full';
  readonly json: boolean;
  readonly output: string | null;
} {
  const providerValue =
    valueAfter(args, '--providers') ??
    valueAfter(args, '--provider') ??
    'tripgo';
  return {
    providers: providerValue
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ''),
    scenario: valueAfter(args, '--scenario'),
    mode: args.includes('--full') ? 'full' : 'quick',
    json: args.includes('--json'),
    output: valueAfter(args, '--output'),
  };
}

function valueAfter(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
