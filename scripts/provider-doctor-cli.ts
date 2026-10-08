import { providerDoctor } from './provider-doctor.js';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.some((arg) => arg !== '--live') || args.length > 1) {
  process.stderr.write('Usage: pnpm provider:doctor [--live]\n');
  process.exitCode = 2;
} else {
  try {
    const report = await providerDoctor(process.env, {
      live: args.includes('--live'),
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
