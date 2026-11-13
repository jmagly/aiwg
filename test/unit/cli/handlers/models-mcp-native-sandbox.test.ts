// Native sandbox groups must be rejected before an MCP invocation is rendered.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createModelsHandler } from '../../../../src/cli/handlers/models.js';
import { WORKER_OPERATOR_APPROVAL } from '../../../../src/models/provider-policy.js';
import { resolveWorkerPlan } from '../../../../src/models/worker-plan.js';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('T-OG-17 excludes a native-sandbox Codex group from models resolve --transport mcp with actionable policy location', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-mcp-native-')); roots.push(root);
  const workdir = path.join(root, 'work'); await mkdir(workdir);
  const brief = path.join(root, 'brief'); await writeFile(brief, 'Synthetic task.');
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.groups!.workers.execution = {
    launchMode: 'native-sandbox', transport: 'shell', sandbox: 'workspace-write', approval: 'never', network: 'deny',
  };
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.provider = 'codex'; adapter.qualification.evidenceRef = WORKER_OPERATOR_APPROVAL;
  const buildInvocation = vi.fn(async () => { throw new Error('Excluded group must never reach its CLI/MCP driver'); });
  const handler = createModelsHandler({ load: async () => ({ snapshot: f.snapshot, drivers: {
    codex: { qualification: { adapter, cliVersion: '1.0.0' }, buildInvocation },
  } }), now: () => f.request.now });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const result = await handler.execute({ args: ['resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
    '--brief', brief, '--workdir', workdir, '--final-output', path.join(workdir, 'final.json'), '--transport', 'mcp', '--json'],
  rawArgs: ['models', 'resolve'], cwd: root, frameworkRoot: root });
  const plan = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(result.exitCode).toBe(2);
  expect(plan.status).toBe('blocked');
  expect(plan.selected).toBeNull();
  expect(plan.eligible).toEqual([]);
  expect(plan.invocation).toBeUndefined();
  expect(plan.exclusions).toHaveLength(2);
  expect(plan.diagnostics).toContainEqual({ code: 'OG_POLICY_RELAXATION',
    pointer: '/parallelism/groups/workers/execution/launchMode',
    message: expect.stringMatching(/--transport mcp selects an MCP-server worker.*native-sandbox.*--transport shell.*worker-invoke transport "shell".*systemd-unit/),
  });
  expect(buildInvocation).not.toHaveBeenCalled();
  expect(resolveWorkerPlan(f.snapshot, { ...f.request, transport: 'shell' }).status).toBe('eligible');
});

it('T-OG-17 skips native-sandbox groups without blocking another eligible MCP group', () => {
  const f = workerResolutionFixture();
  const native = structuredClone(f.snapshot.config.parallelism!.groups!.workers);
  native.execution = { launchMode: 'native-sandbox', transport: 'shell', sandbox: 'workspace-write' };
  f.snapshot.config.parallelism!.groups!.native = native;
  f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.groups.unshift('native');
  const profile = f.snapshot.registry.providers.codex.workerAdapter!.invocationProfiles!['fixture-shell'];
  profile.transport = 'mcp';
  profile.mcp = { serverRef: 'fixture', tool: 'worker', inputSchemaDigest: `sha256:${'a'.repeat(64)}`,
    outputSchemaDigest: `sha256:${'b'.repeat(64)}`, sessionIsolation: 'per-call', cancel: 'uncertain' };
  f.snapshot.installations.codex.mcp = profile.mcp;
  f.snapshot.config.parallelism!.groups!.workers.execution = { transport: 'mcp' };
  const plan = resolveWorkerPlan(f.snapshot, { ...f.request, transport: 'mcp' });
  expect(plan.status, JSON.stringify(plan)).toBe('eligible');
  expect(plan.selected?.group).toBe('workers');
  expect(plan.exclusions.some(row => row.group === 'native'
    && row.diagnostics.some(reason => reason.pointer === '/parallelism/groups/native/execution/launchMode'))).toBe(true);
});
