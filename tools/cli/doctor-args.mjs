// Parse and validate doctor arguments before any probes or writes.
import { importImpl } from '../_resolve-impl.mjs';
const {
  requireFlagValue: requireDoctorFlagValue,
  hasPositionalOrSwitch: hasDoctorFlagSwitch,
  argsTerminatorIndex: doctorArgsTerminatorIndex,
  valueTokenIndexes: doctorValueTokenIndexes,
  MissingFlagValueError: DoctorMissingFlagValueError,
} = await importImpl(import.meta.url, 'cli/flag-parsing.js');

// Parse doctor-specific flags through the shared strict parser
// (src/cli/flag-parsing.ts, #3062) instead of a hand-rolled loop: value
// flags accept `--flag value` and `--flag=value`, stop at a bare `--`
// terminator, and a present-but-valueless flag is a usage error rather than
// a silent default. Unknown `--flags` are rejected (exit 2, naming the
// flag) instead of being silently ignored — previously an extra `--json`
// was swallowed here with no effect.
//
// Known flags are the union of what this script parses and what `aiwg
// doctor` (src/cli/handlers/utilities.ts) consumes upstream and passes
// through: --deployment/--bundle/--scope/--user/--verbose/-v/--project-local/
// --quiet/--help/-h never change this script's behavior but remain accepted
// so existing invocations keep working.
const DOCTOR_VALUE_FLAGS = ['--provider', '--bundle', '--scope', '--context-baseline', '--context-budget-tokens', '--cli', '--forget-approval', '--group'];
const DOCTOR_KNOWN_FLAGS = new Set([
  ...DOCTOR_VALUE_FLAGS,
  '--list-approvals', '--all-providers', '--probe-workers', '--qualify', '--yes', '--dry-run', '--no-budget-check', '--strict-context', '--json',
  '--resources', '--decision-offload', '--fix', '--deployment', '--user', '--verbose', '-v', '--project-local', '--quiet', '--help', '-h',
]);

// Refuse the first unknown `--flag` before the `--` terminator, skipping
// the consumed values of known value-taking flags. The `--flag=value`
// one-token form can never collide with a separate token, so only its flag
// part is checked.
function assertNoUnknownDoctorFlags(argv) {
  const consumed = doctorValueTokenIndexes(argv, DOCTOR_VALUE_FLAGS);
  const limit = doctorArgsTerminatorIndex(argv);
  for (let i = 0; i < limit; i += 1) {
    if (consumed.has(i)) continue;
    const token = argv[i];
    if (token === undefined || !token.startsWith('-')) continue;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (!DOCTOR_KNOWN_FLAGS.has(name) || (token.includes('=') && !DOCTOR_VALUE_FLAGS.includes(name))) {
      throw new Error(`Unknown flag: ${name}. See 'aiwg doctor --help'.`);
    }
  }
}

function parseDoctorArgs(argv) {
  const out = {
    provider: null,
    allProviders: false,
    probeWorkers: false,
    json: false,
    noBudgetCheck: false,
    strictContext: false,
    contextBaseline: '.aiwg/context-memory-firewall-baseline.json',
    contextBudgetTokens: 200_000,
  };
  // Strict value flags (#3062 review item 11): present without a usable
  // value is a usage error, raised before any check, spawn, or write.
  // --bundle/--scope are validated here for the same reason but otherwise
  // handled upstream by `aiwg doctor --deployment` / `--scope user`.
  try {
    // Preserve the previous parser's last-occurrence-wins behavior.
    const valueOptions = { rejectEmpty: true, precedence: 'last' };
    out.forgetApproval = requireDoctorFlagValue(argv, valueOptions, '--forget-approval');
    out.group = requireDoctorFlagValue(argv, valueOptions, '--group');
    out.cli = requireDoctorFlagValue(argv, valueOptions, '--cli');
    out.provider = requireDoctorFlagValue(argv, valueOptions, '--provider') ?? null;
    requireDoctorFlagValue(argv, valueOptions, '--bundle');
    requireDoctorFlagValue(argv, valueOptions, '--scope');
    const baseline = requireDoctorFlagValue(argv, valueOptions, '--context-baseline');
    if (baseline !== undefined) out.contextBaseline = baseline;
    const budget = requireDoctorFlagValue(argv, valueOptions, '--context-budget-tokens');
    if (budget !== undefined) out.contextBudgetTokens = Number(budget);
  } catch (error) {
    if (error instanceof DoctorMissingFlagValueError) throw new Error(`${error.message}. See 'aiwg doctor --help'.`);
    throw error;
  }
  out.allProviders = hasDoctorFlagSwitch(argv, '--all-providers', DOCTOR_VALUE_FLAGS);
  out.probeWorkers = hasDoctorFlagSwitch(argv, '--probe-workers', DOCTOR_VALUE_FLAGS);
  out.listApprovals = hasDoctorFlagSwitch(argv, '--list-approvals', DOCTOR_VALUE_FLAGS);
  out.qualify = hasDoctorFlagSwitch(argv, '--qualify', DOCTOR_VALUE_FLAGS);
  out.yes = hasDoctorFlagSwitch(argv, '--yes', DOCTOR_VALUE_FLAGS);
  out.dryRun = hasDoctorFlagSwitch(argv, '--dry-run', DOCTOR_VALUE_FLAGS);
  out.json = hasDoctorFlagSwitch(argv, '--json', DOCTOR_VALUE_FLAGS);
  out.resources = hasDoctorFlagSwitch(argv, '--resources', DOCTOR_VALUE_FLAGS);
  out.fix = hasDoctorFlagSwitch(argv, '--fix', DOCTOR_VALUE_FLAGS);
  out.decisionOffload = hasDoctorFlagSwitch(argv, '--decision-offload', DOCTOR_VALUE_FLAGS);
  out.noBudgetCheck = hasDoctorFlagSwitch(argv, '--no-budget-check', DOCTOR_VALUE_FLAGS);
  out.strictContext = hasDoctorFlagSwitch(argv, '--strict-context', DOCTOR_VALUE_FLAGS);
  assertNoUnknownDoctorFlags(argv);
  if (out.fix && !out.decisionOffload) throw new Error('--fix requires --decision-offload');
  if (out.group !== undefined && !out.resources) throw new Error('--group requires --resources');
  // JSON is available for worker probes or the explicit offline offload report.
  if (out.json && !out.probeWorkers && !out.decisionOffload && !out.resources) {
    throw new Error('Unknown flag combination: --json requires --probe-workers or --decision-offload or --resources. See \'aiwg doctor --help\'.');
  }
  if (out.resources && (out.probeWorkers || out.decisionOffload || ['--deployment', '--user', '--project-local'].some(flag => hasDoctorFlagSwitch(argv, flag, DOCTOR_VALUE_FLAGS)) || requireDoctorFlagValue(argv, { rejectEmpty: true }, '--scope') !== undefined)) {
    throw new Error('--resources must run separately from other doctor modes');
  }
  if (out.decisionOffload && (out.probeWorkers || hasDoctorFlagSwitch(argv, '--deployment', DOCTOR_VALUE_FLAGS) || hasDoctorFlagSwitch(argv, '--user', DOCTOR_VALUE_FLAGS) || requireDoctorFlagValue(argv, { rejectEmpty: true, precedence: 'last' }, '--scope') !== undefined)) {
    throw new Error('--decision-offload is a separate offline mode; do not combine it with worker, deployment or user-scope checks');
  }
  if ((out.listApprovals || out.forgetApproval || out.qualify || out.cli || out.dryRun || out.yes) && !out.probeWorkers) {
    throw new Error('--list-approvals, --forget-approval, --qualify, --cli, --yes and --dry-run require --probe-workers');
  }
  if ((out.listApprovals || out.forgetApproval) && ((out.listApprovals && out.forgetApproval) || out.qualify || out.dryRun || out.decisionOffload || ['--deployment', '--user'].some(flag => hasDoctorFlagSwitch(argv, flag, DOCTOR_VALUE_FLAGS)) || requireDoctorFlagValue(argv, { rejectEmpty: true }, '--scope') !== undefined)) {
    throw new Error('Approval management must run separately from other doctor modes');
  }
  if (out.forgetApproval && !out.yes) throw new Error('--forget-approval requires --yes');
  return out;
}

// Parse-or-exit wrapper: usage errors name the flag on stderr and exit 2
// (EXIT_CODES.USAGE), before any check, spawn, or write.
export function parseDoctorArgsOrExit(argv) {
  try {
    return parseDoctorArgs(argv);
  } catch (error) {
    process.stderr.write(`aiwg doctor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
