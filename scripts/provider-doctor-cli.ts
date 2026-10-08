import {
  CAPABILITY_IDS,
  providerDoctor,
  type ProviderCapabilityId,
} from './provider-doctor.js';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const selected = args
  .find((arg) => arg.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');
if (
  args.some((arg) => arg !== '--live' && !arg.startsWith('--only=')) ||
  args.filter((arg) => arg === '--live').length > 1 ||
  args.filter((arg) => arg.startsWith('--only=')).length > 1 ||
  (selected &&
    (new Set(selected).size !== selected.length ||
      selected.some(
        (id) => !CAPABILITY_IDS.includes(id as ProviderCapabilityId),
      )))
) {
  process.stderr.write(
    'Usage: pnpm provider:doctor [--live] [--only=<capability-id,...>]\n',
  );
  process.exitCode = 2;
} else {
  try {
    const report = await providerDoctor(process.env, {
      live: args.includes('--live'),
      ...(selected ? { only: selected as ProviderCapabilityId[] } : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (
      args.includes('--live') &&
      report.capabilities.some(
        (c) =>
          !['LIVE_CONTRACT_PASS', 'NO_MATCHING_CANDIDATE'].includes(c.status),
      )
    )
      process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Provider doctor failed; diagnostic details suppressed.\n',
    );
    process.exitCode = 1;
  }
}
