import { copyNode } from '../../helpers/copy-node.js';
import { writeExecutable } from '../../helpers/write-executable.js';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { Socket } from 'node:net';
import { fixtureRevision, permissionChecks } from '../../fixtures/ralph-worker-protocol.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAdapter, workerNegativeFixtureDigest, workerNegativeFixtureSuite } from '../../../tools/ralph-external/lib/provider-adapter.mjs';
import { requiredWorkerControls } from '../../../src/models/provider-policy.js';
import { fixtureJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';

import { getWorkerRecoveryCapabilities as sourceRecoveryCapabilities } from '../../../src/models/worker-installation.mjs';
import { loadRecoveryModuleGraph } from '../../helpers/recovery-module-graph.mjs';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
import { SessionLauncher, directRecoveryEligibility, resetInProcessAllowanceLedger } from '../../../tools/ralph-external/session-launcher.mjs';

vi.mock('node:child_process', { spy: true });

// Force separate direct-source and resolver-selected registries even without
// dist/. CI selects dist before beforeEach forces src; both owners use WeakMaps.
vi.mock('../../../tools/_resolve-impl.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../tools/_resolve-impl.mjs')>();
  return { ...actual, importImpl: (caller: string, name: string) => name === 'models/worker-installation.mjs'
    ? import('../../../src/models/worker-installation.mjs?resolved-owner')
    : actual.importImpl(caller, name) };
});

// Register with the owner captured by the launcher, before per-test env stubs.
const { installation: { registerWorkerRecoveryCapabilities } } = await loadRecoveryModuleGraph();

const exec = promisify(execFile);
const roots: string[] = [];
const cli = path.resolve('test/fixtures/ralph-worker-cli.mjs');
const mcp = path.resolve('test/fixtures/ralph-worker-mcp.mjs');
const protocol = path.resolve('test/fixtures/ralph-worker-protocol.mjs');
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const now = Date.parse('2026-10-07T00:00:00Z');
class FixtureAdapter extends ProviderAdapter {
  fixtureCli = cli;
  workerFlags: string[] = [];
  getName() { return 'fixture'; }
  buildWorkerArgs(invocation: any) { return [...this.workerFlags, this.fixtureCli, '--model', invocation.selected.model, '--final-output', invocation.finalPath]; }
}
const driver = new FixtureAdapter();
beforeEach(() => vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

async function setup(provider = 'codex') {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-2885-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  const packageRoot = path.join(root, 'installed');
  await mkdir(cwd); await mkdir(packageRoot, { mode: 0o755 });
  // Installed copies have explicit trusted modes independent of checkout umask.
  for (const filename of [cli, protocol]) {
    await writeFile(path.join(packageRoot, path.basename(filename)), await readFile(filename), { mode: 0o644 });
  }
  const executable = await copyNode(packageRoot);
  const installedCli = path.join(packageRoot, path.basename(cli));
  driver.fixtureCli = installedCli;
  driver.workerFlags = [];
  const config = path.join(root, 'fixture.json');
  await writeFile(config, JSON.stringify({ version: '1.0.0', recordPath: path.join(cwd, 'record.json') }));
  const source = 'export const interfaceVersion = 1; export function register(factory) {}';
  await writeFile(path.join(packageRoot, 'driver.mjs'), source, { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-driver', version: '1.0.0', type: 'module' }), { mode: 0o644 });
  const adapter = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
  adapter.provider = provider;
  adapter.qualification = { status: 'qualified', fixtureDigest: digest('synthetic'), verifiedAt: new Date(now).toISOString(), evidenceRef: 'fixture:only' };
  adapter.invocation.versionArgv = [installedCli, '--qualification-version'];
  adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  const profile = adapter.invocationProfiles['fixture-shell'];
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  for (const control of Object.values(profile.controls) as any[]) {
    control.support = 'external'; control.mapping = 'fixture runner'; control.evidence = 'fixture:only';
  }
  const controls = requiredWorkerControls({});
  const request: any = { adapter, profile: 'fixture-shell', cliVersion: '1.0.0', requiredControls: controls,
    executable, platform: 'linux', cwd, workerWritableRoots: [cwd],
    modules: [{ reference: adapter.runtimeDriver, packageRoot, packageName: 'fixture-driver', packageVersion: '1.0.0',
      modulePath: 'driver.mjs', interfaceVersion: 1, sha256: digest(source), adapterIds: ['fixture'], platforms: ['linux'] }],
    runtimeFiles: [installedCli, path.join(packageRoot, path.basename(protocol))], effectiveConfigDigest: digest('fixture-config'), accountScope: 'synthetic-account',
    boundary: { kind: 'os', identity: 'synthetic-runner', digest: digest('fixture-boundary'), controls },
    environment: { AIWG_FAKE_WORKER_CONFIG: config }, endpoints: [], allowedEndpoints: [], now };
  const scope = await driver.inspectWorkerInstallation(request);
  request.evidence = { scopeDigest: scope.scopeDigest, fixtureDigest: await workerNegativeFixtureDigest(),
    verifiedAt: new Date(now).toISOString(), evidenceRef: 'fixture:synthetic-only',
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(id => [id, 'passed'])) };
  return { root, cwd, config, packageRoot, profile, request };
}

// Frozen synthetic host evidence tests the recheck separately from the actual
// bounded probe above. It cannot qualify a live vendor installation.
async function preparedFixture(f: Awaited<ReturnType<typeof setup>>) {
  const invocation = structuredClone(fixtureJson('mission-vectors.json').find((v: any) => v.id === 'resolved-shell').value);
  invocation.selected.profileRef = 'fixture-shell';
  Object.assign(invocation, { cwd: f.cwd, briefPath: path.join(f.cwd, 'brief'), stdoutPath: path.join(f.cwd, 'stdout'),
    stderrPath: path.join(f.cwd, 'stderr'), finalPath: path.join(f.cwd, 'final'), stdin: 'closed', envNames: ['AIWG_FAKE_WORKER_CONFIG'] });
  invocation.argv = [f.request.executable, ...driver.buildWorkerArgs(invocation)];
  f.request.invocation ??= structuredClone(invocation);
  const record = { ...f.request.evidence, scopeDigest: (await driver.inspectWorkerInstallation(f.request)).scopeDigest };
  f.request.evidence = record;
  f.profile.installationQualification = { scopeDigest: record.scopeDigest, fixtureDigest: record.fixtureDigest, verifiedAt: record.verifiedAt, evidenceRef: record.evidenceRef };
  invocation.selected.qualificationDigest = record.scopeDigest;
  const qualification: any = { adapter: f.request.adapter, cliVersion: '1.0.0', requiredControls: f.request.requiredControls,
    boundary: f.request.boundary, now, role: 'efficiency', policy: { roleGuidance: { efficiency: { allowNotApplicableEffort: true } } },
    modelObservation: { observedAt: new Date(now).toISOString(), lifecycle: 'active', effortSupport: 'not-applicable',
      dataUse: { processing: 'local', productImprovement: false, retentionDays: null } }, installation: f.request };
  vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', f.config);
  return { invocation, qualification };
}

function nodePermissionFlag(flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): string {
  for (const flag of ['--permission', '--experimental-permission']) {
    if (flags.has(flag)) return flag;
  }
  throw new Error('Node filesystem permission support is required for forbidden-effect fixtures');
}

describe('S1 scoped installation qualification (T-OG-03/10/14/15/19)', () => {
  it('registers recovery capabilities with the launcher owner when direct source imports use a separate registry', () => {
    const localDriver = registerWorkerRecoveryCapabilities({}, { canVerifyAttempt: false });
    expect(sourceRecoveryCapabilities(localDriver)).toBeNull();
    expect(directRecoveryEligibility({ gateEnabled: true, config: {},
      invocation: { selected: { cli: 'codex' } }, drivers: { codex: localDriver } }))
      .toEqual({ gated: false, reason: 'cli-cannot-verify-final' });
  });

  it('qualifies a private executable with explicit permissions independent of the runner Node', async () => {
    const f = await setup();
    const executable = await lstat(f.request.executable);
    expect(f.request.executable).toBe(path.join(f.packageRoot, 'node'));
    expect(executable.mode & 0o777).toBe(0o755);
    expect(executable.nlink).toBe(1);
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('ENABLED');
  });

  it('T-OG-22 blocks endpoint-free recovery with actionable intervention until an operator resets the scope', async () => {
    const f = await setup();
    const inputs = workerResolutionFixture();
    const adapter = inputs.snapshot.registry.providers.codex.workerAdapter!;
    adapter.invocationProfiles['fixture-shell'].envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocationProfiles['fixture-shell'].health = { version: 1, handshake: 'process-only', outputFraming: 'jsonl',
      signalParser: 'fixture:jsonl', sessionLogLocator: null, progressEvidence: [], stopEvidence: 'fixture:wait-only',
      fixtureRef: 'fixture:one-shot', qualifiedAt: inputs.request.now, statusOperation: null, cancelOperation: null };
    // The fixture CLI is a real node process; under full CI load startup alone can exceed 5s (run 83892).
    inputs.snapshot.config.parallelism!.health = { hardTimeoutSeconds: 60, terminateGraceSeconds: 1 };
    inputs.snapshot.config.parallelism!.retry = { maxAttempts: 2 };
    inputs.snapshot.installations.codex.boundary = f.request.boundary;
    let time = 0;
    const breaker = new ScopedFailureBreaker({ nowMs: () => time, jitterMs: () => 0 });
    const scopeKey = `installation:codex:${f.request.boundary.digest}`;
    const localDriver = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
      installation: f.request, boundary: f.request.boundary },
      buildInvocation: async (input: any) => ({ argv: [f.request.executable, driver.fixtureCli, '--model', input.selected.model,
        '--final-output', input.finalPath], stdin: 'closed', envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
      extractFinal: (text: string) => { try { return JSON.parse(text).result ?? null; } catch { return null; } } };
    registerWorkerRecoveryCapabilities(localDriver, {
      parseWorkerAttemptFinal: (output: any, options: any) => driver.parseWorkerAttemptFinal(output, { ...options, format: 'jsonl' }) });
    const launcher = new SessionLauncher();
    const summaries = vi.fn();
    launcher.on('recovery-transition', summaries);
    let dispatches = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No upstream request allowed'));
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', f.config);
    const launch = async (n: number, onDispatch = async () => {}) => {
      const brief = path.join(f.root, `brief-${n}.md`);
      await writeFile(brief, `synthetic endpoint-free task ${n}`);
      const plan = await resolveWorkerInvocation(inputs.snapshot, { role: 'coding', task: 'implementation', group: 'workers',
        brief, workdir: f.cwd, final_output: path.join(f.cwd, `final-${n}.json`) }, { codex: localDriver }, inputs.request.now);
      expect(plan.invocation, JSON.stringify(plan.diagnostics)).toBeDefined();
      const invocationPath = path.join(f.root, `plan-${n}.json`);
      await writeFile(invocationPath, JSON.stringify(plan));
      return launcher.launchWorker({ invocationPath, runDir: path.join(f.root, `run-${n}`), scopedBreaker: breaker,
        inputs: { snapshot: inputs.snapshot, drivers: { codex: localDriver } }, now: inputs.request.now,
        isolation: { mode: 'degraded', reason: 'synthetic manager' }, allowDegraded: true,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        launchIsolated: async ({ command, args, cwd, onDispatchCommit }: any) => {
          await onDispatchCommit();
          dispatches++;
          await onDispatch();
          return { mode: 'degraded', child: spawn(command, args, { cwd, detached: true,
            env: f.request.environment, stdio: ['ignore', 'pipe', 'pipe'] }) };
        } });
    };
    try {
      // Actual ENOENT launches open the qualified installation scope.
      // Restore identical binary bytes so the original qualification still binds.
      await unlink(f.request.executable);
      for (let n = 0; n < 3; n++) await expect(launch(n)).resolves.toMatchObject({ errorCode: 'ENOENT', attemptOutcome: 'failed' });
      expect(breaker.getState(scopeKey).state).toBe('open');
      await copyNode(f.packageRoot);
      time = 120_000;
      await expect(launch(3)).rejects.toMatchObject({ code: 'RECOVERY_OPERATOR_INTERVENTION',
        message: expect.stringContaining('probe-profile-unavailable; restore a qualified scope-relevant probe') });
      expect(breaker.getState(scopeKey).state).toBe('operator-intervention');
      expect(summaries.mock.calls.at(-1)?.[0]).toMatchObject({ scopeKey, to: 'operator-intervention',
        summary: expect.stringContaining('then reset this scope') });
      expect(dispatches).toBe(3);
      expect(breaker.reset(scopeKey)).toEqual({ ok: true });
      const result = await launch(4);
      expect(result.attemptOutcome, JSON.stringify(result, null, 2)).toBe('succeeded');
      expect(breaker.getState(scopeKey).state).toBe('closed');
      expect(dispatches).toBe(4);
      expect(breaker.snapshot().attemptsObserved).toBe(4);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await readdir(f.root)).not.toContain('.aiwg');
    } finally { breaker.destroy(); resetInProcessAllowanceLedger(); }
  }, 180_000);

  it('rejects a writable executable with multiple hard links', async () => {
    const f = await setup();
    await link(f.request.executable, path.join(f.cwd, 'node-alias'));
    const executable = await lstat(f.request.executable);
    expect(executable.mode & 0o777).toBe(0o755);
    expect(executable.nlink).toBeGreaterThan(1);
    await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow('Untrusted binary permissions');
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
  });

  it.each(['claude', 'muse', 'hermes'])('#2956 rejects caller control waivers for %s', async provider => {
    const f = await setup(provider);
    f.request.requiredControls = ['model'];
    f.request.policy = { guards: { denySelfDelegation: true } };
    f.request.permissions = { sandbox: 'external', approval: 'never' };
    f.request.boundary.kind = 'native';
    await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow(/sandbox.*external/);
    expect(await driver.qualifyWorkerInstallation(f.request)).toMatchObject({ status: 'DISABLED' });
  });

  it('#2956 binds the strictest controls when policy authority is absent', async () => {
    const f = await setup();
    f.request.requiredControls = ['model'];
    expect((await driver.inspectWorkerInstallation(f.request)).scopeDigest).toBe(f.request.evidence.scopeDigest);
    f.profile.controls.stepCap.support = 'unqualified';
    expect(await driver.qualifyWorkerInstallation(f.request)).toMatchObject({ status: 'DISABLED' });
  });

  it.each(['codex', 'muse', 'claude', 'hermes'])('enables a synthetic %s profile with no managed services or credential inheritance', async provider => {
    const f = await setup(provider);
    vi.stubEnv('UNRELATED_SECRET', 'never-copy-this');
    expect(await driver.qualifyWorkerInstallation(f.request)).toMatchObject({ status: 'ENABLED', cliVersion: '1.0.0' });
    expect(await readdir(f.root)).not.toContain('.aiwg');
    expect(JSON.stringify(await driver.inspectWorkerInstallation(f.request))).not.toContain('never-copy-this');
  });

  it.each([
    ['binary missing', (f: any) => { f.request.executable = path.join(f.root, 'absent'); }],
    ['unsupported platform', (f: any) => { f.request.platform = 'win32'; }],
    ['version range', (f: any) => { f.request.cliVersion = '2.0.0'; }],
    ['module digest', (f: any) => { f.request.modules[0].sha256 = digest('tampered'); }],
    ['URL module', (f: any) => { f.request.adapter.runtimeDriver = 'https://untrusted.invalid/driver.mjs'; }],
    ['missing module', (f: any) => { f.request.modules = []; }],
    ['duplicate module', (f: any) => { f.request.modules.push(structuredClone(f.request.modules[0])); }],
    ['writable module', (f: any) => { f.request.workerWritableRoots.push(f.packageRoot); }],
    ['controls changed', (f: any) => { f.profile.controls.sandbox.mapping = 'weaker'; }],
    ['effective config changed', (f: any) => { f.request.effectiveConfigDigest = digest('changed'); }],
    ['account changed', (f: any) => { f.request.accountScope = 'other-account'; }],
    ['boundary changed', (f: any) => { f.request.boundary.digest = digest('changed'); }],
    ['pinned executor changed', (f: any) => { f.request.boundary = { ...f.request.boundary, kind: 'executor', identity: 'other' }; }],
    ['unbounded children', (f: any) => { f.request.adapter.capabilities.nestedAgentsControllable = false; }],
    ['native fallback', (f: any) => { f.request.adapter.capabilities.nativeFallbackControllable = false; }],
    ['missing boundary control', (f: any) => { f.request.boundary.controls = []; }],
    ['unscoped environment', (f: any) => { f.request.environment.UNRELATED_SECRET = 'synthetic'; }],
    ['environment changed', (f: any) => { f.request.environment.AIWG_FAKE_WORKER_CONFIG = '/changed'; }],
    ['endpoint unapproved', (f: any) => { f.request.endpoints = ['https://blocked.invalid']; }],
    ['credential URL', (f: any) => { f.request.endpoints = f.request.allowedEndpoints = ['https://user:secret@blocked.invalid']; }],
    ['egress evidence absent', (f: any) => { delete f.request.evidence.cases['denied-egress']; }],
    ['write allowed', (f: any) => { f.request.evidence.cases['forbidden-write'] = 'failed'; }],
    ['scope forged', (f: any) => { f.request.evidence.scopeDigest = digest('wrong'); }],
    ['future evidence', (f: any) => { f.request.evidence.verifiedAt = '2030-01-01T00:00:00Z'; }],
    ['missing closure', (f: any) => { delete f.request.runtimeFiles; }],
    ['unbounded probe', (f: any) => { f.request.timeoutMs = Infinity; }],
  ] as const)('DISABLED: %s', async (_name, mutate) => {
    const f = await setup(); mutate(f);
    expect(await driver.qualifyWorkerInstallation(f.request)).toEqual({ status: 'DISABLED', reason: 'Installation missing, unsupported, changed or not qualified' });
  });

  it.each(['muse', 'claude', 'hermes'])('requires external enforcement for %s restricted tasks', async provider => {
    const f = await setup(provider);
    f.request.boundary.kind = 'native';
    await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow('external enforcing');
  });

  it('keeps local HTTP transport disabled until its own driver qualifies a bounded endpoint probe', async () => {
    const f = await setup('local');
    f.request.adapter.invocation = { kind: 'http', protocol: 'ollama', healthPath: '/api/version', modelsPath: '/api/tags', generatePath: '/api/generate' };
    await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow('HTTP installation requires');
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
  });

  it.each(['hang', 'oversize', 'wrong-version'])('bounds %s version probes and reports no raw output', async probe => {
    const f = await setup();
    await writeFile(f.config, JSON.stringify({ probe, version: '9.0.0' }));
    f.request.timeoutMs = 150; f.request.maxBytes = 1024;
    const start = Date.now();
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('hashes a real-Codex-sized binary but rejects binaries over 1 GiB', async () => {
    const f = await setup();
    const executable = path.join(f.packageRoot, 'large-binary');
    await writeFile(executable, '', { mode: 0o755 });
    // Sparse files exercise the streaming bound without a large allocation.
    await truncate(executable, 296865480);
    f.request.executable = executable;
    const scope = await driver.inspectWorkerInstallation(f.request);
    expect(scope.binary.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    await truncate(executable, 1024 * 1024 * 1024 + 1);
    await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow('Binary exceeds qualification byte bound');
  });

  it('invalidates changed binary bytes, executable permissions and runtime dependencies', async () => {
    const f = await setup();
    const binary = path.join(f.packageRoot, 'binary');
    await writeExecutable(binary, '#!/bin/sh\nprintf 1.0.0');
    f.request.executable = binary;
    f.request.evidence.scopeDigest = (await driver.inspectWorkerInstallation(f.request)).scopeDigest;
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('ENABLED');
    await writeExecutable(binary, '#!/bin/sh\nprintf 1.0.0\n#changed');
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
    await chmod(binary, 0o777);
    await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow('permissions');
    await chmod(binary, 0o755);
    const dependency = path.join(f.packageRoot, 'dependency.mjs');
    await writeFile(dependency, '// original', { mode: 0o644 });
    f.request.runtimeFiles = [dependency];
    const before = await driver.inspectWorkerInstallation(f.request);
    await writeFile(dependency, '// changed');
    expect((await driver.inspectWorkerInstallation(f.request)).scopeDigest).not.toBe(before.scopeDigest);
  });

  it('rechecks scoped metadata and authorizes exact driver argv through prepareWorkerInvocation', async () => {
    const f = await setup();
    const { invocation, qualification } = await preparedFixture(f);
    const prepared = await driver.prepareWorkerInvocation(invocation, qualification);
    expect(prepared.shellCommand).toContain('env -i');
    invocation.argv.push('--dangerously-skip-permissions');
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow('authorized driver');
    invocation.argv.pop();
    const originalStdout = invocation.stdoutPath;
    invocation.stdoutPath = path.join(f.root, 'forbidden');
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow('must be inside the worker-writable root');
    const escape = path.join(f.cwd, 'escape');
    await symlink(f.root, escape);
    invocation.stdoutPath = path.join(escape, 'forbidden');
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow('must be inside the worker-writable root');
    invocation.stdoutPath = originalStdout;
    invocation.cwd = f.root;
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow('qualified workspace');
    invocation.cwd = f.cwd;
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', 'changed-environment');
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow('launch environment');
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', f.config);
    f.profile.controls.sandbox.mapping = 'changed';
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow('qualification changed');
  });

  it.each(['brief', 'final_output'] as const)('#3192 resolve diagnoses %s outside the qualified root', async field => {
    const f = await setup();
    const inputs = workerResolutionFixture();
    const adapter = inputs.snapshot.registry.providers.codex.workerAdapter!;
    f.request.adapter = adapter;
    f.profile = adapter.invocationProfiles['fixture-shell'];
    f.request.policy = {};
    f.request.permissions = { transport: 'shell' };
    f.request.requiredControls = requiredWorkerControls({ policy: {}, permissions: f.request.permissions });
    // Retain the resolver fixture's model controls with the installed fixture's
    // external boundary, so the real installation owner enforces path scope.
    for (const control of Object.values(adapter.invocationProfiles['fixture-shell'].controls) as any[]) {
      control.support = 'external'; control.mapping = 'fixture runner';
    }
    adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocationProfiles['fixture-shell'].envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    const { qualification } = await preparedFixture(f);
    inputs.snapshot.installations.codex.boundary = f.request.boundary;
    const localDriver = {
      qualification: { ...qualification, adapterId: adapter.id },
      buildInvocation: async (input: any) => ({ argv: [f.request.executable, driver.fixtureCli, '--model', input.selected.model,
        '--final-output', input.finalPath], stdin: 'closed', envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
      prepareWorkerInvocation: (invocation: any, context: any) => driver.prepareWorkerInvocation(invocation, context),
    };
    const brief = path.join(f.cwd, 'brief.md');
    await writeFile(brief, 'Reply OK.');
    const request = { role: 'coding' as const, task: 'implementation', group: 'workers', brief,
      workdir: f.cwd, final_output: path.join(f.cwd, 'final.json') };
    const resolve = () => resolveWorkerInvocation(inputs.snapshot, request, { codex: localDriver }, inputs.request.now);
    const allowed = await resolve();
    expect(allowed.status, JSON.stringify({ diagnostics: allowed.diagnostics, exclusions: allowed.exclusions })).toBe('eligible');
    expect(allowed.invocation?.readiness).toBe('launchable');
    // A sibling with the same path prefix must still be refused.
    const outside = `${f.cwd}-outside`;
    await mkdir(outside);
    request[field] = path.join(outside, field === 'brief' ? 'brief.md' : 'final.json');
    if (field === 'brief') await writeFile(request.brief, 'Reply OK.');
    const blocked = await resolve();
    expect(blocked.status).toBe('blocked');
    expect(blocked.invocation).toBeUndefined();
    expect(blocked.diagnostics).toContainEqual({ code: 'OG_CONFIG_REFERENCE',
      pointer: field === 'brief' ? '/request/brief' : '/request/finalOutput',
      message: `${request[field]}${field === 'final_output' ? '.stdout' : ''} must be inside the worker-writable root ${f.cwd}.` });
  });

  it.each(['os', 'executor'])('binds the %s sandbox boundary to matching installation evidence before pure rendering', async kind => {
    const f = await setup('claude');
    f.request.boundary.kind = kind;
    const { invocation, qualification } = await preparedFixture(f);
    const { prepareWorkerInvocation } = await import('../../../src/serve/worker-invocation.js');
    const prepare = () => prepareWorkerInvocation(invocation, { ...qualification, adapterId: 'fixture' });
    await expect(prepare()).resolves.toHaveProperty('shellCommand');
    qualification.boundary = { ...qualification.boundary, digest: digest('caller-replacement') };
    await expect(prepare()).rejects.toThrow(/boundary.*(changed|evidence)|installation.*boundary/i);
    qualification.boundary = f.request.boundary;
    qualification.installation = { ...f.request, evidence: { ...f.request.evidence, scopeDigest: digest('another-installation') } };
    await expect(prepare()).rejects.toThrow(/installation.*(changed|evidence)/i);
  });
});

describe('T-OG-10/17 synthetic forbidden effects for every enabled profile and pinned boundary', () => {
  it('selects supported Node 20 and Node 24 permission flags and fails closed without either', () => {
    expect(nodePermissionFlag(new Set(['--experimental-permission']))).toBe('--experimental-permission');
    expect(nodePermissionFlag(new Set(['--permission']))).toBe('--permission');
    expect(nodePermissionFlag(new Set(['--permission', '--experimental-permission']))).toBe('--permission');
    expect(() => nodePermissionFlag(new Set())).toThrow('filesystem permission support');
  });

  it.each(['codex', 'muse', 'claude', 'hermes'].flatMap(provider => ['os', 'executor'].flatMap(kind => ['shell', 'mcp'].map(transport => [provider, kind, transport]))))('%s / %s / %s: denies sibling/home writes and observes a refused/blocked loopback connection', async (provider, kind, transport) => {
    const f = await setup(provider);
    f.request.boundary.kind = kind;
    const allowed = path.join(f.cwd, 'allowed');
    const sibling = path.join(f.root, 'sibling');
    const home = path.join(f.root, 'synthetic-home');
    const recordPath = path.join(f.cwd, 'record.json');
    const scenarioId = `T-OG-10-${provider}-${kind}-${transport}`;
    await writeFile(f.config, JSON.stringify({ scenarioId, recordPath, permissions: { writes: [allowed, sibling, home],
      endpoints: ['https://blocked.invalid', 'http://127.0.0.1:1', 'https://approved.invalid'], allowedEndpoints: ['https://approved.invalid'] } }));
    const flags = [nodePermissionFlag(), '--allow-fs-read=*', `--allow-fs-write=${f.cwd}`];
    driver.workerFlags = flags;
    f.profile.controls.sandbox.mapping = JSON.stringify(flags);
    f.request.effectiveConfigDigest = digest(await readFile(f.config, 'utf8'));
    const { invocation, qualification } = await preparedFixture(f);
    const prepared = await driver.prepareWorkerInvocation(invocation, qualification);
    const expected = { writes: ['allowed', 'denied', 'denied'], endpointDecisions: ['denied', 'denied', 'allowed'], connectionsEstablished: 0,
      socketAttempts: [{ endpoint: 'tcp://127.0.0.1:1', outcome: expect.stringMatching(/^(ECONNREFUSED|EPERM|EACCES)$/) }] };
    if (transport === 'shell') {
      await exec('/bin/sh', ['-c', prepared.shellCommand], { cwd: f.cwd, timeout: 5_000, env: f.request.environment });
      expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({ scenarioId, permissions: expected });
    } else {
      const child = spawn(f.request.executable, [...flags, mcp], { cwd: f.cwd, env: f.request.environment, stdio: 'pipe' });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'fixture/permissions' })}\n`);
      try { expect(await closed).toBe(0); } finally { clearTimeout(timer); child.kill('SIGKILL'); }
      expect(JSON.parse(output).result).toEqual(expected);
    }
    expect(await readFile(allowed, 'utf8')).toBe('synthetic effect');
    for (const forbidden of [sibling, home]) await expect(lstat(forbidden)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// Review regressions use a shell version probe so blocked nested Node launches
// cannot turn a failing authorization assertion into an accidental pass.
async function shellProbe(f: Awaited<ReturnType<typeof setup>>) {
  f.request.executable = path.join(f.packageRoot, 'version-probe');
  await writeExecutable(f.request.executable, '#!/bin/sh\nprintf 1.0.0');
  f.request.evidence.scopeDigest = (await driver.inspectWorkerInstallation(f.request)).scopeDigest;
}

describe('round 1 security regressions', () => {
  it.each(['Claude', 'CLAUDE', 'claude-code', ' Claude-Code ', 'claude ', 'Muse ', 'HERMES', 'unknown-provider', 'third-module', 'pi'])
    ('denies a native boundary for %j', async provider => {
      const f = await setup(provider);
      f.request.boundary.kind = 'native';
      await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow('external enforcing');
    });

  it.each([
    ['Claude', 'tool-allowlist'], ['claude-code', 'model-pin'], ['claude ', 'tool-allowlist'],
    ['Muse ', 'workspace-trust'], ['HERMES', 'run-config'],
    ...['unknown-provider', 'third-module', 'pi'].flatMap(provider =>
      ['children', 'fallback', 'tool-allowlist', 'model-pin', 'workspace-trust', 'run-config'].map(id => [provider, id])),
  ])('requires %s evidence case %s', async (provider, id) => {
    const f = await setup(provider);
    // Unknown/third-party rows retain the strictest cases even for smaller requests.
    if (['unknown-provider', 'third-module', 'pi'].includes(provider)) f.request.requiredControls = ['model'];
    await shellProbe(f);
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('ENABLED');
    delete f.request.evidence.cases[id];
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
  });

  it('rejects an arbitrary negative-suite digest despite passed case assertions', async () => {
    const f = await setup();
    await shellProbe(f);
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('ENABLED');
    f.request.evidence.fixtureDigest = digest('attacker-chosen-suite');
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
  });

  it.each(['native', 'external'])('rejects claimed %s sandbox mapping absent from driver argv at qualification', async support => {
    const f = await setup();
    const { invocation } = await preparedFixture(f);
    f.profile.controls.sandbox = { support, mapping: '["--sandbox","read-only"]', evidence: 'fixture:only' };
    f.request.invocation = invocation;
    await expect(driver.inspectWorkerInstallation(f.request)).rejects.toThrow(/control.*argv/);
  });

  it('rejects claimed native sandbox mapping absent from authorized preparation argv', async () => {
    const f = await setup();
    // Obtain a bound qualification whose representative argv contains the control.
    driver.workerFlags = ['--sandbox', 'read-only'];
    const { invocation: probe } = await preparedFixture(f);
    f.request.invocation = probe;
    f.profile.controls.sandbox = { support: 'native', mapping: '["--sandbox","read-only"]', evidence: 'fixture:only' };
    const { invocation, qualification } = await preparedFixture(f);
    const build = driver.buildWorkerArgs.bind(driver);
    vi.spyOn(driver, 'buildWorkerArgs').mockImplementation((value: any) =>
      value.finalPath === probe.finalPath ? build(value) : build(value).filter(arg => !['--sandbox', 'read-only'].includes(arg)));
    invocation.finalPath = path.join(f.cwd, 'another-final');
    invocation.argv = [f.request.executable, ...driver.buildWorkerArgs(invocation)];
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow(/control.*argv/);
  });

  it('rejects a forged fixture digest at preparation even when both evidence records agree', async () => {
    const f = await setup();
    const { invocation, qualification } = await preparedFixture(f);
    f.request.evidence.fixtureDigest = f.profile.installationQualification.fixtureDigest = digest('forged-suite');
    await expect(driver.prepareWorkerInvocation(invocation, qualification)).rejects.toThrow('evidence changed');
  });

  it('records a successful socket event instead of assuming zero connections', async () => {
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
      queueMicrotask(() => this.emit('connect'));
      return this;
    });
    const result = await permissionChecks({ writes: [], endpoints: [], allowedEndpoints: [] });
    expect(result).toMatchObject({ connectionsEstablished: 1,
      socketAttempts: [{ endpoint: 'tcp://127.0.0.1:1', outcome: 'connected' }] });
  });

  it('observes a real loopback socket attempt and its refused/blocked outcome', async () => {
    const connect = vi.spyOn(Socket.prototype, 'connect');
    const result = await permissionChecks({ writes: [], endpoints: ['https://blocked.invalid'], allowedEndpoints: [] });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ endpointDecisions: ['denied'], connectionsEstablished: 0,
      socketAttempts: [{ endpoint: 'tcp://127.0.0.1:1', outcome: expect.stringMatching(/^(ECONNREFUSED|EPERM|EACCES)$/) }] });
  });

  async function runProbe(argv: string[], probe = 'oversize') {
    const source = (await readFile(cli, 'utf8')).replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');
    const writes: string[] = [];
    const records: string[] = [];
    let flushed = false;
    let exitBeforeFlush = false;
    const exit = Symbol('fixture-exit');
    const context = {
      config: () => ({ probe, recordPath: 'record' }), fixtureRevision, scenarios: ['success'],
      claims: () => ({}), readFileSync: () => '', writeFileSync: (_path: string, value: string) => records.push(value),
      process: { argv: ['node', cli, ...argv], env: {}, cwd: () => '/fixture',
        stdout: { write: (value: string, callback?: () => void) => {
          writes.push(value); queueMicrotask(() => { flushed = true; callback?.(); }); return false;
        } }, exit: () => { exitBeforeFlush = !flushed; throw exit; } },
    };
    try { await runInNewContext(`(async () => {${source}\n})()`, context); }
    catch (error) { if (error !== exit) throw error; }
    return { writes, records, exitBeforeFlush };
  }

  it('flushes all 8192 probe bytes before exiting under backpressure', async () => {
    const result = await runProbe(['--qualification-version']);
    expect(result.writes.join('')).toHaveLength(8192);
    expect(result.exitBeforeFlush).toBe(false);
  });

  it.each([['--model', '--qualification-version'], ['--qualification-version', 'extra']])
    ('does not interpret task argv %j as an exact version probe', async (...argv) => {
      const result = await runProbe(argv);
      expect(result.records).toHaveLength(1);
      expect(result.writes.join('')).not.toBe('x'.repeat(8192));
    });

  it('bumps the changed shared fixture revision', () => {
    expect(fixtureRevision).toBe(2);
  });
});

describe('T-OG-14 version banner normalization (#2991)', () => {
  it('rejects changed captured version text even when leading zeros normalize to the recorded pin', async () => {
    const f = await setup();
    // Controlled bounded-probe output; keep real installation/scope inspection.
    let banner = 'fixture 2026.10.1';
    vi.mocked(spawn).mockImplementation(() => {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      queueMicrotask(() => { child.stdout.end(banner); child.emit('close', 0); });
      return child;
    });
    f.request.adapter.invocation.versionPattern = '^fixture ([0-9.]{1,32})$';
    f.request.cliVersion = f.request.adapter.supportedVersions = f.profile.supportedVersions = '2026.10.1';
    await writeFile(f.config, JSON.stringify({ version: 'fixture 2026.10.1' }));
    f.request.evidence.scopeDigest = (await driver.inspectWorkerInstallation(f.request)).scopeDigest;
    const recorded = await driver.qualifyWorkerInstallation(f.request);
    expect(recorded.status).toBe('ENABLED');
    f.request.versionProbe = { rawBanner: recorded.rawVersionBanner, version: recorded.cliVersion };
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('ENABLED');
    banner = 'fixture 2026.010.1';
    await writeFile(f.config, JSON.stringify({ version: banner }));
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
  });
  it.each([
    ['codex', 'codex-cli 0.161.0', '0.161.0'],
    ['muse', 'Muse Code 1.4.4 (1.4.4-R5419.1)', '1.4.4'],
    ['claude', '2.1.296 (Claude Code)', '2.1.296'],
    ['hermes', 'Hermes Agent v0.21.6+387.gdce1e9b (2026.9.24) · stable · local dce1e9b37581', '0.21.6+387.gdce1e9b'],
    ['cursor', '2026.10.01-e373342', '2026.10.1-e373342'],
    ['pi', '1.1.0', '1.1.0'],
  ])('%s passes range and installation pin checks once, retaining bounded raw evidence', async (provider, banner, version) => {
    const { loadProviderModelCapabilities, inspectWorkerInvocationProfile } = await import('../../../src/models/provider-policy.js');
    const { normalizeWorkerVersionBanner } = await import('../../../src/models/worker-installation.mjs');
    const registry = loadProviderModelCapabilities();
    const bundled: any = registry.providers[provider].workerAdapter ?? registry.providers[provider].workerHealthAdapter;
    const pattern = bundled.invocation.versionPattern;
    expect(normalizeWorkerVersionBanner(banner, pattern)).toBe(version);
    const f = await setup();
    f.request.adapter.invocation.versionPattern = pattern;
    f.request.adapter.supportedVersions = f.profile.supportedVersions = version;
    f.request.cliVersion = version;
    await writeFile(f.config, JSON.stringify({ version: banner }));
    f.request.evidence.scopeDigest = (await driver.inspectWorkerInstallation(f.request)).scopeDigest;
    expect(inspectWorkerInvocationProfile(f.request.adapter, { profile: f.request.profile, transport: 'shell',
      cliVersion: version, boundary: f.request.boundary })).toBe(f.profile);
    expect(await driver.qualifyWorkerInstallation(f.request)).toMatchObject({ status: 'ENABLED', cliVersion: version, rawVersionBanner: banner });
    await writeFile(f.config, JSON.stringify({ version: banner.replace(version.split('.')[0], '9') }));
    expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
    if (pattern) {
      await writeFile(f.config, JSON.stringify({ version: 'not a CLI banner' }));
      expect((await driver.qualifyWorkerInstallation(f.request)).status).toBe('DISABLED');
    }
  });
});
