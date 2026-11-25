// Offline retention controls are distinct from model or production task performance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStudy, validateSnapshot, refineIncoming } from '../../../tools/eval/skill-retention.mjs';

const fixture = path.resolve('test/fixtures/artifacts/skill-retention.json');
const snapshot = () => JSON.parse(fs.readFileSync(fixture, 'utf8'));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-retention-test-'));
  roots.push(root);
  vi.stubEnv('AIWG_ROOT', path.join(root, 'runtime'));
  return root;
}

describe('preregistered metadata retention pilot (#4239)', () => {
  it('freezes bodies, identities, held-out tasks and both arrival sequences', () => {
    const data = snapshot();
    expect(() => validateSnapshot(data)).not.toThrow();
    expect(createHash('sha256').update(fs.readFileSync(fixture)).digest('hex')).toBe('11d6b9b56d7b1895d534981b81a3c4d182c4f3ac054f4191e613c7eee20ad200');
    expect(data.skills).toHaveLength(8);
    expect(data.tasks).toHaveLength(12);
    data.skills[0].body += '// drift';
    expect(() => validateSnapshot(data)).toThrow(/body hash/);
  });

  it('rejects unsupported capabilities and misleading exclusions; uses original neighbours', () => {
    const data = snapshot();
    const incoming = data.skills[4];
    const neighbours = data.skills.slice(0, 4);
    const before = JSON.stringify(neighbours);
    const refined = refineIncoming(incoming, neighbours, 'neighbour-aware');
    expect(refined.description).toContain('Serialize scalar YAML values.');
    expect(refined.basis).toEqual(neighbours.map(({ id, name, description, bodyHash }) => ({ id, name, description, bodyHash })));
    expect(JSON.stringify(neighbours)).toBe(before);
    for (const lie of ['Deploy remote servers.', 'Does not emit YAML.']) {
      expect(() => refineIncoming({ ...incoming, refined: [lie] }, neighbours, 'neighbour-aware')).toThrow(/unsupported/);
    }
  });

  it('compares all four arms at every insertion with paired strata, alternatives, execution and costs', async () => {
    const data = snapshot();
    const before = JSON.stringify(data);
    const report = await runStudy(data, workspace());
    expect(JSON.stringify(data)).toBe(before);
    expect(report.runs).toHaveLength(40);
    expect(new Set(report.runs.map(run => run.arm))).toEqual(new Set(['unchanged', 'body-only', 'neighbour-aware', 'current-discover']));
    expect(report.pairs.length).toBeGreaterThan(0);
    expect(new Set(report.runs.flatMap(run => Object.keys(run.strata)))).toEqual(new Set(['old-only', 'new-only', 'mixed']));
    for (const run of report.runs) {
      expect(run.controls).toEqual(report.controls);
      expect(run.cost).toMatchObject({ refinementCalls: 0, retries: 0, embeddings: 0, modelTokens: 0, usd: 0 });
      expect(run.cost.routingCharacters).toBeGreaterThan(0);
      if (run.step === 0 || ['unchanged', 'current-discover'].includes(run.arm)) {
        expect(run.cost.refinementContextCharacters).toBe(0);
      } else expect(run.cost.refinementContextCharacters).toBeGreaterThan(0);
      expect(run.strata['old-only'].strict.interval).toHaveLength(2);
    }
    const final = report.runs.filter(run => run.step === 4);
    expect(final.some(run => run.queries.some(query => query.execution.status === 'failed'))).toBe(true);
    expect(report.recommendation.decision).toBe('no-change');
    expect(report.recommendation.reason).toMatch(/synthetic/);
    for (const stream of ['natural-random', 'confusable']) {
      const baseline = final.find(run => run.stream === stream && run.arm === 'unchanged');
      const current = final.find(run => run.stream === stream && run.arm === 'current-discover');
      expect(current.queries.map(q => q.selected)).toEqual(baseline.queries.map(q => q.selected));
    }
  }, 30_000);

  it('validates functional alternatives independently of annotated identity', async () => {
    const data = snapshot();
    const route = async (_project, _skills, task) => task.required.map(id => id === 'sum-alternative' ? 'sum-values' : id);
    const report = await runStudy(data, workspace(), { route });
    const row = report.runs.find(run => run.step === 4).queries.find(q => q.id === 'new-sum');
    expect(row).toMatchObject({ strict: false, functional: true, execution: { status: 'passed' } });
    const bad = data.skills.find(s => s.id === 'sum-values');
    bad.body = bad.body.replace('input.reduce((a,b) => a+b,0)', '99');
    bad.bodyHash = createHash('sha256').update(bad.body).digest('hex');
    const rejected = await runStudy(data, workspace(), { route });
    expect(rejected.alternatives['new-sum']['sum-alternative']).toEqual([]);
    expect(rejected.runs.find(run => run.step === 4).queries.find(q => q.id === 'new-sum').functional).toBe(false);
  });

  it('preserves partial routing runs without changing paired denominators', async () => {
    const report = await runStudy(snapshot(), workspace(), { route: async () => { throw new Error('fixture router failed'); } });
    expect(report.runs.every(run => run.status === 'partial')).toBe(true);
    expect(report.runs[0].queries.every(query => query.error === 'fixture router failed')).toBe(true);
    expect(report.pairs.every(pair => pair.comparable === false)).toBe(true);
    expect(report.recommendation.decision).toBe('no-change');
  });

  it('preserves budget and invalid-selection failures, and rejects nonfunctional alternatives', async () => {
    const data = snapshot();
    const budget = structuredClone(data); budget.protocol.contextCharacters = 1;
    const budgetReport = await runStudy(budget, workspace());
    expect(budgetReport.runs.every(run => run.queries.every(q => q.error === 'routing context budget exceeded'))).toBe(true);
    const invalid = await runStudy(data, workspace(), { route: async () => ['missing'] });
    expect(invalid.runs[0].queries.every(q => q.error === 'router returned invalid selection')).toBe(true);
    data.tasks.find(t => t.id === 'new-sum').alternatives['sum-alternative'] = ['text-upper'];
    const alternatives = await runStudy(data, workspace(), { route: async () => [] });
    expect(alternatives.alternatives['new-sum']['sum-alternative']).toEqual([]);
  });

  it('rejects duplicate identities, incomplete sequences, unknown requirements and budget changes', () => {
    const mutations = [
      data => { data.skills[1].id = data.skills[0].id; },
      data => { data.protocol.streams.confusable.pop(); },
      data => { data.tasks[0].required = ['missing']; },
      data => { data.protocol.limit = 0; },
    ];
    for (const mutate of mutations) {
      const data = snapshot(); mutate(data);
      expect(() => validateSnapshot(data)).toThrow();
    }
  });
});
