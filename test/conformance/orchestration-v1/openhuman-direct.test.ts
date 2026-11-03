import { workerMarkerNames, workerMarkerShell } from '../../fixtures/worker-attribution.js';
/**
 * #2911 (B-OG-47) OpenHuman promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound OpenHuman profile through the real
 * resolver and #2887 renderer, then executes the rendered shell command
 * against a synthetic `openhuman-core` that records argv, params, cwd,
 * environment names and stdin closure. T-OG-20/21/23 drive the same fake
 * through the #2896 health observer. Spawns are plain child processes (no
 * systemd); nothing reaches a network, model, credential or MC state.
 * Fixture qualification here is synthetic and never live qualification:
 * the bundled OpenHuman profile stays unqualified (OD06).
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
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { workerStdinDocument } from '../../../src/serve/worker-stdin-frame.mjs';
import { OPENHUMAN_CHAT_METHOD, OPENHUMAN_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/openhuman-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/openhuman/fake-openhuman-core.mjs');
const VERSION = '0.64.14';
const MODEL = 'synthetic-openhuman/model';
const MARKER = 'OPENHUMAN-BRIEF-MARKER-7f3c9a';
const MODULE = 'tools/ralph-external/lib/openhuman-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/openhuman/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved module into a fresh, read-only package root. */
async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-openhuman-install-')); installRoots.push(base);
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
  // Inactive health metadata becomes a loader candidate only in this copy.
  registry.providers.openhuman.workerAdapter = structuredClone(registry.providers.openhuman.workerHealthAdapter);
  return registry;
}

// One production-loader install per file: the loader binds adapter IDs to one module key.
let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
  const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
    modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
  installed = { owner: createProvider('openhuman'), ids };
});
afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

/** Bounded async spawn; stdin gets `stdinData` then EOF, or stays open with keepStdinOpen. */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; keepStdinOpen?: boolean; stdinData?: string;
  timeoutMs?: number; killSignal?: NodeJS.Signals; onStart?: (child: ReturnType<typeof spawn>) => void }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    if (!options.keepStdinOpen) child.stdin.end(options.stdinData);
    options.onStart?.(child);
    const timer = setTimeout(() => child.kill(options.killSignal ?? 'SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-openhuman-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound OpenHuman profile.
 * `qualify` overlays synthetic fixture qualification so the renderer can be
 * exercised; without it the bundled metadata must block. */
async function openHumanPlan(options: { qualify?: boolean; effort?: boolean; cliVersion?: string; adapterOverride?: (adapter: any) => void } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value -m other ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.openhuman.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    // Synthetic fixture qualification only: models a host that proved every
    // required control for this test. It is never written to the registry.
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-openhuman-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'effort' || name === 'stepCap') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-openhuman-host (not live evidence)' });
    }
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', nestedAgentsControllable: true,
      nativeFallbackControllable: true, sandboxModes: ['read-only', 'workspace-write'] });
  }
  options.adapterOverride?.(adapter);
  registry.providers.openhuman.workerAdapter = adapter;
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'openhuman'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION };
  f.snapshot.installations = { openhuman: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'openhuman'; discovery.runtimeVersion = VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = MODEL; row.apiModelId = MODEL;
    row.worker!.cliId = 'openhuman'; row.worker!.runtimeVersion = VERSION;
    if (!options.effort) {
      row.reasoningEfforts = [];
      Object.assign(row.worker!, { effortSupport: 'not-applicable', efforts: [] });
    }
  }
  f.snapshot.catalog.discovery!.instances = { openhuman: discovery };
  if (!options.effort) {
    // OpenHuman exposes no effort control: route only a not-applicable effort.
    Object.assign(f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!,
      { initialEffort: null, effortLadder: [], allowNotApplicableEffort: true });
  }
  const owner = installed.owner;
  const drivers: Record<string, WorkerInvocationDriver> = { openhuman: {
    qualification: { adapter, adapterId: 'openhuman', cliVersion: binding.cliVersion },
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: adapter.invocation.stdin, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
  } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
  return { plan, root, workdir, payload, adapter, snapshot: f.snapshot, drivers, now: f.request.now };
}

describe('OpenHuman version-bound profile (B-OG-47)', () => {
  it('OD01 pins the evidenced release, driver, catalog and argv template; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.openhuman.workerHealthAdapter!;
    expect(OPENHUMAN_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: APPROVED.entry.packageVersion,
      runtimeDriver: APPROVED.entry.reference,
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { executable: 'openhuman-core', stdin: 'brief-json',
        argv: ['--model', '${model}', 'call', '--method', OPENHUMAN_CHAT_METHOD, '--params-stdin'] },
      qualification: { status: 'unqualified' } });
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^D: openhuman-core 0\.64\.14 source @216ea32/);
    }
    expect(profile.controls.stdin.evidence).toContain('core/cli.rs:445-468');
    expect(profile.health?.provenance?.[0]).toMatchObject({ cliVersion: VERSION,
      ref: expect.stringMatching(/^https:\/\/github\.com\/tinyhumansai\/openhuman\/blob\/216ea322a3c1269dada70751ac5c08eac7dc7596\//) });
    expect(profile.pitfalls.some(line => /Live qualification is an open S1 blocker/.test(line))).toBe(true);
  });

  it('OD01a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:openhuman', interfaceVersion: 1, adapterIds: ['openhuman'],
      platforms: ['linux'] });
    expect(installed.ids).toEqual(['openhuman']);
    expect(installed.owner.getName()).toBe('openhuman');
    expect(installed.owner.constructor.name).toBe('OpenHumanAdapter');
  });

  it('OD01b rejects a tampered copy, an unapproved second module and stays undispatchable after loading', async () => {
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
    const adapter = resolveWorkerAdapter(loadingRegistry(), 'providers:openhuman');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
  });
});

describe('T-OG-15 OpenHuman direct command contract', () => {
  it('OD02 renders --params-stdin; the brief marker never reaches argv or the command and arrives only on stdin', async () => {
    const { plan, root, workdir, payload } = await openHumanPlan();
    expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: (plan as any).exclusions })).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.selected.effort.value).toBeNull();
    expect(invocation.stdin).toBe('brief-json');
    expect(invocation.argv.slice(2)).toEqual(['--model', MODEL, 'call', '--method', OPENHUMAN_CHAT_METHOD, '--params-stdin']);
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    expect(JSON.stringify(plan)).not.toContain(MARKER);
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const framer = path.resolve('src/serve/worker-stdin-frame.mjs');
    expect(invocation.shellCommand).toBe(`cd ${quote(workdir)} && env -i ${[process.execPath, framer, invocation.briefPath, MODEL, workdir].map(quote).join(' ')}`
      + ` | env -i AIWG_FAKE_WORKER_CONFIG="\${AIWG_FAKE_WORKER_CONFIG-}" ${workerMarkerShell(invocation)} ${invocation.argv.map(quote).join(' ')}`
      + ` > ${quote(invocation.stdoutPath)} 2> ${quote(invocation.stderrPath)}`);
    expect(invocation.shellCommand).not.toContain('< /dev/null');
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, OPENHUMAN_UNRELATED_SECRET: 'sk-synthetic-should-not-pass' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ method: OPENHUMAN_CHAT_METHOD, model: MODEL, cwd: workdir, fromStdin: true,
      stdinEof: true, params: { message: payload, model_override: MODEL, cwd: workdir } });
    expect(record.params.message).toContain(MARKER);
    expect(record.stdinBytes).toBe(Buffer.byteLength(JSON.stringify({ message: payload, model_override: MODEL, cwd: workdir })));
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    const final = installed.owner.parseOutput(await readFile(invocation.stdoutPath, 'utf8'));
    expect(final).toEqual({ response: `synthetic reply (${payload.length} chars)` });
  });

  it('OD03 the attached launcher frames stdin; unit/launch and run-dir metadata never carry the brief', async () => {
    const { plan, root, workdir, payload, snapshot, drivers, now } = await openHumanPlan();
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
    expect(launches[0]).toMatchObject({ stdin: 'brief-json', args: plan.invocation!.argv.slice(1) });
    const files = await readdir(runDir);
    expect(files).toEqual(expect.arrayContaining(['invocation.json', 'process.json', 'exit.json']));
    for (const name of files.filter(item => item.endsWith('.json'))) {
      expect(await readFile(path.join(runDir, name), 'utf8'), name).not.toContain(MARKER);
    }
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ fromStdin: true, stdinEof: true, cwd: workdir, params: { message: payload, model_override: MODEL, cwd: workdir } });
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
  });

  it('OD03a a direct systemd launch plan refuses brief-json without a framed params file', async () => {
    const { planDirectWorkerLaunch } = await import('../../../tools/ralph-external/session-launcher.mjs');
    const { plan } = await openHumanPlan();
    // #2915 final (step 6, compatibility): this validation throw is
    // synchronous again — `planDirectWorkerLaunch` is no longer
    // unconditionally `async`, restoring the pre-#2915 literal sync
    // behaviour for every path that never reaches the gated admission
    // branch (see session-launcher.mjs's doc comment on this function).
    expect(() => planDirectWorkerLaunch({ invocation: plan.invocation, memoryMaxGb: 1 }))
      .toThrow('brief-json stdin requires an explicit conductor-framed params file');
  });

  it.each([
    ['bundled unqualified profile', { qualify: false }, /Exact model or fallback control is unqualified|Child-agent control is unqualified/],
    ['unsupported CLI version', { cliVersion: '0.64.15' }, /Worker CLI version is outside qualified profile/],
    ['task requiring effort', { effort: true }, /Required worker control is unqualified: effort/],
    ['required control left unqualified', { adapterOverride: (a: any) => { a.invocationProfiles['direct-shell'].controls.children.support = 'unqualified'; } }, /Required worker control is unqualified: children/],
  ])('OD04 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await openHumanPlan(options as any);
    expect(plan.invocation).toBeUndefined();
    const messages = [...(plan.diagnostics ?? []), ...((plan as any).exclusions ?? []).flatMap((row: any) => row.diagnostics)]
      .map((d: any) => `${d.code} ${d.message}`);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join('\n')).toMatch(reason);
  });

  it('OD05 the driver argv carries no brief, no permission flags and refuses guessed controls', () => {
    const owner = installed.owner;
    const input = { brief: `"; rm -rf / #\n--model evil ${MARKER}`, cwd: '/w', selected: { model: MODEL, effort: { value: null } } };
    const argv = owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', approval: 'never' });
    expect(argv).toEqual(['--model', MODEL, 'call', '--method', OPENHUMAN_CHAT_METHOD, '--params-stdin']);
    expect(argv.join(' ')).not.toContain(MARKER);
    expect(argv.join(' ')).not.toMatch(/bypass|dangerous|yolo|skip-permissions|--fallback|--force/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'high' } } }, null, {})).toThrow(/effort/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '', effort: { value: null } } }, null, {})).toThrow(/model/);
    expect(() => owner.buildSessionArgs()).toThrow(/no qualified Ralph loop session/);
  });

  it('OD06 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:openhuman')).toThrow();
    registry.providers.openhuman.workerAdapter = structuredClone(registry.providers.openhuman.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:openhuman');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    const packs = JSON.parse(JSON.stringify(fixtureJson('provider-coverage.json')));
    expect(packs.rows.find((row: any) => row.provider === 'openhuman')).toMatchObject({ scope: 'IN', qualification: 'unqualified' });
  });
});

describe('T-OG-20/21/23 OpenHuman run identity, stall and security signals', () => {
  const health = () => loadProviderModelCapabilities().providers.openhuman.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  // The profiled argv only; params always travel on stdin, framed like the conductor does.
  const argv = () => [FAKE, '--model', MODEL, 'call', '--method', OPENHUMAN_CHAT_METHOD, '--params-stdin'];
  const frame = (workdir: string) => workerStdinDocument({ brief: 'synthetic', model: MODEL, cwd: workdir });
  const observer = (clock: { t: number }) => createWorkerHealthObserver({ provider: 'openhuman', profile: { health: health() },
    invocationId: 'openhuman-fixture', now: () => clock.t, wallNow: () => 0, startedAt: 0,
    effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300, diagnosticGraceSeconds: 60 } });
  const feed = (o: ReturnType<typeof observer>, text: string, kind: 'stdout' | 'stderr') =>
    o.feed(Buffer.from(text), { kind, id: kind, generation: 0, offset: 0 });

  it('OD07 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'openhuman-core'), ['--help'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
    const o = observer({ t: 0 });
    expect(o.finish({ exitCode: null, termination: 'uncertain' }).state).not.toBe('completed');
  });

  it('OD08 final-only success: process-only handshake, no invented progress, strict final', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(), { cwd: workdir, stdinData: frame(workdir), env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    feed(o, result.stdout, 'stdout');
    clock.t = 1000;
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed',
      finalValid: installed.owner.parseOutput(result.stdout) !== null });
    expect(snapshot).toMatchObject({ state: 'completed', handshake: 'process-only', lastProgressAt: null });
    expect(snapshot.unavailableSignals).toEqual(expect.arrayContaining(['semantic-start', 'semantic-progress']));
    expect(o.evidence().events).toHaveLength(0);
  });

  it.each([
    ['auth-error', 'AUTH'],
    ['model-not-found', 'MODEL'],
  ])('OD09 %s on stderr is diagnosed and fails the attempt', async (scenario, reasonCode) => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, scenario);
    const o = observer({ t: 0 });
    const result = await run(process.execPath, argv(), { cwd: workdir, stdinData: frame(workdir), env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(1);
    feed(o, result.stderr, 'stderr');
    expect(o.snapshot().reasonCode).toBe(reasonCode);
    expect(o.finish({ exitCode: result.code, termination: 'confirmed' }).state).not.toBe('completed');
  });

  it('OD10 malformed output with exit zero is rejected, never auto-accepted', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'malformed');
    const result = await run(process.execPath, argv(), { cwd: workdir, stdinData: frame(workdir), env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    expect(installed.owner.parseOutput(result.stdout)).toBeNull();
    const o = observer({ t: 0 });
    o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: false }).reasonCode).toBe('FINAL_INVALID');
  });

  it('OD11 --params-stdin without EOF blocks; closing stdin delivers the params', async () => {
    const { root, workdir } = await scratch();
    const { file, recordPath } = await fakeConfig(root, 'success');
    const params = JSON.stringify({ message: 'via stdin', model_override: MODEL, cwd: workdir });
    let wrote = false;
    const result = await run(process.execPath, argv(), { cwd: workdir, keepStdinOpen: true,
      env: { AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 5_000,
      onStart: child => { child.stdin!.write(params); wrote = true; setTimeout(() => child.stdin!.end(), 300); } });
    expect(wrote).toBe(true);
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ fromStdin: true, stdinEof: true, stdinBytes: Buffer.byteLength(params), params: { message: 'via stdin' } });

    const waiting = await fakeConfig(root, 'stdin-wait-notice');
    const o = observer({ t: 0 });
    const hung = await run(process.execPath, argv(), { cwd: workdir, keepStdinOpen: true,
      env: { AIWG_FAKE_WORKER_CONFIG: waiting.file }, timeoutMs: 1_000, killSignal: 'SIGTERM' });
    expect(hung.signal).toBe('SIGTERM');
    expect(existsSync(waiting.recordPath)).toBe(false); // params never parsed without EOF
    feed(o, hung.stderr, 'stderr');
    expect(o.snapshot().reasonCode).toBe('STDIN_WAIT');
  });

  it('OD12 silent hang after start crosses quiet then stall windows and needs a stop', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'hang');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(), { cwd: workdir, stdinData: frame(workdir), env: { AIWG_FAKE_WORKER_CONFIG: file },
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

  it('OD13 TERM ignored requires KILL; the exit records the signal, never zero', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'ignore-term');
    const result = await run(process.execPath, argv(), { cwd: workdir, stdinData: frame(workdir), env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 8_000, onStart: termAfterReady });
    expect(result.stdout).toContain(TERM_READY);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
  });

  it('OD14 secrets stay out of the command and a malicious final is inert data', async () => {
    const { plan, root } = await openHumanPlan();
    const secret = 'sk-synthetic-openhuman-secret';
    expect(JSON.stringify(plan)).not.toContain(secret);
    const marker = path.join(root, 'executed-marker');
    const { file, recordPath } = await fakeConfig(root, 'malicious-final', { marker });
    const result = await run('/bin/sh', ['-c', plan.invocation!.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, OPENHUMAN_API_KEY: secret } });
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.envNames).not.toContain('OPENHUMAN_API_KEY');
    const stdout = await readFile(plan.invocation!.stdoutPath, 'utf8');
    expect(stdout).not.toContain(secret);
    const final = installed.owner.parseOutput(stdout);
    expect(final?.response).toContain('touch');
    expect(existsSync(marker)).toBe(false); // worker-returned commands are never executed
  });

  it('OD15 observer loss is reported as a gap and stdout prose cannot forge progress', async () => {
    const clock = { t: 0 };
    const o = observer(clock);
    o.processStarted({ pid: 2, startTicks: 'fixture', executable: process.execPath });
    feed(o, '{"type":"result","success":true}\n{"response":"done"}\n', 'stdout');
    clock.t = 45_000; o.check(clock.t); // a 45 s gap exceeds the 15 s check cadence
    const snapshot = o.snapshot();
    expect(snapshot.lastProgressAt).toBeNull();
    expect(snapshot.unavailableSignals).toContain('observer-continuity');
    expect(o.evidence().gaps.some(gap => gap.reasonCode === 'OBSERVER_GAP')).toBe(true);
    o.disconnect();
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).termination).toBe('uncertain');
  });
});
