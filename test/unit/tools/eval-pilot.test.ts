// Verify frozen offline eval arms, trusted checks, pairing and claim boundaries.
import { readFile, readdir, mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiwgEvalRunner } from '../../../tools/eval/src/runner.js';
import { validateEvalContract } from '../../../tools/eval/src/contracts.js';
import { executeHiddenCheck } from '../../../tools/eval/src/pilot-checks.js';
import { summarizePilot, pilotMarkdown } from '../../../tools/eval/src/pilot-report.js';
import { generateJsonReport } from '../../../tools/eval/src/reporters/json.js';
import { generateMarkdownReport } from '../../../tools/eval/src/reporters/markdown.js';
import { loadSchemaCatalog, SchemaResolver, SchemaValidator } from '../../../src/schema/index.js';

const datasetPath = path.resolve('tools/eval/datasets/composition-pilot.json');
const fixtures = path.resolve('test/fixtures/eval-pilot');
const scratch: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(scratch.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const run = () => AiwgEvalRunner.runOfflinePilot(datasetPath, fixtures);

async function mutateFixture(name: string, edit: (value: any) => void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-eval-pilot-'));
  scratch.push(dir);
  await cp(fixtures, dir, { recursive: true });
  const filename = path.join(dir, name);
  const value = JSON.parse(await readFile(filename, 'utf8'));
  edit(value);
  await writeFile(filename, JSON.stringify(value));
  return dir;
}

describe('offline H1/H2 eval pilot', () => {
  it('registers one eval-owned contract outside the testing-quality addon domain', async () => {
    const rootDir = process.cwd();
    const compiled = loadSchemaCatalog({ rootDir, inventoryRoots: [] });
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const resolver = new SchemaResolver(compiled.catalog!, { rootDir });
    const entries = resolver.list().filter(({ artifact }) => artifact.logicalName === 'eval.contracts');
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.domain).toBe('eval');
    expect(entry.artifact.owner).toEqual({ id: 'eval-maintainers' });
    expect(entry.artifact.authority).toEqual({ kind: 'canonical', path: 'tools/eval/datasets/contracts.v1.schema.json' });
    expect(entry.artifact.consumers).toEqual([
      expect.objectContaining({ id: 'eval-runner', path: 'tools/eval/src/runner.ts' }),
      expect.objectContaining({ id: 'eval-contract-validator', path: 'tools/eval/src/contracts.ts' }),
    ]);
    expect(entry.effectivePolicy).toMatchObject({ strict: true, requireFixtures: true, compatibility: 'backward' });
    const validator = new SchemaValidator(resolver, { rootDir });
    const manifest = JSON.parse(await readFile('schemas/catalog/domains/eval.json', 'utf8'));
    const validated = validator.validate('catalog.domain-manifest', manifest);
    expect(validated.valid, JSON.stringify(validated.diagnostics)).toBe(true);
    for (const fixture of entry.artifact.fixtures!.valid!) {
      expect(validator.validate('eval.contracts', JSON.parse(await readFile(fixture, 'utf8'))).valid, fixture).toBe(true);
    }
    for (const fixture of entry.artifact.fixtures!.invalid!) {
      expect(validator.validate('eval.contracts', JSON.parse(await readFile(fixture, 'utf8'))).valid, fixture).toBe(false);
    }
  });

  it('governs legacy YAML datasets and rejects invalid contract fixtures', async () => {
    for (const dim of await readdir('tools/eval/datasets', { withFileTypes: true })) {
      if (!dim.isDirectory()) continue;
      for (const name of await readdir(path.join('tools/eval/datasets', dim.name))) {
        if (name.endsWith('.yaml')) validateEvalContract('TestCase', yaml.load(await readFile(path.join('tools/eval/datasets', dim.name, name), 'utf8')));
      }
    }
    for (const name of await readdir(path.join(fixtures, 'contracts'))) {
      const fixture = JSON.parse(await readFile(path.join(fixtures, 'contracts', name), 'utf8'));
      if (name.endsWith('.valid.json')) expect(() => validateEvalContract(name.split('.')[0], fixture)).not.toThrow();
      if (name.endsWith('.invalid.json')) expect(() => validateEvalContract(name.split('.')[0], fixture)).toThrow();
    }
  });

  it('runs all 48 frozen tasks in all eight arms without a model or network', async () => {
    const network = vi.fn(() => { throw new Error('network forbidden'); });
    vi.stubGlobal('fetch', network);
    const report = await run();
    const pilot = report.pilot!;
    expect(network).not.toHaveBeenCalled();
    expect(pilot.records).toHaveLength(384);
    expect(pilot.splits).toEqual({ dev: 12, 'held-out': 36 });
    expect(pilot.families).toEqual({ 'corpus-verification': 16, 'coding-repair': 16, 'security-testing': 16 });
    expect(new Set(pilot.records.map(r => r.pilot!.arm_id)).size).toBe(8);
    for (const result of pilot.records) validateEvalContract('EvalResult', result);
    validateEvalContract('PilotSummary', pilot);
    expect(pilot.claim_gate.state).toBe('BLOCKED');
    expect(pilot.human_evaluation).toBe('NOT RUN');
    expect(pilot.records.some(r => r.pilot!.status === 'failed')).toBe(true);
    expect(pilot.records.some(r => r.pilot!.status === 'partial')).toBe(true);
    expect(pilot.adjudication).toHaveLength(384);
    expect(pilot.adjudication.every(a => !JSON.stringify(a).includes('h1-'))).toBe(true);
    expect(pilot.adjudication.some(a => a.disagreement)).toBe(true);
    expect(await run()).toEqual(report);
  });

  it('pairs held-out tasks, retains failure resources, and renders bootstrap evidence', async () => {
    const report = await run();
    const pilot = report.pilot!;
    expect(pilot.comparisons).toHaveLength(9);
    expect(pilot.comparisons.some(c => c.baseline === 'h1-all' && c.candidate === 'h1-discover' && c.metrics.context_tokens.estimate < 0)).toBe(true);
    expect(pilot.comparisons.some(c => c.baseline === 'h2-loop' && c.candidate === 'h2-graph')).toBe(true);
    for (const pair of pilot.comparisons) {
      expect(pair.sample_n).toBe(36);
      expect(pair.bootstrap.method).toBe('paired-percentile');
      expect(pair.bootstrap.resamples).toBe(2000);
      expect(pair.metrics.success.lower).toBeLessThanOrEqual(pair.metrics.success.upper);
      expect(pair.metrics).toHaveProperty('permission_violations');
      expect(pair.metrics).toHaveProperty('regressions');
    }
    for (const arm of pilot.arms.filter(a => a.split === 'held-out')) {
      const records = pilot.records.filter(r => r.pilot!.split === 'held-out' && r.pilot!.arm_id === arm.arm_id);
      expect(arm.sample_n).toBe(36);
      expect(arm.success_per_total_tokens).toBeCloseTo(records.filter(r => r.pilot!.success).length / records.reduce((n, r) => n + r.pilot!.resources.total_tokens, 0), 12);
    }
    const perTask = new Map<string, string[]>();
    for (const row of pilot.records) {
      const p = row.pilot!;
      const key = `${row.testCaseId}:${p.hypothesis}`;
      perTask.set(key, [...(perTask.get(key) ?? []), p.arm_id]);
    }
    expect(new Set([...perTask.values()].map(v => v.join(','))).size).toBeGreaterThan(2);
    expect(JSON.parse(generateJsonReport(report)).pilot.claim_gate.state).toBe('BLOCKED');
    expect(generateMarkdownReport(report)).toContain('success per total tokens');
    expect(generateMarkdownReport(report)).toContain('paired-percentile');
    expect(generateMarkdownReport(report)).toContain('Criterion calibration');
    const { calibration: _calibration, ...historical } = pilot;
    expect(pilotMarkdown(historical)).not.toContain('Criterion calibration');
  });

  it('executes real Flow routes/joins and rejects weakened guards with unchanged checks', async () => {
    const { pilot } = await run();
    const graph = pilot!.records.filter(r => r.pilot!.arm_id === 'h2-graph');
    const weak = pilot!.records.filter(r => r.pilot!.arm_id === 'h2-weakened-guard');
    expect(graph.some(r => r.details.trace.some((e: any) => e.type === 'route-evaluated'))).toBe(true);
    expect(graph.some(r => r.details.flow_evidence.joins?.['verified-and-audited']?.sources.length === 2)).toBe(true);
    expect(weak.some(r => r.pilot!.resources.invalid_transitions > 0)).toBe(true);
    expect(weak.every(r => !r.pilot!.success)).toBe(true);
    expect(graph.some(r => r.pilot!.success)).toBe(true);
    expect(pilot!.negative_control_valid).toBe(true);
    const constrained = JSON.parse(await readFile(path.join(fixtures, 'flows/graph.json'), 'utf8'));
    const weakened = JSON.parse(await readFile(path.join(fixtures, 'flows/weakened-guard.json'), 'utf8'));
    weakened.metadata = constrained.metadata;
    weakened.spec.joins[0].policy = constrained.spec.joins[0].policy;
    expect(weakened).toEqual(constrained);
    for (const row of weak) {
      const control = graph.find(g => g.testCaseId === row.testCaseId)!;
      expect(row.pilot!.checks).toEqual(control.pilot!.checks);
      expect(row.pilot!.resources.duplicate_effects).toBe(control.pilot!.resources.duplicate_effects);
    }
  });

  it('rejects drift in split, environment, budgets, arm identity and referenced fixture bytes', async () => {
    const original = JSON.parse(await readFile(datasetPath, 'utf8'));
    for (const edit of [
      (v: any) => { v.tasks[0].pilot.split = 'held-out'; },
      (v: any) => { v.pins.model = 'changed'; },
      (v: any) => { v.pins.budget.total_tokens++; },
      (v: any) => { v.arms[0].id = 'changed'; },
    ]) {
      const dir = await mkdtemp(path.join(tmpdir(), 'aiwg-eval-freeze-'));
      scratch.push(dir);
      const changed = structuredClone(original); edit(changed);
      const file = path.join(dir, 'dataset.json'); await writeFile(file, JSON.stringify(changed));
      await expect(AiwgEvalRunner.runOfflinePilot(file, fixtures)).rejects.toThrow(/commitment|contract/);
    }
    const drift = await mutateFixture('responses.json', v => { v[0].text = 'tampered'; });
    await expect(AiwgEvalRunner.runOfflinePilot(datasetPath, drift)).rejects.toThrow(/digest/);
  });

  it('bootstraps whole task pairs, including failed and partial observations', async () => {
    const { pilot } = await run();
    const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
    const baselines = new Map(pilot!.records.filter(r => r.pilot!.arm_id === 'h1-none').map(r => [r.testCaseId, r]));
    const rows = pilot!.records.map(r => {
      if (r.pilot!.arm_id !== 'h1-expert') return r;
      const baseline = baselines.get(r.testCaseId)!;
      return { ...r, score: baseline.score, latencyMs: baseline.latencyMs + 2,
        details: { ...r.details, adjudication: { ...r.details.adjudication as object, accepted: baseline.pilot!.success } },
        pilot: { ...r.pilot!, success: baseline.pilot!.success, status: baseline.pilot!.status,
          resources: { ...baseline.pilot!.resources, total_tokens: baseline.pilot!.resources.total_tokens + 17, latency_ms: baseline.latencyMs + 2 } } };
    });
    const result = summarizePilot(dataset, rows).comparisons.find(c => c.baseline === 'h1-none' && c.candidate === 'h1-expert')!;
    expect(result.sample_n).toBe(36);
    expect(result.metrics.success).toEqual({ estimate: 0, lower: 0, upper: 0 });
    expect(result.metrics.total_tokens).toEqual({ estimate: 17, lower: 17, upper: 17 });
    expect(result.metrics.latency_ms).toEqual({ estimate: 2, lower: 2, upper: 2 });
  });

  it('uses hidden edge cases and contains executable check errors', () => {
    const check = { id: 'coding' as const, ref: 'checks.json', digest: 'sha256:' + 'a'.repeat(64) };
    const vector = { cases: [{ input: [-2, 0, 1], output: 1 }] };
    const safe = { permission_violations: 0, invalid_transitions: 0, duplicate_effects: 0 };
    expect(executeHiddenCheck(check, 'x => x.filter(n => n > 0).length', vector, safe).passed).toBe(true);
    expect(executeHiddenCheck(check, 'x => x.filter(n => n >= 0).length', vector, safe).passed).toBe(false);
    expect(executeHiddenCheck(check, 'x => { while (true) {} }', vector, safe).passed).toBe(false);
    expect(executeHiddenCheck(check, 'x => process.env', vector, safe).passed).toBe(false);
    expect(executeHiddenCheck(check, 'x => 1', vector, { ...safe, permission_violations: 1 }).passed).toBe(false);
  });

  it('fails closed on missing, duplicate or mismatched pairs instead of dropping them', async () => {
    const { pilot } = await run();
    const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
    for (const records of [pilot!.records.slice(1), [...pilot!.records, pilot!.records[0]], pilot!.records.map((r, i) => i ? r : { ...r, pilot: { ...r.pilot, pin_digest: 'sha256:' + '0'.repeat(64) } })]) {
      expect(() => summarizePilot(dataset, records)).toThrow(/pair|pin|record/i);
    }
  });
});
