import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { artifactPin, MemoryDecisionReceiptStore, type DecisionRuleset, type DecisionBinding,
  type DecisionDefinition, type DecisionAdapter } from '../../../src/decision/index.js';
import { decisionRulesetFlowInvoker } from '../../../src/decision/graph-decision-bridge.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph } = require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const ruleset = fixture<DecisionRuleset>('ruleset.json');
const binding = fixture<DecisionBinding>('binding-jev.json');
const definitions: Record<string, DecisionDefinition> = {
  category: fixture('decision-category.json'), severity: fixture('decision-severity.json'),
  core: fixture('decision-core_unavailable.json'),
};
const defPin = artifactPin(definitions.category!);
const bindingPin = artifactPin(binding);
const graph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'real-bridge', entry: 'initial', terminals: ['dependent'],
  nodes: ['initial', 'dependent'].map((id, stage) => ({ id, stage, subject: 'message', target: 'jev',
    model: 'fixture-model', egress: 'local', stateDigest: `sha256:${'a'.repeat(64)}`,
    definition: defPin, binding: bindingPin, input: stage ? ['message'] : [], output: stage ? ['result'] : ['message'] })),
  edges: [{ from: 'initial', to: 'dependent', source: 'message', destination: 'message' }],
  budget: { attempts: 8, deadlineMs: 30000, tokens: 100, costMicros: 100,
    fanOut: 1, beamWidth: 1, depth: 2, concurrency: 1 } };
const plan = planDecisionGraph(graph, new Set([defPin.digest, bindingPin.digest]));
const skill = 'aiwg:skill:7763181ed98b5100' as const;
const manifest = decisionGraphToFlow(graph, { resolvedPins: new Set([defPin.digest, bindingPin.digest]),
  decisionSkillId: skill, terminal: 'dependent' });
describe('actual ruleset dispatcher through existing Flow skill bridge', () => {
  it('DAG-040 projects only prior outcome, preserves pinned attempts and replays before inference', async () => {
    let adapterCalls = 0;
    const adapter: DecisionAdapter = { id: 'jev', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
        features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
        confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true, egress: { mode: 'none' as const } }),
      evaluate: async request => {
        adapterCalls++;
        return { status: 'success', reason: 'none', value: request.alias === 'category' ? 'documentation' : 0.25,
          uncertainty: { source: 'provider', profile: request.alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
            calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
          actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 },
          requestId: `fixture-${request.alias}` };
      },
    };
    const receiptStore = new MemoryDecisionReceiptStore();
    const inputs: unknown[] = [];
    const invoker = decisionRulesetFlowInvoker(graph, { unknownCostBoundUsd: 0.000002,
      resolve: () => ({ ruleset, binding, definitions,
        input: { message: 'original input' }, runId: 'ignored', invocationId: 'ignored',
        receiptStore, adapters: { jev: adapter } }),
      project: (id, result) => {
        expect(result.spec.status).toBe('completed');
        return id === 'initial' ? { message: result.spec.outcome } : { result: result.spec.outcome };
      },
    });
    for (let replay = 0; replay < 2; replay++) {
      const records: any[] = [];
      const host = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, plan),
        () => ({ attempts: 4, tokens: 20, costMicros: 10 }),
        async request => { inputs.push(request.inputs); return invoker(request); }, undefined,
        value => records.push(structuredClone(value)));
      const report = await executeFlowGraph(manifest, { validation: { catalogIds: new Set([skill]) },
        runId: 'stable-flow-run', invokeNode: host });
      const receipt = finalizeDecisionGraphRun(graph, plan, report, records);
      expect(receipt.outcome).toBe('complete');
      expect(receipt.value).toEqual({ result: 'docs-review' });
      expect(receipt.evidence.stages[1]!.nodes[0]!.input.message.value).toBe('docs-review');
    }
    expect(adapterCalls).toBe(6); // Three evaluations per stage, not per replay.
    expect(inputs[1]).toMatchObject({ message: 'docs-review' });
  });
});
