import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderProbeResult, ProviderProbeRun } from './types.js';

export function printHumanReport(run: ProviderProbeRun): void {
  console.log(`Provider: ${run.displayName}`);
  console.log(`Health: ${run.health.status}`);
  if (run.health.status !== 'PASS') {
    console.log(run.health.message);
    return;
  }
  const hokkaido =
    run.capabilityDiscovery?.regions
      .filter((region) => region.containsHokkaido)
      .map((region) => region.code)
      .join(', ') || 'none';
  const japan =
    run.capabilityDiscovery?.regions
      .filter((region) => region.japanRelated)
      .map((region) => region.code)
      .join(', ') || 'none';
  console.log(`Japan region: ${japan}`);
  console.log(`Hokkaido region: ${hokkaido}`);
  console.log('');
  console.log(
    row(['Scenario', 'Mode', 'HTTP', 'Route', 'Rail', 'Bus', 'Fare', 'Time']),
  );
  for (const result of run.results) {
    console.log(
      row([
        result.scenarioName,
        result.request.mode,
        result.httpStatus === null ? '-' : String(result.httpStatus),
        yesNo(result.facts.routeFound),
        yesNo(result.facts.railPresent),
        yesNo(result.facts.busPresent),
        yesNo(result.facts.farePresent),
        result.facts.timeConstraintSatisfied === null
          ? '?'
          : result.facts.timeConstraintSatisfied
            ? 'PASS'
            : 'FAIL',
      ]),
    );
  }
  for (const result of run.results) printScenario(result);
}

export async function writeProbeArtifacts(
  run: ProviderProbeRun,
  outputBase: string,
  secrets: readonly string[],
): Promise<string> {
  const stamp = run.startedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const directory = path.resolve(outputBase, run.provider, stamp);
  const rawDirectory = path.join(directory, 'raw');
  await mkdir(rawDirectory, { recursive: true });
  const sanitized = sanitizeEvidence(run, secrets) as ProviderProbeRun;
  await writeJson(path.join(directory, 'summary.json'), {
    ...sanitized,
    results: sanitized.results.map(withoutRawEvidence),
  });
  await writeJson(
    path.join(directory, 'routes.normalized.json'),
    sanitized.results.map(withoutRawEvidence),
  );
  if (sanitized.health.rawEvidence !== undefined) {
    await writeJson(
      path.join(rawDirectory, 'health.json'),
      sanitized.health.rawEvidence,
    );
  }
  if (sanitized.capabilityDiscovery?.rawEvidence !== undefined) {
    await writeJson(
      path.join(rawDirectory, 'regions.json'),
      sanitized.capabilityDiscovery.rawEvidence,
    );
  }
  for (const result of sanitized.results) {
    if (result.rawEvidence !== undefined) {
      await writeJson(
        path.join(
          rawDirectory,
          `${safeFile(result.scenarioId)}-${result.request.mode.toLowerCase()}.json`,
        ),
        result.rawEvidence,
      );
    }
  }
  return directory;
}

export function sanitizeEvidence(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === 'string') {
    return secrets
      .filter((secret) => secret !== '')
      .reduce(
        (result, secret) => result.replaceAll(secret, '[REDACTED]'),
        value,
      )
      .replace(/(X-TripGo-Key\s*[:=]\s*)\S+/giu, '$1[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEvidence(entry, secrets));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /authorization|api[-_]?key|secret|credential|headers?/iu.test(key)
          ? '[REDACTED]'
          : sanitizeEvidence(entry, secrets),
      ]),
    );
  }
  return value;
}

function printScenario(result: ProviderProbeResult): void {
  console.log('');
  console.log(`${result.scenarioName} [${result.request.mode}]`);
  console.log(`Requested: ${result.request.requestedInstant}`);
  console.log(
    `HTTP / Status: ${result.httpStatus ?? '-'} / ${result.providerStatus}`,
  );
  for (const route of result.routes.slice(0, 3)) {
    console.log(
      `Actual: ${route.departure} → ${route.arrival} (${route.totalDurationSeconds}s, transfers ${route.transferCount})`,
    );
    console.log(
      `Fare: ${route.fare === null ? 'unknown' : `${route.fare.amount} ${route.fare.currency}`}`,
    );
    for (const leg of route.legs) {
      console.log(
        `  ${leg.mode} / ${leg.lineName ?? 'line unknown'} / ${leg.from ?? '?'} → ${leg.to ?? '?'}`,
      );
    }
  }
  for (const note of result.notes) console.log(`Note: ${note}`);
}

function row(values: readonly string[]): string {
  const widths = [34, 10, 5, 7, 6, 5, 6, 6];
  return values.map((value, index) => value.padEnd(widths[index]!)).join(' ');
}

function yesNo(value: boolean): string {
  return value ? 'YES' : 'NO';
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeFile(value: string): string {
  return value.replace(/[^a-z0-9-]/giu, '-');
}

function withoutRawEvidence(
  result: ProviderProbeResult,
): Omit<ProviderProbeResult, 'rawEvidence'> {
  const { rawEvidence, ...normalized } = result;
  void rawEvidence;
  return normalized;
}
