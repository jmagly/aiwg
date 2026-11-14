import { copyNode } from '../../../helpers/copy-node.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsHandler, modelsHandler } from '../../../../src/cli/handlers/models.js';
import { parseWorkerCommandArgs, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../../src/serve/worker-invocation.js';
import { qualifyWorkerInvocationProfile, requiredWorkerControls, WorkerPolicyError } from '../../../../src/models/provider-policy.js';
import { ProviderAdapter, workerNegativeFixtureDigest, workerNegativeFixtureSuite } from '../../../../tools/ralph-external/lib/provider-adapter.mjs';
import { McpServerRegistry, workerServerDigest } from '../../../../src/mcp/registry.js';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';
import { fixtureJson } from '../../../conformance/mission-v1/worker-contract-fixtures.js';
import { workerInputSchema } from '../../../fixtures/ralph-worker-protocol.mjs';
import { main as configMain } from '../../../../src/config/cli.js';
import { readAiwgConfig, workerActivationDigests, workerConfigDigest } from '../../../../src/config/aiwg-config.js';
import { bindManagedAdmissionPolicy, FileAdmissionStore, managedProjectAdmissionPolicy, projectAdmissionAuthority, SharedHostScheduler } from '../../../../src/serve/shared-host-scheduler.js';

const roots: string[] = [];
const digest = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;
const execute = promisify(execFile);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(provider = 'codex', transport: 'shell' | 'mcp' = 'shell', explicitProfile = false) {
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-direct-')); roots.push(root);
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value`;
  const brief = path.join(root, "brief '雪\n.md");
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  await writeFile(brief, payload);
  await mkdir(path.join(root, '.aiwg'));
  await writeFile(path.join(root, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
  await writeFile(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: f.projectPolicy } }));
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.id = provider;
  if (f.snapshot.registry.providers[provider]) f.snapshot.registry.providers[provider].workerAdapter = adapter;
  else {
    f.snapshot.registry.workerAdapters = { [provider]: adapter };
    f.snapshot.config.parallelism!.clis = { [provider]: { adapter: `workerAdapters:${provider}`, accountScope: 'synthetic', quotaScope: 'fixture' } };
  }
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(m => { m.cli = provider; });
  f.snapshot.config.parallelism!.groups!.workers.execution = { transport };
  if (provider !== 'codex') delete f.snapshot.registry.providers.codex.workerAdapter;
  const binding = f.snapshot.installations.codex;
  binding.boundary = { kind: 'os', identity: 'fixture:enforcing-boundary', digest: digest('boundary'), controls: ['sandbox'] };
  f.snapshot.installations = { [provider]: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = provider;
  discovery.models.forEach(row => { row.worker!.cliId = provider; });
  f.snapshot.catalog.discovery!.instances = { [provider]: discovery };
  const profile = adapter.invocationProfiles![binding.profile];
  if (explicitProfile) {
    adapter.invocationProfiles = { 'direct-shell': profile };
    binding.profile = 'direct-shell';
    f.snapshot.config.parallelism!.clis = { [provider]: {
      adapter: `providers:${provider}`, accountScope: binding.accountScope, quotaScope: 'fixture',
      invocationProfile: 'direct-shell',
    } };
  }
  profile.transport = transport;
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  const inputSchema = structuredClone(workerInputSchema);
  const outputSchema = { type: 'object' };
  if (transport === 'mcp') {
    profile.mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: digest(inputSchema),
      outputSchemaDigest: digest(outputSchema), sessionIsolation: 'per-call', cancel: 'uncertain' };
    binding.mcp = profile.mcp;
  }
  const buildInvocation = vi.fn(async (input: Parameters<WorkerInvocationDriver['buildInvocation']>[0]) => transport === 'shell' ? {
    argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', input.selected.model,
      '--effort', input.selected.effort.value!, '--sandbox', input.permissions.sandbox!, '--approval', input.permissions.approval!,
      '--final-output', input.finalPath, '--', payload], stdin: 'brief-text' as const, envNames: profile.envAllowlist,
  } : { mcp: { serverRef: profile.mcp!.serverRef, tool: profile.mcp!.tool, inputSchemaDigest: profile.mcp!.inputSchemaDigest, outputSchemaDigest: profile.mcp!.outputSchemaDigest, sessionIsolation: profile.mcp!.sessionIsolation, arguments: { invocationId: 'fixture-task', workspace: input.cwd,
    selection: { provider: input.selected.inferenceProvider, model: input.selected.model, effort: input.selected.effort.value },
    brief: input.brief }, timeoutSeconds: input.limits.wallSeconds } });
  const drivers: Record<string, WorkerInvocationDriver> = { [provider]: { qualification: {
    adapter, adapterId: provider, cliVersion: '1.0.0', boundary: binding.boundary,
    ...(transport === 'mcp' ? { mcp: binding.mcp, mcpSchemas: { input: inputSchema, output: outputSchema } } : {}),
  }, buildInvocation, mcpRegistry: { get: async name => ({ name, type: 'stdio', command: 'fixture-only' }) },
    mcpProfile: { servers: ['fixture-server'] } } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport };
  const handler = createModelsHandler({ load: async () => ({ snapshot: f.snapshot, drivers }), now: () => f.request.now });
  const call = async (format = 'json', extra: string[] = []) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = ['resolve', ...Object.entries(request).map(([k, v]) => `--${k.replace('_', '-')}=${v}`),
      ...(format === 'alias' ? ['--json'] : [`--format=${format}`]), ...extra];
    const result = await handler.execute({ args, rawArgs: ['models', ...args], cwd: root, frameworkRoot: process.cwd() });
    const stdout = String(log.mock.calls.at(-1)?.[0] ?? '');
    const stderr = String(err.mock.calls.at(-1)?.[0] ?? '');
    const output = stdout || stderr; log.mockRestore(); err.mockRestore();
    return { result, output, stdout, stderr, plan: format === 'shell' && result.exitCode === 0 && transport === 'shell' ? null : JSON.parse(output) };
  };
  await writeFile(path.join(root, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
  return { ...f, now: f.request.now, root, payload, request, drivers, adapter, binding, profile, call, buildInvocation };
}

describe('T-OG-12 managed operator rollback to direct', () => {
  it('restores the exact direct command through the documented config setter without managed prerequisites', async () => {
    const f = await fixture();
    vi.stubEnv('AIWG_CONFIG', path.join(f.root, 'user-config'));
    vi.stubEnv('AIWG_ARTIFACTS_PATH', path.join(f.root, 'artifacts'));
    await mkdir(path.join(f.root, 'artifacts'));
    const direct = (await f.call('shell')).stdout;
    await configMain(['set', '--project', '--target', f.root, 'parallelism.worker_mode', 'managed']);
    f.snapshot.config = (await readAiwgConfig(f.root))!;
    expect((await f.call()).result.exitCode).toBe(2);
    await configMain(['set', '--project', '--target', f.root, 'parallelism.worker_mode', 'direct']);
    f.snapshot.config = (await readAiwgConfig(f.root))!;
    expect((await f.call('shell')).stdout).toBe(direct);
    expect(f.snapshot.config.parallelism!.worker_dispatch).toBe(true);
    await expect(readFile(projectAdmissionAuthority(f.root).path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(path.join(f.root, 'artifacts/aiwg.config'), 'utf8')).parallelism.worker_mode).toBe('direct');
  });

  it('preserves uncertain reservations and evidence when dispatch is disabled and direct mode is restored', async () => {
    const f = await fixture();
    vi.stubEnv('AIWG_CONFIG', path.join(f.root, 'user-config'));
    vi.stubEnv('AIWG_ARTIFACTS_PATH', path.join(f.root, 'artifacts'));
    f.snapshot.config.parallelism!.worker_mode = 'managed';
    f.snapshot.config.parallelism!.clis = { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'synthetic' } };
    f.snapshot.config.parallelism!.activation = { revision: 1, ...workerActivationDigests(f.snapshot.config), ...f.snapshot.modelDigests,
      snapshotRef: 'fixture:rollback' };
    await writeFile(path.join(f.root, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
    const policy = managedProjectAdmissionPolicy(f.root, f.snapshot.config.parallelism!, workerConfigDigest(f.snapshot.config.parallelism!.activation), 1);
    const authorityPath = projectAdmissionAuthority(f.root).path;
    const store = new FileAdmissionStore(authorityPath);
    bindManagedAdmissionPolicy(store, policy);
    const scheduler = new SharedHostScheduler(store, policy);
    scheduler.submit({ requestId: 'uncertain-writer', orchestratorId: 'synthetic', environment: 'synthetic', provider: 'codex',
      runtimeKind: 'host', priority: 1, submittedAt: new Date().toISOString(), queueTimeoutMs: 60000, managed: { kind: 'native' } });
    scheduler.stop('uncertain-writer', 1, 'disconnect');
    const before = await readFile(authorityPath, 'utf8');
    await configMain(['set', '--project', '--target', f.root, 'parallelism.worker_dispatch', 'false']);
    await configMain(['set', '--project', '--target', f.root, 'parallelism.worker_mode', 'direct']);
    expect(await readFile(authorityPath, 'utf8')).toBe(before);
    expect(store.read().records['uncertain-writer']!.state).toBe('uncertain');
    // Configuration rollback never turns the preserved authority into a legacy capacity pool.
    const legacy = new SharedHostScheduler(store, { maxConcurrent: 1, defaultHostQuota: 1, leaseTtlMs: 1000,
      agingIntervalMs: 1000, allowPreemption: false });
    expect(() => legacy.reconcileNow()).toThrow(/binding/);
  });
});

/** Exercise the real #2885 inspector/recheck with frozen synthetic host evidence. */
async function installedFixture(transport: 'shell' | 'mcp' = 'shell', provider = 'codex', explicitProfile = false) {
  const f = await fixture('codex', transport, explicitProfile);
  const initial = (await f.call()).plan;
  if (provider !== 'codex') {
    f.adapter.id = provider;
    if (f.snapshot.registry.providers[provider]) f.snapshot.registry.providers[provider].workerAdapter = f.adapter;
    else {
      f.snapshot.registry.workerAdapters = { [provider]: f.adapter };
      f.snapshot.config.parallelism!.clis = { [provider]: { adapter: `workerAdapters:${provider}`, accountScope: 'synthetic', quotaScope: 'fixture' } };
    }
    delete f.snapshot.registry.providers.codex.workerAdapter;
    f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = provider; });
    f.snapshot.installations = { [provider]: f.binding };
    const discovery = f.snapshot.catalog.discovery!.instances!.codex;
    discovery.provider = provider; discovery.models.forEach(row => { row.worker!.cliId = provider; });
    f.snapshot.catalog.discovery!.instances = { [provider]: discovery };
    f.drivers[provider] = f.drivers.codex; delete f.drivers.codex;
    f.drivers[provider].qualification.adapterId = provider;
  }
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const installationRoot = path.join(f.root, 'installed');
  await mkdir(installationRoot, { mode: 0o755 });
  const executable = await copyNode(installationRoot);
  const source = 'export const interfaceVersion = 1; export function register(factory) {}';
  await writeFile(path.join(installationRoot, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(installationRoot, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
  const cli = path.join(installationRoot, 'ralph-worker-cli.mjs');
  const protocol = path.join(installationRoot, 'ralph-worker-protocol.mjs');
  for (const filename of [cli, protocol]) await writeFile(filename, await readFile(path.resolve('test/fixtures', path.basename(filename))), { mode: 0o644 });
  class InstalledAdapter extends ProviderAdapter {
    getName() { return provider; }
    buildWorkerArgs(input: any, _profile: unknown, permissions: any) { return [cli, '--model', input.selected.model, '--effort', input.selected.effort.value,
      '--sandbox', permissions.sandbox, '--approval', permissions.approval, '--final-output', input.finalPath]; }
  }
  const owner = new InstalledAdapter();
  const permissions = initial.selected.permissions;
  const controls = requiredWorkerControls({ policy: initial.policy, permissions, effort: initial.selected.effort });
  f.binding.boundary!.controls = controls;
  for (const control of Object.values(f.profile.controls)) Object.assign(control, { support: 'external', mapping: 'synthetic host boundary' });
  f.profile.envAllowlist = []; f.adapter.invocation.envAllowlist = [];
  f.adapter.invocation.stdin = 'closed';
  f.adapter.invocation.versionArgv = [cli, '--qualification-version'];
  const registry = new McpServerRegistry(path.join(f.root, 'registry'));
  let serverDigest: string | undefined;
  if (transport === 'mcp') {
    await registry.add({ name: f.profile.mcp!.serverRef, type: 'stdio', command: executable, args: [cli], cwd: f.request.workdir });
    serverDigest = workerServerDigest((await registry.get(f.profile.mcp!.serverRef))!);
    f.drivers[provider].mcpRegistry = registry;
  }
  const installation: any = { adapter: f.adapter, profile: f.binding.profile, cliVersion: '1.0.0',
    policy: initial.policy, permissions, effort: initial.selected.effort, requiredControls: controls,
    executable, cwd: f.request.workdir, workerWritableRoots: [f.request.workdir],
    inputRoots: [f.root], outputRoots: [f.root], boundary: f.binding.boundary,
    effectiveConfigDigest: digest(initial.policy), accountScope: f.binding.accountScope, runtimeFiles: [cli, protocol],
    environment: {}, mcp: f.profile.mcp, mcpServerDigest: serverDigest,
    modules: [{ reference: f.adapter.runtimeDriver, packageRoot: installationRoot, packageName: 'fixture-driver',
      packageVersion: '1.0.0', modulePath: 'driver.mjs', interfaceVersion: 1,
      sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`, adapterIds: [provider], platforms: ['linux'] }] };
  const scope = await owner.inspectWorkerInstallation(installation);
  f.profile.installationQualification = { scopeDigest: scope.scopeDigest, fixtureDigest: await workerNegativeFixtureDigest(),
    verifiedAt: f.now!, evidenceRef: 'fixture:host-negative-evidence' };
  installation.evidence = { ...f.profile.installationQualification,
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(name => [name, 'passed'])) };
  f.drivers[provider].qualification.installation = installation;
  f.drivers[provider].prepareWorkerInvocation = owner.prepareWorkerInvocation.bind(owner);
  if (transport === 'shell') f.drivers[provider].buildInvocation = async input => ({
    argv: [executable, ...owner.buildWorkerArgs(input, f.profile, input.permissions)], stdin: 'closed', envNames: [] });
  if (transport === 'mcp') await registry.recordWorkerQualification(f.profile.mcp!.serverRef, {
    adapter: f.adapter, profile: f.binding.profile, cliVersion: '1.0.0', requiredControls: controls,
    policy: initial.policy, permissions, effort: initial.selected.effort, boundary: f.binding.boundary,
    authorizedServerDigest: serverDigest!, mcp: f.profile.mcp!, installationQualification: {
      ...f.profile.installationQualification, status: 'ENABLED', platform: 'linux', cliVersion: '1.0.0', serverDigest,
    },
  });
  return { ...f, owner, installation, installationRoot, registry };
}

describe('S1 installation owner handoff (T-OG-15/17)', () => {
  it('qualifies its own single-link executable with trusted permissions', async () => {
    const f = await installedFixture();
    const executable = await stat(f.installation.executable);
    expect(f.installation.executable).toBe(path.join(f.installationRoot, 'node'));
    expect(executable.mode & 0o777).toBe(0o755);
    expect(executable.nlink).toBe(1);
    expect((await f.call()).result.exitCode).toBe(0);
  });

  it('renders a nonlaunching plan carrying rechecked installation qualification', async () => {
    const f = await installedFixture();
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.selected.qualificationDigest).toBe(f.installation.evidence.scopeDigest);
    expect(result.plan.invocation.argv).toContain(f.installation.permissions.sandbox);
    expect(result.plan.invocation.argv).toContain(f.installation.permissions.approval);
    await expect(readFile(f.request.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(f.installationRoot, 'driver.mjs'), '// changed');
    const changed = await f.call();
    expect(changed.plan.invocation).toBeUndefined();
    expect(changed.plan.status).toBe('blocked');
  });

  it.each([false, true])('names the qualified workspace check with explicit profile=%s (#3516)', async explicitProfile => {
    const f = await installedFixture('shell', 'codex', explicitProfile);
    const otherWorkdir = path.join(f.request.workdir, 'other-worktree');
    await mkdir(otherWorkdir);
    f.request.workdir = otherWorkdir;
    const result = await f.call();
    expect(result.result.exitCode).toBe(2);
    expect(result.plan.status).toBe('blocked');
    expect(result.plan.selected).toBeNull();
    expect(result.plan.eligible).toContainEqual(expect.objectContaining({
      profile: explicitProfile ? 'direct-shell' : 'fixture-shell', effort: 'medium',
    }));
    expect(result.plan.diagnostics.at(-1)).toEqual({ code: 'OG_CONFIG_REFERENCE',
      pointer: '/request/workdir', reason: 'qualified_workspace_mismatch',
      message: 'Worker workdir differs from the qualified workspace. Use the qualified workspace or run aiwg doctor --probe-workers --qualify from the requested workdir.' });
    expect(result.plan.invocation).toBeUndefined();
    await expect(stat(f.request.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${f.request.final_output}.stdout`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('names the missing installation recheck for an accepted explicit profile (#3516)', async () => {
    const f = await installedFixture('shell', 'codex', true);
    // Both bindings accept direct-shell; tuple eligibility never authorizes a launch.
    const parallelism = f.snapshot.config.parallelism!;
    parallelism.clis!.muse = { ...parallelism.clis!.codex, adapter: 'providers:muse' };
    const museAdapter = structuredClone(f.adapter);
    museAdapter.id = museAdapter.provider = 'muse';
    f.snapshot.registry.providers.muse.workerAdapter = museAdapter;
    f.snapshot.installations.muse = structuredClone(f.binding);
    const museDiscovery = structuredClone(f.snapshot.catalog.discovery!.instances!.codex);
    museDiscovery.provider = 'muse';
    museDiscovery.models.forEach(row => { row.worker!.cliId = 'muse'; });
    f.snapshot.catalog.discovery!.instances!.muse = museDiscovery;
    parallelism.groups!.workers.members.push({ ...parallelism.groups!.workers.members[0], id: 'muse-worker', cli: 'muse' });
    await writeFile(path.join(f.root, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
    delete f.drivers.codex.prepareWorkerInvocation;
    const result = await f.call();
    expect(result.result.exitCode).toBe(2);
    expect(result.plan.status).toBe('blocked');
    expect(result.plan.selected).toBeNull();
    for (const cli of ['codex', 'muse']) for (const effort of ['medium', 'high']) {
      expect(result.plan.eligible).toContainEqual(expect.objectContaining({ cli, profile: 'direct-shell', effort }));
    }
    expect(result.plan.invocation).toBeUndefined();
    expect(result.plan.diagnostics.at(-1)).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED',
      pointer: '/invocation/prepareWorkerInvocation', reason: 'installation_recheck_unavailable' });
    await expect(stat(f.request.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the installation owner and rejects changed argv', async () => {
    const f = await installedFixture();
    const prepare = f.drivers.codex.prepareWorkerInvocation;
    delete f.drivers.codex.prepareWorkerInvocation;
    expect((await f.call()).plan.invocation).toBeUndefined();
    f.drivers.codex.prepareWorkerInvocation = prepare;
    const build = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async input => ({ ...await build(input), argv: [process.execPath, '--eval', 'arbitrary'] });
    const changed = await f.call();
    expect(changed.plan.invocation).toBeUndefined();
    expect(changed.plan.diagnostics.at(-1)).toMatchObject({ code: 'OG_PIN_MISMATCH' });
  });

  it('rechecks MCP descriptors against the qualified installation registration', async () => {
    const f = await installedFixture('mcp');
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.mcp.serverRef).toBe(f.profile.mcp!.serverRef);
    await f.registry.update(f.profile.mcp!.serverRef, { args: ['changed'] });
    const changed = await f.call();
    expect(changed.plan.invocation).toBeUndefined();
    expect(changed.plan.diagnostics.at(-1)).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED' });
  });
});

describe('T-OG-15 models resolve direct invocation', () => {
  it('shell and JSON use one descriptor, preserve all bytes and launch nothing until copied', async () => {
    const f = await fixture();
    const json = await f.call();
    expect(json.result.exitCode, json.output).toBe(0);
    const invocation = json.plan.invocation;
    expect(invocation.selected.effort).toEqual({ support: 'explicit', value: 'medium' });
    expect(invocation.readiness).toBe('launchable');
    const shell = await f.call('shell');
    expect(shell.output).toBe(invocation.shellCommand);
    expect((await f.call('alias')).plan).toEqual(json.plan);
    expect(await readdir(path.join(f.root, '.aiwg'))).toEqual(['aiwg.config']);
    await expect(readFile(invocation.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const config = path.join(f.root, 'fake.json'); const record = path.join(f.root, 'record.json');
    await writeFile(config, JSON.stringify({ recordPath: record, scenario: 'success' }));
    await execute('/bin/sh', ['-c', shell.output], { env: { AIWG_FAKE_WORKER_CONFIG: config, UNRELATED_SECRET: 'not-forwarded' }, timeout: 5000 });
    expect(JSON.parse(await readFile(record, 'utf8'))).toMatchObject({ argv: invocation.argv.slice(2), cwd: f.request.workdir,
      stdin: f.payload, outputPaths: { final: invocation.finalPath } });
    expect(JSON.parse(await readFile(record, 'utf8')).envNames).not.toContain('UNRELATED_SECRET');
    await expect(readFile(path.join(f.root, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['ultra', 'contributor', 'stale', 'missing-controls', 'missing-installation'])(`denied %s returns no command`, async kind => {
    const f = await fixture();
    if (kind === 'ultra') f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.initialEffort = 'ultra';
    if (kind === 'ultra') f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.effortLadder = ['ultra'];
    if (kind === 'contributor') f.snapshot.catalog.discovery!.instances!.codex.models.forEach(row => { row.worker!.dataUse.productImprovement = true; });
    if (kind === 'stale') f.snapshot.catalog.discovery!.instances!.codex.models.forEach(row => { row.worker!.observedAt = '2026-09-01T00:00:00Z'; });
    if (kind === 'missing-controls') f.profile.controls.sandbox.support = 'unqualified';
    if (kind === 'missing-installation') f.snapshot.installations = {};
    const result = await f.call('shell');
    expect(result.result.exitCode, result.output).toBe(2);
    expect(result.plan.invocation).toBeUndefined();
    expect(f.buildInvocation).not.toHaveBeenCalled();
  });

  it('checks current brief and profile digests, including mutations during preparation', async () => {
    const f = await fixture();
    const first = (await f.call()).plan;
    const expected = { digests: first.digests, briefDigest: first.invocation.briefDigest };
    await writeFile(f.request.brief, 'changed');
    let result = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now, expected);
    expect(result.invocation).toBeUndefined(); expect(result.diagnostics.at(-1)?.pointer).toBe('/request/brief');
    await writeFile(f.request.brief, f.payload);
    f.binding.cliVersion = '1.0.1';
    result = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now, expected);
    expect(result.invocation).toBeUndefined(); expect(result.diagnostics.some(d => d.pointer === '/request/expectedDigests')).toBe(true);
  });

  it('rejects symlinks and preserves a nonlaunchable preparatory plan for future brief/workdir', async () => {
    const f = await fixture();
    await rm(f.request.brief); await symlink(path.join(f.root, 'models.json'), f.request.brief);
    expect((await f.call()).result.exitCode).toBe(2);
    await rm(f.request.brief);
    f.request.final_output = path.join(f.root, 'future', 'result.json');
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(2);
    expect(result.plan.invocation).toMatchObject({ readiness: 'preparatory', briefDigest: null });
  });

  it('#4161 names a missing brief instead of an adapter failure when the driver needs brief content', async () => {
    const f = await fixture();
    const original = f.drivers.codex.buildInvocation;
    f.drivers.codex.buildInvocation = async (input: any) => {
      if (!input.brief) throw new Error('driver requires brief content');
      return original(input);
    };
    await rm(f.request.brief);
    const missing = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now);
    expect(missing.invocation).toBeUndefined();
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_CONFIG_REFERENCE', reason: 'brief_missing',
      pointer: '/request/brief', message: expect.stringContaining('brief file does not exist') }));
    expect(missing.diagnostics.some(d => d.code === 'OG_ADAPTER_UNQUALIFIED')).toBe(false);
    // A present brief with a failing driver is still an adapter build failure.
    await writeFile(f.request.brief, f.payload);
    f.drivers.codex.buildInvocation = async () => { throw new Error('broken driver'); };
    const broken = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now);
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/invocation/buildInvocation' }));
  });

  it.each(['--unknown=x', '--constructor=x', '--__proto__=x', '--toString=x', '--valueOf=x', '--hasOwnProperty=x', '--transport=acp', '--format=fish', '--group=workers; touch injected'])('rejects %s before loading', async flag => {
    const load = vi.fn(); const handler = createModelsHandler({ load });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['resolve', '--role=coding', '--task=implementation', '--group=workers',
      '--brief=/fixture/brief', '--workdir=/fixture/tree', '--final-output=/fixture/final', flag];
    expect((await handler.execute({ args, rawArgs: args, cwd: '/unused', frameworkRoot: '/unused' })).exitCode).toBe(2);
    expect(load).not.toHaveBeenCalled(); log.mockRestore();
  });

  it.each([
    { label: 'omitted', taskArgs: [] },
    { label: 'without a value', taskArgs: ['--task'] },
    { label: 'empty inline value', taskArgs: ['--task='] },
  ])('explains missing --task before loading ($label)', async ({ taskArgs }) => {
    const load = vi.fn(); const handler = createModelsHandler({ load });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['resolve', '--role=coding', '--group=workers', '--brief=/fixture/brief',
      '--workdir=/fixture/tree', '--final-output=/fixture/final', ...taskArgs];
    const message = 'Missing required --task. Valid task classes: inventory, implementation, architecture, review, plus classes configured in defaults.workerSelection.taskClasses.';
    expect(() => parseWorkerCommandArgs(args.slice(1))).toThrow(message);
    expect((await handler.execute({ args, rawArgs: args, cwd: '/unused', frameworkRoot: '/unused' })).exitCode).toBe(2);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ status: 'blocked', diagnostics: [
      { code: 'OG_CONFIG_REFERENCE', pointer: '/request/task', message },
    ] });
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['brief', 'workdir', 'final_output'] as const)('explains a relative %s with a specific request pointer', async key => {
    const f = await fixture();
    f.request[key] = 'relative-input';
    for (const format of ['json', 'shell']) {
      const result = await f.call(format);
      expect(result.result.exitCode).toBe(2);
      expect(result.plan.invocation).toBeUndefined();
      expect(result.plan.diagnostics.at(-1)).toEqual({ code: 'OG_CONFIG_REFERENCE', pointer: `/request/${key}`,
        message: `--${key.replace('_', '-')} must be an absolute path; relative paths are not resolved against cwd or --workdir.` });
      expect(result.output).not.toContain('relative-input');
      if (format === 'shell') expect(result.stdout).toBe('');
    }
    expect(f.buildInvocation).not.toHaveBeenCalled();
  });

  it('accepts a configured task class at argument parsing', () => {
    expect(parseWorkerCommandArgs(['--role=coding', '--task=custom-task', '--group=workers',
      '--brief=/fixture/brief', '--workdir=/fixture/tree', '--final-output=/fixture/final']).task).toBe('custom-task');
  });

  it.each(['shell', 'json'])('rejects an equals-bearing executable in %s format', async format => {
    const f = await fixture();
    f.drivers.codex.buildInvocation = async () => ({ argv: ['/no/such/a=b', '/bin/echo', 'wrong-executable'], stdin: 'closed', envNames: [] });
    const result = await f.call(format);
    expect(result.result.exitCode).toBe(2);
    expect(result.plan.invocation).toBeUndefined();
  });

  it('keeps a preparatory shell plan off stdout and explains preparation on stderr', async () => {
    const f = await fixture();
    await rm(f.request.brief);
    const result = await f.call('shell');
    expect(result.result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).diagnostics).toContainEqual(expect.objectContaining({
      code: 'OG_CONFIG_REFERENCE', pointer: '/request/brief', message: expect.stringMatching(/prepar|resolve again/i),
    }));
  });

  it.each(['shell', 'json'])('names an adapter build failure without exposing its text in %s', async format => {
    const f = await fixture();
    f.buildInvocation.mockRejectedValueOnce(new WorkerPolicyError('OG_CONFIG_REFERENCE', 'sensitive-build-details'));
    const result = await f.call(format);
    expect(result.result.exitCode).toBe(2);
    expect(result.plan.invocation).toBeUndefined();
    expect(result.plan.diagnostics.at(-1)).toMatchObject({ code: 'OG_CONFIG_REFERENCE',
      pointer: '/invocation/buildInvocation', reason: 'invocation_build_failed' });
    expect(result.output).not.toContain('sensitive-build-details');
  });

  it.each([
    ['brief digest', 'OG_PIN_MISMATCH', '/request/brief'],
    ['path', 'OG_CONFIG_REFERENCE', '/request/brief'],
    ['model', 'OG_MODEL_UNAPPROVED', '/invocation/prepareWorkerInvocation'],
    ['effort', 'OG_EFFORT_DENIED', '/invocation/prepareWorkerInvocation'],
    ['internal', 'OG_ADAPTER_UNQUALIFIED', '/invocation/prepareWorkerInvocation'],
  ])('emits a scoped, sanitized diagnostic for %s', async (kind, code, pointer) => {
    const f = await fixture();
    const secret = 'sensitive-internal-canary';
    let expected;
    if (kind === 'brief digest') expected = { digests: {}, briefDigest: digest('wrong') };
    if (kind === 'path') f.request.brief = secret;
    if (['model', 'effort', 'internal'].includes(kind)) {
      const { prepareWorkerInvocation } = await import('../../../../src/serve/worker-invocation.js');
      f.drivers.codex.prepareWorkerInvocation = async (invocation, qualification) => {
        if (kind === 'internal') throw new Error(secret);
        if (kind === 'model') invocation.selected.model = 'muse-spark-1.3-contributor';
        if (kind === 'effort') invocation.selected.effort.value = 'ultra';
        return prepareWorkerInvocation(invocation, qualification);
      };
    }
    const plan = await resolveWorkerInvocation(f.snapshot, f.request, f.drivers, f.now, expected);
    expect(plan.invocation).toBeUndefined();
    expect(plan.diagnostics.at(-1)).toMatchObject({ code, pointer });
    if (['model', 'effort', 'internal'].includes(kind)) expect(plan.diagnostics.at(-1)?.reason).toBe('invocation_prepare_failed');
    expect(JSON.stringify(plan.diagnostics)).not.toContain(secret);
  });

  it('rejects unknown legacy resolve flags too', async () => {
    expect((await modelsHandler.execute({ args: ['resolve', '--unknown'], rawArgs: [], cwd: '/unused', frameworkRoot: '/unused' })).exitCode).toBe(2);
  });
});

describe('T-OG-19 all IN providers and T-OG-17 descriptors', () => {
  const providers = fixtureJson('provider-coverage.json').rows.filter((row: any) => row.scope === 'IN').map((row: any) => row.provider);
  it.each(providers)('handles eligible %s without a hardcoded provider filter', async provider => {
    const f = await installedFixture('shell', provider);
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.selected.cli).toBe(provider);
  });
  it('T-OG-17 same selected tuple and brief produce equivalent fake shell/MCP claims', async () => {
    const f = await fixture('codex');
    const shell = (await f.call()).plan.invocation;
    const binding = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: digest(workerInputSchema),
      outputSchemaDigest: digest({ type: 'object' }), sessionIsolation: 'per-call' as const, cancel: 'uncertain' as const };
    f.profile.transport = 'mcp'; f.profile.mcp = binding; f.binding.mcp = binding;
    f.snapshot.config.parallelism!.groups!.workers.execution = { transport: 'mcp' };
    const q = f.drivers.codex.qualification;
    q.mcp = binding; q.mcpSchemas = { input: workerInputSchema, output: { type: 'object' } };
    const worker = { invocationId: 'parity', workspace: f.request.workdir, brief: f.payload,
      selection: { provider: shell.selected.inferenceProvider, model: shell.selected.model, effort: shell.selected.effort.value } };
    const { cancel: _cancel, ...descriptor } = binding;
    f.drivers.codex.buildInvocation = async () => ({ mcp: { ...descriptor, arguments: worker, timeoutSeconds: 60 } });
    const mcp = await resolveWorkerInvocation(f.snapshot, { ...f.request, transport: 'mcp' }, f.drivers, f.now);
    expect(mcp.invocation, JSON.stringify(mcp.diagnostics)).toBeDefined();
    expect(mcp.invocation!.selected).toEqual(shell.selected);
    const config = path.join(f.root, 'parity-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(f.root, 'shell-record.json'), scenario: 'success', worker }));
    await execute('/bin/sh', ['-c', shell.shellCommand], { env: { AIWG_FAKE_WORKER_CONFIG: config }, timeout: 5000 });
    const shellClaims = JSON.parse(await readFile(shell.finalPath, 'utf8')).result;
    await writeFile(config, JSON.stringify({ recordPath: path.join(f.root, 'mcp-record.jsonl'), scenario: 'success' }));
    const pending = execute(process.execPath, [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], {
      env: { AIWG_FAKE_WORKER_CONFIG: config }, timeout: 5000,
    });
    const received = new Promise<void>((resolve, reject) => {
      let buffer = '';
      pending.child.stdout!.on('data', chunk => { buffer += chunk; if (buffer.trim().split('\n').length >= 2) resolve(); });
      pending.child.once('close', () => reject(new Error('Fake MCP subprocess closed before protocol output; no replay')));
    });
    pending.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: mcp.invocation!.mcp!.tool, arguments: mcp.invocation!.mcp!.arguments } }) + '\n');
    await received; pending.child.stdin!.end();
    const messages = (await pending).stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(digest(messages[0].result.tools[0].inputSchema)).toBe(binding.inputSchemaDigest);
    expect(messages[1].result.structuredContent).toEqual(shellClaims);
  });

  it('returns pinned MCP server/tool/arguments and detects schema replacement', async () => {
    const f = await installedFixture('mcp', 'muse');
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.shellCommand).toBeUndefined();
    expect(result.plan.invocation.mcp).toMatchObject({ serverRef: 'fixture-server', tool: 'fixture-worker',
      arguments: { workspace: f.request.workdir, brief: f.payload, selection: { model: 'synthetic/a%b', effort: 'medium' } } });
    f.drivers.muse.qualification.mcpSchemas!.input = { type: 'string' };
    expect((await f.call()).plan.invocation).toBeUndefined();
  });
});

describe('#2956 controls come from resolved permissions, never caller waivers', () => {
  it.each(['claude', 'muse', 'hermes'])('%s requires an enforcing boundary even with requiredControls=[model]', async provider => {
    const f = await fixture(provider);
    for (const policySource of [true, false]) {
      const selection = { profile: f.binding.profile, transport: 'shell' as const, cliVersion: '1.0.0',
        requiredControls: ['model'], boundary: { kind: 'native' as const },
        ...(policySource ? { policy: f.snapshot.models.defaults.workerSelection, permissions: { sandbox: 'workspace-write' as const }, effort: 'medium' } : {}) };
      expect(() => qualifyWorkerInvocationProfile(f.adapter, selection)).toThrow(/sandbox.*external/);
    }
    f.binding.boundary = { ...f.binding.boundary!, kind: 'native' };
    const result = await f.call();
    expect(result.plan.invocation).toBeUndefined(); expect(f.buildInvocation).not.toHaveBeenCalled();
  });
  it('parses premium authorization for one request and rejects values or duplicates', () => {
    const args = fixtureJson('public-vocabulary.json').cli.cases[0].argv.slice(2);
    expect(parseWorkerCommandArgs([...args, '--authorize-premium']).authority).toEqual({ premiumAuthorized: true, maxAutoTier: 3 });
    expect(parseWorkerCommandArgs(args).authority).toBeUndefined();
    expect(() => parseWorkerCommandArgs([...args, '--authorize-premium=false'])).toThrow('Unsupported');
    expect(() => parseWorkerCommandArgs([...args, '--authorize-premium', '--authorize-premium'])).toThrow('Duplicate');
  });
  it('requires the strictest set without policy and preserves additions', () => {
    expect(requiredWorkerControls({ requiredControls: ['model'] })).toEqual([
      'model', 'effort', 'sandbox', 'approval', 'workdir', 'finalOutput', 'stdin', 'structuredOutput', 'stepCap', 'trust', 'children', 'fallback',
    ]);
    expect(parseWorkerCommandArgs(fixtureJson('public-vocabulary.json').cli.cases[0].argv.slice(2))).toMatchObject({ role: 'coding', format: 'shell' });
  });
});
