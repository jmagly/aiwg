import { idleHostResourceReaders } from '../../../fixtures/host-resources.js';
import { mkdtempSync } from 'node:fs';
import { workerSigningFixture } from '../../../helpers/worker-qualification-signing.js';
import { copyNode } from '../../../helpers/copy-node.js';
import { createHash } from 'node:crypto';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelsHandler, loadWorkerInputs as loadHostWorkerInputs } from '../../../../src/cli/handlers/models.js';
import { ConfigLoader } from '../../../../src/models/config-loader.js';
import { requiredWorkerControls, WORKER_OPERATOR_APPROVAL } from '../../../../src/models/provider-policy.js';
import { resolveWorkerPlan } from '../../../../src/models/resolver.js';
import { hasProvider as hasInstalledProvider, loadRecordedWorkerInstallations, registerProvider } from '../../../../src/models/worker-installation.mjs';
import { qualificationDigest } from '../../../../src/models/qualification-digest.mjs';
import { ProviderAdapter, workerNegativeFixtureDigest, workerNegativeFixtureSuite } from '../../../../tools/ralph-external/lib/provider-adapter.mjs';
import { workerResolutionFixture } from '../../../fixtures/worker-resolution.js';
import { recordedWorkerStdinBytes } from '../../../../src/serve/worker-stdin-frame.mjs';

const loadWorkerInputs = (ctx: Parameters<typeof loadHostWorkerInputs>[0]) => loadHostWorkerInputs(ctx, idleHostResourceReaders());
const modelsHandler = createModelsHandler({ load: loadWorkerInputs });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function productionFixture(adapterFrame = false) {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-production-worker-')); roots.push(root);
  const cwd = path.join(root, 'project');
  const workdir = path.join(cwd, 'worktree');
  const configDir = path.join(root, 'host-config');
  const installed = path.join(root, 'installed');
  const frameworkRoot = path.join(root, 'framework');
  await Promise.all([mkdir(path.join(cwd, '.aiwg'), { recursive: true }), mkdir(workdir, { recursive: true }),
    mkdir(configDir, { mode: 0o700 }), mkdir(installed, { mode: 0o755 }), mkdir(path.join(root, 'home')),
    mkdir(path.join(frameworkRoot, 'agentic/code/providers'), { recursive: true }),
    mkdir(path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/config'), { recursive: true })]);
  vi.stubEnv('HOME', path.join(root, 'home')); vi.stubEnv('AIWG_CONFIG', configDir); vi.stubEnv('AIWG_HOME', frameworkRoot);
  const f = workerResolutionFixture();
  const now = new Date().toISOString();
  f.snapshot.hostResources!.collectedAt = now;
  const id = `fixture-${path.basename(root).toLowerCase()}`;
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.id = id; adapter.runtimeDriver = `installed:${id}`;
  adapter.qualification.verifiedAt = now;
  const binding = f.snapshot.installations.codex;
  const profile = adapter.invocationProfiles![binding.profile];
  profile.envAllowlist = []; adapter.invocation.envAllowlist = []; adapter.invocation.stdin = 'closed';
  if (adapterFrame) adapter.invocation.stdin = 'adapter-frame';
  delete f.snapshot.registry.providers.codex.workerAdapter;
  f.snapshot.registry.workerAdapters = { [id]: adapter };
  f.snapshot.installations = { [id]: binding };
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = id; });
  f.snapshot.config.parallelism!.clis = { [id]: { adapter: `workerAdapters:${id}`, accountScope: binding.accountScope, quotaScope: 'fixture' } };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  for (const row of discovery.models) {
    row.worker!.cliId = id; row.worker!.observedAt = now; row.worker!.fetchedAt = now; row.worker!.verifiedAt = now;
    row.worker!.qualification.verifiedAt = now;
  }
  discovery.observedAt = now; f.snapshot.catalog.discovery!.instances = { [id]: discovery };
  await writeFile(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify(f.snapshot.config));
  await writeFile(path.join(cwd, 'models.json'), JSON.stringify({ defaults: { workerSelection: f.projectPolicy } }));
  await writeFile(path.join(frameworkRoot, 'agentic/code/providers/model-catalog.v1.json'), JSON.stringify(f.snapshot.catalog));
  await writeFile(path.join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/config/models-v2.json'),
    JSON.stringify({ version: '2.0', defaults: { provider: 'codex', tier: 'standard' }, tiers: {}, providers: {}, agentRoleAssignments: {}, shorthand: {} }));
  const loader = new ConfigLoader(cwd);
  f.snapshot.models = await loader.load(f.snapshot.config.parallelism); f.snapshot.modelDigests = loader.getInputDigests()!;
  binding.boundary = { kind: 'os', identity: 'fixture:host', digest: qualificationDigest('fixture:host'), controls: [] };
  const initial = resolveWorkerPlan(f.snapshot, { ...f.request, now, role: 'coding', group: 'workers' });
  expect(initial.selected, JSON.stringify(initial)).not.toBeNull();
  const permissions = initial.selected!.permissions;
  const controls = requiredWorkerControls({ policy: initial.policy, permissions, effort: 'medium' });
  binding.boundary.controls = controls;
  for (const control of Object.values(profile.controls)) Object.assign(control, { support: 'external', mapping: 'host fixture boundary' });
  const executable = await copyNode(installed);
  const cli = path.join(installed, 'ralph-worker-cli.mjs');
  const protocol = path.join(installed, 'ralph-worker-protocol.mjs');
  for (const filename of [cli, protocol]) await writeFile(filename, await readFile(path.resolve('test/fixtures', path.basename(filename))), { mode: 0o644 });
  // Resolution rechecks the version without the worker's protocol environment.
  adapter.invocation.versionArgv = ['-e', `console.log(${JSON.stringify(binding.cliVersion)})`];
  const args = (input: any, _profile: any, permissions: any) => [cli, '--model', input.selected.model, '--effort', input.selected.effort.value,
    '--sandbox', permissions.sandbox, '--approval', permissions.approval, '--final-output', input.finalPath];
  const source = await readFile(path.resolve('test/fixtures/production-worker-driver.mjs'), 'utf8');
  await writeFile(path.join(installed, 'driver-config.json'), JSON.stringify({ cli, id, adapterFrame }), { mode: 0o644 });
  await writeFile(path.join(installed, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }), { mode: 0o644 });
  class Owner extends ProviderAdapter { getName() { return id; } buildWorkerArgs = args; }
  const owner = new Owner();
  const installation: any = { adapter, profile: binding.profile, cliVersion: binding.cliVersion, now: Date.parse(now),
    policy: initial.policy, permissions, effort: 'medium', requiredControls: controls, executable,
    cwd: workdir, workerWritableRoots: [cwd], inputRoots: [cwd], outputRoots: [cwd], boundary: binding.boundary,
    effectiveConfigDigest: qualificationDigest(initial.policy), accountScope: binding.accountScope,
    runtimeFiles: [cli, protocol, path.join(installed, 'driver-config.json')], environment: {}, modules: [{ reference: adapter.runtimeDriver, packageRoot: installed,
      packageName: id, packageVersion: '1.0.0', modulePath: 'driver.mjs', interfaceVersion: 1,
      sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`, adapterIds: [id], platforms: ['linux'] }] };
  const scope = await owner.inspectWorkerInstallation(installation);
  profile.installationQualification = { scopeDigest: scope.scopeDigest, fixtureDigest: await workerNegativeFixtureDigest(),
    verifiedAt: now, evidenceRef: 'fixture:host-negative-evidence' };
  installation.evidence = { ...profile.installationQualification,
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(name => [name, 'passed'])) };
  const brief = path.join(cwd, 'brief.txt'); await writeFile(brief, 'Do the synthetic task.');
  const finalPath = path.join(workdir, 'final.json');
  const signing = await workerSigningFixture(root, cwd);
  const record = signing.sign({ cli: id, binding, adapter, installation });
  const call = async (handler = modelsHandler) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['resolve', '--role=coding', '--group=workers', '--task=implementation', `--brief=${brief}`, `--workdir=${workdir}`, `--final-output=${finalPath}`, '--format=json'];
    const result = await handler.execute({ args, rawArgs: ['models', ...args], cwd, frameworkRoot });
    const output = String(log.mock.calls.at(-1)?.[0]); log.mockRestore(); return { result, output, plan: JSON.parse(output) };
  };
  return { ...f, call, record, configDir, finalPath, installed, owner, cwd, frameworkRoot, signing };
}

describe('models resolve production installation loading', () => {
  it('T-OG-15 keeps PATH prefixes eligible while rejecting executable and other environment drift', async () => {
    const f = await productionFixture();
    const { adapter, installation, binding } = f.record;
    const profile = adapter.invocationProfiles![binding.profile];
    const extra = path.join(f.installed, 'extra');
    await mkdir(extra);
    const originalPath = f.installed;
    const prefixedPath = `${extra}${path.delimiter}${originalPath}`;
    vi.stubEnv('PATH', originalPath);
    vi.stubEnv('AIWG_SYNTHETIC_SETTING', 'qualified-value');
    adapter.qualification.evidenceRef = WORKER_OPERATOR_APPROVAL;
    installation.requiredControls = [];
    adapter.invocation.envAllowlist = profile.envAllowlist = ['PATH', 'AIWG_SYNTHETIC_SETTING'];
    installation.environment = { PATH: originalPath, AIWG_SYNTHETIC_SETTING: 'qualified-value' };
    const configPath = path.join(f.cwd, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.parallelism.clis[f.record.cli].executable = path.basename(installation.executable);
    await writeFile(configPath, JSON.stringify(config));
    const scope = await f.owner.inspectWorkerInstallation(installation);
    installation.evidence.scopeDigest = profile.installationQualification!.scopeDigest = scope.scopeDigest;
    expect(await f.owner.recordWorkerInstallation({ ...f.record, projectDir: f.cwd })).toMatchObject({ status: 'ENABLED' });
    const stored = await readFile(path.join(f.configDir, 'worker-installations.json'), 'utf8');
    expect(stored).not.toContain('qualified-value');
    expect(JSON.parse(stored).registrations[0].installation.environmentNames).toContain('PATH');
    const baseline = await f.call();
    expect(baseline.plan.status, JSON.stringify(baseline.plan.diagnostics)).toBe('eligible');
    // Freeze the loaded environment too: preparation must tolerate host PATH plumbing.
    const loaded = await loadWorkerInputs({ cwd: f.cwd, frameworkRoot: f.frameworkRoot, args: [], rawArgs: [] });
    vi.stubEnv('PATH', prefixedPath);
    const prepared = await f.call(createModelsHandler({ load: async () => loaded }));
    expect(prepared.plan.status, JSON.stringify(prepared.plan.diagnostics)).toBe('eligible');
    const prefixed = await f.call();
    expect(prefixed.plan.status, JSON.stringify(prefixed.plan.diagnostics)).toBe('eligible');
    expect(prefixed.plan.invocation.argv[0]).toBe(scope.binary.realpath);
    expect(prefixed.plan.invocation.selected.qualificationDigest).toBe(scope.scopeDigest);
    expect(prefixed.plan.invocation.shellCommand).toContain('PATH="${PATH-}"');
    expect(prefixed.plan.invocation.shellCommand).not.toContain(prefixedPath);
    vi.stubEnv('AIWG_SYNTHETIC_SETTING', 'changed-value');
    expect((await f.call()).plan.status).toBe('blocked');
    expect((await f.call(createModelsHandler({ load: async () => loaded }))).plan.status).toBe('blocked');
    vi.stubEnv('AIWG_SYNTHETIC_SETTING', 'qualified-value');
    // Same CLI name, different realpath and bytes; never import or execute the shadow.
    await writeFile(path.join(extra, path.basename(installation.executable)), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    const shadowed = await f.call();
    expect(shadowed.plan.status).toBe('blocked');
    expect(shadowed.plan.invocation).toBeUndefined();
    expect(shadowed.output).toContain('OG_ADAPTER_UNQUALIFIED');
    await expect(loadWorkerInputs({ cwd: f.cwd, frameworkRoot: f.frameworkRoot, args: [], rawArgs: [] }))
      .rejects.toMatchObject({ details: { rejections: [{ registration: 0, reason: 'binary-identity' }] } });
    await rm(path.join(extra, path.basename(installation.executable)));
    // Preserve realpath but alter bytes: the pinned hash must still reject it.
    await writeFile(installation.executable, '#!/bin/sh\nexit 92\n');
    expect((await f.call()).plan.status).toBe('blocked');
    await expect(readFile(f.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing-file', 'missing-role', 'missing-field', 'null-effort'])('reports missing role effort before recorded policy digest and adapter loading (%s)', async kind => {
    const f = await productionFixture();
    // An existing approval lets policy diagnostics precede its now-stale
    // policy digest; absent approvals must retain #3070's qualification error.
    await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [f.record] }), { mode: 0o600 });
    const filename = path.join(f.cwd, 'models.json');
    if (kind === 'missing-file') await rm(filename);
    else {
      const models = JSON.parse(await readFile(filename, 'utf8'));
      if (kind === 'missing-role') delete models.defaults.workerSelection.roleGuidance.coding;
      else if (kind === 'missing-field') delete models.defaults.workerSelection.roleGuidance.coding.initialEffort;
      else Object.assign(models.defaults.workerSelection.roleGuidance.coding,
        { initialEffort: null, effortLadder: [], allowNotApplicableEffort: true });
      await writeFile(filename, JSON.stringify(models));
    }
    const result = await f.call();
    expect(result.result.exitCode).toBe(2);
    expect(result.plan.diagnostics).toContainEqual({ code: 'OG_CONFIG_REFERENCE',
      pointer: '/defaults/workerSelection/roleGuidance/coding/initialEffort',
      message: expect.stringContaining('models.json') });
    expect(result.plan.invocation).toBeUndefined();
  });

  it('qualifies its own single-link executable with trusted permissions', async () => {
    const f = await productionFixture();
    const executable = await stat(f.record.installation.executable);
    expect(f.record.installation.executable).toBe(path.join(f.installed, 'node'));
    expect(executable.mode & 0o777).toBe(0o755);
    expect(executable.nlink).toBe(1);
    await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [f.record] }), { mode: 0o600 });
    expect((await f.call()).result.exitCode).toBe(0);
  });

  it.each([false, true])('loads literal fixture configuration (adapter frame: %s)', async adapterFrame => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'driver-literal-')); roots.push(root);
    const cli = `path with spaces; '" \\ newline\n`;
    const id = `adapter-'"; process.exit(9); //`;
    await writeFile(path.join(root, 'driver.mjs'), await readFile(path.resolve('test/fixtures/production-worker-driver.mjs')));
    await writeFile(path.join(root, 'driver-config.json'), JSON.stringify({ cli, id, adapterFrame }));
    const driver = await import(pathToFileURL(path.join(root, 'driver.mjs')).href);
    let adapter: any;
    driver.register((name: string, factory: () => any) => { expect(name).toBe(id); adapter = factory(); });
    expect(adapter.getName()).toBe(id);
    expect(adapter.buildWorkerArgs({ selected: { model: 'm', effort: { value: 'medium' } }, finalPath: 'final' }, {},
      { sandbox: 'workspace', approval: 'never' })).toEqual([cli, '--model', 'm', '--effort', 'medium',
      '--sandbox', 'workspace', '--approval', 'never', '--final-output', 'final']);
    if (adapterFrame) expect(JSON.parse(adapter.buildWorkerStdinFrame(Buffer.from(cli)))).toEqual({ message: cli });
    else expect(adapter.buildWorkerStdinFrame).toBeUndefined();
  });

  it('frames from the bound host store and policy despite worker cwd config changes, rejecting changed bindings', async () => {
    const f = await productionFixture(true);
    const storePath = path.join(f.configDir, 'worker-installations.json');
    const storeBytes = JSON.stringify({ version: 1, registrations: [f.record] });
    await writeFile(storePath, storeBytes, { mode: 0o600 });
    const resolved = await f.call();
    expect(resolved.result.exitCode, resolved.output).toBe(0);
    const invocation = resolved.plan.invocation;
    const storeDigest = `sha256:${createHash('sha256').update(storeBytes).digest('hex')}`;
    expect(invocation.shellCommand).toContain(storePath);
    expect(invocation.shellCommand).toContain(storeDigest);
    await mkdir(path.join(invocation.cwd, '.aiwg'));
    await writeFile(path.join(invocation.cwd, '.aiwg/aiwg.config'), '{broken worker config');
    await writeFile(path.join(invocation.cwd, 'models.json'), '{broken worker model config');
    const input = { filename: invocation.briefPath, workspace: invocation.cwd, cli: invocation.selected.cli,
      adapterId: f.record.adapter.id, scopeDigest: invocation.selected.qualificationDigest,
      briefDigest: invocation.briefDigest, storePath, storeDigest, policy: f.record.installation.policy, model: invocation.selected.model };
    vi.stubEnv('AIWG_CONFIG', invocation.cwd);
    expect((await recordedWorkerStdinBytes(input))!.toString()).toBe(JSON.stringify({ message: await readFile(invocation.briefPath, 'utf8'), model: invocation.selected.model }));
    expect(invocation.shellCommand).toContain(`'${invocation.selected.model}'`);
    await expect(recordedWorkerStdinBytes({ ...input, policy: {} })).rejects.toThrow(/qualification/);
    await expect(recordedWorkerStdinBytes({ ...input, adapterId: 'changed' })).rejects.toThrow(/binding changed/);
    await expect(recordedWorkerStdinBytes({ ...input, scopeDigest: qualificationDigest('changed') })).rejects.toThrow(/binding changed/);
    await writeFile(invocation.briefPath, 'changed brief');
    await expect(recordedWorkerStdinBytes(input)).rejects.toThrow(/brief changed/);
    await writeFile(invocation.briefPath, 'Do the synthetic task.');
    await writeFile(storePath, storeBytes + '\n');
    await expect(recordedWorkerStdinBytes(input)).rejects.toThrow(/qualification/);
  });
  it('renders a qualified installed fake CLI through the production handler', async () => {
    const f = await productionFixture();
    await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [f.record] }), { mode: 0o600 });
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.argv).toContain(path.join(f.installed, 'ralph-worker-cli.mjs'));
    expect(result.plan.invocation.selected.qualificationDigest).toBe(f.record.installation.evidence.scopeDigest);
    await expect(readFile(f.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(f.installed, 'driver.mjs'), '// changed');
    expect((await f.call()).result.exitCode).toBe(2);
  });
  it.each([
    ['boundary', 'binding-mismatch'], ['expired', 'evidence'], ['negative-case', 'evidence'],
    ['duplicate', 'record-identity'], ['worker-writable-store', 'store-untrusted'], ['hardlinked-store', 'store-untrusted'],
  ])('refuses %s host records before loading the installed driver with reason %s', async (kind, reason) => {
      const f = await productionFixture();
      if (kind === 'boundary') f.record.binding.boundary = { ...f.record.binding.boundary!, digest: qualificationDigest('changed') };
      if (kind === 'expired') {
        f.record.installation.evidence.verifiedAt = '2001-01-01T00:00:00Z';
        f.record.adapter.invocationProfiles![f.record.binding.profile].installationQualification!.verifiedAt = '2001-01-01T00:00:00Z';
      }
      if (kind === 'negative-case') f.record.installation.evidence.cases['forbidden-write'] = 'failed';
      f.signing.sign(f.record);
      const records = kind === 'duplicate' ? [f.record, f.record] : [f.record];
      const storeDir = kind === 'worker-writable-store' ? f.record.installation.cwd : f.configDir;
      vi.stubEnv('AIWG_CONFIG', storeDir);
      await writeFile(path.join(storeDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: records }), { mode: 0o600 });
      if (kind === 'hardlinked-store') await link(path.join(storeDir, 'worker-installations.json'), path.join(f.record.installation.cwd, 'host-alias.json'));
      const result = await f.call();
      expect(result.result.exitCode).toBe(2);
      expect(result.plan.invocation).toBeUndefined();
      expect(hasInstalledProvider(f.record.adapter.id)).toBe(false);
      expect(result.output).toContain('OG_ADAPTER_UNQUALIFIED');
      const rejections = (kind === 'duplicate' ? [0, 1] : [kind === 'worker-writable-store' || kind === 'hardlinked-store' ? null : 0])
        .map(registration => ({ registration, reason }));
      await expect(loadWorkerInputs({ cwd: f.cwd, frameworkRoot: f.frameworkRoot, args: [], rawArgs: [] }))
        .rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', message: expect.stringContaining(reason), details: { rejections } });
    });

  it.each(['environment-name', 'effective-config-digest', 'module-registration', 'binary-identity', 'scope-digest', 'version', 'adapter-conflict'])(
    'reports a secret-free %s registration refusal', async reason => {
      const f = await productionFixture();
      const privateText = 'synthetic-private-content';
      const installation = f.record.installation;
      if (reason === 'environment-name') installation.environment = { AIWG_SYNTHETIC_PRIVATE: privateText };
      if (reason === 'effective-config-digest') installation.effectiveConfigDigest = qualificationDigest(privateText);
      if (reason === 'module-registration') await writeFile(path.join(f.installed, 'driver.mjs'), privateText);
      if (reason === 'binary-identity') await rm(installation.executable);
      if (reason === 'scope-digest') await writeFile(installation.runtimeFiles[0], privateText);
      if (reason === 'adapter-conflict') registerProvider(f.record.adapter.id, () => f.owner);
      if (reason === 'version') {
        f.record.adapter.invocation.versionArgv = ['-e', `console.log(${JSON.stringify(privateText)})`];
        const scope = await f.owner.inspectWorkerInstallation(installation);
        installation.evidence.scopeDigest = scope.scopeDigest;
        f.record.adapter.invocationProfiles![f.record.binding.profile].installationQualification!.scopeDigest = scope.scopeDigest;
      }
      f.signing.sign(f.record);
      await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [f.record] }), { mode: 0o600 });
      const error = await loadWorkerInputs({ cwd: f.cwd, frameworkRoot: f.frameworkRoot, args: [], rawArgs: [] }).catch(error => error);
      expect(error).toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections: [{ registration: 0, reason }] } });
      expect(error.message).toContain(reason);
      expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(privateText);
      expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(f.installed);
    });

  it('records bounded fake qualification without environment values, then resolves it', async () => {
    const f = await productionFixture();
    const name = 'AIWG_SYNTHETIC_WORKER_ENV';
    const value = 'synthetic-only-environment-value';
    // Synthetic worker settings exercise the recorded environment allowlist.
    const fakeWorkerConfig = path.join(f.installed, 'qualification-version-fixture.json');
    await writeFile(fakeWorkerConfig, JSON.stringify({ version: '1.0.0' }));
    vi.stubEnv(name, value);
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', fakeWorkerConfig);
    f.record.adapter.invocation.envAllowlist = [name, 'AIWG_FAKE_WORKER_CONFIG'];
    const profile = f.record.adapter.invocationProfiles![f.record.binding.profile];
    profile.envAllowlist = [name, 'AIWG_FAKE_WORKER_CONFIG'];
    f.record.installation.environment = { [name]: value, AIWG_FAKE_WORKER_CONFIG: fakeWorkerConfig };
    const scope = await f.owner.inspectWorkerInstallation(f.record.installation);
    f.record.installation.evidence.scopeDigest = scope.scopeDigest;
    profile.installationQualification!.scopeDigest = scope.scopeDigest;
    const qualified = await f.owner.recordWorkerInstallation({ ...f.record, projectDir: f.cwd });
    expect(qualified).toMatchObject({ status: 'ENABLED' });
    const stored = await readFile(path.join(f.configDir, 'worker-installations.json'), 'utf8');
    expect(stored).not.toContain(value);
    expect(JSON.parse(stored).registrations[0].installation.environmentNames).toEqual([name, 'AIWG_FAKE_WORKER_CONFIG']);
    expect(JSON.parse(stored).registrations[0].installation.environment).toBeUndefined();
    expect(JSON.parse(stored).registrations[0].signature).toMatchObject({
      keyid: f.signing.keyring.keys[0].keyid, sig: expect.any(String), signedAt: expect.any(String), projectDir: f.cwd,
    });
    expect(stored).not.toContain(await readFile(f.signing.keyPath, 'utf8'));
    const result = await f.call();
    expect(result.result.exitCode, result.output).toBe(0);
    expect(result.plan.invocation.envNames).toEqual([name, 'AIWG_FAKE_WORKER_CONFIG']);
  });

  it.each(['unsigned', 'signature', 'keyid', 'edited-record', 'signing-time'])(
    'rejects %s evidence with valid installation digests before importing an adapter', async kind => {
      const f = await productionFixture();
      if (kind === 'unsigned') delete (f.record as any).signature;
      if (kind === 'signature') f.record.signature.sig = Buffer.alloc(64).toString('base64');
      if (kind === 'keyid') f.record.signature.keyid = `sha256:${'0'.repeat(64)}`;
      if (kind === 'edited-record') f.record.binding.endpointFingerprint = 'forged-but-digests-unchanged';
      if (kind === 'signing-time') f.record.signature.signedAt = '2000-01-01T00:00:00.000Z';
      await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [f.record] }), { mode: 0o600 });
      const expectedReason = kind === 'unsigned' ? 'signature-missing' : kind === 'keyid' ? 'signature-unknown-keyid' : 'signature-invalid';
      await expect(loadWorkerInputs({ cwd: f.cwd, frameworkRoot: f.frameworkRoot, args: [], rawArgs: [] }))
        .rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections: [{ registration: 0, reason: expectedReason }] } });
      expect(hasInstalledProvider(f.record.adapter.id)).toBe(false);
      const result = await f.call();
      expect(result.plan.status).toBe('blocked');
      expect(result.plan.invocation).toBeUndefined();
      expect(result.output).toContain('aiwg doctor --probe-workers --qualify');
      if (kind === 'unsigned') expect(result.output).toContain('one-time requalification');
    });

  it('fails closed without writing when the existing signing key is unavailable', async () => {
    const f = await productionFixture();
    await rm(f.signing.keyPath);
    const result = await f.owner.recordWorkerInstallation({ ...f.record, projectDir: f.cwd });
    expect(result).toMatchObject({ status: 'DISABLED', reason: expect.stringContaining('effects.keyProvider') });
    expect(result.reason).toContain('aiwg effect keys init');
    expect(result.reason).toContain('aiwg doctor --probe-workers --qualify');
    await expect(readFile(path.join(f.configDir, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies existing approvals with public keys while the private key is unavailable', async () => {
    const f = await productionFixture();
    await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1, registrations: [f.record] }), { mode: 0o600 });
    await rm(f.signing.keyPath);
    expect((await f.call()).result.exitCode).toBe(0);
  });

  it('keeps a forged peer disabled and retains its diagnostic while loading a signed approval', async () => {
    const f = await productionFixture();
    const forged = { ...structuredClone(f.record), cli: 'forged-cli' };
    await writeFile(path.join(f.configDir, 'worker-installations.json'), JSON.stringify({ version: 1,
      registrations: [f.record, forged] }), { mode: 0o600 });
    const loaded = await loadRecordedWorkerInstallations({ registry: f.snapshot.registry, cwd: f.cwd,
      policy: f.record.installation.policy });
    expect(Object.keys(loaded.drivers)).toEqual([f.record.cli]);
    expect(loaded.qualificationFailures).toEqual({ 'forged-cli': 'signature-invalid' });
  });

  it('refuses to record missing negative qualification evidence', async () => {
    const f = await productionFixture();
    delete f.record.installation.evidence;
    const result = await f.owner.recordWorkerInstallation({ ...f.record, projectDir: f.cwd });
    expect(result.status).toBe('DISABLED');
    await expect(readFile(path.join(f.configDir, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explains how to qualify when the trusted host store has no installation', async () => {
    const f = await productionFixture();
    const result = await f.call();
    expect(result.result.exitCode).toBe(2);
    expect(result.output).toContain('aiwg doctor --probe-workers --qualify');
    expect(result.output).toContain('OG_ADAPTER_UNQUALIFIED');
    await expect(loadWorkerInputs({ cwd: f.cwd, frameworkRoot: f.frameworkRoot, args: [], rawArgs: [] }))
      .rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED', details: { rejections: [{ registration: null, reason: 'no-records' }] } });
  });
});
