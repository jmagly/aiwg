// Synthetic project and fake dispatch checks for local-only worker inputs.
import { mkdtemp, mkdir, writeFile, access, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerInputs } from '../../fixtures/ralph-external/conductor-worker-inputs.mjs';
import { createInvocationRegistry, registerWorkerInvokeToolset } from '../../../src/mcp/tools/worker-invoke.mjs';
import { workerLocalOnlyPreflight } from '../../../src/mcp/tools/worker-local-only-preflight.mjs';
import { workerConfigDigest as digest } from '../../../src/config/aiwg-config.js';
import { resolveWorkerInvocation, mcpToolSchemaDigest } from '../../../src/serve/worker-invocation.js';
import { workerInputSchema, workerOutputSchema } from '../../fixtures/ralph-worker-protocol.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(processing = 'remote') {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-local-only-'));
  roots.push(root);
  const work = path.join(root, '.aiwg', 'working', 'worktrees', 'worker');
  await mkdir(work, { recursive: true });
  await writeFile(path.join(root, 'brief.md'), 'Synthetic bounded task.');
  const { snapshot, drivers } = await loadWorkerInputs({ cwd: root });
  snapshot.models.defaults.workerSelection.dataPolicy.localOnlyPaths = ['eval-work/local.txt', 'private-inputs'];
  const row = snapshot.catalog.discovery.instances.codex.models[0];
  row.worker.dataUse.processing = processing;
  const registry = createInvocationRegistry();
  const launch = vi.fn(async (_invocation: any) => ({ launched: false, diagnostic: 'FAKE_WORKER_REACHED' }));
  const callMcp = vi.fn(async () => ({ outcome: 'blocked', diagnostic: 'FAKE_MCP_REACHED', dispatchState: 'never-began' }));
  const tools = new Map<string, any>();
  const register = async (options = {}) => registerWorkerInvokeToolset({
    registerTool(name, _schema, handler) { tools.set(name, handler); },
  }, { projectRoot: root, registry, scopedBreaker: null, ensureWorkerContext: false,
    loadWorkerInputs: async () => ({ snapshot, drivers }), launchShellWorker: launch, callMcpWorker: callMcp,
    ...options });
  const input = { operation: 'run', request_id: 'synthetic-local-only', role: 'coding', task: 'implementation', group: 'workers',
    transport: 'shell', brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, 'claims.json') };
  const run = async () => {
    const response = await tools.get('worker-invoke')(input);
    return JSON.parse(response.content[0].text);
  };
  const invocation = { selected: { cli: 'codex', model: row.id, inferenceProvider: row.llmProvider }, cwd: work, transport: 'shell' };
  return { root, work, snapshot, drivers, row, registry, launch, callMcp, register, input, run, invocation };
}

async function addInput(tree: string) {
  await mkdir(path.join(tree, 'eval-work'), { recursive: true });
  await writeFile(path.join(tree, 'eval-work/local.txt'), 'synthetic-private-content-never-in-diagnostic');
}

async function mcpFixture(processing: string) {
  const f = await fixture(processing);
  f.input.transport = 'mcp';
  f.snapshot.config.parallelism.groups.workers.execution = { transport: 'mcp' };
  const driver = f.drivers.codex;
  const adapter = driver.qualification.adapter;
  adapter.qualification.evidenceRef = 'fixture:synthetic-only';
  const profile = adapter.invocationProfiles['fixture-shell'];
  profile.transport = 'mcp';
  profile.mcp = { serverRef: 'fake-server', tool: 'fixture-worker', inputSchemaDigest: mcpToolSchemaDigest(workerInputSchema),
    outputSchemaDigest: mcpToolSchemaDigest(workerOutputSchema), sessionIsolation: 'per-call', cancel: 'uncertain' };
  f.snapshot.installations.codex.mcp = profile.mcp;
  driver.qualification.mcp = profile.mcp;
  driver.qualification.mcpSchemas = { input: workerInputSchema, output: workerOutputSchema };
  driver.mcpRegistry = { get: async () => ({ name: 'fake-server', type: 'stdio', command: 'fixture-only' }) };
  driver.mcpProfile = { servers: ['fake-server'] };
  driver.buildInvocation = async input => ({ mcp: { serverRef: profile.mcp.serverRef, tool: profile.mcp.tool,
    inputSchemaDigest: profile.mcp.inputSchemaDigest, outputSchemaDigest: profile.mcp.outputSchemaDigest,
    sessionIsolation: profile.mcp.sessionIsolation, timeoutSeconds: 30,
    arguments: { invocationId: 'fixture-task', workspace: input.cwd,
      selection: { provider: input.selected.inferenceProvider, model: input.selected.model, effort: input.selected.effort.value },
      brief: input.brief } } });
  // A misleading class label must never qualify a remote observation as local.
  f.snapshot.models.defaults.workerSelection.dataClasses = { 'local-only': {} };
  const plan = await resolveWorkerInvocation(f.snapshot, f.input as any, f.drivers);
  expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
  const inv = plan.invocation!;
  await writeFile(f.input.brief, JSON.stringify({ version: 1, mode: 'direct', invocationId: 'fixture-brief',
    intent: { version: 1, taskId: 'fixture-task', requestId: 'fixture-request', objective: 'Synthetic local-only preflight',
      taskClass: f.input.task, role: f.input.role, group: f.input.group, dataClass: 'local-only',
      inputs: [], ownership: [], requiredTools: [], pins: { member: inv.selected.member, model: inv.selected.model, effort: inv.selected.effort },
      allowFallback: false, limits: inv.limits, acceptance: [{ id: 'AC1', criterion: 'No exposure', checkRef: 'protected:fixture' }],
      verification: { runnerRef: null, independentReview: 'advisory', differentFamily: 'prefer', controlledContext: 'fixture-only' } },
    intentDigest: digest('fixture'), policyDigest: inv.policyDigest, catalogDigest: inv.catalogDigest, selected: inv.selected,
    workspace: { path: f.work, baseRevision: null }, authorizationRefs: [], delegationAllowance: 0,
    output: { schemaRef: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerClaims', resultPath: f.input.final_output } }));
  return f;
}

describe('T-OG-17 worker local-only preflight', () => {
  it('blocks a cloud tuple before fake dispatch and releases capacity and output', async () => {
    const f = await fixture();
    await addInput(f.work);
    await mkdir(path.join(f.work, 'private-inputs'));
    await f.register();
    const result = await f.run();
    expect(result).toMatchObject({ status: 'blocked', termination: 'confirmed', diagnostics: [{
      code: 'LOCAL_ONLY_PATH_EXPOSED', paths: ['eval-work/local.txt', 'private-inputs'],
    }] });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-content');
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.callMcp).not.toHaveBeenCalled();
    expect(f.registry.canStart()).toBe(true);
    await expect(access(f.input.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks the tree after the launcher context preparation adds an input', async () => {
    const f = await fixture();
    const ensure = vi.fn(async () => addInput(f.work));
    await f.register({ ensureWorkerContext: ensure });
    const result = await f.run();
    expect(ensure).toHaveBeenCalledOnce();
    expect(result.diagnostics[0].code).toBe('LOCAL_ONLY_PATH_EXPOSED');
    expect(f.launch).not.toHaveBeenCalled();
  });

  it.each(['remote', 'local'])('checks %s MCP tuples before the fake worker call', async processing => {
    const f = await mcpFixture(processing);
    await addInput(f.work);
    await f.register();
    const result = await f.run();
    if (processing === 'remote') {
      expect(result.diagnostics[0]).toMatchObject({ code: 'LOCAL_ONLY_PATH_EXPOSED', paths: ['eval-work/local.txt'] });
      expect(f.callMcp).not.toHaveBeenCalled();
    } else {
      expect(f.callMcp).toHaveBeenCalledOnce();
      expect(result.diagnostics).toContain('FAKE_MCP_REACHED');
    }
    expect(f.launch).not.toHaveBeenCalled();
  });

  it.each(['ollama', 'lmstudio'])('allows a qualified local %s tuple with a listed path', async provider => {
    const f = await fixture('local');
    f.row.llmProvider = provider;
    await addInput(f.work);
    await f.register();
    const result = await f.run();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.launch.mock.calls[0][0].selected.inferenceProvider).toBe(provider);
    expect(result.diagnostics).toContain('FAKE_WORKER_REACHED');
  });

  it.each(['absent', 'unset', 'outside'])('allows a remote tuple when declared paths are %s from its tree', async kind => {
    const f = await fixture();
    if (kind === 'unset') {
      delete f.snapshot.models.defaults.workerSelection.dataPolicy.localOnlyPaths;
      await addInput(f.work);
    }
    if (kind === 'outside') await addInput(f.root);
    await f.register();
    const result = await f.run();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(result.diagnostics).toContain('FAKE_WORKER_REACHED');
  });

  it('does not accept an empty class named local-only as locality evidence', async () => {
    const f = await fixture();
    f.snapshot.models.defaults.workerSelection.dataClasses = { 'local-only': {} };
    await addInput(f.work);
    await f.register();
    expect((await f.run()).diagnostics[0].code).toBe('LOCAL_ONLY_PATH_EXPOSED');
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('collects group, template and named-class declarations regardless of the selected class', async () => {
    const f = await fixture();
    delete f.snapshot.models.defaults.workerSelection.dataPolicy.localOnlyPaths;
    f.snapshot.models.defaults.workerSelection.dataClasses = { private: { localOnlyPaths: ['eval-work/local.txt'] } };
    f.snapshot.config.parallelism.groups.workers.dataPolicy = { localOnlyPaths: ['private-inputs'] };
    f.snapshot.config.parallelism.groupTemplates = { extra: { dataPolicy: { localOnlyPaths: ['template-input'] } } };
    await addInput(f.work);
    await mkdir(path.join(f.work, 'private-inputs'));
    await writeFile(path.join(f.work, 'template-input'), 'synthetic');
    const result = await workerLocalOnlyPreflight({ ...f, invocation: f.invocation });
    expect(result?.paths).toEqual(['eval-work/local.txt', 'private-inputs', 'template-input']);
  });

  it('covers a workdir nested inside a declared project subtree and its symlink spelling', async () => {
    const f = await fixture();
    f.snapshot.models.defaults.workerSelection.dataPolicy.localOnlyPaths = ['.aiwg/working/worktrees'];
    expect((await workerLocalOnlyPreflight(f))?.code).toBe('LOCAL_ONLY_PATH_EXPOSED');
    await symlink(path.join(f.root, '.aiwg/working/worktrees'), path.join(f.root, 'alias'));
    f.snapshot.models.defaults.workerSelection.dataPolicy.localOnlyPaths = ['alias'];
    expect((await workerLocalOnlyPreflight(f))?.paths).toEqual(['alias']);
  });

  it('checks the MCP server workdir as well as the invocation workdir', async () => {
    const f = await fixture();
    const serverTree = path.join(f.root, 'server-tree');
    await addInput(serverTree);
    const invocation = { ...f.invocation, transport: 'mcp', mcp: { serverRef: 'fake-server' } };
    const drivers = { codex: { mcpRegistry: { get: vi.fn(async () => ({ cwd: serverTree })) } } };
    expect((await workerLocalOnlyPreflight({ ...f, invocation, drivers }))?.paths).toEqual(['eval-work/local.txt']);
    expect(drivers.codex.mcpRegistry.get).toHaveBeenCalledWith('fake-server');
  });

  it('detects symlink aliases in the readable tree without following directory cycles', async () => {
    const f = await fixture();
    await addInput(f.root);
    await symlink(f.work, path.join(f.work, 'cycle'));
    await mkdir(path.join(f.work, 'nested'));
    await symlink(path.join(f.root, 'eval-work'), path.join(f.work, 'nested', 'shared'));
    expect((await workerLocalOnlyPreflight(f))?.paths).toEqual(['eval-work/local.txt']);
  });

  it('checks planned workspace artifacts before they are materialized', async () => {
    const f = await fixture();
    const invocation = { ...f.invocation, artifacts: [{ location: 'workspace-relative', relativePath: 'private-inputs/brief.txt' }] };
    expect((await workerLocalOnlyPreflight({ ...f, invocation }))?.paths).toEqual(['private-inputs']);
  });

  it.each(['unknown', 'unqualified'])('requires qualified local facts rather than %s evidence', async kind => {
    const f = await fixture(kind === 'unknown' ? 'unknown' : 'local');
    if (kind === 'unqualified') f.row.worker.qualification.status = 'unqualified';
    await addInput(f.work);
    expect((await workerLocalOnlyPreflight(f))?.code).toBe('LOCAL_ONLY_PATH_EXPOSED');
  });
});
