// Preserve MCP driver delegation and installation rechecks alongside shell argv rendering.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { requiredWorkerControls } from '../../../src/models/provider-policy.js';
import { createProvider, inspectWorkerInstallation, loadInstalledWorkerAdapters,
  loadRecordedWorkerInstallations, recordWorkerInstallation, workerNegativeFixtureDigest,
  workerNegativeFixtureSuite } from '../../../src/models/worker-installation.mjs';
import { mcpToolSchemaDigest, resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('delegates recorded MCP invocations and rechecks their installation without rendering shell args', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-installed-mcp-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  const packageRoot = path.join(root, 'installed');
  const config = path.join(root, 'config');
  await Promise.all([mkdir(cwd), mkdir(packageRoot, { mode: 0o755 }), mkdir(config, { mode: 0o700 })]);
  vi.stubEnv('AIWG_CONFIG', config);
  await workerSigningFixture(root, cwd);
  const id = 'fixture-installed-mcp';
  const f = workerResolutionFixture();
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.id = id; adapter.provider = 'codex'; adapter.runtimeDriver = `installed:${id}`;
  const now = new Date().toISOString();
  adapter.qualification.verifiedAt = now;
  const profile = adapter.invocationProfiles!['fixture-shell'];
  profile.transport = 'mcp';
  for (const control of Object.values(profile.controls)) Object.assign(control,
    { support: 'external', mapping: 'synthetic host boundary', evidence: 'fixture:synthetic-only' });
  const schemas = { input: { type: 'object', required: ['model'], additionalProperties: false,
    properties: { model: { type: 'string' } } }, output: { type: 'object' } };
  const mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: mcpToolSchemaDigest(schemas.input),
    outputSchemaDigest: mcpToolSchemaDigest(schemas.output), sessionIsolation: 'per-call' as const, cancel: 'uncertain' as const };
  profile.mcp = mcp;
  const { cancel: _cancel, ...transportMcp } = mcp;
  const source = `export const interfaceVersion = 1;
export function register(factory) {
  factory('${id}', () => ({ getName: () => '${id}', parseOutput: value => value,
    buildWorkerArgs() { throw new Error('MCP must not render shell arguments'); },
    buildInvocation(input) { return { mcp: { ...${JSON.stringify(transportMcp)},
      arguments: { model: input.selected.model }, timeoutSeconds: 30 } }; }
  }));
}
`;
  await writeFile(path.join(packageRoot, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: id, version: adapter.adapterVersion, type: 'module' }), { mode: 0o644 });
  const executable = path.join(packageRoot, 'version-probe');
  await writeFile(executable, `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== '--version') process.exit(90);
console.log('1.0.0');
`, { mode: 0o755 });
  adapter.invocation.versionArgv = ['--version'];
  const modules = [{ reference: adapter.runtimeDriver, packageRoot, packageName: id, packageVersion: adapter.adapterVersion,
    modulePath: 'driver.mjs', interfaceVersion: 1, sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
    adapterIds: [id], platforms: ['linux'] }];
  delete f.snapshot.registry.providers.codex.workerAdapter;
  f.snapshot.registry.workerAdapters = { [id]: adapter };
  await loadInstalledWorkerAdapters({ registry: f.snapshot.registry, modules, workerWritableRoots: [cwd], platform: 'linux' });
  const owner = createProvider(id);
  const policy = f.snapshot.models.defaults.workerSelection!;
  const permissions = { transport: 'mcp' as const, sandbox: 'workspace-write' as const, approval: 'never' as const };
  const controls = requiredWorkerControls({ policy, permissions, effort: 'medium' });
  const boundary = { kind: 'os', identity: 'fixture:host', digest: qualificationDigest('fixture:host'), controls };
  const installation: any = { adapter, profile: 'fixture-shell', cliVersion: '1.0.0', executable, cwd,
    workerWritableRoots: [cwd], modules, runtimeFiles: [executable], environment: {}, policy, permissions,
    effectiveConfigDigest: qualificationDigest(policy), accountScope: 'synthetic', requiredControls: controls,
    boundary, mcp, mcpServerDigest: qualificationDigest('fixture:server') };
  installation.evidence = { scopeDigest: (await inspectWorkerInstallation(owner, installation)).scopeDigest,
    fixtureDigest: await workerNegativeFixtureDigest(), verifiedAt: now, evidenceRef: 'fixture:synthetic-only',
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(name => [name, 'passed'])) };
  const binding = { ...f.snapshot.installations.codex, mcp };
  expect(await recordWorkerInstallation(owner, { cli: id, installation, binding, mcpSchemas: schemas,
    mcpProfile: { servers: [mcp.serverRef] } })).toMatchObject({ status: 'ENABLED' });
  const loaded = await loadRecordedWorkerInstallations({ registry: f.snapshot.registry, cwd, policy });
  expect(loaded.qualificationFailures).toEqual({});
  const driver = loaded.drivers[id];
  // A local registry fixture supplies metadata only; no MCP connection is opened.
  const server = { name: mcp.serverRef, type: 'stdio', command: executable } as const;
  vi.spyOn(driver.mcpRegistry!, 'get').mockResolvedValue(server);
  const registration = vi.spyOn(driver.mcpRegistry!, 'assertWorkerQualified').mockResolvedValue(server);
  f.snapshot.registry = loaded.registry;
  f.snapshot.installations = loaded.installations;
  const group = f.snapshot.config.parallelism!.groups!.workers;
  group.execution = permissions;
  group.members = [{ ...group.members[0], cli: id }]; group.fallback = [];
  f.snapshot.config.parallelism!.clis = { [id]: { adapter: `workerAdapters:${id}`, accountScope: 'synthetic', quotaScope: 'fixture' } };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.models = discovery.models.slice(0, 1);
  discovery.observedAt = now;
  Object.assign(discovery.models[0].worker!, { cliId: id, observedAt: now, fetchedAt: now, verifiedAt: now });
  discovery.models[0].worker!.qualification.verifiedAt = now;
  f.snapshot.catalog.discovery!.instances = { [id]: discovery };
  f.snapshot.catalog.discovery!.fetchedAt = now;
  f.snapshot.hostResources!.collectedAt = now;
  const brief = path.join(cwd, 'brief.md');
  await writeFile(brief, 'Synthetic MCP task.');
  const plan = await resolveWorkerInvocation(f.snapshot, { role: 'coding', group: 'workers', task: 'implementation',
    brief, workdir: cwd, final_output: path.join(cwd, 'final.json'), transport: 'mcp' }, loaded.drivers, now);
  expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: plan.exclusions })).toMatchObject({
    readiness: 'launchable', transport: 'mcp', mcp: { ...transportMcp, arguments: { model: 'synthetic/a%b' }, timeoutSeconds: 30 } });
  expect(plan.invocation!.argv).toBeUndefined();
  expect(plan.invocation!.shellCommand).toBeUndefined();
  expect(registration).toHaveBeenCalledWith(mcp.serverRef, expect.objectContaining({
    cliVersion: '1.0.0', mcp, authorizedServerDigest: installation.mcpServerDigest }));
});
