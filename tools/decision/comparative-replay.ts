import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from '../../src/security/artifact-trust.js';
import { artifactPin } from '../../src/decision/validate.js';
import { COMPARATIVE_REPLAY_POLICY } from '../../src/decision/sensitivity/comparative-gates.js';
import { analyzeDecisionSensitivity } from '../../src/decision/sensitivity/runtime.js';
import { sensitivityDigest, validateSensitivityReport } from '../../src/decision/sensitivity/contract.js';
import { buildComparativeReplayEvaluation, type ComparativeReplayInput, type ComparativeReplayPreregistration,
  type ComparativeReplayRoot } from '../../src/decision/sensitivity/comparative.js';
import type { QualificationIntegrityMetadata } from '../../src/decision/qualification/release.js';
import type { SensitivityProbeState, SensitivityReport } from '../../src/decision/sensitivity/types.js';
import { validateReplayAssets, validateReplayFreeze, validateReplayReviewPackets } from './comparative-replay-assets.js';
import { generateComparativeReplayCorpus, REPLAY_CLOCK, REPLAY_IDENTITY } from './comparative-replay-corpus.js';

export const CORPUS_DIRECTORY = resolve(import.meta.dirname, '../../test/fixtures/decision/comparative-replay');
export type ReplayArtifacts = ReturnType<typeof generateComparativeReplayCorpus>;

export function readReplayArtifacts(): ReplayArtifacts {
  const read = (name: string) => JSON.parse(readFileSync(resolve(CORPUS_DIRECTORY, `${name}.json`), 'utf8'));
  const artifacts = { corpus: read('corpus'), gold: read('gold'), split: read('split'), auditSample: read('audit-sample'),
    reviewTemplate: readFileSync(resolve(CORPUS_DIRECTORY, 'review-template.md'), 'utf8') } as ReplayArtifacts;
  validateReplayAssets(artifacts);
  // Regeneration verifies generator identity, every request byte, independent gold, membership and audit selection.
  if (canonicalJson(artifacts) !== canonicalJson(generateComparativeReplayCorpus())) throw new Error('frozen replay assets differ from generator');
  return artifacts;
}

export function replayPreregistration(artifacts: ReplayArtifacts, frozenAt: string): ComparativeReplayPreregistration {
  const payload: Omit<ComparativeReplayPreregistration, 'digest'> = {
    schemaVersion: 'decision-comparative-replay-preregistration/v1', id: 'd23-synthetic-policy-replay-v1', mode: 'shadow',
    corpusDigest: sensitivityDigest(artifacts.split.members.map(({ id, payloadDigest }) => ({ id, payloadDigest }))),
    goldDigest: sensitivityDigest(artifacts.gold.roots), splitDigest: sensitivityDigest(artifacts.split.members),
    comparatorVersion: 'policy-replay-reference-v1', frozenAt, ...COMPARATIVE_REPLAY_POLICY,
  };
  return { ...payload, digest: sensitivityDigest(payload) };
}

export function replayInput(artifacts: ReplayArtifacts, plan: ComparativeReplayPreregistration,
  roots: ComparativeReplayRoot[], accessedAt: string): ComparativeReplayInput {
  const integrity: QualificationIntegrityMetadata = {
    sample_n: roots.filter(root => root.split === 'test').length,
    uncertainty: { levelBps: plan.levelBps, pairedMethod: plan.pairedMethod, errorMethod: plan.errorMethod },
    paired_baseline: { comparatorVersion: plan.comparatorVersion, goldDigest: plan.goldDigest },
    integrity_mode: 'standard', fresh_workspace_required: false, fresh_workspace_verified: false,
    integrity_state: 'unverified', trusted_score_source: 'local-unverified', compromise_labels: [],
    weak_signal_reason: 'synthetic regression corpus; operator freeze, protected snapshot and audit pending',
    release_gate: { decision: 'HOLD', reasons: ['operator-preregistration-and-review-pending'] },
  };
  return { preregistration: plan, trustedPreregistrationDigest: plan.digest, roots, members: artifacts.split.members,
    integrity, trustedIntegrityDigest: sensitivityDigest(integrity), accessedAt, reviewerAuditDigest: null };
}

export interface ReplayCheckpoint {
  reserve(id: string, repetition: number): void;
  complete(id: string, repetition: number, report: SensitivityReport, state: SensitivityProbeState): void;
}

/** A single host-owned state is reused for both passes and every source, with no provider callback. */
export async function replayFrozenCorpus(artifacts: ReplayArtifacts, state: SensitivityProbeState,
  checkpoint: ReplayCheckpoint, signal?: AbortSignal): Promise<{ roots: ComparativeReplayRoot[]; stopped: boolean }> {
  const roots: ComparativeReplayRoot[] = [];
  const labels = new Map(artifacts.gold.roots.map(root => [root.id, root.gold]));
  for (const root of artifacts.corpus.roots) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (signal?.aborted) return { roots, stopped: true };
    const member = artifacts.split.members.find(item => item.id === root.id);
    if (!member || sensitivityDigest(root.request) !== root.payloadDigest || root.payloadDigest !== member.payloadDigest
      || member.planDigest !== sensitivityDigest(root.request.plan)
      || member.sourceResultDigest !== artifactPin(root.request.sourceResult).digest
      || canonicalJson(root.request.probeIdentity) !== canonicalJson(REPLAY_IDENTITY)) throw new Error('replay request binding mismatch');
    const reports: SensitivityReport[] = [];
    for (let repetition = 0; repetition < 2; repetition += 1) {
      checkpoint.reserve(root.id, repetition);
      const report = await analyzeDecisionSensitivity({ ...structuredClone(root.request), probeState: state,
        probeIdentity: REPLAY_IDENTITY, now: () => Date.parse(REPLAY_CLOCK) });
      validateSensitivityReport(report);
      checkpoint.complete(root.id, repetition, report, state);
      reports.push(report);
    }
    roots.push({ id: root.id, slice: root.slice, split: root.split, sourceResultDigest: member.sourceResultDigest,
      gold: labels.get(root.id)!, report: reports[0]!, trustedReportDigest: reports[0]!.digest, reproductionDigest: reports[1]!.digest });
  }
  return { roots, stopped: false };
}

export function buildReplayReviewPackets(artifacts: ReplayArtifacts, roots: readonly ComparativeReplayRoot[]) {
  const sources = new Map(artifacts.corpus.roots.map(root => [root.id, root.request]));
  const reports = new Map(roots.map(root => [root.id, root.report]));
  const gold = new Map(artifacts.gold.roots.map(root => [root.id, root.gold]));
  const packets = { schemaVersion: 'decision-comparative-replay-review-packets/v1', status: 'pending',
    packets: artifacts.auditSample.assessments.map(item => {
      const row = reports.get(item.rootId)!.rows[0]!;
      const predicted = { status: row.deltas.status, outcomeChanged: row.deltas.outcomeChanged,
        acceptanceChanged: row.deltas.acceptanceChanged, ruleChanged: row.deltas.ruleChanged, unreplayable: row.inference === 'unreplayable' };
      const expected = gold.get(item.rootId)!;
      const [A, B] = item.pairOrder === 'gold-report' ? [expected, predicted] : [predicted, expected];
      const source = sources.get(item.rootId)!;
      const evaluation = source.sourceResult.spec.evaluations.parcel!;
      const targets = source.sourceBinding.spec.evaluations.parcel!.targets;
      const context = {
        storedValue: evaluation.spec.value, storedStatus: evaluation.spec.status,
        storedOutcome: source.sourceResult.spec.outcome, matchedRules: source.sourceResult.spec.matchedRules,
        confidence: evaluation.spec.uncertainty?.confidence ?? null,
        distribution: evaluation.spec.uncertainty?.distribution ?? null,
        attempts: evaluation.spec.attempts.map(attempt => ({ targetIndex: targets.findIndex(target => target.model === attempt.requestedModel),
          status: attempt.status, reason: attempt.reason })),
        targets: targets.map(target => ({ acceptance: target.acceptance })),
        fallbackOn: source.sourceBinding.spec.evaluations.parcel!.fallbackOn,
        composition: source.sourceRuleset.spec.composition, rules: source.sourceRuleset.spec.rules,
        defaultOutcome: source.sourceRuleset.spec.defaultOutcome, failureOutcome: source.sourceRuleset.spec.failureOutcome,
        changes: source.plan.variants[0]!.changes,
      };
      return { assessmentId: item.assessmentId, context, A, B };
    }) };
  validateReplayReviewPackets(packets);
  return packets;
}


/** Exclusive one-shot study directory: an interrupted reservation is never silently retried. */
export async function writeReplayStudy(directory: string): Promise<void> {
  const artifacts = readReplayArtifacts();
  mkdirSync(directory, { recursive: true });
  const lock = openSync(resolve(directory, 'study.lock'), 'wx', 0o600);
  try {
    const plan = replayPreregistration(artifacts, new Date().toISOString());
    const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', flush: true });
    write('preregistration.json', plan);
    const freeze = { schemaVersion: 'decision-comparative-replay-freeze/v1', status: 'local-unverified',
      sourceArtifacts: Object.fromEntries(['corpus', 'gold', 'split', 'auditSample'].map(name =>
        [name, sensitivityDigest(artifacts[name as 'corpus' | 'gold' | 'split' | 'auditSample'])])),
      generatorDigest: artifacts.corpus.generatorDigest, preregistrationDigest: plan.digest,
      operatorRecord: null, priorTestAccess: 'development implementation inspected this synthetic regression corpus',
      contingencyUsd: 3, contingencySpentUsd: 0 };
    validateReplayFreeze(freeze);
    write('freeze-manifest.json', freeze);
    const state: SensitivityProbeState = { maxEntriesPerPrincipal: 600, reportsByWindow: new Map(), pathCounts: new Map() };
    mkdirSync(resolve(directory, 'reports'));
    const ledger = resolve(directory, 'probe-ledger.jsonl');
    const journal = (value: unknown) => appendFileSync(ledger, `${JSON.stringify(value)}\n`, { flush: true });
    const checkpoint: ReplayCheckpoint = {
      reserve: (id, repetition) => journal({ kind: 'reserved', id, repetition, identity: REPLAY_IDENTITY }),
      complete: (id, repetition, report) => {
        write(`reports/${id}-${repetition}.json`, report);
        journal({ kind: 'completed', id, repetition, reportDigest: report.digest });
      },
    };
    await new Promise<void>(resolve => setTimeout(resolve, 1));
    const accessedAt = new Date().toISOString();
    if (Date.parse(accessedAt) <= Date.parse(plan.frozenAt)) throw new Error('clock did not advance after freeze');
    write('access.json', { accessedAt, fixtureClock: REPLAY_CLOCK, proceduralHoldout: false });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    let run: Awaited<ReturnType<typeof replayFrozenCorpus>>;
    try { run = await replayFrozenCorpus(artifacts, state, checkpoint, controller.signal); }
    finally { process.removeListener('SIGINT', cancel); }
    write('probe-state.json', { reportsByWindow: [...state.reportsByWindow!], pathCounts: [...state.pathCounts!] });
    write('completion.json', { completedRoots: run.roots.length, stopped: run.stopped });
    if (run.stopped) return;
    const input = replayInput(artifacts, plan, run.roots, accessedAt);
    const evaluated = buildComparativeReplayEvaluation(input);
    write('gate-binding.json', evaluated.binding);
    write('gate-report.json', evaluated.gateReport);
    write('comparative-report.json', evaluated.report);
    write('operator-audit-key.json', artifacts.auditSample);
    write('review-packets.json', buildReplayReviewPackets(artifacts, run.roots));
    writeFileSync(resolve(directory, 'review-template.md'), artifacts.reviewTemplate, { flag: 'wx', flush: true });
  } finally { closeSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--replay') {
    process.stdout.write('Disabled. Use --replay for the frozen synthetic study: 600 roots, zero provider calls.\n');
  } else {
    const routing = JSON.parse(execFileSync('aiwg', ['artifacts', 'path', '--json', '--check-write'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' })) as { artifact_root: string; write_ready: boolean };
    if (!routing.write_ready) throw new Error('artifact root is unavailable');
    const directory = resolve(routing.artifact_root, 'decisions/sensitivity/d23-comparative-replay-v1');
    await writeReplayStudy(directory);
    process.stdout.write(`Offline artifacts: ${directory}\n`);
  }
}
