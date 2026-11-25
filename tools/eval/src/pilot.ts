// Run frozen fixture arms through the existing eval result/report contracts.
import { loadPilot, digest, opaque, pinnedFile, random, shuffle } from './pilot-files.js';
import { executeFixtureFlow } from './pilot-flow.js';
import { executeHiddenCheck, type HiddenVector } from './pilot-checks.js';
import { summarizePilot } from './pilot-report.js';
import { validateEvalContract } from './contracts.js';
import type { EvalReportWithIntegrity, EvalResult } from './models/types.js';
import type { Adjudication, PilotArm, PilotDataset, ResponseTape } from './pilot-types.js';
import { buildIntegrityMetadata } from './integrity.js';
import { loadCalibration } from './calibration.js';

async function observation(dataset: PilotDataset, arm: PilotArm, task: PilotDataset['tasks'][number], tapes: ResponseTape[], root: string) {
  const tape = tapes.find(t => t.task_id === task.id && t.arm_id === (arm.hypothesis === 'H1' ? arm.id : 'h2'));
  const missing: ResponseTape = { task_id: task.id, arm_id: arm.id, text: '', self_pass: false, status: 'failed', total_tokens: 0, latency_ms: 0, tool_calls: 0 };
  const contextBytes = await Promise.all(arm.context.map(ref => pinnedFile(root, ref)));
  const contextTokens = contextBytes.reduce((n, bytes) => n + Math.ceil(bytes.length / 4), 0);
  const base = { ...(tape ?? missing), context_tokens: contextTokens, invalid_transitions: 0, duplicate_effects: 0, trace: [] as any[], flow_evidence: {} as Record<string, unknown> };
  if (tape && tape.status !== 'failed' && arm.graph) {
    const graph = JSON.parse((await pinnedFile(root, arm.graph)).toString('utf8'));
    Object.assign(base, await executeFixtureFlow(graph, arm, { input: task.pilot.input }, tape, dataset.pins));
  }
  base.total_tokens += contextTokens;
  const { budget } = dataset.pins;
  if (base.total_tokens > budget.total_tokens || base.tool_calls > budget.tool_calls || base.latency_ms > budget.latency_ms) base.status = 'partial';
  return base;
}

export async function runOfflinePilot(datasetPath: string, fixtureRoot: string): Promise<EvalReportWithIntegrity> {
  const { dataset, tapes } = await loadPilot(datasetPath, fixtureRoot);
  const records: EvalResult[] = [];
  const rng = random(dataset.seed);
  const pinDigest = digest(dataset.pins);
  for (const task of dataset.tasks) {
    for (const hypothesis of ['H1', 'H2'] as const) {
      const order = shuffle(dataset.arms.filter(a => a.hypothesis === hypothesis), rng);
      for (const [index, arm] of order.entries()) {
        const observed = await observation(dataset, arm, task, tapes, fixtureRoot);
        let permissions = 0;
        if (task.pilot.family === 'security-testing') {
          try {
            const output = JSON.parse(observed.text);
            permissions = (Array.isArray(output.permissions) ? output.permissions : []).filter((p: string) => !dataset.pins.tool_permissions.includes(p)).length;
          } catch { /* Malformed artifacts are rejected by the executable check. */ }
        }
        const safety = { permission_violations: permissions, invalid_transitions: observed.invalid_transitions, duplicate_effects: observed.duplicate_effects };
        const outcomes = [];
        for (const check of task.pilot.checks) {
          const vectors = JSON.parse((await pinnedFile(fixtureRoot, check)).toString('utf8')) as Record<string, HiddenVector>;
          const vector = vectors[task.id];
          if (!vector) throw new Error(`Missing hidden check vector for ${task.id}`);
          outcomes.push(executeHiddenCheck(check, observed.text, vector, safety));
        }
        const success = observed.status === 'completed' && outcomes.every(c => c.passed);
        const identity = { dataset: dataset.commitment, task: task.id, arm: arm.id };
        const id = opaque('adj', identity);
        const reasons = outcomes.flatMap(o => o.reasons);
        if (observed.status !== 'completed') reasons.push(`run ${observed.status}`);
        const entry: Adjudication = {
          id, case_id: opaque('case', task.id), candidate_id: opaque('candidate', identity),
          evaluator: 'hidden-executable', accepted: success, reasons,
          disagreement: observed.self_pass !== success, human_label: 'NOT RUN',
        };
        validateEvalContract('Adjudication', entry);
        const result: EvalResult = {
          testCaseId: task.id, dimension: task.dimension, score: Number(success), maxScore: 1,
          details: { trace: observed.trace, flow_evidence: observed.flow_evidence, check_outcomes: outcomes, adjudication: entry },
          latencyMs: observed.latency_ms, modelResponse: observed.text,
          pilot: {
            arm_id: arm.id, hypothesis, split: task.pilot.split, family: task.pilot.family,
            order: index, status: observed.status, success, pin_digest: pinDigest,
            dataset_commitment: dataset.commitment, checks: task.pilot.checks,
            resources: { total_tokens: observed.total_tokens, context_tokens: observed.context_tokens,
              latency_ms: observed.latency_ms, tool_calls: observed.tool_calls, ...safety,
              regressions: Number(task.pilot.baseline_passed && !success) },
            resource_source: 'fixture', observed_model: `${dataset.pins.model}@${dataset.pins.model_version}`,
            adjudication_id: id,
          },
        };
        validateEvalContract('EvalResult', result);
        records.push(result);
      }
    }
  }
  const pilot = summarizePilot(dataset, records);
  pilot.calibration = await loadCalibration(fixtureRoot, records);
  validateEvalContract('PilotSummary', pilot);
  const overall = records.reduce((n, r) => n + r.score, 0) / records.length * 100;
  return {
    model: dataset.pins.model, backend: 'fixture', date: '2026-11-24T00:00:00.000Z', aiwgVersion: 'offline-pilot-v1',
    dimensions: [], overall, overallTier: 'not-recommended', totalLatencyMs: records.reduce((n, r) => n + r.latencyMs, 0),
    ...buildIntegrityMetadata({ mode: 'standard', freshWorkspaceRequired: false, freshWorkspaceVerified: false,
      changedArtifacts: [], sampleN: dataset.tasks.length, passedN: 0, overallScore: overall }),
    trusted_score_source: 'hidden-executable-fixtures-only',
    weak_signal_reason: 'Offline fixture replay; no empirical model or human evidence',
    pilot,
  };
}
