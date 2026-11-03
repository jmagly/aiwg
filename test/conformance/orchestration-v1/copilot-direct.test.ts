import { workerMarkerNames } from '../../fixtures/worker-attribution.js';
/**
 * #2901 (B-OG-36) GitHub Copilot CLI promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound Copilot direct-shell profile through the
 * real resolver and #2887 renderer, then executes the rendered shell command
 * against a synthetic `copilot` that records argv, cwd, the attached brief
 * file and environment names. The brief travels as an attached file
 * (`--attachment`), never argv or stdin (`stdin: 'closed'`). T-OG-03/20/21/23
 * drive the same fake through the #2896 health observer. Spawns are plain
 * child processes (no systemd); nothing reaches a network, model, credential
 * or MC state. Fixture qualification here is synthetic and never live
 * qualification: the bundled Copilot profile stays unqualified (CP06).
 *
 * No event-level health grammar is evidenced for `copilot` (see
 * `tools/ralph-external/lib/copilot-adapter.mjs` module doc): the installed
 * CLI is a compiled native binary with no readable bundled source, and
 * `--output-format json`'s event vocabulary is undocumented in `--help`. So
 * `observeHealthEvent` always returns null here, exactly like OpenHuman.
 */
import { termAfterReady, TERM_READY } from '../../helpers/term-escalation.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { prepareWorkerInvocation, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { COPILOT_DIRECT_STDIN, COPILOT_FIXED_PROMPT, COPILOT_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/copilot-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/copilot/fake-copilot.mjs');
const VERSION = '1.0.95';
const MODEL = 'synthetic-copilot/model';
const MARKER = 'COPILOT-BRIEF-MARKER-5a1d8e';
const MODULE = 'tools/ralph-external/lib/copilot-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/copilot/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const BOUNDARY_DIGEST = workerConfigDigest('synthetic-copilot-boundary');
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved module into a fresh, read-only package root. */
async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-copilot-install-')); installRoots.push(base);
  const packageRoot = path.join(base, 'package');
  const writable = path.join(base, 'worker-writable');
  await mkdir(packageRoot, { mode: 0o755 }); await mkdir(writable);
  await chmod(base, 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, APPROVED.entry.modulePath), bytes, { mode: 0o644 });
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers.copilot.workerAdapter = structuredClone(registry.providers.copilot.workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
  const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
    modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
  installed = { owner: createProvider('copilot'), ids };
});
afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv;
  timeoutMs?: number; killSignal?: NodeJS.Signals; onStart?: (child: ReturnType<typeof spawn>) => void }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end();
    options.onStart?.(child);
    const timer = setTimeout(() => child.kill(options.killSignal ?? 'SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-copilot-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound Copilot profile.
 * `qualify` overlays synthetic fixture qualification so the renderer can be
 * exercised; without it the bundled metadata must block. */
async function copilotPlan(options: { qualify?: boolean; cliVersion?: string; execution?: Record<string, unknown>;
  adapterOverride?: (adapter: any) => void } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value -m other ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.copilot.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-copilot-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap') continue;
      // No scoped CLI sandbox flag is evidenced (see module doc): the
      // qualified direct-shell profile only accepts externally-enforced
      // sandboxing, exactly like the OpenCode direct profile (#2904).
      Object.assign(control, { support: name === 'sandbox' ? 'external' : 'native',
        evidence: 'fixture:synthetic-copilot-host (not live evidence)' });
    }
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit',
      nestedAgentsControllable: true, nativeFallbackControllable: true });
    profile.installationQualification = { scopeDigest: BOUNDARY_DIGEST,
      fixtureDigest: workerConfigDigest('synthetic-copilot-install'), verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
  }
  options.adapterOverride?.(adapter);
  registry.providers.copilot.workerAdapter = adapter;
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'copilot'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  // Sandbox is externally-enforced for this CLI (no scoped flag; see module
  // doc), so the execution policy must request `sandbox: 'external'`
  // explicitly rather than the config default of `workspace-write`.
  f.snapshot.config.parallelism!.groups!.workers.execution = {
    ...f.snapshot.config.parallelism!.groups!.workers.execution, sandbox: 'external', ...(options.execution as any),
  };
  const boundary = { kind: 'os' as const, identity: 'synthetic-copilot-boundary', digest: BOUNDARY_DIGEST, controls: ['sandbox'] };
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION, boundary };
  f.snapshot.installations = { copilot: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'copilot'; discovery.runtimeVersion = options.cliVersion ?? VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = MODEL; row.apiModelId = MODEL;
    row.worker!.cliId = 'copilot'; row.worker!.runtimeVersion = options.cliVersion ?? VERSION;
  }
  f.snapshot.catalog.discovery!.instances = { copilot: discovery };
  const owner = installed.owner;
  const permissions = { sandbox: 'external', allowTools: ['write'] };
  const drivers: Record<string, WorkerInvocationDriver> = { copilot: {
    qualification: { adapter, adapterId: 'copilot', cliVersion: binding.cliVersion, boundary,
      installation: { evidence: profile.installationQualification, boundary } },
    prepareWorkerInvocation: (invocation: any, qualification: any) => prepareWorkerInvocation(invocation, qualification),
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, permissions)],
      stdin: adapter.invocation.stdin, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
  } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
  return { plan, root, workdir, payload, brief, adapter, snapshot: f.snapshot, drivers, now: f.request.now };
}

function messages(plan: any): string {
  return [...(plan.diagnostics ?? []), ...(plan.exclusions ?? []).flatMap((row: any) => row.diagnostics ?? [])]
    .map((d: any) => `${d.code} ${d.message}`).join('\n');
}

describe('Copilot version-bound profile (B-OG-36)', () => {
  it('CP01 pins the evidenced release, driver, argv template and health grammar; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.copilot.workerHealthAdapter!;
    expect(COPILOT_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: '1', runtimeDriver: 'installed:copilot',
      invocation: { kind: 'process', executable: 'copilot', stdin: 'closed', versionArgv: ['--version'] },
      qualification: { status: 'unqualified' } });
    expect(adapter.invocation.argv).toEqual(['-p', COPILOT_FIXED_PROMPT, '--attachment', '${brief}', '--model', '${model}',
      '--reasoning-effort', '${effort}', '-C', '${workspace}', '--output-format', 'json', '--no-ask-user',
      '--no-custom-instructions', '--disable-builtin-mcps']);
    expect(adapter.invocation.argv.join(' ')).not.toMatch(/allow-all|yolo|--sandbox\b/);
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(profile.transport).toBe('shell');
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^H: copilot 1\.0\.95/);
    }
    expect(profile.controls.model.mapping).toContain('--model');
    expect(profile.controls.model.mapping).not.toMatch(/-m\/--model|-m, --model/);
    expect(profile.controls.effort.mapping).toContain('--reasoning-effort');
    expect(profile.controls.stdin.mapping).toMatch(/--attachment/);
    expect(profile.controls.stdin.mapping).not.toMatch(/^brief-text/);
    expect(profile.controls.approval.mapping).toMatch(/--allow-tool/);
    expect(profile.controls.approval.mapping).not.toMatch(/allow-all-tools is (emitted|used)/);
    expect(profile.controls.sandbox.mapping).toMatch(/unavailable/);
    expect(profile.pitfalls.some((line: string) => /no event-level health signal is evidenced/.test(line))).toBe(true);
    expect(profile.health).toMatchObject({ handshake: 'process-only', outputFraming: 'jsonl',
      coverage: 'degraded', qualificationTarget: 'process-only', evidenceGrades: ['H'] });
    expect(profile.health!.provenance!.find((row: any) => row.kind === 'help')).toMatchObject({ cliVersion: VERSION });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
  });

  it('CP01a pins the one approved module digest and loads Copilot through the production installed loader', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:copilot', interfaceVersion: 1, adapterIds: ['copilot'], platforms: ['linux'] });
    expect(installed.ids).toEqual(['copilot']);
    expect(installed.owner.getName()).toBe('copilot');
    expect(installed.owner.constructor.name).toBe('CopilotAdapter');
    expect(installed.owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: '/w', briefPath: '/w/brief.md' },
      null, { allowTools: ['write'] })).toEqual(['-p', COPILOT_FIXED_PROMPT, '--attachment', '/w/brief.md',
      '--model', MODEL, '--reasoning-effort', 'medium', '-C', '/w', '--output-format', 'json', '--no-ask-user',
      '--no-custom-instructions', '--disable-builtin-mcps', '--allow-tool', 'write']);
    expect(COPILOT_DIRECT_STDIN).toBe('closed');
  });

  it('CP01b a tampered copy, an unapproved second module and a worker-writable install are all refused', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const widened = loadingRegistry();
    widened.providers.openclaw.workerAdapter = { ...structuredClone(widened.providers.openclaw.workerHealthAdapter!), runtimeDriver: 'installed:openclaw' };
    const good = await installPackage(readFileSync(MODULE));
    await expect(loadInstalledWorkerAdapters({ registry: widened, modules: [{ ...APPROVED.entry, packageRoot: good.packageRoot }],
      workerWritableRoots: [good.writable], platform: 'linux' })).rejects.toThrow('Worker module is not installed/approved: installed:openclaw');
    const insideWritable = await installPackage(readFileSync(MODULE));
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: insideWritable.packageRoot }],
      workerWritableRoots: [path.dirname(insideWritable.packageRoot)], platform: 'linux' })).rejects.toThrow(/worker-writable/);
    const adapter = resolveWorkerAdapter(loadingRegistry(), 'providers:copilot');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
  });
});

describe('T-OG-15 Copilot direct command contract', () => {
  it('CP02 renders --attachment; the brief marker never reaches argv or the command and arrives only via the attached file', async () => {
    const { plan, root, workdir, payload } = await copilotPlan();
    expect(plan.invocation, messages(plan)).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.selected.model).toBe(MODEL);
    expect(invocation.stdin).toBe('closed');
    expect(invocation.argv.slice(2, 4)).toEqual(['-p', COPILOT_FIXED_PROMPT]);
    expect(invocation.argv).toContain('--attachment');
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    expect(JSON.stringify(plan)).not.toContain(MARKER);
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, COPILOT_UNRELATED_SECRET: '[REDACTED]' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ model: MODEL, effort: 'medium', cwd: workdir, outputFormat: 'json',
      noAskUser: true, noCustomInstructions: true, disableBuiltinMcps: true, allowTools: ['write'] });
    expect(record.brief).toBe(payload);
    expect(record.brief).toContain(MARKER);
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    // #2995 round 3 (item D): parseOutput (the installed extractFinal hook)
    // always returns null -- there is no evidenced answer field, so no
    // success-looking candidate is ever published. parseDirectFinal keeps
    // the one structural check for this diagnostic.
    expect(installed.owner.parseOutput(await readFile(invocation.stdoutPath, 'utf8'))).toBeNull();
    const final = installed.owner.parseDirectFinal(await readFile(invocation.stdoutPath, 'utf8'));
    expect(final).toEqual({ events: [{ content: `synthetic reply (${payload.length} chars)` }] });
  });

  it('CP03 the attached launcher never carries the brief in argv, launch records or run-dir metadata', async () => {
    const { plan, root, workdir, payload, snapshot, drivers, now } = await copilotPlan();
    const { file, recordPath } = await fakeConfig(root, 'success');
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', file);
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
    const runDir = path.join(root, 'run');
    const launches: unknown[] = [];
    try {
      const result: any = await new SessionLauncher().launchWorker({ invocationPath, runDir, inputs: { snapshot, drivers }, now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic: no systemd user manager' }, allowDegraded: true,
        launchIsolated: (options: any) => { launches.push(structuredClone({ ...options, gate: undefined, config: undefined, onDispatchCommit: undefined }));
          return launchIsolatedWorker(options); } });
      expect(result.exitCode ?? result.exit?.exitCode ?? 0, JSON.stringify(result)).toBe(0);
    } finally { vi.unstubAllEnvs(); }
    expect(launches).toHaveLength(1);
    expect(JSON.stringify(launches)).not.toContain(MARKER);
    expect(launches[0]).toMatchObject({ stdin: 'closed', args: plan.invocation!.argv.slice(1) });
    const files = await readdir(runDir);
    expect(files).toEqual(expect.arrayContaining(['invocation.json', 'process.json', 'exit.json']));
    for (const name of files.filter(item => item.endsWith('.json'))) {
      expect(await readFile(path.join(runDir, name), 'utf8'), name).not.toContain(MARKER);
    }
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ cwd: workdir, brief: payload });
  });

  it.each([
    ['bundled unqualified profile', { qualify: false }, /Exact model or fallback control is unqualified|Child-agent control is unqualified/],
    ['unsupported CLI version', { cliVersion: '1.0.88' }, /Worker CLI version is outside qualified profile/],
    ['required control left unqualified', { adapterOverride: (a: any) => { a.invocationProfiles['direct-shell'].controls.children.support = 'unqualified'; } }, /Required worker control is unqualified: children/],
  ])('CP04 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await copilotPlan(options as any);
    expect(plan.invocation).toBeUndefined();
    const text = messages(plan);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(reason as RegExp);
  });

  it('CP05 the driver argv carries no brief, never emits a blanket permission bypass and refuses guessed controls', () => {
    const owner = installed.owner;
    const input = { brief: `"; rm -rf / #\n--model evil ${MARKER}`, briefPath: '/w/brief.md', cwd: '/w',
      selected: { model: MODEL, effort: { value: 'medium' } } };
    const argv = owner.buildWorkerArgs(input, null, { allowTools: ['write'] });
    expect(argv.join(' ')).not.toContain(MARKER);
    expect(argv.join(' ')).not.toMatch(/allow-all|yolo|dangerous|skip-permissions/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'auto', effort: { value: 'medium' } } }, null, { allowTools: ['write'] }))
      .toThrow(/never 'auto'/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'opus', effort: { value: 'medium' } } }, null, { allowTools: ['write'] }))
      .toThrow(/exact observed model/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: null } } }, null, { allowTools: ['write'] }))
      .toThrow(/explicit qualified reasoning effort/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, { allowTools: ['write'] })).toThrow(/absolute workspace/);
    expect(() => owner.buildWorkerArgs({ ...input, briefPath: 'relative.md' }, null, { allowTools: ['write'] })).toThrow(/absolute brief-file path/);
    expect(() => owner.buildWorkerArgs(input, null, {})).toThrow(/at least one explicit scoped --allow-tool/);
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['--allow-all-tools'] })).toThrow(/never a blanket bypass/);
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['*'] })).toThrow(/never a blanket bypass/);
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['write'], sandbox: 'danger-full-access' })).toThrow(/not a qualified direct mode/);
    expect(owner.getAbortInput()).toBeNull();
    expect(() => owner.buildSessionArgs()).toThrow(/no qualified Ralph loop session/);
  });

  it('CP06 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:copilot')).toThrow();
    registry.providers.copilot.workerAdapter = structuredClone(registry.providers.copilot.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:copilot');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    expect(fixtureJson('provider-coverage.json').rows.find((row: any) => row.provider === 'copilot'))
      .toMatchObject({ scope: 'IN', owner: 'B-OG-36', qualification: 'unqualified' });
  });
});

describe('T-OG-20/21/23 Copilot run identity, stall and security signals', () => {
  const health = () => loadProviderModelCapabilities().providers.copilot.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  const argv = (workdir: string, briefPath: string) => [FAKE, ...installed.owner.buildWorkerArgs(
    { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: workdir, briefPath }, null, { allowTools: ['write'] })];
  const observer = (clock: { t: number }) => createWorkerHealthObserver({ provider: 'copilot', profile: { health: health() },
    invocationId: 'copilot-fixture', now: () => clock.t, wallNow: () => 0, startedAt: 0,
    effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300, diagnosticGraceSeconds: 60 } });
  const feed = (o: ReturnType<typeof observer>, text: string, kind: 'stdout' | 'stderr') =>
    o.feed(Buffer.from(text), { kind, id: kind, generation: 0, offset: 0 });

  it('CP07 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'copilot'), ['--version'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
    const o = observer({ t: 0 });
    expect(o.finish({ exitCode: null, termination: 'uncertain' }).state).not.toBe('completed');
  });

  it('CP08 final-only success: process-only handshake, no invented progress, strict JSONL final', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'success');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    expect(result.code, result.stderr).toBe(0);
    feed(o, result.stdout, 'stdout');
    clock.t = 1000;
    // #2995 round 3 (item D): parseOutput always returns null now (no
    // evidenced answer field), so finalValid is always false here and the
    // run never reaches `completed` -- exactly the documented, unqualified
    // state for this profile (see docs/providers/copilot-direct.md).
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed',
      finalValid: installed.owner.parseOutput(result.stdout) !== null });
    expect(snapshot).toMatchObject({ state: 'failed', handshake: 'process-only', lastProgressAt: null });
    expect(snapshot.unavailableSignals).toEqual(expect.arrayContaining(['semantic-start', 'semantic-progress']));
    expect(o.evidence().events).toHaveLength(0);
  });

  it.each([
    ['auth-error', 'AUTH'],
    ['model-not-found', 'MODEL'],
  ])('CP09 %s on stderr is diagnosed and fails the attempt', async (scenario, reasonCode) => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, scenario);
    const o = observer({ t: 0 });
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(1);
    feed(o, result.stderr, 'stderr');
    expect(o.snapshot().reasonCode).toBe(reasonCode);
    expect(o.finish({ exitCode: result.code, termination: 'confirmed' }).state).not.toBe('completed');
  });

  it('CP10 malformed output with exit zero is rejected, never auto-accepted', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'malformed');
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
    const o = observer({ t: 0 });
    o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: false }).reasonCode).toBe('FINAL_INVALID');
  });

  it('CP11 silent hang after start crosses quiet then stall windows and needs a stop', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'hang');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 1_000, killSignal: 'SIGTERM',
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    for (const seconds of [15, 30, 45, 60, 75, 90]) { clock.t = seconds * 1000; o.check(clock.t); }
    expect(o.snapshot().state).toBe('quiet');
    for (let seconds = 105; seconds <= 300; seconds += 15) { clock.t = seconds * 1000; o.check(clock.t); }
    expect(o.snapshot()).toMatchObject({ state: 'stalled', reasonCode: 'NO_PROGRESS', confidence: 'suspected' });
    expect(result.signal).toBe('SIGTERM');
    expect(o.finish({ exitCode: null, signal: result.signal, termination: 'confirmed', stopReason: 'NO_PROGRESS', timedOut: true }).state)
      .toBe('failed');
  });

  it('CP12 TERM ignored requires KILL; the exit records the signal, never zero', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'ignore-term');
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 8_000, onStart: termAfterReady });
    expect(result.stdout).toContain(TERM_READY);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
  });

  it('CP13 secrets stay out of the command and a malicious final is inert data', async () => {
    const { plan, root } = await copilotPlan();
    const secret = '[REDACTED]';
    expect(JSON.stringify(plan)).not.toContain(secret);
    const marker = path.join(root, 'executed-marker');
    const { file, recordPath } = await fakeConfig(root, 'malicious-final', { marker });
    const result = await run('/bin/sh', ['-c', plan.invocation!.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, COPILOT_GITHUB_TOKEN: secret } });
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.envNames).not.toContain('COPILOT_GITHUB_TOKEN');
    const stdout = await readFile(plan.invocation!.stdoutPath, 'utf8');
    expect(stdout).not.toContain(secret);
    // #2995 round 3 (item D): parseOutput always returns null; the
    // structural diagnostic (parseDirectFinal) still shows the malicious
    // text landed in the stream as inert data, never executed.
    expect(installed.owner.parseOutput(stdout)).toBeNull();
    const final = installed.owner.parseDirectFinal(stdout);
    expect(final?.events?.[0]?.content).toContain('touch');
    expect(existsSync(marker)).toBe(false); // worker-returned commands are never executed
  });

  it('CP14 observer loss is reported as a gap and stdout prose cannot forge progress', async () => {
    const clock = { t: 0 };
    const o = observer(clock);
    o.processStarted({ pid: 2, startTicks: 'fixture', executable: process.execPath });
    feed(o, 'synthetic prose without any event grammar\n', 'stdout');
    clock.t = 45_000; o.check(clock.t); // a 45 s gap exceeds the 15 s check cadence
    const snapshot = o.snapshot();
    expect(snapshot.lastProgressAt).toBeNull();
    expect(snapshot.unavailableSignals).toContain('observer-continuity');
    expect(o.evidence().gaps.some(gap => gap.reasonCode === 'OBSERVER_GAP')).toBe(true);
    o.disconnect();
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).termination).toBe('uncertain');
  });

  it('CP15 (round-1 fix, BLOCKER) an exit-zero error-shaped JSONL line fails both parseOutput and the health observer, never completed/OK', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'error-event');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    expect(result.code, result.stderr).toBe(0); // exit zero is exactly the trap this guards against
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
    feed(o, result.stdout, 'stdout');
    clock.t = 1000;
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed',
      finalValid: installed.owner.parseOutput(result.stdout) !== null });
    expect(snapshot.state).not.toBe('completed');
    expect(snapshot.reasonCode).not.toBe('OK');
    expect(snapshot).toMatchObject({ state: 'failed', reasonCode: 'PROVIDER_ERROR' });
  });

  // #2995: unlike every other adapter in this effort, Copilot's event
  // vocabulary is wholly unevidenced (module/doc above), so parseWorkerFinal
  // fails closed unconditionally -- including for a successful stream whose
  // final line would otherwise look like a valid claims document, since
  // there is still no evidenced field to extract it from.
  const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };

  it('CP20 parseWorkerFinal always rejects, even a clean successful stream', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    await expect(installed.owner.parseWorkerFinal(result.stdout, { observation })).rejects.toThrow(/unavailable/);
  });

  it('CP21 parseWorkerFinal rejects a malformed stream and Uint8Array/Buffer bytes input alike', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'malformed');
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    await expect(installed.owner.parseWorkerFinal(result.stdout, { observation })).rejects.toThrow();
    await expect(installed.owner.parseWorkerFinal(Buffer.from(result.stdout, 'utf8'), { observation })).rejects.toThrow();
  });

  it('CP22 parseWorkerFinal rejects unconditionally even for an MCP-formatted call', async () => {
    await expect(installed.owner.parseWorkerFinal('{}', { observation, format: 'mcp' })).rejects.toThrow();
  });
});

describe('Copilot round-1 review fixes (#2901)', () => {
  it('CP16 (MAJOR) a tool pattern that looks like a CLI option is refused, never emitted as an --allow-tool/--deny-tool bypass', () => {
    const owner = installed.owner;
    const input = { briefPath: '/w/brief.md', cwd: '/w', selected: { model: MODEL, effort: { value: 'medium' } } };
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['write', '--allow-all-paths', '--allow-all-urls'] }))
      .toThrow(/must not look like a CLI option/);
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['write'], denyTools: ['-x'] }))
      .toThrow(/must not look like a CLI option/);
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['   '] }))
      .toThrow(/non-empty single-line string/);
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['bad\tpattern'] }))
      .toThrow(/non-empty single-line string/);
    // Still refuses the originally-banned blanket bypass words/flags.
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['--allow-all-tools'] })).toThrow(/never a blanket bypass/);
    expect(() => owner.buildWorkerArgs(input, null, { allowTools: ['*'] })).toThrow(/never a blanket bypass/);
  });

  it('CP17 (MAJOR) the fake treats a "-"-prefixed token after --allow-tool as a NEW option, mirroring a real variadic parser, and refuses the bypass', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, [FAKE, '-p', COPILOT_FIXED_PROMPT, '--attachment', briefPath, '--model', MODEL,
      '--reasoning-effort', 'medium', '-C', workdir, '--output-format', 'json', '--no-ask-user', '--no-custom-instructions',
      '--disable-builtin-mcps', '--allow-tool', 'write', '--allow-all-paths', '--allow-all-urls'],
      { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refused: blanket permission bypass is never part of the direct profile \(--allow-all-paths\)/);
  });

  it('CP18 (MINOR) the fake requires --reasoning-effort with a help-listed value', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'success');
    const base = [FAKE, '-p', COPILOT_FIXED_PROMPT, '--attachment', briefPath, '--model', MODEL,
      '-C', workdir, '--output-format', 'json', '--no-ask-user', '--no-custom-instructions', '--disable-builtin-mcps',
      '--allow-tool', 'write'];
    const missing = await run(process.execPath, base, { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/--reasoning-effort is required/);
    const invalid = await run(process.execPath, [...base, '--reasoning-effort', 'ultra'],
      { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/--reasoning-effort must be one of/);
  });

  it('CP19 (MINOR) the docs record the live auth-failure evidence and drop the unsupported write-permission claim', () => {
    const docs = readFileSync('docs/providers/copilot-direct.md', 'utf8');
    expect(docs).toContain('Classic Personal Access Tokens');
    expect(docs).toContain('not supported by Copilot');
    expect(docs).toContain('BLOCKED on authentication');
    expect(docs).not.toContain('is the minimum scoped permission needed for Copilot');
    expect(docs).toMatch(/error-shaped/);
    expect(docs).toMatch(/one JSON object per line/);
  });
});
