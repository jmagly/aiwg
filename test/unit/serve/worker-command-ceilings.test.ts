// Verifies CLI ceilings through synthetic shell/MCP rendering and saved-plan revalidation.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsHandler } from '../../../src/cli/handlers/models.js';
import { mcpToolSchemaDigest, parseWorkerCommandArgs, resolveWorkerInvocation,
  revalidateWorkerInvocationPlan, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerInputSchema } from '../../fixtures/ralph-worker-protocol.mjs';
import { fixtureJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(transport: 'shell' | 'mcp' = 'shell') {
  const f = workerResolutionFixture();
  const root = await mkdtemp(join(tmpdir(), 'aiwg-task-ceilings-')); roots.push(root);
  const brief = join(root, 'brief.txt');
  await writeFile(brief, 'Synthetic bounded task.');
  f.snapshot.config.parallelism!.budgets = { perTask: { tokens: 5000, costUsd: 2, wallSeconds: 60 } };
  f.snapshot.config.parallelism!.groups!.workers.execution = { transport };
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const profile = adapter.invocationProfiles!['fixture-shell'];
  profile.transport = transport;
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  const binding = f.snapshot.installations.codex;
  binding.boundary = { kind: 'os', identity: 'fixture:boundary',
    digest: mcpToolSchemaDigest({ synthetic: true }), controls: ['sandbox'] };
  const inputSchema = { ...workerInputSchema, properties: { ...workerInputSchema.properties,
    limits: { type: 'object', additionalProperties: false, required: ['tokens', 'costUsd', 'wallSeconds', 'maxAttempts'],
      properties: { tokens: { type: 'integer' }, costUsd: { type: ['number', 'null'] },
        wallSeconds: { type: 'integer' }, maxAttempts: { type: 'integer' } } } } };
  const outputSchema = { type: 'object' };
  if (transport === 'mcp') {
    profile.mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: mcpToolSchemaDigest(inputSchema),
      outputSchemaDigest: mcpToolSchemaDigest(outputSchema), sessionIsolation: 'per-call', cancel: 'uncertain' };
    binding.mcp = profile.mcp;
  }
  const buildInvocation = vi.fn<WorkerInvocationDriver['buildInvocation']>(async input => transport === 'shell' ? {
    argv: [process.execPath, resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', input.selected.model,
      '--final-output', input.finalPath, '--max-attempts', String(input.limits.maxAttempts),
      '--max-output-tokens', String(input.limits.tokens), '--max-usd', String(input.limits.costUsd),
      '--timeout-ms', String(input.limits.wallSeconds * 1000)], stdin: 'brief-text', envNames: profile.envAllowlist,
  } : { mcp: { serverRef: profile.mcp!.serverRef, tool: profile.mcp!.tool,
    inputSchemaDigest: profile.mcp!.inputSchemaDigest, outputSchemaDigest: profile.mcp!.outputSchemaDigest,
    sessionIsolation: profile.mcp!.sessionIsolation, arguments: { invocationId: 'synthetic-task', workspace: input.cwd,
    selection: { provider: input.selected.inferenceProvider, model: input.selected.model, effort: input.selected.effort.value },
    brief: input.brief, limits: input.limits }, timeoutSeconds: input.limits.wallSeconds } });
  const drivers: Record<string, WorkerInvocationDriver> = { codex: { qualification: {
    adapter, adapterId: adapter.id, cliVersion: binding.cliVersion, boundary: binding.boundary,
    ...(transport === 'mcp' ? { mcp: binding.mcp, mcpSchemas: { input: inputSchema, output: outputSchema } } : {}),
  }, buildInvocation, mcpRegistry: { get: async name => ({ name, type: 'stdio', command: 'fixture-only' }) },
    mcpProfile: { servers: ['fixture-server'] } } };
  const args = ['--role=coding', '--task=implementation', '--group=workers', `--brief=${brief}`,
    `--workdir=${root}`, `--final-output=${join(root, 'final.json')}`, `--transport=${transport}`];
  const request = parseWorkerCommandArgs(args);
  const load = vi.fn(async () => ({ snapshot: f.snapshot, drivers }));
  const handler = createModelsHandler({ load, now: () => f.request.now });
  const call = async (extra: string[] = []) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const argv = ['resolve', ...args, ...extra];
    const result = await handler.execute({ args: argv, rawArgs: ['models', ...argv], cwd: root, frameworkRoot: process.cwd() });
    const output = String(log.mock.calls.at(-1)?.[0] ?? err.mock.calls.at(-1)?.[0] ?? '');
    log.mockRestore(); err.mockRestore();
    return { result, output };
  };
  return { ...f, now: f.request.now, root, args, request, drivers, buildInvocation, call, load };
}

const flags = ['--max-attempts=2', '--timeout-ms=20000', '--max-output-tokens=1000', '--max-usd=0.5'];
const tightened = { maxAttempts: 2, wallSeconds: 20, tokens: 1000, costUsd: 0.5 };

describe('T-OG-15 per-task ceiling commands (#3701)', () => {
  it.each(['shell', 'mcp'] as const)('%s renders, saves, reloads and revalidates tightened ceilings', async transport => {
    const f = await fixture(transport);
    const { result, output } = await f.call(flags);
    expect(result.exitCode, JSON.stringify(JSON.parse(output).diagnostics)).toBe(0);
    const plan = JSON.parse(output);
    expect(plan.request.ceilings).toEqual(tightened);
    expect(plan.ceilings).toEqual(tightened);
    expect(plan.invocation.limits).toEqual(tightened);
    expect(plan.invocation.health.hardTimeoutSeconds).toBe(20);
    expect(plan.invocation.health.origins.hardTimeoutSeconds).toContain('/request/ceilings/wallSeconds');
    for (const key of Object.keys(tightened)) expect(plan.origins[`/ceilings/${key}`][0].pointer).toBe(`/request/ceilings/${key}`);
    if (transport === 'shell') {
      expect(plan.invocation.shellCommand).toContain("timeout --signal=KILL '20s'");
      for (const [key, value] of [['max-attempts', 2], ['timeout-ms', 20000], ['max-output-tokens', 1000], ['max-usd', 0.5]]) {
        expect(plan.invocation.shellCommand).toContain(`'--${key}' '${value}'`);
      }
      expect((await f.call([...flags, '--format=shell'])).output).toBe(plan.invocation.shellCommand);
    } else {
      expect(plan.invocation.mcp.arguments.limits).toEqual(tightened);
      expect(plan.invocation.mcp.timeoutSeconds).toBe(20);
    }
    const filename = join(f.root, 'plan.json');
    await writeFile(filename, output);
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    expect(await revalidateWorkerInvocationPlan(saved, f.snapshot, f.drivers, f.now)).toEqual(plan.invocation);
    const tampered = structuredClone(saved);
    tampered.invocation.limits.tokens++;
    await expect(revalidateWorkerInvocationPlan(tampered, f.snapshot, f.drivers, f.now))
      .rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
    // A plan resolved under another project configuration says how to recover (#2918 direct-02, #4125).
    const otherProject = structuredClone(saved);
    otherProject.digests.resolvedModelsDigest = `sha256:${'0'.repeat(64)}`;
    await expect(revalidateWorkerInvocationPlan(otherProject, f.snapshot, f.drivers, f.now))
      .rejects.toMatchObject({ code: 'OG_PIN_MISMATCH', message: expect.stringContaining('resolve again from the conductor project directory you launch from') });
    saved.request.ceilings.tokens = 5001;
    await expect(revalidateWorkerInvocationPlan(saved, f.snapshot, f.drivers, f.now))
      .rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
  });

  it.each([['--max-attempts=4', 'maxAttempts', 4, 3], ['--timeout-ms=61000', 'wallSeconds', 61, 60],
    ['--max-output-tokens=5001', 'tokens', 5001, 5000], ['--max-usd=3', 'costUsd', 3, 2]] as const)(
    'refuses %s with a typed field/value diagnostic before rendering', async (flag, key, requested, resolved) => {
      const f = await fixture();
      const { result, output } = await f.call([flag]);
      expect(result.exitCode).toBe(2);
      expect(f.buildInvocation).not.toHaveBeenCalled();
      expect(JSON.parse(output).diagnostics).toContainEqual({ code: 'OG_POLICY_RELAXATION',
        pointer: `/request/ceilings/${key}`,
        message: `Requested ${key} ceiling ${requested} exceeds resolved policy ceiling ${resolved}.` });
    });

  it.each(['--max-attempts=0', '--max-attempts=1.1', '--max-attempts=9007199254740992', '--timeout-ms=0',
    '--timeout-ms=1500', '--max-output-tokens=-1', '--max-output-tokens=NaN', '--max-usd=Infinity', '--max-usd=-0.01', '--max-usd= '])(
    'rejects invalid numeric syntax before loading installations: %s', async flag => {
      const f = await fixture();
      const { result, output } = await f.call([flag]);
      expect(result.exitCode).toBe(2);
      expect(f.load).not.toHaveBeenCalled();
      expect(JSON.parse(output).diagnostics[0]).toMatchObject({ code: 'OG_CONFIG_REFERENCE',
        pointer: expect.stringMatching(/^\/request\/ceilings\//) });
    });

  it('accepts split flag values and zero cost, and rejects duplicate ceilings', async () => {
    const f = await fixture();
    expect(parseWorkerCommandArgs([...f.args, '--max-attempts', '1', '--max-usd', '0']).ceilings)
      .toEqual({ maxAttempts: 1, costUsd: 0 });
    expect(() => parseWorkerCommandArgs([...f.args, '--max-attempts=1', '--max-attempts', '2'])).toThrow('Duplicate');
  });

  it('caller ceilings intersect a structured brief and survive its revalidation', async () => {
    const f = await fixture();
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.contextTokens = 20000;
    f.snapshot.models.defaults.workerSelection!.dataClasses = { 'fixture-data': {} };
    const initial = JSON.parse((await f.call()).output);
    const brief = structuredClone(fixtureJson('mission-vectors.json').find((row: any) => row.id === 'direct-brief-no-lease').value);
    Object.assign(brief.intent, { role: 'coding', taskClass: 'implementation', group: 'workers', dataClass: 'fixture-data',
      limits: { tokens: 2000, costUsd: 1, wallSeconds: 30, maxAttempts: 3 } });
    Object.assign(brief, { selected: initial.invocation.selected, policyDigest: initial.invocation.policyDigest,
      catalogDigest: initial.invocation.catalogDigest, intentDigest: workerConfigDigest(brief.intent) });
    brief.workspace.path = f.root;
    brief.output.resultPath = f.request.final_output;
    await writeFile(f.request.brief, JSON.stringify(brief));
    const { result, output } = await f.call(flags);
    const plan = JSON.parse(output);
    expect(result.exitCode, JSON.stringify(plan.diagnostics)).toBe(0);
    expect(plan.ceilings).toEqual(tightened);
    expect(await revalidateWorkerInvocationPlan(plan, f.snapshot, f.drivers, f.now)).toEqual(plan.invocation);
    const loosened = JSON.parse((await f.call(['--max-output-tokens=2001'])).output);
    expect(loosened.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_POLICY_RELAXATION',
      pointer: '/request/ceilings/tokens', message: 'Requested tokens ceiling 2001 exceeds resolved policy ceiling 2000.' }));
  });

  it('compares a requested hard stop with the selected MCP transport deadline', async () => {
    const f = await fixture('mcp');
    const build = f.buildInvocation.getMockImplementation()!;
    f.buildInvocation.mockImplementation(async input => {
      const rendered = await build(input);
      rendered.mcp!.timeoutSeconds = Math.min(input.limits.wallSeconds, 10);
      return rendered;
    });
    const { result, output } = await f.call(['--timeout-ms=20000']);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(output).diagnostics).toContainEqual({ code: 'OG_POLICY_RELAXATION',
      pointer: '/request/ceilings/wallSeconds', message: 'Requested wallSeconds ceiling 20 exceeds resolved policy ceiling 10.' });
    expect((await f.call(['--timeout-ms=5000'])).result.exitCode).toBe(0);
  });

  it('the copied shell command hard-stops a hanging fake CLI', async () => {
    const f = await fixture();
    const config = join(f.root, 'fake.json');
    await writeFile(config, JSON.stringify({ scenario: 'hang', recordPath: join(f.root, 'record.json') }));
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', config);
    const { result, output } = await f.call(['--timeout-ms=1000', '--format=shell']);
    expect(result.exitCode, output).toBe(0);
    const stopped = promisify(execFile)('/bin/sh', ['-c', output], { timeout: 5000, env: { AIWG_FAKE_WORKER_CONFIG: config } });
    await expect(stopped).rejects.toMatchObject({ killed: false });
    await stopped.catch(error => expect([124, 137]).toContain(error.code));
    expect(JSON.parse(await readFile(join(f.root, 'record.json'), 'utf8')).scenario).toBe('hang');
  });

  it('help documents flag units, attempt semantics, origins and tightening-only behavior', async () => {
    const f = await fixture();
    const { result, output } = await f.call(['--help']);
    expect(result.exitCode).toBe(0);
    for (const text of ['--max-attempts', '--timeout-ms', '--max-output-tokens', '--max-usd', 'initial attempt',
      'hard stop', 'whole seconds', 'task token budget', 'larger values fail', 'origins']) expect(output).toContain(text);
    expect(f.load).not.toHaveBeenCalled();
  });
});
