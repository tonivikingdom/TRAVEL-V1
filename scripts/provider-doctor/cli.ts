import { doctor } from './runner.js';
const args = process.argv.slice(2).filter((a) => a !== '--');
if (
  args.some((a) => a !== '--live') ||
  args.filter((a) => a === '--live').length > 1
) {
  console.error('Usage: pnpm provider:doctor [--live]');
  process.exitCode = 2;
} else {
  const result = await doctor(process.env, args.includes('--live'));
  console.log(result.lines.join('\n'));
  if (
    args.includes('--live') &&
    result.lines.some((l) =>
      /SECRET_UNSET|NETWORK_BLOCKED|API_NOT_ENABLED|BILLING_OR_ENTITLEMENT|AUTH_REJECTED|CONTRACT_MISMATCH|PROVIDER_ERROR|BLOCKED_/.test(
        l,
      ),
    )
  )
    process.exitCode = 1;
}
