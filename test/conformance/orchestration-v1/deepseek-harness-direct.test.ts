import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2909 (B-OG-44) DeepSeek Harness (`dsh`) promotion: offline S1 profile
 * work. T-OG-15 renders the version-bound `deepseek-harness-direct`
 * profile through the real resolver and #2887 renderer, then executes the
 * resolved invocation through the launcher against a synthetic `dsh` that records argv, cwd,
 * the patch file contents, stdin brief and environment names. T-OG-20/21
 * drive the same fake through the #2896 health observer and the real
 * `parseWorkerFinal` hook. Spawns are plain child processes (no systemd);
 * nothing reaches a network, model, credential or MC state. Fixture
 * qualification here is synthetic and never live qualification: the
 * bundled profile stays unqualified (DH08).
 */
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { DEEPSEEK_HARNESS_DIRECT_EFFORT_VALUES, DEEPSEEK_HARNESS_DIRECT_STDIN,
  DeepSeekHarnessDirectAdapter, buildDeepSeekHarnessPatch, deepSeekHarnessPatchPath,
  parseDeepSeekHarnessTerminal } from '../../../tools/ralph-external/lib/deepseek-harness-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/deepseek-harness/fake-dsh-direct.mjs');
const VERSION = '0.2.0-rc.2';
const MODEL = 'deepseek-v4-pro';
const EFFORT = 'low';
const MARKER = 'DSH-BRIEF-MARKER-7a1c9e';
const MODULE = 'tools/ralph-external/lib/deepseek-harness-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/deepseek-harness/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const owner = new DeepSeekHarnessDirectAdapter();
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved module into a fresh, read-only
 * package root (mirrors codex-adapter.mjs's/openclaw-adapter.mjs's own
 * installed-loader test fixture). */
async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-dsh-install-')); installRoots.push(base);
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'deepseek-harness-adapter.mjs'), bytes, { mode: 0o644 });
  await copyWorkerAdapterRuntime(base, packageRoot);
  // Legacy class in the same module file imports this transport module too.
  // '../../providers/...' from pkg/lib resolves to base/providers/... (pkg/lib
  // mirrors tools/ralph-external/lib; base mirrors tools/).
  await mkdir(path.join(base, 'providers'), { recursive: true, mode: 0o755 });
  await copyFile(path.resolve('tools/providers/deepseek-harness-transport.mjs'), path.join(base, 'providers', 'deepseek-harness-transport.mjs'));
  await chmod(path.join(base, 'providers', 'deepseek-harness-transport.mjs'), 0o644);
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  // The transport signals children through process/signal-child.mjs (#3194).
  await mkdir(path.join(base, 'src', 'process'), { recursive: true, mode: 0o755 });
  await writeFile(path.join(base, 'src', 'process', 'signal-child.mjs'),
    `export * from ${JSON.stringify(path.relative(path.join(base, 'src', 'process'), path.resolve('src/process/signal-child.mjs')))};\n`);
  await mkdir(path.join(base, 'src', 'mission-protocol'), { recursive: true, mode: 0o755 });
  const missionTarget = path.resolve('src/mission-protocol/index.ts');
  const missionRelative = path.relative(path.join(base, 'src', 'mission-protocol'), missionTarget);
  await writeFile(path.join(base, 'src', 'mission-protocol', 'index.js'),
    `export * from ${JSON.stringify(missionRelative)};\n`);
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers['deepseek-harness'].workerAdapter = structuredClone(registry.providers['deepseek-harness'].workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('deepseek-harness-direct'), ids };
  } finally {
    if (saved === undefined) delete process.env.AIWG_RESOLVE_IMPL_FROM;
    else process.env.AIWG_RESOLVE_IMPL_FROM = saved;
  }
});
afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdinData?: string;
  timeoutMs?: number; onStart?: (child: ReturnType<typeof spawn>) => void }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdinData ?? '');
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    options.onStart?.(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-dsh-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound DeepSeek Harness
 * direct-shell profile. */
async function dshPlan(options: { qualify?: boolean; cliVersion?: string } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `'double" leading 雪\n$(touch ${root}/injected); \`echo danger\` = value --model evil ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers['deepseek-harness'].workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-dsh-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-dsh-host (not live evidence)' });
    }
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit', sandboxModes: ['read-only', 'workspace-write'],
      nestedAgentsControllable: true, nativeFallbackControllable: true });
  }
  registry.providers['deepseek-harness'].workerAdapter = adapter;
  Object.assign(f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!, { initialEffort: EFFORT, effortLadder: [EFFORT] });
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'deepseek-harness'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  f.snapshot.config.parallelism!.groups!.workers.execution = { sandbox: 'workspace-write' } as any;
  const binding: any = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION };
  f.snapshot.installations = { 'deepseek-harness': binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'deepseek-harness'; discovery.runtimeVersion = options.cliVersion ?? VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) { row.id = MODEL; row.apiModelId = MODEL; row.worker!.cliId = 'deepseek-harness';
    row.worker!.runtimeVersion = options.cliVersion ?? VERSION; row.reasoningEfforts = [EFFORT];
    (row.worker as any).efforts = [{ id: EFFORT, selfDelegates: false }]; }
  f.snapshot.catalog.discovery!.instances = { 'deepseek-harness': discovery };
  const drivers: Record<string, WorkerInvocationDriver> = { 'deepseek-harness': {
    qualification: { adapter, adapterId: 'deepseek-harness-direct', cliVersion: binding.cliVersion },
    extractFinal: (output: string) => installed.owner.parseOutput(output),
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      artifacts: owner.buildWorkerArtifacts(input),
      stdin: DEEPSEEK_HARNESS_DIRECT_STDIN, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
  } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
  return { plan, root, workdir, payload, brief, adapter, profile, snapshot: f.snapshot, drivers };
}

describe('DeepSeek Harness version-bound direct profile (B-OG-44)', () => {
  it('DH00 pins the evidenced release, driver, catalog and argv template; every control stays unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers['deepseek-harness'].workerHealthAdapter!;
    expect(adapter.invocation.executable).toBe('dsh');
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      expect(control.support, name).toBe('unqualified');
    }
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
  });

  it('DH00a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(installed.ids).toEqual(['deepseek-harness-direct']);
    // #2909 fix round 1 (item 2, mirrors #2995): the direct class's own
    // getName() must return the registry adapter id, not the inherited
    // legacy bare name, or inspectWorkerInstallation's identity check fails.
    expect(installed.owner.getName()).toBe('deepseek-harness-direct');
    expect(installed.owner.constructor.name).toBe('DeepSeekHarnessDirectAdapter');
  });

  it('DH00b rejects a tampered copy', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
  });

  it("DH00c inspectWorkerInstallation accepts the direct adapter's identity (adapter.id === instance.getName())", async () => {
    const { inspectWorkerInstallation } = await import('../../../src/models/worker-installation.mjs');
    const adapter = structuredClone(loadProviderModelCapabilities().providers['deepseek-harness'].workerHealthAdapter!);
    let error: any;
    try {
      await inspectWorkerInstallation(installed.owner, { adapter, platform: 'linux', profile: 'direct-shell',
        cliVersion: adapter.supportedVersions, workerWritableRoots: [], effectiveConfigDigest: `sha256:${'a'.repeat(64)}`,
        accountScope: 'synthetic', boundary: null, cwd: '/tmp' });
    } catch (e) { error = e; }
    // Before this fix this threw 'Unsupported installation identity/platform'
    // because the Direct subclass's getName() still returned the bare id
    // while adapter.id is `deepseek-harness-direct`. Any OTHER error here
    // (this minimal request is deliberately incomplete past the identity
    // gate) proves the identity check itself passed.
    expect(error?.message).not.toBe('Unsupported installation identity/platform');
  });
});

describe('T-OG-15 DeepSeek Harness direct command contract', () => {
  it('DH02 resolve writes nothing; the launcher writes only the selected patch controls and cleans up', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const { plan, root, workdir, payload, snapshot, drivers } = await dshPlan();
    expect(plan.invocation).toBeDefined();
    expect(plan.invocation!.argv[5]).toBe('${artifact:dsh-patch}');
    expect(existsSync(path.join(root, 'artifact-dsh-patch'))).toBe(false);
    const patch = plan.invocation!.artifacts![0];
    expect(patch.content).toBe(buildDeepSeekHarnessPatch({ model: MODEL, effort: EFFORT, sandbox: 'workspace-write', approval: 'never' }));
    expect(patch.content).not.toContain(MARKER);
    const { file, recordPath } = await fakeConfig(root, 'success');
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', file);
    const invocationPath = path.join(root, 'plan.json');
    await writeFile(invocationPath, JSON.stringify(plan));
    const runDir = path.join(root, 'run');
    const result = await new SessionLauncher().launchWorker({ invocationPath, runDir,
      inputs: { snapshot, drivers }, now: '2026-10-07T00:00:00Z',
      checkDispatch: () => ({ ok: true, enabled: true, failures: [] }),
      launchIsolated: (options: any) => {
        const launched = launchIsolatedWorker(options);
        const proof = (outcome: any) => ({ ...outcome, mode: 'systemd-unit', unit: 'aiwg-worker-dsh-fixture' });
        return launched?.then ? launched.then(proof) : proof(launched);
      },
      isolationStatus: () => ({ active: false, cgroupEmpty: true, execMainCode: 1, execMainStatus: 0, result: 'success' }),
      isolation: { mode: 'degraded', reason: 'synthetic' }, allowDegraded: true });
    expect(result.termination).toBe('confirmed');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ model: MODEL, effort: EFFORT, sandbox: 'workspace-write', approval: 'never', cwd: workdir,
      patchPath: path.join(runDir, 'artifact-dsh-patch'), brief: workerPromptBrief(payload, plan.invocation!.finalPath!).toString() });
    expect(existsSync(record.patchPath)).toBe(false);
    expect(record.argv).not.toContain(payload);
    expect(result.exitCode).toBe(0);
    vi.unstubAllEnvs();
  });

  it('DH03 the driver argv is PURE (no I/O) and refuses guessed or unsafe controls', () => {
    const input = { brief: 'b', cwd: '/w', finalPath: '/w/final.json', selected: { model: MODEL, effort: { value: EFFORT } } };
    const argv = owner.buildWorkerArgs(input, null, {});
    expect(argv.slice(0, 2)).toEqual(['--profile', 'headless']);
    expect(owner.buildWorkerArgs({ ...input, brief: undefined, briefPath: '/w/brief' }, null, {})).toEqual(argv);
    expect(argv.slice(4)).toEqual(['--json', '-']);
    // No I/O: calling buildWorkerArgs twice never creates a file.
    expect(existsSync(argv[3])).toBe(false);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'auto', effort: { value: EFFORT } } }, null, {})).toThrow(/auto-selected/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'ultra' } } }, null, {})).toThrow(/explicit qualified reasoning effort/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'danger-full-access' })).toThrow(/not a qualified direct mode/);
    expect(() => owner.buildWorkerArgs(input, null, { approval: 'ask' })).toThrow(/not a qualified direct policy/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '--model evil', effort: { value: EFFORT } } }, null, {})).toThrow(/look like an option/);
    // Conservative charset: quoting/YAML-significant/whitespace characters refused outright.
    for (const bad of ['model"; injected', "model'anchor", 'model: &anchor', 'model\ttab', 'model with space', '*tag', '-leading-dash']) {
      expect(() => owner.buildWorkerArgs({ ...input, selected: { model: bad, effort: { value: EFFORT } } }, null, {}),
        bad).toThrow(/conservative identifier charset|look like an option/);
    }
    expect(DEEPSEEK_HARNESS_DIRECT_EFFORT_VALUES).toEqual(['off', 'low', 'high', 'max']);
  });

  it('DH03a buildDeepSeekHarnessPatch and deepSeekHarnessPatchPath are pure and reusable standalone', () => {
    const patch = buildDeepSeekHarnessPatch({ model: MODEL, effort: EFFORT, sandbox: 'read-only', approval: 'never' });
    expect(patch).toContain(`model: "${MODEL}"`);
    expect(patch).toContain('mode: "read-only"');
    expect(patch).toContain('policy: "never"');
    expect(() => buildDeepSeekHarnessPatch({ model: 'bad"quote', effort: EFFORT, sandbox: 'read-only', approval: 'never' }))
      .toThrow(/conservative identifier charset/);
    expect(deepSeekHarnessPatchPath({ finalPath: '/w/final.json' })).toBe('${artifact:dsh-patch}');
  });

  it('DH08 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:deepseek-harness')).toThrow();
    registry.providers['deepseek-harness'].workerAdapter = structuredClone(registry.providers['deepseek-harness'].workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:deepseek-harness');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    const rows = JSON.parse(JSON.stringify(fixtureJson('provider-coverage.json')));
    const row = rows.rows.find((r: any) => r.provider === 'deepseek-harness');
    if (row) expect(row.qualification).toBe('unqualified');
  });
});

describe('T-OG-20/21 DeepSeek Harness run identity and failure signals', () => {
  const health = () => loadProviderModelCapabilities().providers['deepseek-harness'].workerHealthAdapter!
    .invocationProfiles!['direct-shell'].health!;
  const observer = (clock: { t: number }) => createWorkerHealthObserver({ provider: 'deepseek-harness', profile: { health: health() },
    invocationId: 'dsh-fixture', now: () => clock.t, wallNow: () => 0, startedAt: 0,
    effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300, diagnosticGraceSeconds: 60 } });
  const feed = (o: ReturnType<typeof observer>, text: string, kind: 'stdout' | 'stderr') =>
    o.feed(Buffer.from(text), { kind, id: kind, generation: 0, offset: 0 });

  async function withPatch(root: string, extra: Record<string, unknown> = {}) {
    const patchPath = path.join(root, '.dsh-direct-patch.yml');
    await writeFile(patchPath, `- id: agent-default-model\n  config:\n    provider: "deepseek-official"\n    model: "${MODEL}"\n    reasoningEffort: "${EFFORT}"\n`
      + `- id: sandbox-policy\n  config:\n    mode: "workspace-write"\n- id: approval\n  config:\n    policy: "never"\n`);
    return patchPath;
  }

  async function realFinalValid(stdout: string, code: number | null) {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      await installed.owner.parseWorkerFinal(stdout,
        { observation: { transport: 'shell', status: code === 0 ? 'completed' : 'failed', termination: 'confirmed', exitCode: code } });
      return true;
    } catch { return false; }
    finally { vi.unstubAllEnvs(); }
  }

  it('DH05 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'dsh'), ['--help'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    const o = observer({ t: 0 });
    expect(o.finish({ exitCode: null, termination: 'uncertain' }).state).not.toBe('completed');
  });

  it('DH05a a missing/unreadable --patch file fails closed before any task is read (mirrors the real dsh no-model probe)', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, [FAKE, '--profile', 'headless', '--patch', path.join(root, 'nonexistent-patch.yml'), '--json', '-'],
      { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file }, stdinData: 'synthetic brief' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/patch file not found/);
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
  });

  it.each(['missing-credential', 'exit-zero-error', 'tool-error', 'malformed', 'empty-final-completed', 'event-after-final'])
    ('DH06 %s never establishes a healthy successful final through parseOutput, the real parseWorkerFinal hook, or the observer', async scenario => {
      const { root, workdir } = await scratch();
      const patchPath = await withPatch(root);
      const { file } = await fakeConfig(root, scenario);
      const result = await run(process.execPath, [FAKE, '--profile', 'headless', '--patch', patchPath, '--json', '-'],
        { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file }, stdinData: 'synthetic brief' });
      expect(installed.owner.parseOutput(result.stdout)).toBeNull();
      expect(await realFinalValid(result.stdout, result.code)).toBe(false);
      const o = observer({ t: 0 });
      o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
      feed(o, result.stdout, 'stdout');
      expect(o.finish({ exitCode: result.code, termination: 'confirmed', finalValid: false }).state).not.toBe('completed');
    });

  it('DH07 success through parseOutput, the real parseWorkerFinal hook and the observer terminal', async () => {
    const { root, workdir } = await scratch();
    const patchPath = await withPatch(root);
    const { file } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, [FAKE, '--profile', 'headless', '--patch', patchPath, '--json', '-'],
      { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file }, stdinData: 'synthetic brief' });
    expect(result.code).toBe(0);
    expect(installed.owner.parseOutput(result.stdout)).not.toBeNull();
    expect(await realFinalValid(result.stdout, result.code)).toBe(true);
    const clock = { t: 0 };
    const o = observer(clock);
    o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    feed(o, result.stdout, 'stdout');
    clock.t = 1000;
    const finalValid = await realFinalValid(result.stdout, result.code);
    expect(o.finish({ exitCode: result.code, termination: 'confirmed', finalValid }).state).toBe('completed');
  });

  it('DH09 a malicious final is inert data; secrets stay out of the recorded stream', async () => {
    const { root, workdir } = await scratch();
    const patchPath = await withPatch(root);
    const marker = path.join(root, 'executed-marker');
    const { file } = await fakeConfig(root, 'malicious-final', { marker });
    const secret = 'sk-synthetic-dsh-secret';
    const result = await run(process.execPath, [FAKE, '--profile', 'headless', '--patch', patchPath, '--json', '-'],
      { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file, DSH_UNRELATED_SECRET: secret }, stdinData: 'synthetic brief' });
    expect(result.stdout).not.toContain(secret);
    const final = installed.owner.parseOutput(result.stdout);
    expect(final?.text).toContain('touch');
    expect(existsSync(marker)).toBe(false);
  });

  const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
  const SESSION = { type: 'session', sessionId: 'session-ordering-fixture', cwd: '/w' };
  const COMPLETED_TURN = (turn: number) => [
    line({ type: 'status', phase: 'turn_start', turn }),
    line({ type: 'status', phase: 'turn_end', turn, reason: { kind: 'completed' } }),
  ].join('');

  it('DH10 rejects a duplicate/late session event', () => {
    const stream = line(SESSION) + COMPLETED_TURN(1) + line(SESSION) + line({ type: 'final', text: 'ok' });
    expect(() => parseDeepSeekHarnessTerminal(stream)).toThrow(/session event must be exactly one, first/);
  });

  it('DH11 rejects an unknown status phase', () => {
    const stream = line(SESSION) + line({ type: 'status', phase: 'turn_paused', turn: 1 }) + line({ type: 'final', text: 'ok' });
    expect(() => parseDeepSeekHarnessTerminal(stream)).toThrow(/Unknown DeepSeek Harness status phase/);
  });

  it('DH12 rejects an unfinished second turn after an earlier completed turn (no stale-success carryover)', () => {
    const stream = line(SESSION) + COMPLETED_TURN(1) + line({ type: 'status', phase: 'turn_start', turn: 2 }) + line({ type: 'final', text: 'ok' });
    expect(() => parseDeepSeekHarnessTerminal(stream)).toThrow(/did not complete/);
    // Sanity: the same shape with turn 2 also completing is accepted.
    const okStream = line(SESSION) + COMPLETED_TURN(1) + COMPLETED_TURN(2) + line({ type: 'final', text: 'ok' });
    expect(parseDeepSeekHarnessTerminal(okStream)).toMatchObject({ text: 'ok', completed: true });
  });

  it('DH13 rejects any event before the session event, and an unknown event type', () => {
    expect(() => parseDeepSeekHarnessTerminal(line({ type: 'text', text: 'early' }) + line(SESSION) + COMPLETED_TURN(1) + line({ type: 'final', text: 'ok' })))
      .toThrow(/session event must be exactly one, first/);
    expect(() => parseDeepSeekHarnessTerminal(line(SESSION) + COMPLETED_TURN(1) + line({ type: 'mystery' }) + line({ type: 'final', text: 'ok' })))
      .toThrow(/Unknown DeepSeek Harness event type/);
  });
});
