import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactPin, type DecisionBinding, type DecisionDefinition } from '../../../src/decision/index.js';
import { decisionEvaluateSkillFlowInvoker, resolveDecisionEvaluateSkill, runDecisionEvaluateSkill,
  type DecisionSkillRun } from '../../../src/decision/graph-skill-bridge.js';
import { decisionGraphApprovalGateId, decisionGraphToFlow } from '../../../src/decision/graph-flow.js';
import { GraphBudgetLedger } from '../../../src/decision/graph-budget.js';
import { admittedDecisionFlowAdapter } from '../../../src/decision/graph-flow-adapter.js';
import { finalizeDecisionGraphRun } from '../../../src/decision/graph-run.js';
import { planDecisionGraph, type DecisionGraph } from '../../../src/decision/graph.js';
import { GRAPH_CONFORMANCE_CASES } from '../../../agentic/code/addons/graph-pattern/lib/conformance.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executeFlowGraph, validateFlowGraph } = {
  ...require('../../../agentic/code/addons/composition-engine/lib/runtime.mjs'),
  ...require('../../../agentic/code/addons/composition-engine/lib/validator.mjs'),
};

// AC13: decision stages run as ordinary Flow skill nodes whose ref is the catalog-resolved
// `decision-evaluate` skill, and whose invocation is that skill's own script and request
// contract. The #2127 graph profile projects onto this same FlowGraph substrate, so each
// case below reproduces one of its conformance cases through the decision bridge.
const root = resolve(import.meta.dirname, '../../..');
const examples = join(root, 'examples/decision');
const built = existsSync(join(root, 'dist/src/decision/index.js'));
const load = <T>(name: string): T => JSON.parse(readFileSync(join(examples, name), 'utf8')) as T;
const binding = load<DecisionBinding>('binding-llm-subagent.json');
const category = load<DecisionDefinition>('decision-category.json');
const defPin = artifactPin(category); const bindingPin = artifactPin(binding);
const pins = new Set([defPin.digest, bindingPin.digest]);
const graph: DecisionGraph = { schemaVersion: 'decision-graph/v1', id: 'skill-bridge', entry: 'initial', terminals: ['dependent'],
  nodes: ['initial', 'dependent'].map((id, stage) => ({ id, stage, subject: 'message', target: 'llm-subagent',
    model: 'fixture-structured-worker', egress: 'local', stateDigest: `sha256:${'a'.repeat(64)}`,
    definition: defPin, binding: bindingPin, input: stage ? ['message'] : [], output: stage ? ['result'] : ['message'] })),
  edges: [{ from: 'initial', to: 'dependent', source: 'message', destination: 'message' }],
  budget: { attempts: 8, deadlineMs: 60_000, tokens: 100, costMicros: 100, fanOut: 1, beamWidth: 1, depth: 2, concurrency: 1 } };
const plan = planDecisionGraph(graph, pins);
const request = () => ({ rulesetPath: join(examples, 'ruleset.json'), bindingPath: join(examples, 'binding-llm-subagent.json'),
  definitionPaths: ['decision-category.json', 'decision-severity.json', 'decision-core_unavailable.json'].map(name => join(examples, name)),
  inputPath: join(examples, 'input.json'), adapterModules: { 'llm-subagent': join(examples, 'fixture-llm-adapter.mjs') } });
const project = (id: string, result: any) => id === 'initial' ? { message: result.spec.outcome } : { result: result.spec.outcome };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-skill-bridge-')); directories.push(dir); return dir;
}
/** Offline stand-in for the skill process: answers the written request document. */
function scripted(seen: Array<{ request: any; input: unknown; run: DecisionSkillRun }>, code = 0) {
  return async (run: DecisionSkillRun) => {
    const document = JSON.parse(await readFile(run.requestPath, 'utf8'));
    seen.push({ request: document, input: JSON.parse(await readFile(document.inputPath, 'utf8')), run });
    const spec = { ruleset: artifactPin(load('ruleset.json')), binding: bindingPin, runId: document.runId,
      invocationId: document.invocationId, status: 'completed', reason: 'none', outcome: 'docs-review', matchedRules: [],
      evaluations: { category: { spec: { status: 'success', attempts: [{ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.000001 }, durationMs: 2 }] } } } };
    return { code, stdout: JSON.stringify({ apiVersion: 'decision.aiwg.io/v1alpha1', kind: 'RulesetResult',
      metadata: { id: 'result', version: '1' }, spec }) };
  };
}
async function host(options: { run?: (run: DecisionSkillRun) => Promise<{ code: number; stdout: string }>; approvalStages?: number[] } = {}) {
  const skill = await resolveDecisionEvaluateSkill(root);
  const manifest = decisionGraphToFlow(graph, { resolvedPins: pins, decisionSkillId: skill.id, terminal: 'dependent',
    ...(options.approvalStages ? { approvalStages: options.approvalStages } : {}) });
  const ledger = new GraphBudgetLedger(graph, plan);
  const records: any[] = [];
  const invoker = decisionEvaluateSkillFlowInvoker(graph, { skill, request, workDirectory: await workDirectory(),
    project, unknownCostBoundUsd: 0.000001, ...(options.run ? { run: options.run } : {}) });
  const invokeNode = admittedDecisionFlowAdapter(ledger, () => ({ attempts: 4, tokens: 20, costMicros: 10 }), invoker,
    undefined, record => records.push(structuredClone(record)));
  const execute = (extra: Record<string, unknown> = {}) => executeFlowGraph(manifest, {
    validation: { catalogIds: new Set([skill.id]) }, invokeNode, runId: 'skill-flow-run', ...extra });
  return { skill, manifest, records, execute };
}

describe('decision graph through the shipped decision-evaluate skill (AC13)', () => {
  it('DAG-049 resolves the skill from the catalog and compiles to existing Flow skill nodes only', async () => {
    const { skill, manifest } = await host();
    expect(skill.id).toMatch(/^aiwg:skill:[a-f0-9]{16}$/);
    // The ID the other graph suites pin is this catalog-derived ID, not an invented constant.
    expect(skill.id).toBe('aiwg:skill:7763181ed98b5100');
    expect(skill.scriptPath).toBe(join(root, 'agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate.mjs'));
    expect(validateFlowGraph(manifest, { catalogIds: new Set([skill.id]) }).valid).toBe(true);
    expect(manifest.spec.nodes.map((n: any) => [n.kind, n.ref])).toEqual([['skill', skill.id], ['skill', skill.id]]);
    // Every case here reproduces a #2127 graph-profile conformance case by name.
    for (const name of ['success-path', 'hitl-blocked', 'hitl-denial', 'runtime-failure', 'budget-limit', 'checkpoint-replay']) {
      expect(GRAPH_CONFORMANCE_CASES).toContain(name);
    }
  });
  it.skipIf(!built)('DAG-050 success-path: both stages run the real skill script with only projected evidence', async () => {
    const seen: any[] = [];
    const { records, execute } = await host({ run: async run => {
      const document = JSON.parse(await readFile(run.requestPath, 'utf8'));
      seen.push({ document, input: JSON.parse(await readFile(document.inputPath, 'utf8')), env: run.env });
      return runDecisionEvaluateSkill(run);
    } });
    const report = await execute();
    expect(report.status).toBe('completed');
    const receipt = finalizeDecisionGraphRun(graph, plan, report, records);
    expect(receipt).toMatchObject({ outcome: 'complete', terminal: 'dependent', value: { result: 'docs-review' } });
    expect(receipt.evidence.stages[1]!.nodes[0]!.input.message).toMatchObject({ sourceNode: 'initial', value: 'docs-review' });
    expect(seen.map(item => item.document.runId)).toEqual(['skill-flow-run', 'skill-flow-run']);
    expect(seen.map(item => item.document.invocationId)).toEqual(records.map(item => item.request.invocationKey));
    expect(seen[1].input).toEqual({ message: 'docs-review' });
    expect(seen[0].input).toEqual(load('input.json'));
    expect(seen.every(item => Object.keys(item.env).length === 0)).toBe(true);
    // Per-invocation request documents are private and removed after the call.
    expect(seen.every(item => !existsSync(item.document.inputPath) || item.document.inputPath.startsWith(examples))).toBe(true);
  }, 60_000);
  it('DAG-051 hitl-blocked then approved: a stage waits on a Flow gate and resumes without re-dispatch', async () => {
    const seen: any[] = [];
    const { manifest, records, execute } = await host({ run: scripted(seen), approvalStages: [1] });
    const gate = decisionGraphApprovalGateId('dependent');
    expect(manifest.spec.nodes.map((n: any) => [n.id, n.kind])).toEqual([['initial', 'skill'], [gate, 'gate'], ['dependent', 'skill']]);
    expect(manifest.spec.nodes.some((n: any) => n.kind === 'decision')).toBe(false);
    const paused = await execute();
    expect(paused.status).toBe('paused');
    expect(paused.trace.some((event: any) => event.code === 'APPROVAL_REQUIRED' && event.nodeId === gate)).toBe(true);
    expect(seen.map(item => item.request.invocationId)).toHaveLength(1);
    expect(() => finalizeDecisionGraphRun(graph, plan, paused, records, [], undefined, [], [1])).toThrow(/not final/);
    // checkpoint-replay: resume from Flow's checkpoint after approval; the entry is not re-run.
    const resumed = await execute({ resumeFrom: paused.checkpoint, approvedGates: [gate] });
    expect(resumed.status).toBe('completed');
    expect(seen).toHaveLength(2);
    expect(seen[1].input).toEqual({ message: 'docs-review' });
    const receipt = finalizeDecisionGraphRun(graph, plan, resumed, records, [], undefined, [], [1]);
    expect(receipt).toMatchObject({ outcome: 'complete', terminal: 'dependent', value: { result: 'docs-review' } });
    expect(receipt.approvals).toEqual([{ gate, nodeId: 'dependent', stage: 1,
      nodeRunId: expect.stringContaining(gate), activation: expect.any(Number) }]);
    expect(receipt.attempts.map(a => a.nodeId)).toEqual(['dependent', 'initial']);
    // A finalizer that is not told about the gate cannot account for the Flow run.
    expect(() => finalizeDecisionGraphRun(graph, plan, resumed, records)).toThrow();
  });
  it('DAG-052 hitl-denial: a cancelled approval ends the graph with no value and no dispatch', async () => {
    const seen: any[] = [];
    const { records, execute } = await host({ run: scripted(seen), approvalStages: [1] });
    const report = await execute({ cancelledGates: [decisionGraphApprovalGateId('dependent')] });
    expect(report.status).toBe('cancelled');
    expect(seen).toHaveLength(1);
    const receipt = finalizeDecisionGraphRun(graph, plan, report, records, [], undefined, [], [1]);
    expect(receipt).toMatchObject({ outcome: 'cancelled', value: null, approvals: [] });
    expect(receipt.evidence.stages[1]!.nodes[0]).toMatchObject({ id: 'dependent', status: 'cancelled', attempts: 0 });
  });
  it('DAG-053 runtime-failure and budget-limit: failed or mismatched skill runs and exhausted budgets yield no value', async () => {
    const failing = await host({ run: async () => ({ code: 2, stdout: '' }) });
    const failed = await failing.execute();
    expect(failed.status).toBe('failed');
    expect(failed.trace.some((event: any) => event.type === 'node-attempt-failed' && /skill failed/.test(event.message))).toBe(true);
    expect(() => finalizeDecisionGraphRun(graph, plan, failed, failing.records)).toThrow();
    const seen: any[] = [];
    const forged = await host({ run: async run => {
      const answer = await scripted(seen)(run);
      return { ...answer, stdout: answer.stdout.replace(/"invocationId":"[^"]+"/, '"invocationId":"other"') };
    } });
    const mismatched = await forged.execute();
    expect(mismatched.trace.some((event: any) => /does not match its Flow invocation/.test(event.message ?? ''))).toBe(true);
    expect(forged.records).toHaveLength(0);
    // budget-limit: the ledger refuses before the skill process is started.
    let started = 0;
    const skill = await resolveDecisionEvaluateSkill(root);
    const invoker = decisionEvaluateSkillFlowInvoker(graph, { skill, request, workDirectory: await workDirectory(), project,
      unknownCostBoundUsd: 0.000001, run: async () => { started++; return { code: 2, stdout: '' }; } });
    const adapter = admittedDecisionFlowAdapter(new GraphBudgetLedger(graph, plan, [{ tokens: 5 }]),
      () => ({ attempts: 4, tokens: 20, costMicros: 10 }), invoker);
    const manifest = decisionGraphToFlow(graph, { resolvedPins: pins, decisionSkillId: skill.id, terminal: 'dependent' });
    const limited = await executeFlowGraph(manifest, { validation: { catalogIds: new Set([skill.id]) }, invokeNode: adapter });
    expect(limited.status).toBe('failed');
    expect(started).toBe(0);
    // Relative or evidence-supplied paths are refused before any process starts.
    const relative = decisionEvaluateSkillFlowInvoker(graph, { skill, workDirectory: await workDirectory(), project,
      unknownCostBoundUsd: 0.000001, request: () => ({ ...request(), rulesetPath: 'ruleset.json' }),
      run: async () => { started++; return { code: 0, stdout: '' }; } });
    await expect(relative({ node: { id: 'initial', kind: 'skill', phase: 'stage-0', retry: { limit: 0 }, sideEffectMode: 'none' },
      inputs: {}, runId: 'r', nodeRunId: 'n', activationId: 'a', invocationKey: 'i' })).rejects.toThrow(/request/);
    expect(started).toBe(0);
  });
  it('DAG-054 leaves no per-invocation request documents behind', async () => {
    const seen: any[] = [];
    const dir = await workDirectory();
    const skill = await resolveDecisionEvaluateSkill(root);
    const invoker = decisionEvaluateSkillFlowInvoker(graph, { skill, request, workDirectory: dir, project,
      unknownCostBoundUsd: 0.000001, run: scripted(seen) });
    await invoker({ node: { id: 'dependent', kind: 'skill', phase: 'stage-1', retry: { limit: 0 }, sideEffectMode: 'none' },
      inputs: { message: 'docs-review', 'binding-pin': 'ignored' }, runId: 'r', nodeRunId: 'n', activationId: 'a', invocationKey: 'i' });
    expect(seen[0].input).toEqual({ message: 'docs-review' });
    expect(seen[0].request).toMatchObject({ runId: 'r', invocationId: 'i' });
    expect(await readdir(dir)).toEqual([]);
  });
});
