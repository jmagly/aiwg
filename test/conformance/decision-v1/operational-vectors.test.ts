import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactPin, DecisionAdmissionController, executeQualificationPlan, LlmSubagentDecisionAdapter,
  verifyQualificationArtifacts, type DecisionAdapterRequest, type DecisionBinding, type DecisionDefinition,
  type QualificationCaseExecutor } from '../../../src/decision/index.js';

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`examples/decision/${name}`, 'utf8')) as T;
const ids = ['C35', 'C41'] as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const executors: Record<(typeof ids)[number], QualificationCaseExecutor> = {
  C35: async () => {
    const limits = { concurrency: 1, maxCostUsd: 1, allowUnknownCost: false, maxQueueLength: 1, maxQueueWaitMs: 1000 };
    const controller = new DecisionAdmissionController(() => ({ principal: limits, workspace: limits, provider: limits }));
    let rejected = false;
    try {
      await controller.acquire({ budgetId: 'synthetic', principalId: 'principal', workspaceId: 'workspace', providerId: 'jev',
        estimate: { costUsd: null }, deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal });
    } catch (error) {
      rejected = true;
      assert.deepEqual((error as { evidence?: { reason: string } }).evidence?.reason, 'unknown-cost');
    }
    assert.equal(rejected, true);
    return { outcome: 'pass' };
  },
  C41: async () => {
    const source = await fixture<DecisionBinding>('binding-llm-subagent.json');
    const definition = await fixture<DecisionDefinition>('decision-category.json');
    const worker = await fixture<{ metadata: { id: string; version: string } }>('worker-fixture.json');
    const pin = artifactPin(worker);
    let runs = 0;
    const adapter = new LlmSubagentDecisionAdapter({ resolveWorker: async () => ({ ...worker, metadata: {
      ...worker.metadata, version: '2.0.0',
    } }) as never, runWorker: async () => { runs++; return { started: false, terminal: false }; } });
    const request: DecisionAdapterRequest = { alias: 'category', definition, input: await fixture('input.json'),
      target: { ...source.spec.evaluations.category!.targets[0]!, subagent: pin }, invocationId: 'worker-changed',
      deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal,
      resolveCredential: async () => new Uint8Array() };
    const result = await adapter.evaluate(request);
    assert.equal(result.reason, 'invalid-definition'); assert.equal(runs, 0);
    return { outcome: 'pass' };
  },
};

describe('C35/C41 offline cost and worker provenance vectors', () => {
  it('asserts fail-closed admission and pinned worker identity before emitting evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decision-operational-vectors-')); roots.push(root);
    const run = await executeQualificationPlan({ artifactRoot: root, executors,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'operational-vectors',
        generatedAt: '2026-09-23T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: ids.map(id => ({ id, kind: 'baseline' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/operational-vectors.test.ts'] })) },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(ids.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, root)).every(item => item.verified)).toBe(true);
  });
});
