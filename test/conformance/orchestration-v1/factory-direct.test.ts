import { workerMarkerNames, workerMarkerShell } from '../../fixtures/worker-attribution.js';
import { termAfterReady, TERM_READY } from '../../helpers/term-escalation.js';
import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2902 (B-OG-37) Factory (Droid) promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound Factory direct-shell profile through
 * the real resolver and #2887 renderer, then executes the rendered shell
 * command against a synthetic `droid` that records argv, cwd, stdin,
 * environment names and the captured stdout stream. The brief travels on
 * stdin (no `prompt` argument is ever emitted, `stdin: 'brief-text'`),
 * never in argv. T-OG-03/20/21/23 drive the same fake through the #2896
 * health observer via the production FactoryAdapter owner. Spawns are plain
 * child processes (no systemd); nothing reaches a network, model,
 * credential or MC state. Fixture qualification here is synthetic and
 * never live qualification: the bundled Factory profile stays unqualified
 * (FD01b).
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
import { FACTORY_DIRECT_STDIN, FACTORY_SUPPORTED_VERSIONS, FactoryAdapter } from '../../../tools/ralph-external/lib/factory-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/factory/fake-droid.mjs');
const VERSION = '0.238.0';
const MODEL = 'synthetic/factory-model';
const MARKER = 'FACTORY-BRIEF-MARKER-5b1e7c';
const MODULE = 'tools/ralph-external/lib/factory-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/factory/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved Factory module into a fresh,
 * read-only package root. factory-adapter.mjs imports provider-adapter.mjs
 * and worker-health.mjs as siblings, so they ride along uninstrumented;
 * worker-installation itself is bridged back to the source file under
 * test so registration lands in the production loader registry that
 * createProvider reads (mirrors #2897 codex-adapter.mjs). */
async function installFactoryPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-factory-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'factory-adapter.mjs'), bytes, { mode: 0o644 });
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
  registry.providers.factory.workerAdapter = structuredClone(registry.providers.factory.workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installFactoryPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('factory-direct'), ids };
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-factory-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound Factory profile.
 * `qualify` overlays synthetic fixture qualification so the renderer can be
 * exercised; without it the bundled metadata must block. */
async function factoryPlan(options: { qualify?: boolean; cliVersion?: string; adapterOverride?: (adapter: any) => void } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value -m other ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.factory.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-factory-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-factory-host (not live evidence)' });
    }
    profile.envAllowlist = [...profile.envAllowlist, 'AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = [...adapter.invocation.envAllowlist, 'AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit',
      nestedAgentsControllable: true, nativeFallbackControllable: true,
      sandboxModes: ['read-only', 'workspace-write'] });
  }
  options.adapterOverride?.(adapter);
  registry.providers.factory.workerAdapter = adapter;
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'factory'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION };
  f.snapshot.installations = { factory: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'factory'; discovery.runtimeVersion = options.cliVersion ?? VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = MODEL; row.apiModelId = MODEL;
    row.worker!.cliId = 'factory'; row.worker!.runtimeVersion = options.cliVersion ?? VERSION;
  }
  f.snapshot.catalog.discovery!.instances = { factory: discovery };
  const owner = installed.owner;
  const drivers: Record<string, WorkerInvocationDriver> = { factory: {
    qualification: { adapter, adapterId: adapter.id, cliVersion: binding.cliVersion },
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: FACTORY_DIRECT_STDIN, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
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

describe('Factory (Droid) version-bound profile (B-OG-37)', () => {
  it('FD01 pins the evidenced release, driver, catalog and argv template; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.factory.workerHealthAdapter!;
    expect(FACTORY_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: APPROVED.entry.packageVersion,
      runtimeDriver: APPROVED.entry.reference,
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { executable: 'droid', stdin: 'brief-text',
        argv: ['exec', '--auto', '${sandbox}', '-m', '${model}', '-r', '${effort}', '--cwd', '${workspace}', '--output-format', 'stream-json'] },
      qualification: { status: 'unqualified' } });
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^(H|D): /);
    }
    expect(profile.pitfalls.some((line: string) => /skip-permissions-unsafe/.test(line))).toBe(true);
    expect(profile.health?.provenance?.[0]).toMatchObject({ cliVersion: VERSION });
  });

  it('FD01a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:factory', interfaceVersion: 1, adapterIds: ['factory-direct'],
      platforms: ['linux'] });
    expect(installed.ids).toEqual(['factory-direct']);
    expect(installed.owner.getName()).toBe('factory-direct');
    // #2995: the installed loader wires the `-direct` subclass (same
    // Claude/Hermes pattern) so `parseOutput` is the strict native rule,
    // never the legacy-pinned regex `FactoryAdapter` keeps for the legacy
    // Ralph-loop registration.
    expect(installed.owner.constructor.name).toBe('FactoryDirectAdapter');
  });

  it("(#2995 round 4, item 3) inspectWorkerInstallation accepts the direct adapter's identity (adapter.id === instance.getName())", async () => {
    const { inspectWorkerInstallation } = await import('../../../src/models/worker-installation.mjs');
    const adapter = structuredClone(loadProviderModelCapabilities().providers['factory'].workerHealthAdapter!);
    let error: any;
    try {
      await inspectWorkerInstallation(installed.owner, { adapter, platform: 'linux', profile: 'direct-shell',
        cliVersion: adapter.supportedVersions, workerWritableRoots: [], effectiveConfigDigest: `sha256:${'a'.repeat(64)}`,
        accountScope: 'synthetic', boundary: null, cwd: '/tmp' });
    } catch (e) { error = e; }
    // Before this fix, this threw 'Unsupported installation identity/platform'
    // because the Direct subclass's getName() still returned the bare id
    // while adapter.id is now `factory-direct`. Any OTHER error here (this minimal
    // request is deliberately incomplete past the identity gate) proves
    // the identity check itself passed.
    expect(error?.message).not.toBe('Unsupported installation identity/platform');
  });

  it('FD01c (#2995 round 3, item B) loading the installed module under the `factory-direct` id never overwrites the legacy `factory` registration', () => {
    // Before this fix, `register(factory)` registered the direct subclass
    // under the SAME bare id as the legacy `registerProvider('factory', ...)`
    // call, so loading the installed module in-process silently replaced
    // the legacy factory function (src/models/worker-installation.mjs
    // ~l.550): `createProvider('factory')` would then return the direct
    // class instead of the legacy one, and legacy generic group finals
    // would stop validating.
    const legacy = createProvider('factory');
    expect(legacy.constructor.name).toBe('FactoryAdapter');
    expect(legacy.constructor.name).not.toBe(installed.owner.constructor.name);
    const claims = { version: 1, status: 'completed', summary: 'Synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
    const genericEnvelope = JSON.stringify({ type: 'result', result: claims });
    return expect(legacy.parseWorkerFinal(genericEnvelope, { observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 } }))
      .resolves.toMatchObject({ status: 'completed' });
  });

  it('FD01b a tampered copy is refused and the bundled registry stays undispatchable', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installFactoryPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:factory')).toThrow();
    registry.providers.factory.workerAdapter = structuredClone(registry.providers.factory.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:factory');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    const packs = JSON.parse(JSON.stringify(fixtureJson('provider-coverage.json')));
    expect(packs.rows.find((row: any) => row.provider === 'factory')).toMatchObject({ scope: 'IN', qualification: 'unqualified' });
  });
});

describe('T-OG-15 Factory direct command contract', () => {
  it('FD02 renders the qualified template; the brief marker never reaches argv, the command or the plan', async () => {
    const { plan, root, workdir, payload, brief } = await factoryPlan();
    expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: (plan as any).exclusions })).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.stdin).toBe('brief-text');
    expect(invocation.argv.slice(2)).toEqual(['exec', '--auto', 'low', '-m', MODEL, '-r', invocation.selected.effort.value,
      '--cwd', workdir, '--output-format', 'stream-json']);
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    expect(JSON.stringify(plan)).not.toContain(MARKER);
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    expect(invocation.shellCommand).toBe(`cd ${quote(workdir)} && env -i AIWG_FAKE_WORKER_CONFIG="\${AIWG_FAKE_WORKER_CONFIG-}"`
      + ` ${workerMarkerShell(invocation)} ${invocation.argv.map(quote).join(' ')} < ${quote(brief)} > ${quote(invocation.stdoutPath)} 2> ${quote(invocation.stderrPath)}`);
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, FACTORY_UNRELATED_SECRET: 'fk-synthetic-should-not-pass' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ model: MODEL, cwd: workdir, promptViaStdin: true, stdinEof: true });
    expect(record.brief).toContain(MARKER);
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    const final = installed.owner.parseDirectFinal(await readFile(invocation.stdoutPath, 'utf8'));
    expect(final).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
  });

  it.each([
    ['bundled unqualified profile', { qualify: false }, /unqualified/],
    ['unsupported CLI version', { cliVersion: '0.238.1' }, /Worker CLI version is outside qualified profile/],
  ])('FD03 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await factoryPlan(options as any);
    expect(plan.invocation).toBeUndefined();
    expect(messages(plan).length).toBeGreaterThan(0);
    expect(messages(plan)).toMatch(reason);
  });

  it('FD04 the driver argv refuses guessed/unsafe controls and carries no brief', () => {
    const owner = installed.owner;
    const input = { brief: `"; rm -rf / #\n--model evil ${MARKER}`, cwd: '/w', selected: { model: MODEL, effort: { value: 'low' } } };
    const argv = owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', approval: 'never' });
    expect(argv).toEqual(['exec', '--auto', 'low', '-m', MODEL, '-r', 'low', '--cwd', '/w', '--output-format', 'stream-json']);
    expect(argv.join(' ')).not.toContain(MARKER);
    expect(argv.join(' ')).not.toMatch(/skip-permissions-unsafe|bypass|dangerous|yolo/);
    expect(owner.buildWorkerArgs(input, null, { sandbox: 'read-only', approval: 'never' })).toEqual(
      ['exec', '-m', MODEL, '-r', 'low', '--cwd', '/w', '--output-format', 'stream-json']);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'opus', effort: { value: 'low' } } }, null, {}))
      .toThrow(/generic alias/);
    // roctinam/aiwg#2902 fix round 1: `-m auto` lets the CLI itself pick the
    // model ("Auto Model" in `exec --help`'s "Available Models"), which
    // violates the explicit-model invariant exactly like a generic alias.
    // Refused case-insensitively.
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'auto', effort: { value: 'low' } } }, null, {}))
      .toThrow(/auto-selection/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'AUTO', effort: { value: 'low' } } }, null, {}))
      .toThrow(/auto-selection/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: null } } }, null, {}))
      .toThrow(/explicit qualified reasoning effort/);
    // `exec --help`'s "Model details" lists `none` as a valid reasoning
    // level for several models (e.g. GPT-6 Sol/Luna); it must be accepted,
    // not just the seven other levels.
    expect(owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'none' } } }, null,
      { sandbox: 'read-only', approval: 'never' })).toEqual(
      ['exec', '-m', MODEL, '-r', 'none', '--cwd', '/w', '--output-format', 'stream-json']);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'external', approval: 'never' })).toThrow(/sandbox is not a qualified/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', approval: 'on-request' })).toThrow(/approval is not a qualified/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, { sandbox: 'workspace-write', approval: 'never' })).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '', effort: { value: 'low' } } }, null, {})).toThrow(/explicit model/);
    expect(owner.getAbortInput()).toBeNull();
  });
});

describe('T-OG-03/20/21/23 Factory run identity, stall and security signals', () => {
  const health = () => loadProviderModelCapabilities().providers.factory.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  const argv = () => [FAKE, 'exec', '--auto', 'low', '-m', MODEL, '-r', 'low', '--cwd', '/w', '--output-format', 'stream-json'];
  const owner = () => installed.owner;
  const stdoutSource = { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 };

  it('FD05 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'droid'), ['--help'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
  });

  it('FD06 success handshakes on activity/progress and completes on a strict terminal', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const kinds = events.map(event => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' })?.kind);
    expect(kinds).toEqual(['activity', 'activity', 'progress', 'terminal']);
    expect(owner().parseDirectFinal(result.stdout)).toMatchObject({ type: 'result', is_error: false });
  });

  it('FD07 a standalone error event fails despite a clean terminal and exit zero', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'exit-zero-error');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const observations = events.map(event => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' }));
    expect(observations.some(observation => observation?.fatal === true)).toBe(true);
    // The standalone parser fails closed too: a clean-looking terminal never papers over the error.
    expect(owner().parseDirectFinal(result.stdout)).toBeNull();
  });

  it('FD12a parseDirectFinal alone fails closed: bad terminals, ordering, errors and malformed lines', () => {
    const ok = { type: 'result', subtype: 'success', is_error: false, result: 'done' };
    const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';
    const parse = (text: string) => owner().parseDirectFinal(text);
    expect(parse(jsonl({ type: 'system' }, ok))).toMatchObject(ok);
    expect(parse(jsonl({ type: 'result' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'interrupted', is_error: false, result: 'x' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'mystery', is_error: false, result: 'x' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'success', is_error: true, result: 'x' }))).toBeNull();
    expect(parse(jsonl({ type: 'result', subtype: 'success', is_error: false, result: '  ' }))).toBeNull();
    // A later success never replaces an earlier failed result; an error after success is not ignored.
    expect(parse(jsonl({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'x' }, ok))).toBeNull();
    expect(parse(jsonl(ok, { type: 'error', message: 'late failure' }))).toBeNull();
    expect(parse(jsonl(ok) + 'not json\n')).toBeNull();
    expect(parse(jsonl({ type: 'system' }))).toBeNull();
  });

  it('FD12 a valid-JSON but underspecified/unsuccessful terminal fails closed, never open (roctinam/aiwg#2902 fix round 1)', async () => {
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
    // A bare `{"type":"result"}` with no subtype/is_error/result at all
    // must never default to success just because nothing is negative.
    expect(await runScenario('bare-result')).toMatchObject({ kind: 'terminal', success: false });
    // An unsuccessful subtype with is_error omitted and a non-empty result
    // must still fail.
    expect(await runScenario('interrupted-result')).toMatchObject({ kind: 'terminal', success: false });
    // Affirmative success markers but an empty result string must fail.
    expect(await runScenario('empty-result-text')).toMatchObject({ kind: 'terminal', success: false });
    // The fully-documented success shape stays a pass (regression guard).
    expect(await runScenario('success')).toMatchObject({ kind: 'terminal', success: true });
  });

  it('FD08 malformed or missing-final output with exit zero is never auto-accepted', async () => {
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

  it('FD09 silent hang after start crosses quiet then stall windows and needs a stop', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'hang');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 1_000, killSignal: 'SIGTERM' });
    expect(result.signal).toBe('SIGTERM');
    expect(result.code).toBeNull();
    expect(health().handshake).toBe('process-only');
  });

  it('FD10 TERM ignored requires KILL; the exit records the signal, never zero', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'ignore-term');
    const result = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 8_000,
        onStart: termAfterReady });
    expect(result.stdout).toContain(TERM_READY);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
  });

  it('FD11 secrets stay out of the command and a malicious final is inert data', async () => {
    const { plan, root } = await factoryPlan();
    const secret = 'fk-synthetic-factory-secret';
    expect(JSON.stringify(plan)).not.toContain(secret);
    const marker = path.join(root, 'executed-marker');
    const { file, recordPath } = await fakeConfig(root, 'malicious-final', { marker });
    const invocation = plan.invocation!;
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, FACTORY_API_KEY: secret } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.envNames).not.toContain('FACTORY_API_KEY');
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

  it('FD13 parseWorkerFinal resolves a successful stream whose final answer is a valid claims document', async () => {
    const stream = await streamFor('claims-final');
    await expect(owner().parseWorkerFinal(stream, { observation })).resolves.toMatchObject({ version: 1, status: 'completed' });
  });

  it('FD14 parseWorkerFinal rejects a successful stream whose final answer is plain text (not claims)', async () => {
    const stream = await streamFor('success');
    await expect(owner().parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });

  it('FD15 parseWorkerFinal rejects a failed or malformed stream', async () => {
    const { root, workdir } = await scratch();
    const malformed = await fakeConfig(root, 'malformed');
    const malformedResult = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: malformed.file } });
    expect(malformedResult.code).toBe(0);
    await expect(owner().parseWorkerFinal(malformedResult.stdout, { observation })).rejects.toThrow();
    const missing = await fakeConfig(root, 'missing-final');
    const missingResult = await run(process.execPath, argv().slice(0, 1).concat(argv().slice(1).map(a => a === '/w' ? workdir : a)),
      { cwd: workdir, stdinData: 'brief', env: { AIWG_FAKE_WORKER_CONFIG: missing.file } });
    await expect(owner().parseWorkerFinal(missingResult.stdout, { observation })).rejects.toThrow();
  });

  it('FD16 parseWorkerFinal accepts Uint8Array/Buffer bytes input', async () => {
    const stream = await streamFor('claims-final');
    await expect(owner().parseWorkerFinal(Buffer.from(stream, 'utf8'), { observation })).resolves.toMatchObject({ status: 'completed' });
  });
});
