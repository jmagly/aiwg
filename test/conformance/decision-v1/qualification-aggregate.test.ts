import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DECISION_GATE_SUITES, evaluateExecutedQualification, executeQualificationPlan, writeQualificationEvidenceManifest,
} from '../../../src/decision/index.js';
import { DECISION_CASE_COVERAGE } from './coverage-map.js';
import { loadQualificationRegistry, QUALIFICATION_VECTOR_SUITES } from './vectors/registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Files whose `C01: () => ...` style callbacks exercise runner mechanics, not vectors.
const RUNNER_MECHANICS = new Set([
  'test/unit/decision/qualification-runner.test.ts',
  'test/unit/decision/qualification-release.test.ts',
  'test/unit/decision/qualification-gates.test.ts',
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])));
  return nested.flat();
}

/** Case IDs defined as executor callbacks (`C31: async () =>`), by file. */
async function executorDefinitions(): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  for (const dir of ['test/conformance/decision-v1', 'test/unit/decision']) {
    for (const file of await sourceFiles(dir)) {
      const path = relative(process.cwd(), file);
      if (RUNNER_MECHANICS.has(path)) continue;
      const ids = [...(await readFile(file, 'utf8')).matchAll(/^\s+((?:C|TV)\d{2}): (?:async )?\(/gm)].map(match => match[1]!);
      if (ids.length) found.set(path, new Set(ids));
    }
  }
  return found;
}

describe('D11 aggregate qualification run', () => {
  it('maps every hinted case to a registered executor from that suite, and every executor to its hint', async () => {
    const registry = await loadQualificationRegistry();
    for (const item of DECISION_CASE_COVERAGE) {
      const suite = registry.suiteByCase[item.id];
      if (item.candidateTests.length) {
        expect(suite, `${item.id} is mapped but has no registered executor`).toBeDefined();
        expect(item.candidateTests).toContain(suite!.suite);
      } else {
        expect(suite, `${item.id} has an executor but no coverage hint`).toBeUndefined();
      }
    }
    for (const caseId of Object.keys(registry.executors)) {
      expect(DECISION_CASE_COVERAGE.map(item => item.id)).toContain(caseId);
    }
  });

  it('finds no executor defined in the repository that is missing from the registry', async () => {
    const registry = await loadQualificationRegistry();
    const modules = new Map(QUALIFICATION_VECTOR_SUITES.map(suite => [suite.module, suite]));
    const definitions = await executorDefinitions();
    // Every registered module is found by the scan, so an empty scan cannot pass vacuously.
    expect([...definitions.keys()].sort()).toEqual([...modules.keys()].sort());
    for (const [file, ids] of definitions) {
      expect(modules.has(file), `${file} defines vector executors outside the registry`).toBe(true);
      for (const id of ids) expect(registry.suiteByCase[id]?.module, `${id} in ${file}`).toBe(file);
    }
  });

  it('runs every registered executor in one run and binds each outcome to a verified digest', async () => {
    const registry = await loadQualificationRegistry();
    const root = await mkdtemp(join(tmpdir(), 'decision-aggregate-')); roots.push(root);
    const cases = DECISION_CASE_COVERAGE.map(item => registry.evidenceIds[item.id]
      ? { ...item, evidenceIds: [...registry.evidenceIds[item.id]!] } : item);
    const run = await executeQualificationPlan({
      artifactRoot: root, executors: registry.executors, concurrency: 1, timeoutMs: 60_000,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'd11-aggregate',
        generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true, cases },
    });
    const registered = new Set(Object.keys(registry.executors));
    const failures = run.evidence.filter(item => registered.has(item.caseId) && item.outcome !== 'pass').map(item => item.caseId);
    expect(failures).toEqual([]);
    for (const item of run.evidence) {
      if (registered.has(item.caseId)) {
        expect(item).toMatchObject({ executable: true, outcome: 'pass' });
        expect(item.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      } else {
        expect(item).toMatchObject({ executable: false, outcome: 'skip' });
      }
    }

    const evaluated = await evaluateExecutedQualification(run, root);
    expect(evaluated.verification.every(item => item.verified)).toBe(true);
    const unregistered = cases.map(item => item.id).filter(id => !registered.has(id));
    const g0 = evaluated.report.gates.find(gate => gate.id === 'G0')!;
    expect(g0.missing).toEqual(unregistered.map(id => `case:${id}`).sort());
    // Suite flags come from the recorded run, not from callbacks.
    for (const name of Object.keys(DECISION_GATE_SUITES)) expect(run.evidenceFlags[name], name).toBe(true);
    expect(evaluated.report.decision).toBe('HOLD');

    const executed = { ...run, evidence: run.evidence.filter(item => registered.has(item.caseId)) };
    const linked = await writeQualificationEvidenceManifest(executed, root, process.cwd(), Object.fromEntries(
      Object.entries(registry.suiteByCase).map(([caseId, suite]) => [caseId, [suite.suite, suite.module, ...suite.sources]]),
    ));
    expect(linked.manifest.evidence).toHaveLength(registered.size);
    expect(linked.manifest.evidence.every(item => item.sourceGoldens.length >= 2)).toBe(true);
  }, 120_000);
});
