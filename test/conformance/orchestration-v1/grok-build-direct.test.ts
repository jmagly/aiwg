import { workerMarkerNames } from '../../fixtures/worker-attribution.js';
import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2906 (B-OG-41) Grok Build CLI promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound Grok Build direct-shell profile through
 * the real resolver and #2887 renderer, then executes the rendered shell
 * command against a synthetic `grok` that records argv, cwd, the prompt
 * file and environment names. The brief travels as a prompt file
 * (`--prompt-file`), never argv or stdin (`stdin: 'closed'`). T-OG-03/20/21
 * drive the same fake through the #2896 health observer and the adapter's
 * own `parseDirectFinal`. Spawns are plain child processes (no systemd);
 * nothing reaches a network, model, credential or MC state. Fixture
 * qualification here is synthetic and never live qualification: the
 * bundled Grok Build profile stays unqualified (GB06).
 *
 * The ACP-derived `streaming-json` event grammar (`text`, `thought`,
 * `tool_call`, `tool_call_update`, `usage`, `plan`, `available_commands`,
 * `end`, `error`) is evidenced from the captured `--help` plus the
 * installed binary's own bundled output-format documentation (see
 * `tools/ralph-external/lib/grok-build-adapter.mjs` module doc); it is
 * never live-observed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { prepareWorkerInvocation, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { GROK_BUILD_DIRECT_STDIN, GROK_BUILD_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/grok-build-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/grok-build/fake-grok-build.mjs');
const VERSION = '1.0.50';
const MODEL = 'synthetic-grok/model';
const MARKER = 'GROK-BRIEF-MARKER-7c2e9a';
const MODULE = 'tools/ralph-external/lib/grok-build-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/grok-build/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const BOUNDARY_DIGEST = workerConfigDigest('synthetic-grok-build-boundary');
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved module into a fresh, read-only
 * package root. #2995: grok-build-adapter.mjs now also imports
 * ProviderAdapter from the sibling ./provider-adapter.mjs (for
 * parseWorkerFinal's shared strict-claims path), so this mirrors the
 * `pkg/lib/` layout the other `-direct` adapters use (e.g.
 * cursor-adapter.mjs's install helper) instead of the old flat package
 * root: provider-adapter.mjs itself resolves `../../_resolve-impl.mjs` two
 * directories up, and that in turn resolves `mission-protocol/index.js`
 * under `src/`. */
async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-grok-install-')); installRoots.push(base);
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable);
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, APPROVED.entry.modulePath), bytes, { mode: 0o644 });
  // grok-build-adapter.mjs imports classifyWorkerHealthFailure/
  // healthEventMatchesBinding from ./worker-health.mjs and ProviderAdapter
  // from ./provider-adapter.mjs: copy both siblings alongside.
  await copyWorkerAdapterRuntime(base, packageRoot);
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  // parseWorkerFinal's shared strict-claims path (provider-adapter.mjs)
  // resolves mission-protocol/index.js via the same _resolve-impl bridge.
  await mkdir(path.join(base, 'src', 'mission-protocol'), { recursive: true, mode: 0o755 });
  const protocolTarget = path.resolve('src/mission-protocol/index.ts');
  const protocolRelative = path.relative(path.join(base, 'src', 'mission-protocol'), protocolTarget);
  await writeFile(path.join(base, 'src', 'mission-protocol', 'index.js'),
    `export * from ${JSON.stringify(protocolRelative)};\n`);
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers['grok-build'].workerAdapter = structuredClone(registry.providers['grok-build'].workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
  const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
    modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
  installed = { owner: createProvider('grok-build'), ids };
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-grok-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound Grok Build profile.
 * `qualify` overlays synthetic fixture qualification so the renderer can be
 * exercised; without it the bundled metadata must block. */
async function grokPlan(options: { qualify?: boolean; cliVersion?: string; execution?: Record<string, unknown>;
  adapterOverride?: (adapter: any) => void } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value -m other ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers['grok-build'].workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-grok-build-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-grok-build-host (not live evidence)' });
    }
    profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit',
      nestedAgentsControllable: true, nativeFallbackControllable: true });
    profile.installationQualification = { scopeDigest: BOUNDARY_DIGEST,
      fixtureDigest: workerConfigDigest('synthetic-grok-build-install'), verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
  }
  options.adapterOverride?.(adapter);
  registry.providers['grok-build'].workerAdapter = adapter;
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'grok-build'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  f.snapshot.config.parallelism!.groups!.workers.execution = {
    ...f.snapshot.config.parallelism!.groups!.workers.execution, sandbox: 'workspace-write', ...(options.execution as any),
  };
  const boundary = { kind: 'os' as const, identity: 'synthetic-grok-build-boundary', digest: BOUNDARY_DIGEST, controls: ['sandbox'] };
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION, boundary };
  f.snapshot.installations = { 'grok-build': binding } as any;
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'grok-build'; discovery.runtimeVersion = options.cliVersion ?? VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = MODEL; row.apiModelId = MODEL;
    row.worker!.cliId = 'grok-build'; row.worker!.runtimeVersion = options.cliVersion ?? VERSION;
  }
  f.snapshot.catalog.discovery!.instances = { 'grok-build': discovery } as any;
  const owner = installed.owner;
  const permissions = { sandbox: 'workspace-write', allowRules: ['Edit'] };
  const drivers: Record<string, WorkerInvocationDriver> = { 'grok-build': {
    qualification: { adapter, adapterId: 'grok-build', cliVersion: binding.cliVersion, boundary,
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

describe('Grok Build version-bound profile (B-OG-41)', () => {
  it('GB01 pins the evidenced release, driver, argv template and health grammar; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers['grok-build'].workerHealthAdapter!;
    expect(GROK_BUILD_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: '1', runtimeDriver: 'installed:grok-build',
      invocation: { kind: 'process', executable: 'grok', stdin: 'closed', versionArgv: ['--version'] },
      qualification: { status: 'unqualified' } });
    expect(adapter.invocation.argv).toEqual(['--prompt-file', '${brief}', '-m', '${model}', '--reasoning-effort', '${effort}',
      '--permission-mode', 'dontAsk', '--sandbox', '${sandbox}', '--cwd', '${workspace}', '--output-format', 'streaming-json',
      '--no-subagents', '--no-plan', '--no-alt-screen', '--disable-web-search']);
    expect(adapter.invocation.argv.join(' ')).not.toMatch(/always-approve|bypassPermissions|allow-all|yolo/);
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(profile.transport).toBe('shell');
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^H: grok 1\.0\.50/);
    }
    expect(profile.controls.model.mapping).toContain('-m, --model');
    expect(profile.controls.stdin.mapping).toMatch(/--prompt-file/);
    expect(profile.controls.approval.mapping).toMatch(/dontAsk/);
    expect(profile.controls.approval.mapping).not.toMatch(/bypassPermissions is (emitted|used)/);
    expect(profile.controls.sandbox.mapping).toMatch(/read-only|workspace/);
    expect(profile.health).toMatchObject({ handshake: 'process-only', outputFraming: 'jsonl',
      coverage: 'degraded', qualificationTarget: 'semantic', evidenceGrades: ['H'] });
    expect(profile.health!.provenance!.find((row: any) => row.kind === 'help')).toMatchObject({ cliVersion: VERSION });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
  });

  it('GB01a pins the one approved module digest and loads Grok Build through the production installed loader', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:grok-build', interfaceVersion: 1, adapterIds: ['grok-build'], platforms: ['linux'] });
    expect(installed.ids).toEqual(['grok-build']);
    expect(installed.owner.getName()).toBe('grok-build');
    expect(installed.owner.constructor.name).toBe('GrokBuildAdapter');
    expect(installed.owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: '/w', briefPath: '/w/brief.md' },
      null, { sandbox: 'workspace-write', allowRules: ['Edit'] })).toEqual(['--prompt-file', '/w/brief.md',
      '-m', MODEL, '--reasoning-effort', 'medium', '--permission-mode', 'dontAsk', '--sandbox', 'workspace',
      '--cwd', '/w', '--output-format', 'streaming-json', '--no-subagents', '--no-plan', '--no-alt-screen',
      '--disable-web-search', '--allow', 'Edit']);
    expect(GROK_BUILD_DIRECT_STDIN).toBe('closed');
  });

  it('GB05 the driver argv carries no brief, never emits a blanket permission bypass and refuses guessed controls', () => {
    const owner = installed.owner;
    const input = { brief: `"; rm -rf / #\n--model evil ${MARKER}`, briefPath: '/w/brief.md', cwd: '/w',
      selected: { model: MODEL, effort: { value: 'medium' } } };
    const argv = owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', allowRules: ['Edit'] });
    expect(argv.join(' ')).not.toContain(MARKER);
    expect(argv.join(' ')).not.toMatch(/always-approve|bypassPermissions|yolo/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'auto', effort: { value: 'medium' } } }, null, { sandbox: 'workspace-write' }))
      .toThrow(/never 'auto'/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'opus', effort: { value: 'medium' } } }, null, { sandbox: 'workspace-write' }))
      .toThrow(/exact observed model/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: null } } }, null, { sandbox: 'workspace-write' }))
      .toThrow(/explicit qualified reasoning effort/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, { sandbox: 'workspace-write' })).toThrow(/absolute workspace/);
    expect(() => owner.buildWorkerArgs({ ...input, briefPath: 'relative.md' }, null, { sandbox: 'workspace-write' })).toThrow(/absolute prompt-file path/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'danger-full-access' })).toThrow(/not a qualified direct mode/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', allowRules: ['--always-approve'] })).toThrow(/never a blanket bypass/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', allowRules: ['*'] })).toThrow(/never a blanket bypass/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', allowRules: ['-m evil'] })).toThrow(/option-prefixed tokens/);
    expect(owner.getAbortInput()).toBeNull();
    expect(() => owner.buildSessionArgs()).toThrow(/no qualified Ralph loop session/);
  });

  it('GB06 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:grok-build')).toThrow();
    registry.providers['grok-build'].workerAdapter = structuredClone(registry.providers['grok-build'].workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:grok-build');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    expect(fixtureJson('provider-coverage.json').rows.find((row: any) => row.provider === 'grok-build'))
      .toMatchObject({ scope: 'IN', owner: 'B-OG-41', qualification: 'unqualified' });
  });
});

describe('T-OG-15 Grok Build direct command contract', () => {
  it('GB02 renders --prompt-file; the brief marker never reaches argv or the command and arrives only via the prompt file', async () => {
    const { plan, root, workdir, payload } = await grokPlan();
    expect(plan.invocation, messages(plan)).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.selected.model).toBe(MODEL);
    expect(invocation.stdin).toBe('closed');
    expect(invocation.argv.slice(2, 4)).toEqual(['--prompt-file', expect.stringContaining('brief')]);
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    expect(JSON.stringify(plan)).not.toContain(MARKER);
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, GROK_UNRELATED_SECRET: '[REDACTED]' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ model: MODEL, effort: 'medium', cwd: workdir, outputFormat: 'streaming-json',
      permissionMode: 'dontAsk', sandbox: 'workspace', noSubagents: true, noPlan: true, disableWebSearch: true, allowRules: ['Edit'] });
    expect(record.brief).toBe(payload);
    expect(record.brief).toContain(MARKER);
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    const final = installed.owner.parseDirectFinal(await readFile(invocation.stdoutPath, 'utf8'));
    expect(final).toMatchObject({ stopReason: 'end_turn', text: expect.stringContaining(`synthetic reply (${payload.length} chars)`) });
  });

  it.each([
    ['bundled unqualified profile', { qualify: false }, /Exact model or fallback control is unqualified|Child-agent control is unqualified/],
    ['unsupported CLI version', { cliVersion: '1.0.41' }, /Worker CLI version is outside qualified profile/],
  ])('GB04 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await grokPlan(options as any);
    expect(plan.invocation).toBeUndefined();
    const text = messages(plan);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(reason as RegExp);
  });
});

describe('T-OG-03/20/21 Grok Build run identity and ACP-grammar health signals', () => {
  const health = () => loadProviderModelCapabilities().providers['grok-build'].workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  const argv = (workdir: string, briefPath: string) => [FAKE, ...installed.owner.buildWorkerArgs(
    { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: workdir, briefPath }, null,
    { sandbox: 'workspace-write', allowRules: ['Edit'] })];
  const observer = (clock: { t: number }) => createWorkerHealthObserver({ provider: 'grok-build', profile: { health: health() },
    invocationId: 'grok-fixture', now: () => clock.t, wallNow: () => 0, startedAt: 0,
    // Wire the adapter's OWN ACP grammar explicitly: the shared default
    // normalizer would otherwise fall back to the generic, pre-existing
    // grok-build branch in worker-health.mjs (the older message/result
    // shape), which does not recognize any ACP event and would silently
    // leave `terminal` unset instead of exercising this profile's grammar.
    normalizeEvent: (event: unknown, source: unknown, binding: unknown) => installed.owner.observeHealthEvent(event, source, binding),
    effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300, diagnosticGraceSeconds: 60 } });
  const feed = (o: ReturnType<typeof observer>, text: string, kind: 'stdout' | 'stderr') =>
    o.feed(Buffer.from(text), { kind, id: kind, generation: 0, offset: 0 });

  it('GB07 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'grok'), ['--version'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
    const o = observer({ t: 0 });
    expect(o.finish({ exitCode: null, termination: 'uncertain' }).state).not.toBe('completed');
  });

  it('GB08 success: own ACP grammar observes progress/activity/terminal and the strict final extracts cleanly', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'success');
    const clock = { t: 0 };
    const o = observer(clock);
    const binding = { invocationId: 'grok-fixture', sessionId: null, runId: null };
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    expect(result.code, result.stderr).toBe(0);
    const stdout = { kind: 'stdout' as const, id: 'stdout', generation: 0, offset: 0 };
    const kinds = result.stdout.trim().split('\n').map(line =>
      installed.owner.observeHealthEvent(JSON.parse(line), stdout, binding)?.kind ?? null);
    expect(kinds).toEqual(['activity', 'progress', 'progress', 'activity', 'activity', 'terminal']);
    feed(o, result.stdout, 'stdout');
    clock.t = 1000;
    const final = installed.owner.parseDirectFinal(result.stdout);
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed', finalValid: final !== null });
    expect(snapshot.state).toBe('completed');
    expect(final).toMatchObject({ stopReason: 'end_turn' });
  });

  it.each([
    ['error-event', 'synthetic provider error'],
    ['tool-failed', 'tool call call_1 failed'],
  ])('GB09 %s defeats exit zero: a standalone error or a failed tool call never lets a later terminal repair it', async (scenario) => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, scenario);
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    expect(installed.owner.parseDirectFinal(result.stdout)).toBeNull();
    const o = observer({ t: 0 });
    const binding = { invocationId: 'grok-fixture', sessionId: null, runId: null };
    const stdout = { kind: 'stdout' as const, id: 'stdout', generation: 0, offset: 0 };
    let sawFatal = false;
    for (const line of result.stdout.trim().split('\n')) {
      const observation = installed.owner.observeHealthEvent(JSON.parse(line), stdout, binding);
      if (observation) o.observe(observation);
      if (observation?.fatal) sawFatal = true;
    }
    o.observe({ kind: 'terminal', success: true });
    expect(sawFatal).toBe(true);
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: false }).state).not.toBe('completed');
  });

  it('GB11 a non-end_turn stopReason (refusal) is terminal but never success, and the strict final rejects it', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'refusal');
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    expect(installed.owner.parseDirectFinal(result.stdout)).toBeNull();
    const binding = { invocationId: 'grok-fixture', sessionId: null, runId: null };
    const stdout = { kind: 'stdout' as const, id: 'stdout', generation: 0, offset: 0 };
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const terminal = installed.owner.observeHealthEvent(events[events.length - 1], stdout, binding);
    expect(terminal).toMatchObject({ kind: 'terminal', success: false });
  });

  // #2995: production marks a run `completed` only when `parseWorkerFinal`
  // succeeds. These cases drive the real installed-owner hook, never a
  // hand-fed finalValid.
  const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
  async function streamFor(scenario: string): Promise<string> {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, scenario);
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  it('GB16 parseWorkerFinal resolves a successful stream whose final answer is a valid claims document', async () => {
    const stream = await streamFor('claims-final');
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).resolves.toMatchObject({ version: 1, status: 'completed' });
  });

  it('GB17 parseWorkerFinal rejects a successful stream whose final answer is plain text (not claims)', async () => {
    const stream = await streamFor('success');
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });

  it.each(['error-event', 'tool-failed', 'refusal', 'malformed'])('GB18 parseWorkerFinal rejects a %s stream', async scenario => {
    const stream = await streamFor(scenario);
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });

  it('GB19 parseWorkerFinal accepts Uint8Array/Buffer bytes input', async () => {
    const stream = await streamFor('claims-final');
    await expect(installed.owner.parseWorkerFinal(Buffer.from(stream, 'utf8'), { observation })).resolves.toMatchObject({ status: 'completed' });
  });

  // #2995 round 3 (item E): GrokBuildAdapter now extends ProviderAdapter
  // (for parseWorkerFinal's shared strict-claims path), which means
  // `createHealthObserver` is newly INHERITED rather than absent. Pin that
  // the inherited method still wires Grok's OWN `observeHealthEvent` (ACP
  // grammar), the same one `buildWorkerArgs`/`parseDirectFinal` already
  // use directly elsewhere in this file -- never the generic/legacy
  // grok-build event shape in worker-health.mjs.
  it('GB20 the inherited createHealthObserver wires Grok Build\'s own ACP observeHealthEvent, not the generic default', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'synthetic brief');
    const { file } = await fakeConfig(root, 'success');
    const clock = { t: 0 };
    const o = installed.owner.createHealthObserver({ provider: 'grok-build', profile: { health: health() },
      invocationId: 'grok-fixture-inherited', now: () => clock.t, wallNow: () => 0, startedAt: 0,
      effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300, diagnosticGraceSeconds: 60 } });
    const result = await run(process.execPath, argv(workdir, briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    expect(result.code, result.stderr).toBe(0);
    feed(o, result.stdout, 'stdout');
    clock.t = 1000;
    const final = installed.owner.parseDirectFinal(result.stdout);
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed', finalValid: final !== null });
    expect(snapshot.state).toBe('completed');
    expect(o.evidence().events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['progress']));
  });
});

describe('GB12 parseDirectFinal: latching, ordering and malformed-anywhere rejection', () => {
  const ev = (obj: Record<string, unknown>) => JSON.stringify(obj);
  const owner = () => installed.owner;

  it('keeps final text through response and whole-turn usage while requiring end', () => {
    const frames = [
      { type: 'text', data: 'final answer' },
      { type: 'usage', messageId: 'response-1', stopReason: 'end_turn', usage: { input_tokens: 1 } },
      { type: 'usage', usage: { input_tokens: 2 } },
    ];
    expect(owner().parseDirectFinal(frames.map(ev).join('\n'))).toBeNull();
    const stdout = [...frames, { type: 'end', stopReason: 'end_turn', sessionId: 's1' }].map(ev).join('\n');
    expect(owner().parseDirectFinal(stdout)).toEqual({ text: 'final answer', stopReason: 'end_turn', sessionId: 's1' });
  });

  it('a bare end with no text fails (empty final content)', () => {
    const stdout = `${ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' })}\n`;
    expect(owner().parseDirectFinal(stdout)).toBeNull();
  });

  it.each(['max_tokens', 'max_turn_requests', 'cancelled', 'refusal'])('a non-end_turn stopReason (%s) fails even with text present', (stopReason) => {
    const stdout = [ev({ type: 'text', data: 'partial' }), ev({ type: 'end', stopReason })].join('\n');
    expect(owner().parseDirectFinal(stdout)).toBeNull();
  });

  it('a malformed line anywhere (start, middle, end) fails the whole parse', () => {
    const good = ev({ type: 'text', data: 'hello' });
    const end = ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' });
    expect(owner().parseDirectFinal(`not json\n${good}\n${end}`)).toBeNull();
    expect(owner().parseDirectFinal(`${good}\nnot json\n${end}`)).toBeNull();
    expect(owner().parseDirectFinal(`${good}\n${end}\nnot json`)).toBeNull();
  });

  it('a plain-text (non-JSON-object) line anywhere fails the whole parse, including after a clean end', () => {
    const good = ev({ type: 'text', data: 'hello' });
    const end = ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' });
    expect(owner().parseDirectFinal(`${good}\n${end}\nplain trailing text, not a JSON line at all`)).toBeNull();
    expect(owner().parseDirectFinal(`"just a quoted json string"\n${good}\n${end}`)).toBeNull();
  });

  it('text -> end(refusal) -> end(end_turn): the refusal latches permanently; a later end_turn can never repair it', () => {
    const stdout = [ev({ type: 'text', data: 'hello' }), ev({ type: 'end', stopReason: 'refusal', sessionId: 's1' }),
      ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' })].join('\n');
    expect(owner().parseDirectFinal(stdout)).toBeNull();
  });

  it('text -> end(end_turn) -> text: end must be the last event; trailing content after it fails', () => {
    const stdout = [ev({ type: 'text', data: 'hello' }), ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' }),
      ev({ type: 'text', data: 'more' })].join('\n');
    expect(owner().parseDirectFinal(stdout)).toBeNull();
  });

  it('the one clean, well-ordered success shape still parses', () => {
    const stdout = [ev({ type: 'text', data: 'hello ' }), ev({ type: 'text', data: 'world' }),
      ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' })].join('\n');
    expect(owner().parseDirectFinal(stdout)).toEqual({ text: 'hello world', stopReason: 'end_turn', sessionId: 's1' });
  });

  // #2995 round 4 (item 2): response boundaries (docs/providers/
  // grok-build-cli-evidence.md ~l.183, `usage` = "Per-response boundary
  // ..., one per model response"). Text emitted before a tool call is
  // never part of the final answer, and a pre-tool prefix can never
  // repair an otherwise-invalid final.
  it('(regression) text(valid claims) -> tool_call -> tool_call_update(completed) -> text(whitespace) -> end(end_turn) REJECTS', () => {
    const claims = JSON.stringify({ version: 1, status: 'completed', summary: 'x', claims: [], artifacts: [], checks: [], limitations: [] });
    const stdout = [
      ev({ type: 'text', data: claims }),
      ev({ type: 'tool_call', toolCallId: 'call_1', status: 'in_progress' }),
      ev({ type: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }),
      ev({ type: 'text', data: '   ' }),
      ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' }),
    ].join('\n');
    expect(owner().parseDirectFinal(stdout)).toBeNull();
  });

  it('(regression) a pre-tool text prefix can never repair an otherwise-invalid final', () => {
    const stdout = [
      ev({ type: 'text', data: '{"partial":' }),
      ev({ type: 'tool_call', toolCallId: 'call_1', status: 'in_progress' }),
      ev({ type: 'text', data: 'rest that is invalid alone' }),
      ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' }),
    ].join('\n');
    const final = owner().parseDirectFinal(stdout);
    expect(final?.text).toBe('rest that is invalid alone');
    expect(final?.text).not.toContain('"partial"');
  });

  it('(regression) tool_call -> text(chunk1) -> text(chunk2) -> end(end_turn) RESOLVES with the concatenated in-response chunks', () => {
    const claims = JSON.stringify({ version: 1, status: 'completed', summary: 'x', claims: [], artifacts: [], checks: [], limitations: [] });
    const stdout = [
      ev({ type: 'tool_call', toolCallId: 'call_1', status: 'in_progress' }),
      ev({ type: 'text', data: claims.slice(0, 20) }),
      ev({ type: 'text', data: claims.slice(20) }),
      ev({ type: 'end', stopReason: 'end_turn', sessionId: 's1' }),
    ].join('\n');
    expect(owner().parseDirectFinal(stdout)).toMatchObject({ text: claims });
  });
});

describe('GB13 fake CLI defense-in-depth: forbidden permission-mode/sandbox values are refused directly', () => {
  async function spawnRaw(argvTail: string[], root: string) {
    return run(process.execPath, [FAKE, ...argvTail], { cwd: root, env: { PATH: process.env.PATH } });
  }

  it.each(['auto', 'acceptEdits', 'default', 'plan', 'bypassPermissions'])(
    "permission-mode '%s' is refused even though it is a syntactically valid CLI value", async (mode) => {
      const { root, workdir } = await scratch();
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'x');
      const result = await spawnRaw(['--prompt-file', briefPath, '-m', MODEL, '--reasoning-effort', 'medium',
        '--permission-mode', mode, '--sandbox', 'read-only', '--cwd', workdir, '--output-format', 'streaming-json'], workdir);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/never part of the direct profile/);
    });

  it.each(['devbox', 'strict', 'off'])("sandbox profile '%s' is refused even though it is a syntactically valid CLI value", async (sandbox) => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'x');
    const result = await spawnRaw(['--prompt-file', briefPath, '-m', MODEL, '--reasoning-effort', 'medium',
      '--permission-mode', 'dontAsk', '--sandbox', sandbox, '--cwd', workdir, '--output-format', 'streaming-json'], workdir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/refused/);
  });
});

describe('GB14 model/effort values can never smuggle a new CLI option', () => {
  const owner = () => installed.owner;
  const base = { cwd: '/w', briefPath: '/w/brief.md' };

  it.each(['--always-approve', '--permission-mode=bypassPermissions', '-m evil', 'model with space'])(
    "model '%s' is refused as option-like or whitespace-containing", (model) => {
      expect(() => owner().buildWorkerArgs({ ...base, selected: { model, effort: { value: 'medium' } } }, null,
        { sandbox: 'workspace-write' })).toThrow(/option|whitespace/);
    });

  it('a control character in the model value is refused', () => {
    expect(() => owner().buildWorkerArgs({ ...base, selected: { model: 'grok\tcode', effort: { value: 'medium' } } }, null,
      { sandbox: 'workspace-write' })).toThrow(/whitespace|control/);
  });
});

describe('GB15 final extraction fails closed when output continues past a claimed terminal success', () => {
  it('the installed driver hook (parseOutput) refuses malformed or trailing output after a successful end', () => {
    const end = JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 's1' });
    const text = JSON.stringify({ type: 'text', data: 'done' });
    const clean = `${text}\n${end}\n`;
    // The launcher only reports completed when this hook returns a final (src/models/worker-installation.mjs extractFinal).
    expect(installed.owner.parseOutput(clean)).not.toBeNull();
    expect(installed.owner.parseOutput(`${clean}not json at all\n`)).toBeNull();
    expect(installed.owner.parseOutput(`${clean}${text}\n`)).toBeNull();
    expect(installed.owner.parseOutput(`${text}\n${JSON.stringify({ type: 'end', stopReason: 'refusal' })}\n${end}\n`)).toBeNull();
    expect(installed.owner.parseOutput('{"result":"loose object the base class would accept"}')).toBeNull();
  });
});
