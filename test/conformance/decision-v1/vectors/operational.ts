import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  artifactPin, DecisionAdmissionController, LlmSubagentDecisionAdapter, type DecisionAdapterRequest,
  type DecisionBinding, type DecisionDefinition, type QualificationCaseExecutor,
} from '../../../../src/decision/index.js';

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
export const ids = ['C35', 'C41'] as const;
export const executors: Record<(typeof ids)[number], QualificationCaseExecutor> = {
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
