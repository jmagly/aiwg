// Exercise recorded OpenCode versions through inspection, transport and preparation.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installWorkerAdapterPackage } from '../../helpers/worker-adapter-runtime.mjs';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { loadProviderModelCapabilities, requiredWorkerControls } from '../../../src/models/provider-policy.js';
import { createProvider, inspectWorkerInstallation, loadInstalledWorkerAdapters,
  loadRecordedWorkerInstallations, recordWorkerInstallation, workerNegativeFixtureDigest,
  workerNegativeFixtureSuite } from '../../../src/models/worker-installation.mjs';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';

const roots: string[] = [];
const model = 'synthetic/a%b';
let packageBase: string;
let modules: any[];
beforeAll(async () => {
  packageBase = await mkdtemp(path.join(tmpdir(), 'aiwg-opencode-package-'));
  const approved = JSON.parse(await readFile('test/fixtures/providers/opencode/approved-module.json', 'utf8'));
  const { packageRoot } = await installWorkerAdapterPackage(packageBase, approved.entry, await readFile(approved.source));
  modules = [{ ...approved.entry, packageRoot }];
});
afterAll(async () => { if (packageBase) await rm(packageBase, { recursive: true, force: true }); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function installedFixture(cliVersion: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-opencode-installed-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd);
  const config = path.join(root, 'config');
  await mkdir(config, { mode: 0o700 });
  vi.stubEnv('AIWG_CONFIG', config);
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  await workerSigningFixture(root, cwd);
  const executable = path.join(root, 'opencode');
  // The only spawned operation is this local version probe; no model is called.
  await writeFile(executable, `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== '--version') process.exit(90);
console.log(${JSON.stringify(cliVersion)});
`, { mode: 0o755 });
  const now = new Date().toISOString();
  const registry = structuredClone(loadProviderModelCapabilities());
  const adapter = structuredClone(registry.providers.opencode.workerHealthAdapter!);
  const profile = adapter.invocationProfiles!['direct-shell'];
  const fixtureDigest = await workerNegativeFixtureDigest();
  adapter.qualification = { status: 'qualified', fixtureDigest, verifiedAt: now, evidenceRef: 'fixture:synthetic-only' };
  Object.assign(adapter.capabilities, { effort: 'explicit', modelPin: 'requested',
    nestedAgentsControllable: true, nativeFallbackControllable: true });
  // Synthetic host controls only: the shipped unqualified profile is unchanged.
  const controls = Object.keys(profile.controls);
  for (const control of Object.values(profile.controls)) Object.assign(control,
    { support: 'external', mapping: 'synthetic host boundary', evidence: 'fixture:synthetic-only' });
  Object.assign(profile.controls.model, { support: 'native', mapping: '-m' });
  for (const provider of Object.values(registry.providers)) delete provider.workerAdapter;
  registry.workerAdapters = { [adapter.id]: adapter };
  await loadInstalledWorkerAdapters({ registry, modules, workerWritableRoots: [cwd], platform: 'linux' });
  const owner = createProvider(adapter.id);
  const f = workerResolutionFixture();
  const policy = f.snapshot.models.defaults.workerSelection!;
  policy.guards!.denySelfDelegation = false;
  const permissions = { sandbox: 'external' as const, approval: 'never' as const };
  const briefPath = path.join(cwd, 'brief.md');
  await writeFile(briefPath, 'Synthetic installation version test.');
  const invocation = { cliVersion: '3.0.0', selected: { model, effort: { value: 'medium' } }, cwd, briefPath, permissions };
  const boundary = { kind: 'os', identity: 'fixture:host', digest: qualificationDigest('fixture:host'), controls };
  const installation: any = { adapter, profile: 'direct-shell', cliVersion, executable, cwd,
    platform: 'linux', workerWritableRoots: [cwd], modules, runtimeFiles: [executable], environment: {},
    effectiveConfigDigest: qualificationDigest(policy), policy, permissions, accountScope: 'synthetic',
    requiredControls: requiredWorkerControls({ policy, permissions, effort: 'medium' }), boundary, invocation };
  const render = vi.spyOn(owner, 'buildWorkerArgs');
  const scope = await inspectWorkerInstallation(owner, installation);
  expect(render).toHaveBeenCalledWith(expect.objectContaining({ cliVersion }), profile, permissions);
  expect(render.mock.results[0].value).toEqual(expectedArgs(cliVersion, briefPath));
  installation.evidence = { scopeDigest: scope.scopeDigest, fixtureDigest, verifiedAt: now,
    evidenceRef: 'fixture:synthetic-only',
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(id => [id, 'passed'])) };
  expect(await recordWorkerInstallation(owner, { cli: 'opencode', installation,
    binding: { profile: 'direct-shell', cliVersion, accountScope: 'synthetic',
      endpointFingerprint: 'fixture:loopback', identityEvidence: 'runtime-configured' } })).toMatchObject({ status: 'ENABLED' });
  const loaded = await loadRecordedWorkerInstallations({ registry, cwd, policy });
  expect(loaded.qualificationFailures).toEqual({});
  return { f, loaded, cwd, briefPath, permissions, cliVersion, now };
}

function expectedArgs(cliVersion: string, briefPath: string) {
  const modelArgs = cliVersion.startsWith('1.') ? ['-m', model, '--variant', 'medium'] : ['-m', `${model}#medium`];
  return ['run', '--format', 'json', ...modelArgs, '-f', briefPath,
    'Follow the instructions in the attached file exactly.'];
}

describe('OpenCode installed worker version binding', () => {
  it.each(['1.19.5', '2.0.26'])('uses recorded %s for control inspection, argv and preparation', async cliVersion => {
    const { f, loaded, cwd, briefPath, permissions, now } = await installedFixture(cliVersion);
    const driver = loaded.drivers.opencode;
    const input: any = { cliVersion: '3.0.0', selected: { model, effort: { value: 'medium' } }, cwd, briefPath, permissions };
    const transport = await driver.buildInvocation!(input);
    expect(transport).toEqual({ argv: [path.join(path.dirname(cwd), 'opencode'), ...expectedArgs(cliVersion, briefPath)],
      stdin: 'closed', envNames: [] });
    expect(input.cliVersion).toBe('3.0.0');

    f.snapshot.registry = loaded.registry;
    f.snapshot.registry.providers.opencode.workerAdapter = driver.qualification.adapter;
    f.snapshot.installations = loaded.installations;
    const group = f.snapshot.config.parallelism!.groups!.workers;
    group.execution = permissions;
    group.members = [{ ...group.members[0], cli: 'opencode', model }];
    group.fallback = [];
    const discovery = f.snapshot.catalog.discovery!.instances!.codex;
    Object.assign(discovery, { provider: 'opencode', runtimeVersion: cliVersion, observedAt: now });
    discovery.models = discovery.models.slice(0, 1);
    Object.assign(discovery.models[0].worker!, { cliId: 'opencode', runtimeVersion: cliVersion,
      observedAt: now, fetchedAt: now, verifiedAt: now });
    discovery.models[0].worker!.qualification.verifiedAt = now;
    f.snapshot.catalog.discovery!.instances = { opencode: discovery };
    f.snapshot.catalog.discovery!.fetchedAt = now;
    f.snapshot.hostResources!.collectedAt = now;
    const plan = await resolveWorkerInvocation(f.snapshot, { role: 'coding', group: 'workers', task: 'implementation',
      brief: briefPath, workdir: cwd, final_output: path.join(cwd, 'final.json'), transport: 'shell' }, loaded.drivers, now);
    expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: plan.exclusions })).toMatchObject({ readiness: 'launchable',
      argv: transport.argv, stdin: 'closed', selected: { cli: 'opencode', model } });
    expect(plan.invocation!.shellCommand).toContain('< /dev/null');
    // Preparation independently recomputes argv from the recorded CLI version.
    const qualification = { ...driver.qualification, now: Date.parse(now), role: 'coding',
      policy: f.snapshot.models.defaults.workerSelection, permissions,
      modelObservation: discovery.models[0].worker } as any;
    await expect(driver.prepareWorkerInvocation!({ ...plan.invocation!, argv: [...transport.argv!, '--variant', 'wrong'] },
      qualification)).rejects.toThrow('Worker argv/stdin differs from the authorized driver mapping');
  });
});
