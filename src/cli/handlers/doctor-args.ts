// Validate public doctor flags before routing early-return modes.
import { argsTerminatorIndex, hasPositionalOrSwitch, requireFlagValue, valueTokenIndexes } from '../flag-parsing.js';

export function parsePublicDoctorFlags(args: string[]) {
  const valueFlags = ['--provider', '--bundle', '--scope', '--context-baseline', '--context-budget-tokens', '--cli', '--forget-approval', '--group'];
  const knownFlags = new Set([
    ...valueFlags, '--list-approvals', '--all-providers', '--probe-workers', '--qualify', '--yes', '--dry-run', '--no-budget-check', '--strict-context', '--json',
    '--resources', '--decision-offload', '--fix', '--deployment', '--user', '--verbose', '-v', '--project-local', '--quiet', '--help', '-h',
  ]);
  const hasSwitch = (name: string): boolean => hasPositionalOrSwitch(args, name, valueFlags);
  const values = new Map<string, string | undefined>();
  for (const flag of valueFlags) {
    values.set(flag, requireFlagValue(args, { rejectEmpty: true, precedence: 'last' }, flag));
  }
  const consumed = valueTokenIndexes(args, valueFlags);
  for (let i = 0; i < argsTerminatorIndex(args); i += 1) {
    const token = args[i]!;
    if (consumed.has(i) || !token.startsWith('-')) continue;
    const name = token.split('=')[0]!;
    if (!knownFlags.has(name) || (token.includes('=') && !valueFlags.includes(name))) {
      throw new Error(`Unknown flag: ${name}`);
    }
  }
  if (hasSwitch('--fix') && !hasSwitch('--decision-offload')) throw new Error('--fix requires --decision-offload');
  if (values.get('--group') !== undefined && !hasSwitch('--resources')) throw new Error('--group requires --resources');
  if (hasSwitch('--resources') && (['--probe-workers', '--decision-offload', '--deployment', '--user', '--project-local'].some(hasSwitch) || values.get('--scope') !== undefined)) {
    throw new Error('--resources must run separately from other doctor modes');
  }
  if (hasSwitch('--decision-offload') && (hasSwitch('--probe-workers') || hasSwitch('--deployment') || hasSwitch('--user') || values.get('--scope') !== undefined)) {
    throw new Error('--decision-offload is a separate offline mode; do not combine it with worker, deployment or user-scope checks');
  }
  if (['--list-approvals', '--forget-approval', '--qualify', '--cli', '--yes', '--dry-run'].some(flag => hasSwitch(flag) || values.get(flag)) && !hasSwitch('--probe-workers')) {
    throw new Error('--list-approvals, --forget-approval, --qualify, --cli, --yes and --dry-run require --probe-workers');
  }
  if ((hasSwitch('--list-approvals') || values.get('--forget-approval')) && ((hasSwitch('--list-approvals') && values.get('--forget-approval')) || ['--qualify', '--dry-run', '--resources', '--decision-offload', '--deployment', '--user'].some(hasSwitch) || values.get('--scope') !== undefined)) {
    throw new Error('Approval management must run separately from other doctor modes');
  }
  if (values.get('--forget-approval') && !hasSwitch('--yes')) throw new Error('--forget-approval requires --yes');
  if (hasSwitch('--json') && !hasSwitch('--probe-workers') && !hasSwitch('--deployment') && !hasSwitch('--decision-offload') && !hasSwitch('--resources')) {
    throw new Error('--json requires --probe-workers or --deployment or --decision-offload or --resources');
  }
  return { hasSwitch, values };
}
