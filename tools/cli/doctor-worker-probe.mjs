// Report explicit worker probes and return their exit status independently of process state.
import { collectDecisionOffloadReport } from './decision-offload-report.mjs';
import { importImpl } from '../_resolve-impl.mjs';
import { collectWrapperEnforcement } from './doctor-wrapper-enforcement.mjs';
import { wrapperTextFindings } from './doctor-wrapper-text.mjs';

const { getPackageRoot } = await importImpl(import.meta.url, 'channel/manager.mjs');
const { nativeSandboxWarnings } = await importImpl(import.meta.url, 'config/native-sandbox-warnings.js');

// Empty-state guidance for the worker-probe report (#3066). Names the real
// configuration command and key: `aiwg config set --project` writes dotted
// keys into .aiwg/aiwg.config (src/config/cli.ts projectConfigSet), and
// each parallelism.clis entry binds a provider adapter reference
// (src/config/aiwg-config.ts validation).
export const WORKER_PROBE_EMPTY_MESSAGE =
  `No worker CLIs are configured (parallelism.clis in .aiwg/aiwg.config is empty); add a complete cli entry, e.g. \`aiwg config set --project parallelism.clis.codex '{"adapter":"providers:codex","accountScope":"local-account","quotaScope":"local-quota"}'\`, then rerun with --probe-workers.`;
const WORKER_PROBE_DISABLED_MESSAGE =
  'Group dispatch is disabled (parallelism.worker_dispatch is not true); no version probes were run. Enable it with `aiwg config set --project parallelism.worker_dispatch true`, then rerun with --probe-workers.';

// One machine-readable record per CLI for `aiwg doctor --probe-workers
// --json`, mapped from the install-kind readiness finding (one per
// configured cli, untruncated — see buildDirectWorkerDoctorSection's
// installFindings):
// - installed: the executable ran and produced output (a matched version,
//   an out-of-range version, or an unmatched banner from something present);
// - version: the identified version, or null when none was identified;
// - inRange: true/false once a version was identified, else null;
// - ready: true only for WORKER_DIRECT_READY;
// - reason: the stable finding code (see src/models/worker-direct-readiness.ts).
export function toWorkerProbeRecord(finding) {
  const version = finding.installedVersion ?? null;
  return {
    cli: finding.cli,
    installed: version !== null || finding.code === 'WORKER_DIRECT_BANNER_UNMATCHED',
    version,
    inRange: finding.code === 'WORKER_DIRECT_READY' ? true : (version !== null ? false : null),
    ready: finding.code === 'WORKER_DIRECT_READY',
    reason: finding.code,
  };
}

// Machine-readable worker-probe report (#3066). Prints exactly one JSON
// document on stdout and nothing else: no announce lines (announce is
// omitted), no buffered checks, no footer. Dispatch eligibility comes from
// the binding-level fallback (no resolver snapshot is resolved here) — the
// records only speak to installation readiness, so the snapshot would add
// resolution cost without changing them.
// With --cli, a group-scoped diagnostic blocks only when that group uses the requested CLI (#4293);
// others stay listed as non-blocking. Static wiring diagnostics are unchanged.
export function scopeDiagnosticsToCli(diagnostics, parallelism, cli) {
  if (!cli) return diagnostics;
  return diagnostics.map(row => {
    const group = /^\/parallelism\/groups\/([^/]+)\//.exec(row.pointer ?? '')?.[1];
    if (!group) return row;
    const usesCli = (parallelism?.groups?.[group]?.members ?? []).some(member => member.cli === cli);
    return usesCli ? row : { ...row, blocking: false };
  });
}

export async function runWorkerProbe(projectDir, options, workerConfig) {
  let exitCode = 0;
  const parallelism = workerConfig?.parallelism;
  if (options.cli) {
    const ids = new Set([...Object.keys(parallelism?.clis ?? {}), ...Object.values(parallelism?.groups ?? {}).flatMap(group => group.members.map(member => member.cli))]);
    if (!ids.has(options.cli)) throw new Error(`Unknown configured worker CLI: ${options.cli}`);
  }
  const workerDispatch = parallelism?.worker_dispatch === true;
  const { loadProviderModelCapabilities } = await importImpl(import.meta.url, 'models/provider-policy.js');
  const { buildDirectWorkerDoctorSection } = await importImpl(import.meta.url, 'models/worker-direct-readiness.js');
  const registry = loadProviderModelCapabilities();
  const section = await buildDirectWorkerDoctorSection({
    parallelism,
    registry,
    cli: options.cli,
    probeWorkers: true,
    projectRoot: projectDir,
  });
  const workers = section.installFindings.map(toWorkerProbeRecord);
  const payload = {
    probeWorkers: true,
    nativeSandboxWarnings: nativeSandboxWarnings(workerConfig, projectDir),
    decisionOffload: await collectDecisionOffloadReport(projectDir),
    workerDispatch,
    workersConfigured: section.workersConfigured,
    workers,
    wrapperEnforcement: await collectWrapperEnforcement({ projectDir, config: workerConfig,
      packageRoot: getPackageRoot(), provider: options.provider }),
  };
  if (workerDispatch) {
    const { checkWorkerSandboxLaunches } = await import('./worker-qualification.mjs');
    payload.sandboxChecks = await checkWorkerSandboxLaunches({ projectDir, config: workerConfig, registry, cli: options.cli });
    // A blocked probe limits only the systemd-unit launcher path, which fails
    // closed at launch. Direct shell dispatch stays ready (Tier 0 runs under
    // the conductor harness's sandbox), so report it without failing doctor.
    for (const worker of workers) {
      const blocked = payload.sandboxChecks.find(check => check.cli === worker.cli && check.status === 'blocked');
      if (blocked) worker.launcherSandbox = { status: 'blocked', code: blocked.diagnostics[0].code, scope: blocked.scope };
    }
  }
  if (!section.workersConfigured) payload.message = WORKER_PROBE_EMPTY_MESSAGE;
  else if (!workerDispatch) payload.message = WORKER_PROBE_DISABLED_MESSAGE;
  if (options.qualify) {
    const { qualifyProbedWorkers } = await import('./worker-qualification.mjs');
    payload.qualification = await qualifyProbedWorkers({ projectDir, packageRoot: getPackageRoot(), config: workerConfig,
      registry, section, ...options });
    if (['failed', 'partial'].includes(payload.qualification.status)) exitCode = 1;
  }
  if (workerDispatch && workers.some(worker => worker.ready) && !options.dryRun) {
    const { checkRecordedWorkerInvocationBuilds } = await import('./worker-qualification.mjs');
    payload.invocationChecks = options.qualify
      ? payload.qualification.results.flatMap(result => result.invocationChecks ?? [])
      : await checkRecordedWorkerInvocationBuilds({ projectDir, config: workerConfig, registry, workers });
    for (const worker of workers) {
      if (payload.invocationChecks.some(check => check.cli === worker.cli && check.status === 'blocked')) {
        worker.ready = false;
        worker.reason = 'WORKER_DIRECT_INVOCATION_BLOCKED';
        exitCode = 1;
      }
    }
  }
  const { collectWorkerPolicyDiagnostics } = await import('./doctor-worker-policy.mjs');
  payload.workerPolicyDiagnostics = scopeDiagnosticsToCli(
    await collectWorkerPolicyDiagnostics(projectDir, workerConfig), parallelism, options.cli);
  if (payload.workerPolicyDiagnostics.some(row => row.blocking !== false)) exitCode = 1;
  if (options.json !== false) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    for (const finding of wrapperTextFindings(payload.wrapperEnforcement)) console.log(`${finding.name}: ${finding.message}`);
    for (const diagnostic of payload.workerPolicyDiagnostics) console.log(`Worker Policy: ${diagnostic.code} ${diagnostic.pointer}: ${diagnostic.message}`);
    for (const warning of payload.nativeSandboxWarnings) console.log(`Warning: ${warning.message}`);
    for (const worker of workers) console.log(`Direct Worker ${worker.cli}: ${worker.reason}`);
    if (payload.sandboxChecks?.length) console.log(`Worker sandbox checks: ${JSON.stringify(payload.sandboxChecks)}`);
    if (payload.qualification) console.log(`Worker qualification: ${JSON.stringify(payload.qualification)}`);
    if (payload.invocationChecks?.length) console.log(`Worker invocation checks: ${JSON.stringify(payload.invocationChecks)}`);
  }
  return exitCode;
}

// Approval maintenance is offline and independent of project configuration or CLI availability.
export async function runWorkerApprovalManagement(projectDir, options) {
  const { listWorkerApprovals, forgetWorkerApproval } = await importImpl(import.meta.url, 'models/worker-installation-store.mjs');
  const payload = options.forgetApproval
    ? { removed: await forgetWorkerApproval({ cwd: projectDir, workspace: options.forgetApproval, cli: options.cli, yes: options.yes }) }
    : { approvals: await listWorkerApprovals({ cwd: projectDir, cli: options.cli }) };
  if (options.json) console.log(JSON.stringify(payload, null, 2));
  else if (payload.removed) {
    for (const row of payload.removed) console.log(`Removed worker approval: ${row.cli} ${row.workspace}`);
  } else if (!payload.approvals.length) console.log('No worker approvals recorded.');
  else for (const row of payload.approvals) console.log(`${row.cli} ${row.workspace} (${row.workspaceExists ? 'exists' : 'deleted'})`);
  return 0;
}
