import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { findRelativeImportSpecifiers } from '../helpers/packed-relative-imports.mjs';
import { buildCliPackage } from '../../tools/release/build-cli-package.mjs';
import { fixtureJson, fixtureRoot } from '../conformance/mission-v1/worker-contract-fixtures.js';
import { workerInputSchema } from '../fixtures/ralph-worker-protocol.mjs';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

describe('T-OG-14 published package installed adapter paths', () => {
  it('@aiwg/cli packs the complete worker-invoke runtime import graph', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-closure-'));
    roots.push(root);
    const stage = path.join(root, 'stage');
    await buildCliPackage({ outputDir: stage });
    const { stdout } = await exec('npm', ['pack', stage, '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
        npm_config_cache: path.join(root, 'cache'), npm_config_update_notifier: 'false' },
    });
    const files = new Set(JSON.parse(stdout)[0].files.map((file: any) => file.path));
    // These URL-based imports construct their paths rather than using literal
    // specifiers. Literal importImpl/loadRalphExternal calls are followed below.
    const constructedImports: Record<string, string[]> = {
      'dist/src/mcp/tools/worker-invoke.mjs': ['tools/_resolve-impl.mjs'],
      'dist/src/mcp/tools/worker-shell-control.mjs': ['tools/ralph-external/lib/systemd-client.mjs'],
      'tools/ralph-external/lib/session-environment.mjs': ['agentic/code/providers/model-capabilities.v1.json'],
      'tools/scripts/resource-preflight.mjs': [
        'dist/src/config/dispatch-thresholds-runtime.mjs', 'dist/src/config/project-artifacts-runtime.mjs',
      ],
    };
    const pending = ['dist/src/mcp/tools/worker-invoke.mjs'];
    const visited = new Set<string>();
    while (pending.length) {
      const filename = pending.pop()!;
      if (visited.has(filename)) continue;
      visited.add(filename);
      const source = await readFile(path.resolve(filename), 'utf8');
      const imports = findRelativeImportSpecifiers(filename, source)
        .map(({ spec }: { spec: string }) => path.posix.join(path.posix.dirname(filename), spec));
      imports.push(...(constructedImports[filename] ?? []));
      const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const arg = node.arguments[node.arguments.length - 1];
          if (arg && ts.isStringLiteralLike(arg)) {
            if (node.expression.text === 'importImpl') imports.push(`dist/src/${arg.text}`);
            if (node.expression.text === 'loadRalphExternal') imports.push(`tools/ralph-external/${arg.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      pending.push(...imports);
    }
    expect([...visited].filter(filename => !files.has(filename))).toEqual([]);
  }, 60_000);

  it.each(['aiwg', '@aiwg/cli'])('%s loads session environment policy from an extracted package', async target => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-session-env-package-'));
    roots.push(root);
    const stage = path.join(root, 'stage');
    if (target === '@aiwg/cli') await buildCliPackage({ outputDir: stage });
    const { stdout } = await exec('npm', ['pack', target === 'aiwg' ? process.cwd() : stage,
      '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: root, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
        npm_config_cache: path.join(root, 'cache'), npm_config_update_notifier: 'false' },
    });
    const packed = JSON.parse(stdout)[0];
    const files = packed.files.map((file: any) => file.path);
    expect(files).toContain('tools/ralph-external/lib/session-environment.mjs');
    expect(files).toContain('agentic/code/providers/model-capabilities.v1.json');
    await exec('tar', ['-xzf', path.join(root, packed.filename), '-C', root]);
    // No checkout fallback or dependency install: this module must find its
    // provider policy using only its package-relative URL in the shipped tree.
    const { stdout: result } = await exec(process.execPath, ['--input-type=module', '-e', `
      import { buildSessionEnvironment } from './package/tools/ralph-external/lib/session-environment.mjs';
      console.log(JSON.stringify(buildSessionEnvironment('codex', {}, {
        OPENAI_API_KEY: 'synthetic-provider', AIWG_GITEA_TOKEN: 'synthetic-denied',
      })));
    `], { cwd: root, timeout: 10_000, env: { PATH: process.env.PATH, HOME: root } });
    expect(JSON.parse(result)).toEqual({ OPENAI_API_KEY: 'synthetic-provider' });
  }, 60_000);

  it.each(['aiwg', '@aiwg/cli'])('%s loads a third module and catalog outside the checkout', async target => {
    // Build prerequisite: npx tsc && npm run build:copy-mjs. Registry installs
    // use only public package dependencies; no model service or account store.
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-package-'));
    roots.push(root);
    const stage = path.join(root, 'stage');
    const source = target === 'aiwg' ? process.cwd() : stage;
    if (target === '@aiwg/cli') await buildCliPackage({ outputDir: stage });
    await writeFile(path.join(root, 'empty.npmrc'), '');
    await writeFile(path.join(root, 'empty-global.npmrc'), '');
    const { stdout } = await exec('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: root, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), npm_config_userconfig: path.join(root, 'empty.npmrc'), npm_config_globalconfig: path.join(root, 'empty-global.npmrc'), npm_config_cache: path.join(root, 'cache'), npm_config_update_notifier: 'false' },
    });
    const packed = JSON.parse(stdout)[0];
    expect(packed.name).toBe(target);
    const files = new Set(packed.files.map((file: any) => file.path));
    for (const required of ['tools/ralph-external/lib/provider-adapter.mjs', 'tools/ralph-external/lib/worker-health.mjs', 'tools/_resolve-impl.mjs',
      'dist/src/models/provider-policy.js', 'dist/src/serve/worker-invocation.js', 'schemas/models/provider-model-capabilities.v1.schema.json']) expect(files.has(required), required).toBe(true);
    if (target === 'aiwg') expect(files.has('tools/ralph-external/index.mjs')).toBe(true);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const npmEnv = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), npm_config_cache: process.env.AIWG_PACKAGE_TEST_NPM_CACHE ?? path.join(root, 'cache'),
      npm_config_userconfig: path.join(root, 'empty.npmrc'), npm_config_globalconfig: path.join(root, 'empty-global.npmrc'),
      npm_config_update_notifier: 'false' };
    await exec('npm', ['install', path.join(root, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund',
      '--fetch-retries=0', '--fetch-timeout=10000', ...(process.env.AIWG_PACKAGE_TEST_NPM_CACHE ? ['--offline'] : [])], {
      cwd: root, timeout: 90_000, maxBuffer: 65536, env: npmEnv,
    });
    const installed = path.join(root, 'node_modules', target);
    expect((await lstat(installed)).isSymbolicLink()).toBe(false);
    await expect(lstat(path.join(installed, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
    const driverRoot = path.join(root, 'fixture-driver');
    await mkdir(driverRoot, { mode: 0o755 });
    await cp(path.join(fixtureRoot, 'third-worker-adapter.mjs'), path.join(driverRoot, 'driver.mjs'));
    await chmod(path.join(driverRoot, 'driver.mjs'), 0o644);
    const driver = await readFile(path.join(driverRoot, 'driver.mjs'));
    await writeFile(path.join(driverRoot, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
    const metadata = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
    metadata.id = 'third-fixture'; metadata.runtimeDriver = 'installed:third-fixture';
    metadata.catalogAdapter = { kind: 'module', locator: 'installed:third-fixture', parser: 'fixture-v1' };
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    for (const filename of ['ralph-worker-cli.mjs', 'ralph-worker-protocol.mjs']) {
      await cp(path.resolve('test/fixtures', filename), path.join(driverRoot, filename));
      await chmod(path.join(driverRoot, filename), 0o644);
    }
    const fixtureConfig = path.join(root, 'fake-worker-config.json');
    await writeFile(fixtureConfig, JSON.stringify({ version: '1.0.0' }));
    const request = {
      metadata, modules: [{ reference: metadata.runtimeDriver, packageRoot: driverRoot, packageName: 'fixture-driver', packageVersion: '1.0.0',
        modulePath: 'driver.mjs', interfaceVersion: 1, sha256: `sha256:${createHash('sha256').update(driver).digest('hex')}`,
        adapterIds: [metadata.id], platforms: ['linux'] }], workerWritableRoots: [workspace],
    };
    const invocation = structuredClone(fixtureJson('mission-vectors.json').find((v: any) => v.id === 'resolved-shell').value);
    const profileAdapter = structuredClone(metadata);
    profileAdapter.id = 'claude';
    for (const control of Object.values(profileAdapter.invocationProfiles['fixture-shell'].controls) as any[]) {
      control.support = 'external'; control.mapping = 'synthetic installed fixture boundary';
    }
    profileAdapter.invocation.stdin = 'closed';
    profileAdapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    profileAdapter.invocation.versionArgv = [path.join(driverRoot, 'ralph-worker-cli.mjs'), '--qualification-version'];
    profileAdapter.invocationProfiles['fixture-shell'].envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    profileAdapter.qualification = { status: 'qualified', fixtureDigest: invocation.selected.qualificationDigest,
      verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only' };
    profileAdapter.invocationProfiles = { [invocation.selected.profileRef]: structuredClone(profileAdapter.invocationProfiles['fixture-shell']) };
    const mcpInvocation = structuredClone(fixtureJson('mission-vectors.json').find((v: any) => v.id === 'resolved-mcp').value);
    const schemas = { input: workerInputSchema, output: { type: 'object' } };
    for (const key of ['input', 'output'] as const) {
      mcpInvocation.mcp[`${key}SchemaDigest`] = `sha256:${createHash('sha256').update(JSON.stringify(schemas[key])).digest('hex')}`;
    }
    mcpInvocation.mcp.arguments = { invocationId: 'installed-transport-fixture', workspace: mcpInvocation.cwd,
      selection: { provider: mcpInvocation.selected.inferenceProvider, model: mcpInvocation.selected.model, effort: null }, brief: 'Synthetic installed brief' };
    const mcpAdapter = structuredClone(profileAdapter);
    const mcpProfile = mcpAdapter.invocationProfiles[mcpInvocation.selected.profileRef];
    mcpProfile.transport = 'mcp';
    const { arguments: _arguments, timeoutSeconds: _timeout, ...binding } = mcpInvocation.mcp;
    mcpProfile.mcp = { ...binding, cancel: 'uncertain' };
    Object.assign(request, { invocation, profileAdapter, mcpInvocation, mcpAdapter, schemas });
    await writeFile(path.join(root, 'request.json'), JSON.stringify(request));
    await writeFile(path.join(installed, 'probe.mjs'), `
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SessionLauncher } from './tools/ralph-external/session-launcher.mjs';
import { registerWorkerInvokeToolset } from './dist/src/mcp/tools/worker-invoke.mjs';
if (typeof SessionLauncher !== 'function' || typeof registerWorkerInvokeToolset !== 'function') throw new Error('Installed worker runtime unavailable');
import { loadProviderModelCapabilities, resolveWorkerInstallation, requiredWorkerControls } from './dist/src/models/provider-policy.js';
import { qualificationDigest } from './dist/src/models/qualification-digest.mjs';
import { ProviderAdapter, createProvider, ensureProvidersRegistered, listProviders, workerNegativeFixtureDigest, workerNegativeFixtureSuite } from './tools/ralph-external/lib/provider-adapter.mjs';
const { metadata, invocation, profileAdapter, mcpInvocation, mcpAdapter, schemas, ...trusted } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const registry = { ...loadProviderModelCapabilities(), workerAdapters: { fixture: metadata } };
await ensureProvidersRegistered({ registry, ...trusted });
const adapter = createProvider(metadata.id);
const cwd = trusted.workerWritableRoots[0];
const fixtureCli = path.join(trusted.modules[0].packageRoot, 'ralph-worker-cli.mjs');
class QualifiedFixtureDriver extends ProviderAdapter {
  getName() { return 'claude'; }
  buildWorkerArgs(value) { return [fixtureCli, '--model', value.selected.model, '--final-output', value.finalPath]; }
}
const driver = new QualifiedFixtureDriver();
const selectionEvidence = {
  role: 'efficiency',
  permissions: { sandbox: 'workspace-write', approval: 'never' },
  boundary: { kind: 'os', identity: 'fixture:external-boundary', digest: qualificationDigest('synthetic installed fixture'), controls: requiredWorkerControls({}) },
  policy: { roleGuidance: { efficiency: { groups: ['synthesis'], tier: 'economy',
    initialEffort: null, effortLadder: [], allowNotApplicableEffort: true } } },
  modelObservation: { observedAt: '2026-10-07T00:00:00Z', lifecycle: 'active',
    effortSupport: 'not-applicable', dataUse: { processing: 'local', productImprovement: false, retentionDays: null } },
};
async function prepareQualified(value, metadata) {
  Object.assign(value, { cwd, briefPath: path.join(cwd, 'brief'), stdoutPath: path.join(cwd, 'stdout'),
    stderrPath: path.join(cwd, 'stderr'), finalPath: path.join(cwd, 'final') });
  if (value.transport === 'shell') {
    Object.assign(value, { argv: [process.execPath, ...driver.buildWorkerArgs(value)], stdin: 'closed', envNames: ['AIWG_FAKE_WORKER_CONFIG'] });
  } else value.mcp.arguments.workspace = cwd;
  const profile = metadata.invocationProfiles[value.selected.profileRef];
  const qualification = { ...selectionEvidence, adapter: metadata, cliVersion: '1.0.0', requiredControls: ['model'],
    now: Date.parse('2026-10-07T00:00:00Z'), platform: 'linux',
    ...(value.transport === 'mcp' ? { mcp: profile.mcp, mcpSchemas: schemas } : {}) };
  const installation = { ...qualification, ...trusted, modules: trusted.modules.map(entry => ({ ...entry, adapterIds: ['claude'] })),
    profile: value.selected.profileRef, executable: process.execPath, cwd, runtimeFiles: [fixtureCli, path.join(path.dirname(fixtureCli), 'ralph-worker-protocol.mjs')],
    accountScope: 'fixture-only', effectiveConfigDigest: qualificationDigest({}), environment: { AIWG_FAKE_WORKER_CONFIG: process.env.AIWG_FAKE_WORKER_CONFIG },
    effort: value.selected.effort.value,
    ...(value.transport === 'mcp' ? { mcpServerDigest: qualificationDigest(profile.mcp) } : {}) };
  const scope = await driver.inspectWorkerInstallation(installation);
  installation.evidence = { scopeDigest: scope.scopeDigest, fixtureDigest: await workerNegativeFixtureDigest(),
    verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:installed-negative-suite',
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(id => [id, 'passed'])) };
  const qualified = await driver.qualifyWorkerInstallation(installation);
  if (qualified.status !== 'ENABLED') throw new Error('Synthetic package installation qualification failed');
  const { scopeDigest, fixtureDigest, verifiedAt, evidenceRef } = qualified;
  profile.installationQualification = { scopeDigest, fixtureDigest, verifiedAt, evidenceRef };
  value.selected.qualificationDigest = scopeDigest;
  return driver.prepareWorkerInvocation(value, { ...qualification, installation });
}
const prepared = await prepareQualified(invocation, profileAdapter);
const preparedMcp = await prepareQualified(mcpInvocation, mcpAdapter);
console.log(JSON.stringify({ name: adapter.getName(), catalog: adapter.catalog(),
  executable: resolveWorkerInstallation(registry, { adapter: 'workerAdapters:fixture' }).executable,
  builtinNames: listProviders().filter(name => name !== metadata.id).sort(),
  prepared: prepared.selected.model, rendered: prepared.shellCommand.includes('env -i'),
  mcpPrepared: preparedMcp.mcp.arguments.selection.model,
}));
`);
    const result = await exec(process.execPath, [path.join(installed, 'probe.mjs'), path.join(root, 'request.json')], {
      cwd: workspace, timeout: 10_000, maxBuffer: 65536,
      env: { PATH: process.env.PATH, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_FAKE_WORKER_CONFIG: fixtureConfig },
    });
    expect(JSON.parse(result.stdout)).toEqual({ name: 'third-fixture', catalog: [{ id: 'synthetic-model', provider: 'synthetic-inference' }], executable: 'fixture-worker',
      builtinNames: ['claude', 'codex', 'deepseek-harness', 'dsh', 'factory', 'muse', 'omp', 'opencode', 'pi'],
      prepared: invocation.selected.model, rendered: true, mcpPrepared: invocation.selected.model });
  }, 120_000);
});
