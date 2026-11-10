// Exercise signed approval replacement and pruning through the shared recording owner.
import { mkdir, mkdtemp, readFile, writeFile, stat, access, rm, symlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyNode } from '../../helpers/copy-node.js';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';
import { fixtureJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { requiredWorkerControls, loadProviderModelCapabilities, resolveWorkerAdapter, WORKER_OPERATOR_APPROVAL } from '../../../src/models/provider-policy.js';
import { inspectWorkerInstallation, recordWorkerInstallation, workerNegativeFixtureDigest,
  workerNegativeFixtureSuite, loadRecordedWorkerInstallations, loadInstalledWorkerAdapters, createProvider } from '../../../src/models/worker-installation.mjs';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';
import { writeExecutable } from '../../helpers/write-executable.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-model-recording-')); roots.push(root);
  const cwd = path.join(root, 'workspace');
  const installed = path.join(root, 'installed');
  const config = path.join(root, 'config');
  await Promise.all([mkdir(cwd), mkdir(installed, { mode: 0o755 }), mkdir(config, { mode: 0o700 })]);
  vi.stubEnv('AIWG_CONFIG', config);
  await workerSigningFixture(root, cwd);
  const executable = await copyNode(installed);
  const cli = path.join(installed, 'cli.mjs');
  await writeFile(cli, "console.log('1.0.0');\n", { mode: 0o644 });
  const source = 'export const interfaceVersion = 1; export function register(factory) {}';
  await writeFile(path.join(installed, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
  const adapter = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
  adapter.provider = 'codex';
  adapter.qualification = { status: 'qualified', fixtureDigest: qualificationDigest('synthetic'),
    verifiedAt: new Date().toISOString(), evidenceRef: 'fixture:only' };
  adapter.invocation.versionArgv = [cli];
  adapter.invocation.envAllowlist = ['SYNTHETIC_SETTING'];
  const profile = adapter.invocationProfiles['fixture-shell'];
  profile.envAllowlist = ['SYNTHETIC_SETTING'];
  for (const control of Object.values(profile.controls) as any[]) {
    control.support = 'external'; control.mapping = 'fixture runner'; control.evidence = 'fixture:only';
  }
  const controls = requiredWorkerControls({});
  const installation: any = { adapter, profile: 'fixture-shell', cliVersion: '1.0.0', requiredControls: controls,
    executable, platform: 'linux', cwd, workerWritableRoots: [cwd], runtimeFiles: [cli],
    modules: [{ reference: adapter.runtimeDriver, packageRoot: installed, packageName: 'fixture-driver', packageVersion: '1.0.0',
      modulePath: 'driver.mjs', interfaceVersion: 1, sha256: qualificationDigestRaw(source), adapterIds: ['fixture'], platforms: ['linux'] }],
    effectiveConfigDigest: qualificationDigest('fixture-config'), accountScope: 'synthetic-account',
    boundary: { kind: 'os', identity: 'synthetic-runner', digest: qualificationDigest('boundary'), controls },
    environment: { SYNTHETIC_SETTING: 'fixture-value' }, endpoints: [], allowedEndpoints: [] };
  const instance = { getName: () => adapter.id };
  installation.evidence = { scopeDigest: (await inspectWorkerInstallation(instance, installation)).scopeDigest,
    fixtureDigest: await workerNegativeFixtureDigest(), verifiedAt: new Date().toISOString(), evidenceRef: 'fixture:synthetic-only',
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(id => [id, 'passed'])) };
  const binding = { profile: installation.profile, cliVersion: installation.cliVersion, accountScope: installation.accountScope };
  return { root, cwd, config, installation, instance, binding };
}

function qualificationDigestRaw(value: string) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

describe('recorded approval maintenance', () => {
  it.each(['factory', 'claude'] as const)('#4076 records and reloads providers:%s with its -direct adapter', async cli => {
    const f = await doctorWorkerCliFixture(); roots.push(f.root);
    const version = cli === 'factory' ? '1.0.0' : '2.1.319';
    const binary = path.join(f.root, 'fake-bin', cli === 'factory' ? 'droid' : 'claude');
    await writeExecutable(binary, `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== '--version') process.exit(90);
console.log('${version}${cli === 'claude' ? ' (Claude Code)' : ''}');
`);
    const configFile = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.providers = [cli];
    config.parallelism.clis = { [cli]: { adapter: `providers:${cli}`, executable: binary,
      accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } };
    config.parallelism.groups.workers.members[0].cli = cli;
    await writeFile(configFile, JSON.stringify(config));
    const now = new Date().toISOString();
    const worker = workerResolutionFixture().observation;
    Object.assign(worker, { cliId: cli, runtimeVersion: version, accountScope: 'synthetic-account',
      endpointFingerprint: `local-cli:${cli}`, observedAt: now, fetchedAt: now, verifiedAt: now });
    await mkdir(path.join(f.root, '.cache/aiwg'), { recursive: true });
    await writeFile(path.join(f.root, '.cache/aiwg/model-catalog.v1.json'), JSON.stringify({ discovery: { instances: {
      [cli]: { provider: cli, source: 'native', observedAt: now, accountScope: 'local-account',
        accountBinding: 'synthetic-account', runtimeVersion: version, models: [
        { id: 'synthetic-model', apiModelId: 'synthetic-model', llmProvider: 'synthetic', reasoningEfforts: worker.efforts.map(e => e.id), worker },
      ] },
    } } }));
    for (const [name, value] of Object.entries({ HOME: f.root, AIWG_CONFIG: f.config, AIWG_HOME: f.installed })) vi.stubEnv(name, value);
    const models = await new ConfigLoader(f.project).load(config.parallelism);
    if (cli === 'factory') {
      const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', cli, '--yes', '--json']);
      expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
      expect(JSON.parse(qualified.stdout).qualification.status).toBe('recorded');
    } else {
      // Claude retains its external-boundary requirement. Supply a synthetic
      // trusted host approval through the recording owner, not a native exemption.
      const { ClaudeAdapter, ClaudeDirectAdapter } = await import('../../../tools/ralph-external/lib/claude-adapter.mjs');
      expect(new ClaudeDirectAdapter().getName()).toBe('claude-direct');
      expect(new ClaudeAdapter().getName()).toBe('claude');
      const registry = structuredClone(loadProviderModelCapabilities());
      const adapter = structuredClone(registry.providers.claude.workerHealthAdapter!);
      const profile = adapter.invocationProfiles!['direct-shell'];
      const controls = Object.keys(profile.controls);
      for (const control of Object.values(profile.controls)) Object.assign(control,
        { support: 'external', mapping: 'synthetic host boundary', evidence: 'fixture:host' });
      adapter.adapterVersion = JSON.parse(await readFile(path.join(f.installed, 'package.json'), 'utf8')).version;
      adapter.qualification = { status: 'qualified', fixtureDigest: await workerNegativeFixtureDigest(),
        verifiedAt: now, evidenceRef: WORKER_OPERATOR_APPROVAL };
      const modulePath = 'tools/ralph-external/lib/claude-adapter.mjs';
      const modules = [{ reference: adapter.runtimeDriver, packageRoot: f.installed, packageName: 'aiwg',
        packageVersion: adapter.adapterVersion, modulePath, interfaceVersion: 1, adapterIds: [adapter.id], platforms: ['linux'],
        sha256: qualificationDigestRaw(await readFile(path.join(f.installed, modulePath), 'utf8')) }];
      for (const provider of Object.values(registry.providers)) delete provider.workerAdapter;
      registry.workerAdapters = {};
      registry.providers.claude.workerAdapter = adapter;
      await loadInstalledWorkerAdapters({ registry, modules, workerWritableRoots: [f.project] });
      const driver = createProvider(adapter.id);
      const installation: any = { adapter, profile: 'direct-shell', cliVersion: version, now: Date.now(),
        executable: binary, cwd: f.project, workerWritableRoots: [f.project], modules,
        runtimeFiles: [path.join(f.installed, modulePath)], environment: { HOME: f.root, PATH: process.env.PATH },
        effectiveConfigDigest: qualificationDigest(models.defaults.workerSelection), accountScope: 'synthetic-account',
        policy: models.defaults.workerSelection, permissions: config.parallelism.groups.workers.execution,
        requiredControls: [], boundary: { kind: 'os', identity: 'fixture:host', digest: qualificationDigest('fixture:host'), controls } };
      installation.evidence = { scopeDigest: (await inspectWorkerInstallation(driver, installation)).scopeDigest,
        fixtureDigest: adapter.qualification.fixtureDigest, verifiedAt: now, evidenceRef: WORKER_OPERATOR_APPROVAL };
      worker.qualification = { ...adapter.qualification, roles: ['coding'] } as typeof worker.qualification;
      expect(await recordWorkerInstallation(driver, { cli, installation, projectDir: f.project,
        binding: { profile: 'direct-shell', cliVersion: version, accountScope: 'synthetic-account',
          endpointFingerprint: `local-cli:${cli}`, boundary: installation.boundary },
        modelObservations: { provider: cli, source: 'native', observedAt: now, runtimeVersion: version,
          accountScope: 'local-account', accountBinding: 'synthetic-account', models: [
          { id: 'synthetic-model', apiModelId: 'synthetic-model', llmProvider: 'synthetic', reasoningEfforts: worker.efforts.map(e => e.id), worker },
        ] } })).toMatchObject({ status: 'ENABLED' });
    }
    const record = JSON.parse(await readFile(path.join(f.config, 'worker-installations.json'), 'utf8')).registrations[0];
    expect(record.adapter.id).toBe(`${cli}-direct`);
    expect(record.signature).toBeDefined();
    const input = { registry: loadProviderModelCapabilities(), cwd: f.project,
      policy: models.defaults.workerSelection, parallelism: config.parallelism };
    const loaded = await loadRecordedWorkerInstallations(input);
    expect(loaded.qualificationFailures).toEqual({});
    expect(Object.keys(loaded.installations)).toEqual([cli]);
    expect(resolveWorkerAdapter(loaded.registry, `providers:${cli}`)).toEqual(record.adapter);
    const reloaded = await loadRecordedWorkerInstallations({ ...input, registry: loaded.registry });
    expect(resolveWorkerAdapter(reloaded.registry, `providers:${cli}`)).toEqual(record.adapter);
    const customRegistry = structuredClone(input.registry);
    customRegistry.workerAdapters = { ...customRegistry.workerAdapters, [record.adapter.id]: record.adapter };
    const customParallelism = structuredClone(config.parallelism);
    customParallelism.clis[cli].adapter = `workerAdapters:${record.adapter.id}`;
    const custom = await loadRecordedWorkerInstallations({ ...input, registry: customRegistry, parallelism: customParallelism });
    expect(resolveWorkerAdapter(custom.registry, `workerAdapters:${record.adapter.id}`)).toEqual(record.adapter);
    expect(custom.registry.providers[cli].workerAdapter).toBeUndefined();
    const probed = await f.run(['doctor', '--probe-workers', '--cli', cli, '--json']);
    expect(JSON.parse(probed.stdout).workers).toContainEqual(expect.objectContaining({ cli, ready: true }));
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout).invocation).toMatchObject({ readiness: 'launchable', selected: { cli } });
    // Equal bytes/version at another path still cannot replace the approved binary.
    const replacement = path.join(f.root, 'fake-bin/replacement');
    await copyFile(binary, replacement);
    config.parallelism.clis[cli].executable = replacement;
    await expect(loadRecordedWorkerInstallations(input)).rejects.toMatchObject({ code: 'OG_ADAPTER_UNQUALIFIED',
      details: { rejections: [{ registration: 0, reason: 'binary-identity' }] } });
  });

  it.each([false, true])('keeps custom adapters in workerAdapters without a matching provider slot (operator: %s)', async operator => {
    const f = await fixture();
    const id = operator ? 'fixture-operator' : 'fixture';
    f.installation.adapter.id = id; f.installation.modules[0].adapterIds = [id];
    f.instance.getName = () => id;
    const source = `export const interfaceVersion = 1; export function register(factory) { factory('${id}', () => ({ getName: () => '${id}', parseOutput: value => value })); }`;
    await writeFile(path.join(f.installation.modules[0].packageRoot, 'driver.mjs'), source, { mode: 0o644 });
    f.installation.modules[0].sha256 = qualificationDigestRaw(source);
    f.installation.policy = {};
    f.installation.effectiveConfigDigest = qualificationDigest(f.installation.policy);
    if (operator) {
      f.installation.adapter.provider = 'synthetic-provider';
      f.installation.adapter.qualification.evidenceRef = WORKER_OPERATOR_APPROVAL;
      f.installation.evidence.evidenceRef = WORKER_OPERATOR_APPROVAL;
    }
    f.installation.evidence.scopeDigest = (await inspectWorkerInstallation(f.instance, f.installation)).scopeDigest;
    vi.stubEnv('SYNTHETIC_SETTING', 'fixture-value');
    expect(await recordWorkerInstallation(f.instance, { cli: 'fixture', binding: f.binding, installation: f.installation }))
      .toMatchObject({ status: 'ENABLED' });
    const loaded = await loadRecordedWorkerInstallations({ registry: loadProviderModelCapabilities(), cwd: f.cwd, policy: f.installation.policy });
    expect(resolveWorkerAdapter(loaded.registry, `workerAdapters:${id}`).id).toBe(id);
    expect(loaded.registry.providers.codex.workerAdapter).toBeUndefined();
  });

  it('signs and stores canonical approvals, prunes deleted workspaces and replaces an existing exact key', async () => {
    const f = await fixture();
    const alias = path.join(f.root, 'workspace-alias');
    await symlink(f.cwd, alias);
    f.installation.cwd = alias;
    const filename = path.join(f.config, 'worker-installations.json');
    const live = { cli: 'peer', installation: { cwd: f.cwd } };
    const deleted = { cli: 'old', installation: { cwd: path.join(f.root, 'deleted') } };
    await writeFile(filename, JSON.stringify({ version: 1, registrations: [live, deleted] }), { mode: 0o600 });
    const options = { cli: 'fixture', binding: f.binding, installation: f.installation };
    expect(await recordWorkerInstallation(f.instance, options)).toMatchObject({ status: 'ENABLED', cliVersion: '1.0.0' });
    let stored = JSON.parse(await readFile(filename, 'utf8'));
    expect(stored.registrations).toHaveLength(2);
    expect(stored.registrations[0]).toEqual(live);
    expect(stored.registrations[1]).toMatchObject({ cli: 'fixture', signature: { projectDir: f.cwd },
      installation: { cwd: f.cwd, environmentNames: ['SYNTHETIC_SETTING'] } });
    expect(stored.registrations[1].installation).not.toHaveProperty('environment');
    expect(await recordWorkerInstallation(f.instance, options)).toMatchObject({ status: 'ENABLED' });
    stored = JSON.parse(await readFile(filename, 'utf8'));
    expect(stored.registrations.map((record: any) => record.cli)).toEqual(['peer', 'fixture']);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    await expect(access(`${filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
