import { workerMarkerNames } from '../../fixtures/worker-attribution.js';
import { termAfterReady, TERM_READY } from '../../helpers/term-escalation.js';
import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2907 (B-OG-42) OpenClaw promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound OpenClaw direct-shell profile through
 * the real resolver and #2887 renderer, then executes the rendered shell
 * command against a synthetic `openclaw` that records argv, cwd, the brief
 * file contents and environment names. T-OG-20/21/23 drive the same fake
 * through the #2896 health observer. Spawns are plain child processes (no
 * systemd); nothing reaches a network, model, credential or MC state.
 * Fixture qualification here is synthetic and never live qualification:
 * the bundled OpenClaw profile stays unqualified (OC08).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { prepareWorkerInvocation, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { OPENCLAW_DIRECT_THINKING_LEVELS, OPENCLAW_SUPPORTED_VERSIONS, OpenClawAdapter } from '../../../tools/ralph-external/lib/openclaw-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/openclaw/fake-openclaw.mjs');
const VERSION = '2026.10.1';
const MODEL = 'openrouter/synthetic-model';
const MARKER = 'OPENCLAW-BRIEF-MARKER-5c8b1f';
const MODULE = 'tools/ralph-external/lib/openclaw-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/openclaw/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved module into a fresh, read-only
 * package root. The adapter now extends `ProviderAdapter` (to use
 * `super.parseWorkerFinal`), so its side-effect-free siblings ride along
 * so the copied module resolves, mirroring `codex-adapter.mjs`'s own
 * installed-loader test fixture. */
async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-openclaw-install-')); installRoots.push(base);
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'openclaw-adapter.mjs'), bytes, { mode: 0o644 });
  await copyWorkerAdapterRuntime(base, packageRoot);
  // Mirrors the repo layout (tools/ralph-external/lib -> tools/): from
  // pkg/lib, '../../_resolve-impl.mjs' resolves to the install base.
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  // Bridge for provider-adapter.mjs's own importImpl('mission-protocol/index.js')
  // (the strict workerClaims decode parseWorkerFinal exercises for real).
  await mkdir(path.join(base, 'src', 'mission-protocol'), { recursive: true, mode: 0o755 });
  const missionTarget = path.resolve('src/mission-protocol/index.ts');
  const missionRelative = path.relative(path.join(base, 'src', 'mission-protocol'), missionTarget);
  await writeFile(path.join(base, 'src', 'mission-protocol', 'index.js'),
    `export * from ${JSON.stringify(missionRelative)};\n`);
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers.openclaw.workerAdapter = structuredClone(registry.providers.openclaw.workerHealthAdapter);
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
    installed = { owner: createProvider('openclaw'), ids };
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

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number;
  killSignal?: NodeJS.Signals; onStart?: (child: ReturnType<typeof spawn>) => void }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    options.onStart?.(child);
    const timer = setTimeout(() => child.kill(options.killSignal ?? 'SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-openclaw-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound OpenClaw profile.
 * `sandbox` defaults to `'external'` -- the only mode this profile's bundled
 * `sandboxModes` ever advertises (no override here); passing
 * `'read-only'`/`'workspace-write'` models a caller that asked for CLI
 * sandboxing this provider cannot give, and must be refused before any argv
 * renders (OC13). */
async function openClawPlan(options: { qualify?: boolean; cliVersion?: string; sandbox?: string; noBoundary?: boolean;
  adapterOverride?: (adapter: any) => void } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value --model evil ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.openclaw.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-openclaw-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    // 'sandbox' is deliberately left at its bundled 'unqualified' value: this
    // profile genuinely has no sandbox control, and the real, unwidened
    // `capabilities.sandboxModes: ["external"]` is what gates OC13 below.
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap' || name === 'sandbox') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-openclaw-host (not live evidence)' });
    }
    // 'sandbox' is genuinely external-enforced, not CLI-native (per the
    // boundary warning above): qualified support is 'external', proven by a
    // separately attributed boundary record, mirroring muse-adapter's own
    // sandbox/children/fallback controls -- never widened to a CLI mode this
    // provider cannot give.
    Object.assign(profile.controls.sandbox, { support: 'external', evidence: 'fixture:synthetic-openclaw-external-boundary (not live evidence)' });
    profile.installationQualification = { scopeDigest: workerConfigDigest('synthetic-openclaw-scope'),
      fixtureDigest: workerConfigDigest('synthetic-openclaw-only'), verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', nestedAgentsControllable: true, nativeFallbackControllable: true });
  }
  options.adapterOverride?.(adapter);
  registry.providers.openclaw.workerAdapter = adapter;
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'openclaw'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  // resolveParallelism() defaults group.execution.sandbox to 'workspace-write'
  // when unset -- this profile can never honor that, so a real project must
  // configure 'external' explicitly for this provider.
  f.snapshot.config.parallelism!.groups!.workers.execution = { sandbox: options.sandbox ?? 'external' } as any;
  const boundary = { kind: 'os' as const, identity: 'synthetic-openclaw-boundary', digest: workerConfigDigest('synthetic-openclaw-boundary'),
    controls: ['sandbox'] };
  const binding: any = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION, boundary };
  if (options.noBoundary) delete binding.boundary;
  f.snapshot.installations = { openclaw: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'openclaw'; discovery.runtimeVersion = VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) { row.id = MODEL; row.apiModelId = MODEL; row.worker!.cliId = 'openclaw'; row.worker!.runtimeVersion = VERSION; }
  f.snapshot.catalog.discovery!.instances = { openclaw: discovery };
  const owner = installed.owner;
  const drivers: Record<string, WorkerInvocationDriver> = { openclaw: {
    qualification: { adapter, adapterId: 'openclaw', cliVersion: binding.cliVersion, boundary,
      installation: { evidence: profile.installationQualification, boundary } },
    // Synthetic installation recheck; the real preparation owner still checks
    // all policy, tuple, environment, path and matching-boundary bindings.
    prepareWorkerInvocation: (invocation: any, qualification: any) => prepareWorkerInvocation(invocation, qualification),
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: adapter.invocation.stdin, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
  } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
  return { plan, root, workdir, payload, adapter, profile, snapshot: f.snapshot, drivers };
}

describe('OpenClaw version-bound profile (B-OG-42)', () => {
  it('OC01 pins the evidenced release, driver, catalog and argv template; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.openclaw.workerHealthAdapter!;
    expect(OPENCLAW_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: APPROVED.entry.packageVersion,
      runtimeDriver: APPROVED.entry.reference,
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { executable: 'openclaw', stdin: 'closed',
        argv: ['agent', 'exec', '--isolated', '--auth-env-only', '--json', '--model', '${model}', '--thinking', '${effort}',
          '--cwd', '${workspace}', '--message-file', '${briefPath}'],
        envAllowlist: ['OPENROUTER_API_KEY', 'PATH'] },
      qualification: { status: 'unqualified' } });
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const name of ['sandbox', 'approval', 'structuredOutput', 'stepCap', 'trust', 'children']) {
      expect(profile.controls[name].support, name).toBe('unqualified');
    }
    expect(profile.controls.fallback.mapping).toMatch(/never emitted/);
    expect(profile.health).toMatchObject({ handshake: 'process-only', coverage: 'degraded', outputFraming: 'final-json',
      qualificationOwner: 'B-OG-42', progressEvidence: [] });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
    expect(profile.pitfalls.some((line: string) => /--deliver/.test(line))).toBe(true);
  });

  it('OC01a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:openclaw', interfaceVersion: 1, adapterIds: ['openclaw'], platforms: ['linux'] });
    expect(installed.ids).toEqual(['openclaw']);
    expect(installed.owner.getName()).toBe('openclaw');
    expect(installed.owner.constructor.name).toBe('OpenClawAdapter');
  });

  it('OC01b rejects a tampered copy and an unapproved second module', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const insideWritable = await installPackage(readFileSync(MODULE));
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: insideWritable.packageRoot }],
      workerWritableRoots: [path.dirname(insideWritable.packageRoot)], platform: 'linux' })).rejects.toThrow(/worker-writable/);
    const adapter = resolveWorkerAdapter(loadingRegistry(), 'providers:openclaw');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
  });
});

describe('T-OG-15 OpenClaw direct command contract', () => {
  it('OC02 renders and executes exact argv; the brief marker never reaches argv, only the message file', async () => {
    const { plan, root, payload, workdir } = await openClawPlan();
    expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: (plan as any).exclusions })).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.selected.effort.value).not.toBeNull();
    const effort = invocation.selected.effort.value;
    expect(OPENCLAW_DIRECT_THINKING_LEVELS).toContain(effort);
    expect(invocation.argv.slice(2)).toEqual(['agent', 'exec', '--isolated', '--auth-env-only', '--json',
      '--model', MODEL, '--thinking', effort, '--cwd', workdir, '--message-file', invocation.briefPath]);
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    expect(invocation.shellCommand).toContain('< /dev/null');
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file, OPENCLAW_UNRELATED_SECRET: 'sk-synthetic-should-not-pass' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ model: MODEL, thinking: effort, cwd: workdir, messageFile: invocation.briefPath, prompt: payload });
    expect(record.prompt).toContain(MARKER);
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    const stdout = await readFile(invocation.stdoutPath, 'utf8');
    const final = installed.owner.parseOutput(stdout);
    expect(final).not.toBeNull();
    expect(final).toMatchObject({ ok: true, status: 'ok' });
    expect(JSON.parse(final!.final)).toMatchObject({ summary: `synthetic reply (${payload.length} chars)` });
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      const claims = await installed.owner.parseWorkerFinal(stdout,
        { observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 } });
      expect(claims).toMatchObject({ status: 'completed', summary: `synthetic reply (${payload.length} chars)` });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    ['bundled unqualified profile', { qualify: false }, /unqualified/],
    ['unsupported CLI version', { cliVersion: '2026.9.9' }, /scope differ|unqualified/],
    ['required control left unqualified', { adapterOverride: (a: any) => { a.invocationProfiles['direct-shell'].controls.model.support = 'unqualified'; } }, /unqualified/],
  ])('OC03 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await openClawPlan(options as any);
    expect(plan.invocation).toBeUndefined();
    const messages = [...(plan.diagnostics ?? []), ...((plan as any).exclusions ?? []).flatMap((row: any) => row.diagnostics)]
      .map((d: any) => `${d.code} ${d.message}`);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join('\n')).toMatch(reason);
  });

  it('OC04 the driver argv carries no brief, no auto-approval/routing flags and refuses unsafe or guessed controls', () => {
    const owner = installed.owner;
    const input = { brief: `"; rm -rf / #\n--model evil ${MARKER}`, briefPath: '/w/brief.md', cwd: '/w',
      selected: { model: MODEL, effort: { value: 'medium' } } };
    const argv = owner.buildWorkerArgs(input, null, {});
    expect(argv).toEqual(['agent', 'exec', '--isolated', '--auth-env-only', '--json', '--model', MODEL, '--thinking', 'medium', '--cwd', '/w', '--message-file', '/w/brief.md']);
    expect(argv.join(' ')).not.toContain(MARKER);
    for (const forbidden of ['--deliver', '--to', '--channel', '--reply-channel', '--reply-to', '--fallback', '--yolo', '--force', '--trust-all', '--local', '--no-auth-env-only']) {
      expect(argv).not.toContain(forbidden);
    }
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'auto', effort: { value: 'medium' } } }, null, {})).toThrow(/provider\/model|auto-selected/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'AUTO', effort: { value: 'medium' } } }, null, {})).toThrow(/provider\/model|auto-selected/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'openrouter/auto', effort: { value: 'medium' } } }, null, {})).toThrow(/auto-selected/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'bare-model-no-slash', effort: { value: 'medium' } } }, null, {})).toThrow(/provider\/model/);
    for (const bad of ['/', 'openrouter/', '/synthetic-model', 'auto/foo', 'Auto/foo', 'openrouter/default', 'openrouter/DEFAULT']) {
      expect(() => owner.buildWorkerArgs({ ...input, selected: { model: bad, effort: { value: 'medium' } } }, null, {}),
        bad).toThrow(/provider\/model|auto-selected/);
    }
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'adaptive' } } }, null, {})).toThrow(/thinking level/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: null } } }, null, {})).toThrow(/thinking level/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, briefPath: 'relative.md' }, null, {})).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '--model evil', effort: { value: 'medium' } } }, null, {})).toThrow(/look like an option/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'openrouter/has space', effort: { value: 'medium' } } }, null, {})).toThrow(/look like an option/);
    expect(() => owner.buildSessionArgs()).toThrow(/no qualified Ralph loop session/);
  });

  it('OC08 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:openclaw')).toThrow();
    registry.providers.openclaw.workerAdapter = structuredClone(registry.providers.openclaw.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:openclaw');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    const rows = JSON.parse(JSON.stringify(fixtureJson('provider-coverage.json')));
    expect(rows.rows.find((row: any) => row.provider === 'openclaw')).toMatchObject({ scope: 'IN', qualification: 'unqualified' });
  });

  it.each(['workspace-write', 'read-only'])(
    'OC13 a %s (CLI-enforced) sandbox request is refused for this profile; sandboxModes stays external-only', async sandbox => {
      const bundled = loadProviderModelCapabilities().providers.openclaw.workerHealthAdapter!.capabilities;
      expect(bundled.sandboxModes).toEqual(['external']);
      const { plan } = await openClawPlan({ sandbox });
      expect(plan.invocation).toBeUndefined();
      const messages = [...(plan.diagnostics ?? []), ...((plan as any).exclusions ?? []).flatMap((row: any) => row.diagnostics)]
        .map((d: any) => `${d.code} ${d.message}`);
      expect(messages.join('\n')).toMatch(/Requested sandbox mode is unqualified/);
    });
  it('OC13a even the external sandbox mode is refused when the installation has no external boundary', async () => {
    const { plan } = await openClawPlan({ sandbox: 'external', noBoundary: true });
    expect(plan.invocation).toBeUndefined();
  });
});

describe('T-OG-20/21/23 OpenClaw run identity, stall and security signals', () => {
  const health = () => loadProviderModelCapabilities().providers.openclaw.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  const observer = (clock: { t: number }) => createWorkerHealthObserver({ provider: 'openclaw', profile: { health: health() },
    invocationId: 'openclaw-fixture', now: () => clock.t, wallNow: () => 0, startedAt: 0,
    effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300, diagnosticGraceSeconds: 60 } });
  const feed = (o: ReturnType<typeof observer>, text: string, kind: 'stdout' | 'stderr') =>
    o.feed(Buffer.from(text), { kind, id: kind, generation: 0, offset: 0 });

  async function briefFile(workdir: string, text = 'synthetic brief') {
    const file = path.join(workdir, 'brief.md');
    await writeFile(file, text);
    return file;
  }
  const argv = (brief: string, workdir: string) => ['agent', 'exec', '--isolated', '--auth-env-only', '--json',
    '--model', MODEL, '--thinking', 'low', '--cwd', workdir, '--message-file', brief];

  it('OC05 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'openclaw'), ['--help'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
    const o = observer({ t: 0 });
    expect(o.finish({ exitCode: null, termination: 'uncertain' }).state).not.toBe('completed');
  });

  /** Production wiring: session-launcher.mjs (~480-490) sets `finalValid`
   * only from the driver's `parseWorkerFinal`, never a hand-fed flag. */
  async function realFinalValid(stdout: string, code: number | null) {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      await installed.owner.parseWorkerFinal(stdout,
        { observation: { transport: 'shell', status: code === 0 ? 'completed' : 'failed', termination: 'confirmed', exitCode: code } });
      return true;
    } catch { return false; }
    finally { vi.unstubAllEnvs(); }
  }

  it('OC06 final-only success: process-only handshake, no invented progress, strict final through the real parseWorkerFinal hook', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const brief = await briefFile(workdir);
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, [FAKE, ...argv(brief, workdir)], { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    feed(o, result.stdout, 'stdout');
    clock.t = 1000;
    const finalValid = await realFinalValid(result.stdout, result.code);
    expect(finalValid).toBe(true);
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed', finalValid });
    expect(snapshot).toMatchObject({ state: 'completed', handshake: 'process-only', lastProgressAt: null });
    expect(snapshot.unavailableSignals).toEqual(expect.arrayContaining(['semantic-start', 'semantic-progress']));
  });

  it('OC06b compact single-line envelope also parses through parseOutput and the real parseWorkerFinal hook', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success-compact');
    const brief = await briefFile(workdir);
    const result = await run(process.execPath, [FAKE, ...argv(brief, workdir)], { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(installed.owner.parseOutput(result.stdout)).not.toBeNull();
    expect(await realFinalValid(result.stdout, result.code)).toBe(true);
  });

  it.each(['auth-error', 'model-not-found', 'exit-zero-error', 'timeout', 'empty-final-ok'])
    ('OC07 %s never establishes a healthy successful final through parseOutput or the real parseWorkerFinal hook', async scenario => {
      const { root, workdir } = await scratch();
      const { file } = await fakeConfig(root, scenario);
      const brief = await briefFile(workdir);
      const result = await run(process.execPath, [FAKE, ...argv(brief, workdir)], { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
      expect(installed.owner.parseOutput(result.stdout)).toBeNull();
      const finalValid = await realFinalValid(result.stdout, result.code);
      expect(finalValid).toBe(false);
      const o = observer({ t: 0 });
      o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
      feed(o, result.stderr, 'stderr');
      expect(o.finish({ exitCode: result.code, termination: 'confirmed', finalValid }).state).not.toBe('completed');
    });

  it('OC09 malformed output with exit zero is rejected, never auto-accepted', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'malformed');
    const brief = await briefFile(workdir);
    const result = await run(process.execPath, [FAKE, ...argv(brief, workdir)], { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
  });

  it('OC10 silent hang after start crosses quiet then stall windows and needs a stop', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'hang');
    const brief = await briefFile(workdir);
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, [FAKE, ...argv(brief, workdir)], { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 1_000, killSignal: 'SIGTERM', onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    for (const seconds of [15, 30, 45, 60, 75, 90]) { clock.t = seconds * 1000; o.check(clock.t); }
    expect(o.snapshot().state).toBe('quiet');
    for (let seconds = 105; seconds <= 300; seconds += 15) { clock.t = seconds * 1000; o.check(clock.t); }
    expect(o.snapshot()).toMatchObject({ state: 'stalled', reasonCode: 'NO_PROGRESS', confidence: 'suspected' });
    expect(result.signal).toBe('SIGTERM');
    expect(o.finish({ exitCode: null, signal: result.signal, termination: 'confirmed', stopReason: 'NO_PROGRESS', timedOut: true }).state).toBe('failed');
  });

  it('OC11 TERM ignored requires KILL; the exit records the signal, never zero', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'ignore-term');
    const brief = await briefFile(workdir);
    const result = await run(process.execPath, [FAKE, ...argv(brief, workdir)], { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 8_000, onStart: termAfterReady });
    expect(result.stdout).toContain(TERM_READY);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
  });

  it('OC12 secrets stay out of the command and a malicious final is inert data', async () => {
    const { plan, root } = await openClawPlan();
    const secret = 'sk-synthetic-openclaw-secret';
    expect(JSON.stringify(plan)).not.toContain(secret);
    const marker = path.join(root, 'executed-marker');
    const { file } = await fakeConfig(root, 'malicious-final', { marker });
    const result = await run('/bin/sh', ['-c', plan.invocation!.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file, OPENROUTER_UNRELATED_SECRET: secret } });
    expect(result.code).toBe(0);
    const stdout = await readFile(plan.invocation!.stdoutPath, 'utf8');
    expect(stdout).not.toContain(secret);
    const final = installed.owner.parseOutput(stdout);
    expect(final?.final).toContain('touch');
    expect(existsSync(marker)).toBe(false);
  });
});
