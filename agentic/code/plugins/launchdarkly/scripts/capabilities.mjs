/** Provider-neutral host hooks execute I/O; this addon validates LD v1 semantics.
 * Hooks must return sanitized metadata, never raw management responses.
 * Agent execution follows docs/capability-contract.md and all four ld rules.
 */
import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync(new URL('../provider-implementations.json', import.meta.url), 'utf8'));
export function resolveImplementation(config, capability) {
  if (config?.feature_flags?.provider !== registry.provider) return null;
  return registry.implementations[capability] ?? null;
}
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sameFlags = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && [...a].sort().every((flag, i) => flag === [...b].sort()[i]);
function requireInput(input, names) {
  for (const name of names) if (input[name] === undefined) throw new Error(`Missing input: ${name}`);
  if (!Array.isArray(input.flags) || !input.flags.length || !input.flags.every(nonempty) ||
      new Set(input.flags).size !== input.flags.length) throw new Error('Invalid flags');
  if (input.project !== undefined && !nonempty(input.project)) throw new Error('Invalid projectKey');
  if (input.provider_options !== undefined && (!input.provider_options ||
      typeof input.provider_options !== 'object' || Array.isArray(input.provider_options))) {
    throw new Error('Invalid provider_options');
  }
}
function options(input, allowed) {
  const supplied = input.provider_options ?? {};
  if (Object.keys(supplied).some(key => !allowed.includes(key))) throw new Error('Unknown provider option');
  return supplied;
}
async function authorize(host, operation, diff) {
  // Host authorization must bind current version, exact operation, diff and environment.
  // Reauthorization is required for every mutation, including rollback and ticket writes.
  const decision = await host.authorize({ operation, diff });
  if (decision?.approved !== true || !nonempty(decision.ref)) throw new Error('Approval required');
  return decision.ref;
}
function validStates(input, evidence, suite) {
  return evidence?.revision === input.revision && nonempty(input.revision) &&
    nonempty(evidence.suite) && evidence.suite === suite && sameFlags(input.flags, evidence.flags) &&
    evidence.off_exit_code === 0 && evidence.on_exit_code === 0;
}
async function flagCheck(input, host) {
  requireInput(input, ['flags', 'flag_cards', 'revision', 'states_test_evidence']);
  const opts = options(input, ['suite']);
  const expectedSuite = opts.suite ?? host.expectedSuite;
  if (!nonempty(expectedSuite)) throw new Error('Expected suite identity is required');
  const states = await host.readEvidence(input.states_test_evidence);
  const checked = [];
  let passed = validStates(input, states, expectedSuite);
  for (const key of input.flags) {
    const flag = await host.readFlag({ projectKey: input.project, key });
    const card = input.flag_cards.find(card => card.key === key);
    const ok = flag?.key === key && card && nonempty(card.owner) && card.owner === flag.maintainer &&
      typeof card.temporary === 'boolean' && card.temporary === flag.temporary && nonempty(card.removal_criteria);
    if (ok) checked.push(key);
    else passed = false;
  }
  return { passed, checked_flags: checked, approval_ref: '', evidence_path: host.evidencePath };
}
async function statesTest(input, host) {
  requireInput(input, ['flags', 'suite', 'revision', 'workspace']);
  options(input, []);
  for (const key of ['suite', 'revision', 'workspace']) if (!nonempty(input[key])) throw new Error(`Invalid ${key}`);
  const snapshot = await host.snapshotTestState(input);
  let off, on;
  try {
    await host.forceTestState(input.flags, false);
    off = await host.runSuite(input.suite, input.revision, input.workspace);
    await host.forceTestState(input.flags, true);
    on = await host.runSuite(input.suite, input.revision, input.workspace);
    if (!Number.isInteger(off) || !Number.isInteger(on)) throw new Error('Invalid suite exit status');
  } finally { await host.restoreTestState(snapshot); }
  return { off_exit_code: off, on_exit_code: on, revision: input.revision, flags: input.flags,
    suite: input.suite, approval_ref: '', evidence_path: host.evidencePath };
}
async function codeRefs(input, host) {
  requireInput(input, ['repository', 'revision', 'flags']);
  options(input, []);
  if (!nonempty(input.repository) || !nonempty(input.revision)) throw new Error('Invalid repository/revision');
  const scan = await host.readCodeRefs({ ...input, projectKey: input.project });
  const complete = scan?.onboarded === true && scan.complete === true &&
    scan.revision === input.revision && nonempty(scan.scan_ref) && Array.isArray(scan.references);
  return { scan_ref: scan?.scan_ref ?? '', revision: input.revision, references: scan?.references ?? [],
    complete, approval_ref: '', evidence_path: host.evidencePath };
}
async function cleanup(input, host) {
  requireInput(input, ['flags', 'flag_cards', 'release_evidence', 'coderefs_evidence']);
  options(input, []);
  const release = await host.readEvidence(input.release_evidence);
  const refs = await host.readEvidence(input.coderefs_evidence);
  const blockers = [];
  let met = release?.completed === true && nonempty(release.revision) && sameFlags(input.flags, release.flags) &&
    refs?.complete === true && refs.revision === release.revision && nonempty(refs.scan_ref) && Array.isArray(refs.references);
  for (const key of input.flags) {
    const card = input.flag_cards.find(card => card.key === key);
    const readiness = await host.readRemovalReadiness({ projectKey: input.project, key });
    if (!card || !nonempty(card.owner) || !nonempty(card.removal_criteria) ||
        !['Ready for code removal', 'Ready to archive'].includes(readiness?.stage) ||
        readiness.criteria_met !== true || readiness.status !== 'safe') met = false;
    if (readiness?.experiment_pinned === true) blockers.push({ flag: key, kind: 'archive-only',
      text: 'Experiment-pinned flag and metric: retain archive-only residue; deletion is blocked.' });
  }
  let ticket = '', approval = '';
  if (met) {
    const proposal = { projectKey: input.project, flags: input.flags, cards: input.flag_cards,
      release_evidence: input.release_evidence, coderefs_evidence: input.coderefs_evidence, blockers };
    approval = await authorize(host, 'cleanup-ticket', proposal);
    ticket = await host.upsertCleanupTicket(proposal); // host deduplicates by project/flags/cards
    if (!nonempty(ticket)) throw new Error('Missing owner-assigned cleanup ticket');
  }
  return { criteria_met: met, ticket_ref: ticket, blockers, approval_ref: approval, evidence_path: host.evidencePath };
}
function rolloutOptions(input) {
  const opts = options(input, ['guarded']);
  if (opts.guarded !== undefined && typeof opts.guarded !== 'boolean') throw new Error('Invalid guarded mode');
  const guarded = opts.guarded === true;
  if (!nonempty(input.environment) || !Array.isArray(input.percentages) || !input.percentages.length ||
      input.percentages.some((n, i, all) => !Number.isFinite(n) || n < 0 || n > (guarded ? 50 : 100) ||
        (i > 0 && n <= all[i - 1]))) throw new Error('Invalid percentages (guarded stages <= 50%)');
  if (input.stage_durations_seconds !== undefined &&
      (!Array.isArray(input.stage_durations_seconds) || input.stage_durations_seconds.length !== input.percentages.length ||
       input.stage_durations_seconds.some(n => !Number.isFinite(n) || n <= 0))) throw new Error('Invalid stage durations');
  if (input.metrics !== undefined && (!Array.isArray(input.metrics) || !input.metrics.length ||
      input.metrics.some(m => !nonempty(m.key) || typeof m.rollback !== 'boolean'))) throw new Error('Invalid metrics');
  if (input.randomization_unit !== undefined && !nonempty(input.randomization_unit)) throw new Error('Invalid context kind');
  const timing = { poll: input.poll_interval_seconds ?? 10, backoff: input.backoff_multiplier ?? 2,
    cap: input.max_poll_interval_seconds ?? 60, propagation: input.propagation_allowance_seconds ?? 120,
    timeout: input.timeout_seconds ?? 600 };
  if (Object.values(timing).some(n => !Number.isFinite(n) || n <= 0) || timing.backoff < 1 ||
      timing.timeout <= timing.propagation || timing.cap < timing.poll) throw new Error('Invalid timing');
  return { guarded, timing };
}
async function rollout(input, host) {
  requireInput(input, ['flags', 'environment', 'percentages']);
  const { guarded, timing } = rolloutOptions(input);
  const base = { projectKey: input.project, flags: input.flags, environment: input.environment };
  const metadata = await Promise.all(input.flags.map(key => host.readFlag({ projectKey: input.project, key })));
  if (metadata.some((f, i) => f?.key !== input.flags[i] || f.experimentLinked !== false || typeof f.migration !== 'boolean')) {
    throw new Error('Missing metadata or experiment-linked flag');
  }
  if (guarded && metadata.some(f => f.migration)) throw new Error('Migration flags cannot use guarded rollout');
  let snapshot = await host.snapshotTargeting(base);
  if (!Number.isFinite(snapshot?.percentage)) throw new Error('Missing last known-good exposure');
  const result = { status: 'held', final_percentage: snapshot.percentage, rollback_verified: false,
    gate_evidence: [], approval_ref: '', evidence_path: host.evidencePath, rollout_ref: '' };
  const nativeRequest = { ...base, percentages: input.percentages, stage_durations_seconds: input.stage_durations_seconds,
    metrics: input.metrics, randomization_unit: input.randomization_unit ?? 'user' };
  if (guarded) {
    result.approval_ref = await authorize(host, 'start-guarded-rollout', { ...nativeRequest, snapshot });
    const native = await host.startGuarded(nativeRequest);
    if (!nonempty(native?.rollout_ref)) throw new Error('Missing durable rollout_ref');
    result.rollout_ref = native.rollout_ref;
    if (native.longRunning === true) return { ...result, status: 'handed-off' };
  }
  for (const percentage of input.percentages) {
    if (!guarded) {
      result.approval_ref = await authorize(host, 'set-percentage', { ...base, percentage, snapshot });
      await host.setPercentage({ ...base, percentage });
    }
    await host.sleep(timing.propagation);
    let elapsed = timing.propagation, interval = timing.poll, healthy = false;
    while (elapsed < timing.timeout) {
      const gate = await host.readGate({ ...base, percentage, rollout_ref: result.rollout_ref,
        health_gate: input.health_gate ?? 'aiwg:cicd-complete/progressive-rollout-health' });
      if (gate?.signal === (input.gate_failure_signal ?? 'ROLLBACK')) {
        result.gate_evidence.push({ percentage, signal: 'ROLLBACK' });
        result.approval_ref = await authorize(host, 'rollback', { ...base, snapshot, rollout_ref: result.rollout_ref });
        await host.restoreTargeting({ ...base, snapshot, rollout_ref: result.rollout_ref });
        await host.sleep(timing.propagation);
        let rollbackElapsed = timing.propagation, rollbackInterval = timing.poll;
        while (rollbackElapsed < timing.timeout) {
          if (await host.verifyRollback({ ...base, snapshot }) === true) { result.rollback_verified = true; break; }
          const delay = Math.min(rollbackInterval, timing.timeout - rollbackElapsed);
          await host.sleep(delay); rollbackElapsed += delay;
          rollbackInterval = Math.min(timing.cap, rollbackInterval * timing.backoff);
        }
        return { ...result, status: result.rollback_verified ? 'rolled-back' : 'held', final_percentage: snapshot.percentage };
      }
      if (gate?.signal === 'HOLD') return result;
      if (gate?.signal === 'PASS' && nonempty(gate.ref)) {
        result.gate_evidence.push({ percentage, signal: 'PASS', ref: gate.ref }); healthy = true; break;
      }
      const delay = Math.min(interval, timing.timeout - elapsed);
      await host.sleep(delay); elapsed += delay; interval = Math.min(timing.cap, interval * timing.backoff);
    }
    if (!healthy) return result;
    result.final_percentage = percentage;
    snapshot = await host.snapshotTargeting(base); // promote only a verified state to known-good
    if (snapshot?.percentage !== percentage) return { ...result, status: 'held' };
  }
  if (guarded && await host.verifyNativeComplete(result.rollout_ref) !== true) return result;
  return { ...result, status: 'completed' };
}
const handlers = { 'flag-check': flagCheck, 'flag-states-test': statesTest,
  'flag-coderefs-scan': codeRefs, 'flag-cleanup-handoff': cleanup, 'progressive-rollout': rollout };
export async function runCapability(config, capability, input, host) {
  if (!resolveImplementation(config, capability)) throw new Error('No LaunchDarkly implementation selected');
  if (!nonempty(host.evidencePath)) throw new Error('Resolved artifact evidence path required');
  return handlers[capability](input, host);
}
