// Report paired task-level fixture differences without opening empirical claims.
import type { EvalResult } from './models/types.js';
import type { Adjudication, ArmSummary, Comparison, Interval, PilotDataset, PilotSummary, Resources, Split } from './pilot-types.js';
import { digest, random } from './pilot-files.js';
import { validateEvalContract } from './contracts.js';

const keys = ['success', 'total_tokens', 'context_tokens', 'latency_ms', 'permission_violations', 'invalid_transitions', 'duplicate_effects', 'regressions'] as const;
const mean = (v: number[]) => v.reduce((n, x) => n + x, 0) / v.length;
function metric(row: EvalResult, key: typeof keys[number]): number {
  return key === 'success' ? Number(row.pilot!.success) : row.pilot!.resources[key as keyof Resources];
}
function paired(baseline: string, candidate: string, rows: EvalResult[], dataset: PilotDataset): Comparison {
  const tasks = dataset.tasks.filter(t => t.pilot.split === 'held-out');
  const byKey = new Map(rows.map(r => [`${r.testCaseId}:${r.pilot!.arm_id}`, r]));
  const differences = tasks.map(t => {
    const a = byKey.get(`${t.id}:${baseline}`)!;
    const b = byKey.get(`${t.id}:${candidate}`)!;
    return keys.map(k => metric(b, k) - metric(a, k));
  });
  const rng = random(dataset.seed);
  const resamples = 2000;
  const draws = keys.map(() => [] as number[]);
  for (let iteration = 0; iteration < resamples; iteration++) {
    const sums = keys.map(() => 0);
    for (let j = 0; j < tasks.length; j++) {
      const sampled = differences[Math.floor(rng() * tasks.length)];
      sampled.forEach((v, k) => { sums[k] += v; });
    }
    sums.forEach((v, k) => draws[k].push(v / tasks.length));
  }
  const metrics = Object.fromEntries(keys.map((key, k) => {
    const sorted = draws[k].sort((a, b) => a - b);
    const interval: Interval = { estimate: mean(differences.map(d => d[k])), lower: sorted[Math.floor(resamples * 0.025)], upper: sorted[Math.ceil(resamples * 0.975) - 1] };
    return [key, interval];
  })) as Comparison['metrics'];
  return {
    hypothesis: dataset.arms.find(a => a.id === candidate)!.hypothesis,
    baseline, candidate, sample_n: tasks.length,
    bootstrap: { method: 'paired-percentile', confidence: 0.95, resamples, seed: dataset.seed }, metrics,
  };
}

export function summarizePilot(dataset: PilotDataset, records: EvalResult[]): PilotSummary {
  const indexed = new Map<string, EvalResult>();
  const pinDigest = digest(dataset.pins);
  for (const row of records) {
    validateEvalContract('EvalResult', row);
    const p = row.pilot;
    if (!p) throw new Error('Pilot record missing pairing metadata');
    const task = dataset.tasks.find(t => t.id === row.testCaseId);
    const arm = dataset.arms.find(a => a.id === p.arm_id);
    if (!task || !arm || p.hypothesis !== arm.hypothesis || p.split !== task.pilot.split || p.family !== task.pilot.family) throw new Error('Pilot record pair identity mismatch');
    if (p.pin_digest !== pinDigest || p.dataset_commitment !== dataset.commitment || digest(p.checks) !== digest(task.pilot.checks)) throw new Error('Pilot record pin mismatch');
    if (p.success !== Boolean(row.score) || (p.success && p.status !== 'completed')) throw new Error('Pilot record success/status mismatch');
    validateEvalContract('Adjudication', row.details.adjudication);
    const adjudication = row.details.adjudication as Adjudication;
    if (adjudication.id !== p.adjudication_id || adjudication.accepted !== p.success) throw new Error('Pilot record adjudication mismatch');
    const key = `${row.testCaseId}:${p.arm_id}`;
    if (indexed.has(key)) throw new Error('Duplicate pilot record pair');
    indexed.set(key, row);
  }
  for (const task of dataset.tasks) {
    for (const arm of dataset.arms) if (!indexed.has(`${task.id}:${arm.id}`)) throw new Error('Missing pilot record pair');
    for (const hypothesis of ['H1', 'H2']) {
      const order = records.filter(r => r.testCaseId === task.id && r.pilot!.hypothesis === hypothesis).map(r => r.pilot!.order).sort();
      if (order.join(',') !== '0,1,2,3') throw new Error('Pilot pair order mismatch');
    }
  }
  const arms: ArmSummary[] = dataset.arms.flatMap(arm => (['dev', 'held-out'] as Split[]).map(split => {
    const rows = records.filter(r => r.pilot!.arm_id === arm.id && r.pilot!.split === split);
    const successes = rows.filter(r => r.pilot!.success).length;
    const tokens = rows.reduce((n, r) => n + r.pilot!.resources.total_tokens, 0);
    return { arm_id: arm.id, split, sample_n: rows.length, successes,
      failures: rows.filter(r => !r.pilot!.success && r.pilot!.status !== 'partial').length,
      partials: rows.filter(r => r.pilot!.status === 'partial').length,
      success_rate: successes / rows.length, total_tokens: tokens,
      success_per_total_tokens: tokens ? successes / tokens : null,
      mean_latency_ms: mean(rows.map(r => r.latencyMs)) };
  }));
  const comparisons = [
    ...['h1-all', 'h1-discover', 'h1-expert'].map(id => paired('h1-none', id, records, dataset)),
    ...['h1-discover', 'h1-expert'].map(id => paired('h1-all', id, records, dataset)),
    ...['h2-loop', 'h2-graph'].map(id => paired('h2-dag', id, records, dataset)),
    paired('h2-loop', 'h2-graph', records, dataset),
    paired('h2-graph', 'h2-weakened-guard', records, dataset),
  ];
  const summary: PilotSummary = {
    dataset_id: dataset.dataset_id, dataset_commitment: dataset.commitment, evidence_mode: 'offline-fixture',
    splits: { dev: 12, 'held-out': 36 },
    families: { 'corpus-verification': 16, 'coding-repair': 16, 'security-testing': 16 },
    records, adjudication: records.map(r => r.details.adjudication as Adjudication), arms, comparisons,
    negative_control_valid: records.filter(r => r.pilot!.arm_id === 'h2-weakened-guard').every(r => !r.pilot!.success)
      && records.some(r => r.pilot!.arm_id === 'h2-graph' && r.pilot!.success),
    human_evaluation: 'NOT RUN',
    claim_gate: { state: 'BLOCKED', reasons: ['Fixture observations only; real trusted model runs do not exist', 'Blinded expert adjudication NOT RUN', 'H3-H6 deferred; fixture confidence intervals do not establish model effectiveness'] },
  };
  validateEvalContract('PilotSummary', summary);
  return summary;
}

export function pilotMarkdown(pilot: PilotSummary): string {
  const lines = ['## Offline H1/H2 pilot', '', 'Claim gate: **BLOCKED**. Human evaluation: **NOT RUN**.',
    'Fixture observations only. Context tokens use ceil(UTF-8 bytes / 4); no model usage was measured.',
    '', '| Arm | Split | Tasks | Accepted | Partial | success per total tokens |', '|---|---|---:|---:|---:|---:|'];
  for (const a of pilot.arms) lines.push(`| ${a.arm_id} | ${a.split} | ${a.sample_n} | ${a.successes} | ${a.partials} | ${a.success_per_total_tokens ?? 'unknown'} |`);
  lines.push('', 'Held-out paired-percentile bootstrap: 2,000 task-pair resamples, 95% intervals; candidate minus baseline.',
    '', '| Candidate / baseline | n | Success delta [95% CI] | Token delta | Latency delta (ms) |', '|---|---:|---|---:|---:|');
  for (const c of pilot.comparisons) lines.push(`| ${c.candidate} / ${c.baseline} | ${c.sample_n} | ${c.metrics.success.estimate.toFixed(3)} [${c.metrics.success.lower.toFixed(3)}, ${c.metrics.success.upper.toFixed(3)}] | ${c.metrics.total_tokens.estimate.toFixed(1)} | ${c.metrics.latency_ms.estimate.toFixed(1)} |`);
  lines.push('', 'JSON retains every executable check, failed/partial artifact, blinded adjudication, regression and permission/transition/effect observation.');
  return lines.join('\n');
}
