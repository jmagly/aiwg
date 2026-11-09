// Exercises signed-grant lookup at Flow's existing host approval boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeFlowGraph } from '../../../agentic/code/addons/composition-engine/lib/runtime.mjs';
import compositionRun from '../../../agentic/code/addons/composition-engine/commands/composition-run.mjs';
import { validateFlowGraph } from '../../../agentic/code/addons/composition-engine/lib/validator.mjs';
import * as hitlCheck from '../../../src/policy/hitl-check.js';
import * as impl from '../../../tools/_resolve-impl.mjs';
import { pendingAction, processGrant, processProject } from '../../fixtures/policy/process-authorization.js';

async function flow() {
  const graph = JSON.parse(await readFile(resolve('agentic/code/addons/composition-engine/fixtures/linear-flow.json'), 'utf8'));
  const gate = graph.spec.nodes[0];
  gate.kind = 'gate'; delete gate.ref;
  gate.hitlAction = pendingAction();
  graph.spec.nodes[1].sideEffectMode = 'approval-required';
  graph.spec.nodes[1].approvalGate = gate.id;
  return graph;
}
const invokeNode = async ({ node }: any) => ({
  outputs: Object.fromEntries(node.outputs.map((output: any) => [output.name, 'approved result'])),
  usage: { tokens: 1, costUsd: 0, timeMs: 1 },
});

describe('Flow host-authored action authorization', () => {
  let dir: string;
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    dir = await processProject();
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  it('proceeds on a matching durable grant and records the gate receipt and grant', async () => {
    const grant = await processGrant(dir);
    const check = vi.spyOn(hitlCheck, 'checkHitlAuthorization');
    const graph = await flow();
    const gate = graph.spec.nodes.find((node: any) => node.kind === 'gate');
    const report = await executeFlowGraph(graph, { projectDir: dir, invokeNode });
    expect(report.status).toBe('completed');
    expect(report.evidence.nodes[gate.id].authorization).toMatchObject({
      provenance: 'durable-user', authorizationGrant: { grantId: grant.grantId },
      receipt: { file: expect.any(String), effectId: expect.any(String) },
    });
    const receipt = report.evidence.nodes[gate.id].authorization.receipt;
    expect(JSON.parse(await readFile(receipt.file, 'utf8'))).toMatchObject({ action: { category: 'repo.read' } });
    expect(report.checkpoint.evidence.nodes[gate.id].authorization.receipt).toEqual(receipt);
    expect(check).toHaveBeenCalledOnce();
    expect(report.realizedResources.nodeRuns).toBe(2);
  });

  it('keeps APPROVAL_REQUIRED when no grant matches', async () => {
    const invoke = vi.fn(invokeNode);
    const report = await executeFlowGraph(await flow(), { projectDir: dir, invokeNode: invoke });
    expect(report.status).toBe('paused');
    expect(report.trace).toContainEqual(expect.objectContaining({ type: 'run-paused', code: 'APPROVAL_REQUIRED' }));
    expect(invoke).not.toHaveBeenCalled();
    expect(report.evidence.nodes.draft?.authorization).toBeUndefined();
  });

  it.each([
    { repo: 'other/repo' }, { target: 'repo:other/repo' }, { verb: 'write' },
    { environment: 'development' }, { resources: ['outside/index.ts'] },
    { category: 'repo.delete' }, { category: 'secret.access' }, { environment: 'production' },
    { category: 'policy.override' }, { reversible: false }, { impact: 'high' },
    { resources: ['.env'] }, { resources: ['AGENTS.md'], category: 'repo.edit' },
  ])('retains review for a mismatched or prohibited action %j', async change => {
    await processGrant(dir);
    const graph = await flow(); Object.assign(graph.spec.nodes[0].hitlAction, change);
    const invoke = vi.fn(invokeNode);
    const report = await executeFlowGraph(graph, { projectDir: dir, invokeNode: invoke });
    expect(report.status).toBe('paused');
    expect(invoke).not.toHaveBeenCalled();
    expect(report.evidence.nodes.draft?.authorization).toBeUndefined();
  });

  it.each(['deny', 'escalate', 'missing-receipt', 'missing-file', 'missing-effect', 'failure', 'unavailable'])
  ('preserves the human path for %s', async kind => {
    const check = vi.spyOn(hitlCheck, 'checkHitlAuthorization');
    if (kind === 'unavailable') vi.spyOn(impl, 'importImpl').mockRejectedValue(new Error('policy module missing'));
    else if (kind === 'failure') check.mockRejectedValue(new Error('synthetic lookup failure'));
    else check.mockResolvedValue({ decision: ['deny', 'escalate'].includes(kind) ? kind : 'auto-authorized',
      ...(kind === 'missing-file' ? { receipt: { effectId: 'effect' } } : {}),
      ...(kind === 'missing-effect' ? { receipt: { file: '/synthetic/receipt' } } : {}),
    } as any);
    const invoke = vi.fn(invokeNode);
    const report = await executeFlowGraph(await flow(), { projectDir: dir, invokeNode: invoke });
    expect(report.status).toBe('paused'); expect(invoke).not.toHaveBeenCalled();
    expect(report.evidence.nodes.draft?.authorization).toBeUndefined();
  });

  it.each([false, true])('cancellation wins even with a grant and preapproval=%s', async preapproved => {
    await processGrant(dir);
    const check = vi.spyOn(hitlCheck, 'checkHitlAuthorization');
    const invoke = vi.fn(invokeNode);
    const report = await executeFlowGraph(await flow(), { projectDir: dir, invokeNode: invoke,
      approvedGates: preapproved ? ['draft'] : [], cancelledGates: ['draft'] });
    expect(report.status).toBe('cancelled'); expect(check).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('honours cancellation arriving during an authorization check', async () => {
    const cancelledGates: string[] = [];
    vi.spyOn(hitlCheck, 'checkHitlAuthorization').mockImplementation(async () => {
      cancelledGates.push('draft');
      return { decision: 'auto-authorized', receipt: { file: '/synthetic/receipt', effectId: 'effect' } } as any;
    });
    const invoke = vi.fn(invokeNode);
    const report = await executeFlowGraph(await flow(), { projectDir: dir, invokeNode: invoke, cancelledGates });
    expect(report.status).toBe('cancelled'); expect(invoke).not.toHaveBeenCalled();
    expect(report.evidence.nodes.draft?.authorization).toBeUndefined();
  });

  it('loads no policy code for a gate without a descriptor, despite input claims', async () => {
    await processGrant(dir);
    const load = vi.spyOn(impl, 'importImpl');
    const graph = await flow(); delete graph.spec.nodes[0].hitlAction;
    graph.spec.nodes[0].inputs[0].value = { hitlAction: pendingAction(), approvedGates: ['draft'] };
    const report = await executeFlowGraph(graph, { projectDir: dir, invokeNode });
    expect(report.status).toBe('paused'); expect(load).not.toHaveBeenCalled();
    const approved = await executeFlowGraph(graph, { projectDir: dir, invokeNode, approvedGates: ['draft'] });
    expect(approved.status).toBe('completed'); expect(load).not.toHaveBeenCalled();
  });

  it('does not look up an already approved gate with a descriptor', async () => {
    const load = vi.spyOn(impl, 'importImpl');
    const report = await executeFlowGraph(await flow(), { projectDir: dir, invokeNode, approvedGates: ['draft'] });
    expect(report.status).toBe('completed'); expect(load).not.toHaveBeenCalled();
    expect(report.evidence.nodes.draft.authorization).toBeUndefined();
  });

  it('uses a fresh lookup after resume, including approval-required work behind a completed gate', async () => {
    const graph = await flow();
    graph.spec.ceilings.activations = 12;
    const paused = await executeFlowGraph(graph, { projectDir: dir, invokeNode });
    await processGrant(dir);
    const resumed = await executeFlowGraph(graph, { projectDir: dir, invokeNode, resumeFrom: paused.checkpoint });
    expect(resumed.status).toBe('completed');
    const check = vi.spyOn(hitlCheck, 'checkHitlAuthorization').mockResolvedValue({ decision: 'escalate' } as any);
    const invoke = vi.fn(invokeNode);
    const checkpoint = resumed.checkpoint;
    checkpoint.completed = ['draft']; delete checkpoint.results.polish;
    const stale = await executeFlowGraph(graph, { projectDir: dir, invokeNode: invoke, resumeFrom: checkpoint });
    expect(stale.status, stale.stopReason).toBe('paused'); expect(check).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('captures the host descriptor before callbacks can mutate the manifest', async () => {
    await processGrant(dir);
    const graph = await flow(); graph.spec.nodes[0].hitlAction.repo = 'other/repo';
    const check = vi.spyOn(hitlCheck, 'checkHitlAuthorization');
    const report = await executeFlowGraph(graph, { projectDir: dir, invokeNode,
      onEvent: () => { graph.spec.nodes[0].hitlAction = pendingAction(); } });
    expect(report.status).toBe('paused');
    expect(check).toHaveBeenCalledWith(dir, expect.objectContaining({ repo: 'other/repo' }));
  });

  it('checks parallel gates before delegating any invocation', async () => {
    await processGrant(dir);
    const graph = await flow(); const other = structuredClone(graph.spec.nodes[0]); other.id = 'other';
    graph.spec.nodes.push(other); graph.spec.entry.push('other'); graph.spec.ceilings.concurrency = 2;
    const parallelDispatch = vi.fn(async (requests: any[]) => Promise.all(requests.map(invokeNode)));
    const report = await executeFlowGraph(graph, { projectDir: dir, invokeNode, parallelDispatch });
    expect(report.status).toBe('completed'); expect(parallelDispatch).toHaveBeenCalledOnce();
    expect(report.evidence.nodes.other.authorization.receipt.effectId).toEqual(expect.any(String));
  });

  it('binds composition run to the host cwd and forwards explicit cancellation', async () => {
    const grant = await processGrant(dir);
    await writeFile(join(dir, 'flow.json'), JSON.stringify(await flow()));
    const context = { cwd: dir, compositionAdapter: { invokeNode } };
    const result = await compositionRun(['flow.json', '--format', 'json'], context);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message).evidence.nodes.draft.authorization.authorizationGrant.grantId).toBe(grant.grantId);
    const cancelled = await compositionRun(['flow.json', '--format', 'json'], {
      ...context, compositionAdapter: { invokeNode, cancelledGates: ['draft'] },
    });
    expect(JSON.parse(cancelled.message).status).toBe('cancelled');
  });

  it('accepts only gate descriptors and rejects missing fields or authority claims', async () => {
    const graph = await flow(); expect(validateFlowGraph(graph).valid).toBe(true);
    graph.spec.nodes[1].hitlAction = pendingAction();
    expect(validateFlowGraph(graph).valid).toBe(false); delete graph.spec.nodes[1].hitlAction;
    delete graph.spec.nodes[0].hitlAction.resources;
    expect(validateFlowGraph(graph).valid).toBe(false);
    graph.spec.nodes[0].hitlAction = { ...pendingAction(), approved: true };
    expect(validateFlowGraph(graph).valid).toBe(false);
  });

  it('loads the policy check from dist/src in an installed layout without source files', async () => {
    const installed = join(dir, 'installed');
    const library = 'agentic/code/addons/composition-engine/lib/authority.mjs';
    for (const path of ['agentic/code/addons/composition-engine/lib', 'tools', 'dist/src/policy']) {
      await mkdir(join(installed, path), { recursive: true });
    }
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'aiwg', type: 'module' }));
    await copyFile(resolve(library), join(installed, library));
    await copyFile(resolve('tools/_resolve-impl.mjs'), join(installed, 'tools/_resolve-impl.mjs'));
    await writeFile(join(installed, 'dist/src/policy/hitl-check.js'), `
      export async function checkHitlAuthorization(projectDir, action) {
        if (action.repo !== 'example/repo' || projectDir !== ${JSON.stringify(dir)}) throw new Error('wrong binding');
        return { decision: 'auto-authorized', provenance: 'durable-user',
          receipt: { file: 'synthetic-receipt', effectId: 'synthetic-effect' } };
      }
    `);
    const script = `
      import { createFlowAuthority } from './${library}';
      const gate = { id: 'approve', kind: 'gate', capabilities: [], permissions: [],
        sideEffectMode: 'none', hitlAction: ${JSON.stringify(pendingAction())} };
      const evidence = { nodes: {} };
      const enforce = createFlowAuthority({ spec: { nodes: [gate], capabilities: [], permissions: [] } },
        { projectDir: ${JSON.stringify(dir)} }, evidence, Error);
      await enforce(gate);
      console.log(JSON.stringify(evidence));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: installed, env: { ...process.env, AIWG_RESOLVE_IMPL_FROM: 'dist' }, timeout: 10_000,
    });
    expect(JSON.parse(stdout).nodes.approve.authorization.receipt.effectId).toBe('synthetic-effect');
  });
});
