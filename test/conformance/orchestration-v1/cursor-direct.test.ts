import { shellCaptureBody } from '../../fixtures/shell-capture-command.js';
import { workerMarkerNames, workerMarkerShell } from '../../fixtures/worker-attribution.js';
import { termAfterReady, TERM_READY } from '../../helpers/term-escalation.js';
import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2903 (B-OG-38) Cursor Agent promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound Cursor direct-shell profile through
 * the real resolver and #2887 renderer, then executes the rendered shell
 * command against a synthetic `cursor-agent` that records argv, cwd,
 * stdin, environment names and the captured stdout stream. The brief
 * travels on stdin (no `prompt` argument is ever emitted,
 * `stdin: 'brief-text'`), never in argv. T-OG-03/20/21/23 drive the same
 * fake through the #2896 health observer via the production CursorAdapter
 * owner. Spawns are plain child processes (no systemd); nothing reaches a
 * network, model, credential or MC state. Fixture qualification here is
 * synthetic and never live qualification: the bundled Cursor profile
 * stays unqualified.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { CURSOR_DIRECT_STDIN, CURSOR_SUPPORTED_VERSIONS, CursorAdapter } from '../../../tools/ralph-external/lib/cursor-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/cursor/fake-cursor-agent.mjs');
// Semver-normalized (SE4: the raw `--version` banner `2026.10.01-e373342`
// has a leading-zero day-of-month and is not valid semver; see
// tools/ralph-external/lib/cursor-adapter.mjs module doc).
const VERSION = '2026.10.1-e373342';
const MODEL = 'synthetic/cursor-model';
const MARKER = 'CURSOR-BRIEF-MARKER-7a2d9f';
const MODULE = 'tools/ralph-external/lib/cursor-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/cursor/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved Cursor module into a fresh,
 * read-only package root. cursor-adapter.mjs imports provider-adapter.mjs
 * and worker-health.mjs as siblings, so they ride along uninstrumented;
 * worker-installation itself is bridged back to the source file under
 * test so registration lands in the production loader registry that
 * createProvider reads (mirrors #2897 codex-adapter.mjs / #2902
 * factory-adapter.mjs). */
async function installCursorPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-cursor-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'cursor-adapter.mjs'), bytes, { mode: 0o644 });
  await copyWorkerAdapterRuntime(base, packageRoot);
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
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
  registry.providers.cursor.workerAdapter = structuredClone(registry.providers.cursor.workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installCursorPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('cursor-direct'), ids };
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
  timeoutMs?: number; killSignal?: NodeJS.Signals; onStart?: (child: ReturnType<typeof spawn>) => void }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdinData);
    options.onStart?.(child);
    const timer = setTimeout(() => child.kill(options.killSignal ?? 'SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-cursor-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound Cursor profile.
 * `qualify` overlays synthetic fixture qualification so the renderer can be
 * exercised; without it the bundled metadata must block. */
async function cursorPlan(options: { qualify?: boolean; cliVersion?: string; adapterOverride?: (adapter: any) => void } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value -m other ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.cursor.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-cursor-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-cursor-host (not live evidence)' });
    }
    profile.envAllowlist = [...profile.envAllowlist, 'AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = [...adapter.invocation.envAllowlist, 'AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit',
      nestedAgentsControllable: true, nativeFallbackControllable: true,
      sandboxModes: ['read-only', 'workspace-write'] });
  }
  options.adapterOverride?.(adapter);
  registry.providers.cursor.workerAdapter = adapter;
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'cursor'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION };
  f.snapshot.installations = { cursor: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'cursor'; discovery.runtimeVersion = options.cliVersion ?? VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = MODEL; row.apiModelId = MODEL;
    row.worker!.cliId = 'cursor'; row.worker!.runtimeVersion = options.cliVersion ?? VERSION;
  }
  f.snapshot.catalog.discovery!.instances = { cursor: discovery };
  const owner = installed.owner;
  const drivers: Record<string, WorkerInvocationDriver> = { cursor: {
    qualification: { adapter, adapterId: adapter.id, cliVersion: binding.cliVersion },
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: CURSOR_DIRECT_STDIN, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
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

describe('Cursor Agent version-bound profile (B-OG-38)', () => {
  it('CD01 pins the evidenced release, driver, catalog and argv template; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.cursor.workerHealthAdapter!;
    expect(CURSOR_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: APPROVED.entry.packageVersion,
      runtimeDriver: APPROVED.entry.reference,
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { executable: 'cursor-agent', stdin: 'brief-text',
        argv: ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '${mode}', '--workspace', '${workspace}', '--model', '${model}'] },
      qualification: { status: 'unqualified' } });
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^(H|D): /);
    }
    expect(profile.pitfalls.some((line: string) => /yolo/.test(line))).toBe(true);
    expect(profile.health?.provenance?.[0]).toMatchObject({ cliVersion: VERSION });
  });

  it('CD01a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:cursor', interfaceVersion: 1, adapterIds: ['cursor-direct'],
      platforms: ['linux'] });
    expect(installed.ids).toEqual(['cursor-direct']);
    expect(installed.owner.getName()).toBe('cursor-direct');
    // #2995: the installed loader wires the `-direct` subclass (same
    // Claude/Hermes pattern) so `parseOutput` is the strict native rule,
    // never the base class's loose inherited regex `CursorAdapter` keeps
    // for the legacy Ralph-loop registration.
    expect(installed.owner.constructor.name).toBe('CursorDirectAdapter');
  });

  it("(#2995 round 4, item 3) inspectWorkerInstallation accepts the direct adapter's identity (adapter.id === instance.getName())", async () => {
    const { inspectWorkerInstallation } = await import('../../../src/models/worker-installation.mjs');
    const adapter = structuredClone(loadProviderModelCapabilities().providers['cursor'].workerHealthAdapter!);
    let error: any;
    try {
      await inspectWorkerInstallation(installed.owner, { adapter, platform: 'linux', profile: 'direct-shell',
        cliVersion: adapter.supportedVersions, workerWritableRoots: [], effectiveConfigDigest: `sha256:${'a'.repeat(64)}`,
        accountScope: 'synthetic', boundary: null, cwd: '/tmp' });
    } catch (e) { error = e; }
    // Before this fix, this threw 'Unsupported installation identity/platform'
    // because the Direct subclass's getName() still returned the bare id
    // while adapter.id is now `cursor-direct`. Any OTHER error here (this minimal
    // request is deliberately incomplete past the identity gate) proves
    // the identity check itself passed.
    expect(error?.message).not.toBe('Unsupported installation identity/platform');
  });

  it('CD01c (#2995 round 3, item B) loading the installed module under the `cursor-direct` id never overwrites the legacy `cursor` registration', async () => {
    const legacyOwner = createProvider('cursor');
    expect(legacyOwner.constructor.name).toBe('CursorAdapter');
    expect(legacyOwner.constructor.name).not.toBe(installed.owner.constructor.name);
    const claims = { version: 1, status: 'completed', summary: 'Synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
    const genericEnvelope = JSON.stringify({ type: 'result', result: claims });
    await expect(legacyOwner.parseWorkerFinal(genericEnvelope,
      { observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 } }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('CD01b a tampered copy is refused and the bundled registry stays undispatchable', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installCursorPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:cursor')).toThrow();
    registry.providers.cursor.workerAdapter = structuredClone(registry.providers.cursor.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:cursor');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    const packs = JSON.parse(JSON.stringify(fixtureJson('provider-coverage.json')));
    expect(packs.rows.find((row: any) => row.provider === 'cursor')).toMatchObject({ scope: 'IN', qualification: 'unqualified' });
  });
});

describe('T-OG-15 Cursor direct command contract', () => {
  it('CD02 renders the qualified template; the brief marker never reaches argv, the command or the plan', async () => {
    const { plan, root, workdir, payload, brief } = await cursorPlan();
    expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: (plan as any).exclusions })).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.stdin).toBe('brief-text');
    expect(invocation.argv.slice(2)).toEqual(['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled',
      '--workspace', workdir, '--model', `${MODEL}[effort=${invocation.selected.effort.value}]`]);
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    expect(JSON.stringify(plan)).not.toContain(MARKER);
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    expect(shellCaptureBody(invocation)).toBe(`cd ${quote(workdir)} && env -i AIWG_FAKE_WORKER_CONFIG="\${AIWG_FAKE_WORKER_CONFIG-}"`
      + ` ${workerMarkerShell(invocation)} ${invocation.argv.map(quote).join(' ')} < ${quote(brief)} > ${quote(invocation.stdoutPath)} 2> ${quote(invocation.stderrPath)}`);
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, CURSOR_UNRELATED_SECRET: 'fk-synthetic-should-not-pass' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ workspace: workdir, promptViaStdin: true, stdinEof: true, trust: true, approveMcps: false });
    expect(record.model).toContain(MODEL);
    expect(record.brief).toContain(MARKER);
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    const final = installed.owner.parseDirectFinal(await readFile(invocation.stdoutPath, 'utf8'));
    expect(final).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
  });

  it.each([
    ['bundled unqualified profile', { qualify: false }, /unqualified/],
    ['unsupported CLI version', { cliVersion: '2026.10.02-abcdef' }, /Worker CLI version is outside qualified profile/],
  ])('CD03 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await cursorPlan(options as any);
    expect(plan.invocation).toBeUndefined();
    expect(messages(plan).length).toBeGreaterThan(0);
    expect(messages(plan)).toMatch(reason);
  });

  it('CD04 the driver argv refuses guessed/unsafe controls and carries no brief', () => {
    const owner = installed.owner;
    const input = { brief: `"; rm -rf / #\n--model evil ${MARKER}`, cwd: '/w', selected: { model: MODEL, effort: { value: 'low' } } };
    const argv = owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', approval: 'never' });
    expect(argv).toEqual(['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled',
      '--workspace', '/w', '--model', `${MODEL}[effort=low]`]);
    expect(argv.join(' ')).not.toContain(MARKER);
    expect(argv.join(' ')).not.toMatch(/-f\b|--force|--yolo|--auto-review|--approve-mcps|(^|\s)-m(\s|$)/);
    expect(owner.buildWorkerArgs(input, null, { sandbox: 'read-only', approval: 'never' })).toEqual(
      ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--mode', 'ask',
        '--workspace', '/w', '--model', `${MODEL}[effort=low]`]);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'opus', effort: { value: 'low' } } }, null, {}))
      .toThrow(/generic alias/);
    // fix round 1 (roctinam/aiwg#2903 item 5): probes accepted 'auto'/'default'
    // unchecked; refused case-insensitively even without a documented CLI
    // meaning for either sentinel.
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'auto', effort: { value: 'low' } } }, null, {}))
      .toThrow(/auto-selection/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'AUTO', effort: { value: 'low' } } }, null, {}))
      .toThrow(/auto-selection/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'default', effort: { value: 'low' } } }, null, {}))
      .toThrow(/auto-selection/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'DEFAULT', effort: { value: 'low' } } }, null, {}))
      .toThrow(/auto-selection/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: null } } }, null, {}))
      .toThrow(/explicit qualified reasoning effort/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'not valid!' } } }, null, {}))
      .toThrow(/explicit qualified reasoning effort/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'external', approval: 'never' })).toThrow(/sandbox is not a qualified/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', approval: 'on-request' })).toThrow(/approval is not a qualified/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, { sandbox: 'workspace-write', approval: 'never' })).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '', effort: { value: 'low' } } }, null, {})).toThrow(/explicit model/);
    expect(owner.getAbortInput()).toBeNull();
  });
});

describe('T-OG-03/20/21/23 Cursor run identity, stall and security signals', () => {
  const health = () => loadProviderModelCapabilities().providers.cursor.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  const argv = () => [FAKE, '-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled',
    '--workspace', '/w', '--model', `${MODEL}[effort=low]`];
  const owner = () => installed.owner;
  const stdoutSource = { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 };

  it('CD05 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'cursor-agent'), ['--help'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
  });

  it('CD05a the fake refuses --approve-mcps and the unevidenced -m alias (regression guard)', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const withApproveMcps = await run(process.execPath, [FAKE, '-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled',
      '--approve-mcps', '--workspace', workdir, '--model', `${MODEL}[effort=low]`],
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(withApproveMcps.code).not.toBe(0);
    expect(withApproveMcps.stderr).toMatch(/refused/);
    const withShortM = await run(process.execPath, [FAKE, '-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled',
      '-m', `${MODEL}[effort=low]`, '--workspace', workdir],
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(withShortM.code).not.toBe(0);
    expect(withShortM.stderr).toMatch(/refused/);
  });

  it('CD06 success handshakes on setup/activity/progress and completes on a strict terminal', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const kinds = events.map(event => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' })?.kind);
    expect(kinds).toEqual(['setup', 'activity', 'activity', 'progress', 'terminal']);
    expect(owner().parseDirectFinal(result.stdout)).toMatchObject({ type: 'result', is_error: false });
  });

  it('CD07 an interaction_query request fails despite no terminal and exit zero not yet reached', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'interactive-prompt');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 1_000, killSignal: 'SIGTERM' });
    const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const observations = events.map(event => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' }));
    expect(observations.some(observation => observation?.fatal === true)).toBe(true);
    expect(owner().parseDirectFinal(result.stdout)).toBeNull();
  });

  it('CD12a parseDirectFinal alone fails closed: bad terminals, ordering, and malformed lines', () => {
    const ok = { type: 'result', subtype: 'success', is_error: false, result: 'done' };
    const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';
    const parse = (text: string) => owner().parseDirectFinal(text);
    expect(parse(jsonl({ type: 'system' }, ok))).toMatchObject(ok);
    expect(parse(jsonl({ type: 'result' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'interrupted', is_error: false, result: 'x' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'mystery', is_error: false, result: 'x' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'success', is_error: true, result: 'x' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'success', is_error: false, result: '  ' }))).toBeNull();
    expect(parse(jsonl(ok) + 'not json\n')).toBeNull();
    expect(parse(jsonl({ type: 'system' }))).toBeNull();
    // fix round 1 (roctinam/aiwg#2903 item 4): an error-shaped or
    // approval-request event fails the stream regardless of position,
    // including strictly AFTER an earlier affirmative success; a later
    // success never repairs an earlier failure either.
    expect(parse(jsonl(ok, { type: 'error', message: 'late failure' }))).toBeNull();
    expect(parse(jsonl(ok, { type: 'thinking', error: { message: 'late top-level error field' } }))).toBeNull();
    expect(parse(jsonl(ok, { type: 'interaction_query', subtype: 'request', query_type: 'command-approval' }))).toBeNull();
    expect(parse(jsonl({ type: 'error', message: 'early failure' }, ok))).toBeNull();
    expect(parse(jsonl({ type: 'interaction_query', subtype: 'request' }, ok))).toBeNull();
  });

  it('CD12c the health observer treats untyped errors and any interaction_query as fatal', () => {
    const observe = (event: unknown) => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' });
    expect(observe({ error: 'boom' })).toMatchObject({ kind: 'error', fatal: true });
    expect(observe({ type: 'thinking', error: false })).toMatchObject({ kind: 'error', fatal: true });
    expect(observe({ type: 'interaction_query' })).toMatchObject({ kind: 'error', fatal: true });
    expect(observe({ type: 'interaction_query', subtype: 'request', query_type: 'shell' })).toMatchObject({ kind: 'error', fatal: true });
    expect(observe({ type: 'thinking' })).toEqual({ kind: 'activity' });
  });

  it('CD12b observeHealthEvent fails closed on error-shaped and approval-request events in any position', () => {
    const observe = (event: unknown) => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' });
    const ok = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fixture' };
    // Before a success: fatal.
    expect(observe({ type: 'error', message: 'early failure', session_id: 'fixture' })).toMatchObject({ fatal: true });
    expect(observe({ type: 'interaction_query', subtype: 'request', session_id: 'fixture' })).toMatchObject({ fatal: true });
    // After a success: still fatal — a later terminal observation never
    // retroactively repairs an earlier one, because each fatal observation
    // is independently reported regardless of what preceded it.
    expect(observe(ok)).toMatchObject({ kind: 'terminal', success: true });
    expect(observe({ type: 'error', message: 'late failure', session_id: 'fixture' })).toMatchObject({ fatal: true });
    expect(observe({ type: 'thinking', error: { message: 'late top-level error field' }, session_id: 'fixture' })).toMatchObject({ fatal: true });
    expect(observe({ type: 'interaction_query', subtype: 'request', session_id: 'fixture' })).toMatchObject({ fatal: true });
  });

  it('CD12 a valid-JSON but underspecified/unsuccessful terminal fails closed, never open', async () => {
    const { root, workdir } = await scratch();
    const runScenario = async (scenario: string) => {
      const { file } = await fakeConfig(root, scenario);
      const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
        { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
      expect(result.code, result.stderr).toBe(0);
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      const terminal = events.map(event => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' }))
        .find(observation => observation?.kind === 'terminal');
      return terminal;
    };
    expect(await runScenario('bare-result')).toMatchObject({ kind: 'terminal', success: false });
    expect(await runScenario('interrupted-result')).toMatchObject({ kind: 'terminal', success: false });
    expect(await runScenario('empty-result-text')).toMatchObject({ kind: 'terminal', success: false });
    expect(await runScenario('success')).toMatchObject({ kind: 'terminal', success: true });
  });

  it('CD08 malformed or missing-final output with exit zero is never auto-accepted', async () => {
    const { root, workdir } = await scratch();
    const malformed = await fakeConfig(root, 'malformed');
    const malformedResult = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: malformed.file } });
    expect(malformedResult.code).toBe(0);
    expect(owner().parseDirectFinal(malformedResult.stdout)).toBeNull();

    const missing = await fakeConfig(root, 'missing-final');
    const missingResult = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: missing.file } });
    expect(missingResult.code).toBe(0);
    expect(owner().parseDirectFinal(missingResult.stdout)).toBeNull();
  });

  it('CD09 silent hang after start crosses quiet then stall windows and needs a stop', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'hang');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 1_000, killSignal: 'SIGTERM' });
    expect(result.signal).toBe('SIGTERM');
    expect(result.code).toBeNull();
    expect(health().handshake).toBe('process-only');
  });

  it('CD10 TERM ignored requires KILL; the exit records the signal, never zero', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'ignore-term');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 8_000,
        onStart: termAfterReady });
    expect(result.stdout).toContain(TERM_READY);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
  });

  it('CD11 secrets stay out of the command and a malicious final is inert data', async () => {
    const { plan, root } = await cursorPlan();
    const secret = 'fk-synthetic-cursor-secret';
    expect(JSON.stringify(plan)).not.toContain(secret);
    const marker = path.join(root, 'executed-marker');
    const { file, recordPath } = await fakeConfig(root, 'malicious-final', { marker });
    const invocation = plan.invocation!;
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, CURSOR_API_KEY: secret } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.envNames).not.toContain('CURSOR_API_KEY');
    const stdout = await readFile(invocation.stdoutPath, 'utf8');
    expect(stdout).not.toContain(secret);
    const final = installed.owner.parseDirectFinal(stdout);
    expect(final?.result).toContain('touch');
    expect(existsSync(marker)).toBe(false); // worker-returned commands are never executed
  });

  // #2995: production marks a run `completed` only when `parseWorkerFinal`
  // succeeds. These cases drive the real installed-owner hook, never a
  // hand-fed finalValid.
  const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
  async function streamFor(scenario: string): Promise<string> {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, scenario);
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  it('CD13 parseWorkerFinal resolves a successful stream whose final answer is a valid claims document', async () => {
    const stream = await streamFor('claims-final');
    await expect(owner().parseWorkerFinal(stream, { observation })).resolves.toMatchObject({ version: 1, status: 'completed' });
  });

  it('CD14 parseWorkerFinal rejects a successful stream whose final answer is plain text (not claims)', async () => {
    const stream = await streamFor('success');
    await expect(owner().parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });

  it('CD15 parseWorkerFinal rejects a failed or malformed stream', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'malformed');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    await expect(owner().parseWorkerFinal(result.stdout, { observation })).rejects.toThrow();
    const missing = await fakeConfig(root, 'missing-final');
    const missingResult = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: missing.file } });
    await expect(owner().parseWorkerFinal(missingResult.stdout, { observation })).rejects.toThrow();
  });

  it('CD16 parseWorkerFinal accepts Uint8Array/Buffer bytes input', async () => {
    const stream = await streamFor('claims-final');
    await expect(owner().parseWorkerFinal(Buffer.from(stream, 'utf8'), { observation })).resolves.toMatchObject({ status: 'completed' });
  });
});
