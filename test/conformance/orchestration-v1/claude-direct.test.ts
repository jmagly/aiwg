import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/** #2900: offline Claude CLI profile mechanics, never live qualification.
 * T-OG-03/10/14/15/19/20/23 are partial: no model, account or MC access.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile } from '../../../src/models/provider-policy.js';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { prepareWorkerInvocation, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
// Deliberately preload legacy Claude: the direct installed ID must coexist.
import { ClaudeAdapter, CLAUDE_SUPPORTED_VERSIONS } from '../../../tools/ralph-external/lib/claude-adapter.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const MODULE = 'tools/ralph-external/lib/claude-adapter.mjs';
const FAKE = path.resolve('test/fixtures/providers/claude/fake-claude.mjs');
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/claude/approved-module.json', 'utf8'));
const VERSION = '2.1.319', MODEL = 'synthetic-claude-model', MARKER = 'CLAUDE-BRIEF-雪';
const roots: string[] = [], installRoots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let installed: { owner: any; ids: string[] };

function metadata() { return structuredClone(loadProviderModelCapabilities().providers.claude.workerHealthAdapter!); }
function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers.claude.workerAdapter = metadata();
  return registry;
}

/** Copy approved bytes with their dependency closure. The test-only bridge to
 * the source loader keeps one registry; no node_modules mutation or systemd.
 */
async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-claude-install-')); installRoots.push(base);
  await chmod(base, 0o755);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', type: 'module' }));
  const packageRoot = path.join(base, 'pkg'), writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 });
  await mkdir(writable); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, APPROVED.entry.modulePath), bytes, { mode: 0o644 });
  await copyWorkerAdapterRuntime(base, packageRoot);
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), path.join(base, '_resolve-impl.mjs'));
  await mkdir(path.join(base, 'src', 'models'), { recursive: true });
  const target = path.relative(path.join(base, 'src', 'models'), path.resolve('src/models/worker-installation.mjs'));
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'), `export * from ${JSON.stringify(target)};\n`);
  await mkdir(path.join(base, 'src', 'mission-protocol'), { recursive: true });
  const protocol = path.relative(path.join(base, 'src', 'mission-protocol'), path.resolve('src/mission-protocol/index.ts'));
  await writeFile(path.join(base, 'src', 'mission-protocol', 'index.js'), `export * from ${JSON.stringify(protocol)};\n`);
  return { packageRoot, writable };
}
beforeAll(async () => {
  const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
  const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot }],
    workerWritableRoots: [writable], platform: 'linux' });
  installed = { owner: createProvider('claude-direct'), ids };
});
afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-claude-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}
/** Async, bounded spawn. CI needs no user manager, and stdin always reaches EOF. */
function run(command: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, stdin?: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function plan(qualified = true, version = VERSION) {
  const f = workerResolutionFixture(), { root, workdir } = await scratch();
  const payload = `--leading ${MARKER} 'quotes"\n$(touch ${root}/injected); \`echo danger\``;
  const brief = path.join(root, "brief '雪\n.md"); await writeFile(brief, payload);
  const adapter = metadata() as any, profile = adapter.invocationProfiles['direct-shell'];
  // In-memory synthetic host controls exercise the existing resolver gate only.
  const evidence = { scopeDigest: workerConfigDigest('synthetic-scope'), fixtureDigest: workerConfigDigest('synthetic-fixture'),
    verifiedAt: f.request.now, evidenceRef: 'fixture:synthetic-only' };
  const boundary = { kind: 'os' as const, identity: 'fixture:external-boundary', digest: workerConfigDigest('boundary'), controls: ['sandbox'] };
  if (qualified) {
    adapter.qualification = { status: 'qualified', fixtureDigest: evidence.fixtureDigest,
      verifiedAt: f.request.now, evidenceRef: evidence.evidenceRef };
    for (const control of Object.values(profile.controls) as any[]) control.support = 'native';
    profile.controls.sandbox.support = 'external';
    profile.installationQualification = evidence;
  }
  profile.envAllowlist = adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  delete f.snapshot.registry.providers.codex.workerAdapter;
  f.snapshot.registry.providers.claude.workerAdapter = adapter;
  const workers = f.snapshot.config.parallelism!.groups!.workers;
  workers.members = [{ id: 'primary', cli: 'claude', model: MODEL, roles: ['coding'], priority: 10 }]; workers.fallback = [];
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'claude'; discovery.runtimeVersion = version; discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = row.apiModelId = MODEL; row.worker!.cliId = 'claude'; row.worker!.runtimeVersion = version;
    row.reasoningEfforts = ['medium', 'high']; row.worker!.efforts = [{ id: 'medium', selfDelegates: false }, { id: 'high', selfDelegates: false }];
  }
  f.snapshot.catalog.discovery!.instances = { claude: discovery };
  const binding = { ...f.snapshot.installations.codex, cliVersion: version, profile: 'direct-shell', boundary };
  f.snapshot.installations = { claude: binding };
  const drivers: Record<string, WorkerInvocationDriver> = { claude: {
    qualification: { adapter, adapterId: adapter.id, cliVersion: version, boundary,
      installation: { executable: process.execPath, cwd: workdir, workerWritableRoots: [workdir],
        effectiveConfigDigest: workerConfigDigest('fixture'), accountScope: 'synthetic', boundary, evidence: { ...evidence, cases: {} } } },
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...installed.owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: 'brief-text', envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
    // Claude's sandbox control is external-boundary-only (no native CLI sandbox),
    // so installation-scoped qualification applies; delegate to the shared
    // #2885 preparation/recheck implementation rather than a bespoke one.
    prepareWorkerInvocation: (invocation, qualification) => prepareWorkerInvocation(invocation, qualification),
  } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport: 'shell' as const };
  const result = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
  return { result, root, workdir, payload };
}
async function execute(scenario = 'success') {
  const f = await plan();
  expect(f.result.invocation, JSON.stringify(f.result)).toBeDefined();
  const invocation = f.result.invocation!;
  const config = path.join(f.root, 'fake.json'), record = path.join(f.root, 'record.json');
  await writeFile(config, JSON.stringify({ scenario, recordPath: record }));
  const result = await run('/bin/sh', ['-c', invocation.shellCommand!], f.root,
    { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: config, UNRELATED_SECRET: 'synthetic-secret' });
  return { ...f, invocation, record, ...result, stream: await readFile(invocation.stdoutPath, 'utf8') };
}
const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
const source = { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 };
function observer() {
  return installed.owner.createHealthObserver({ provider: 'claude', profile: metadata().invocationProfiles!['direct-shell'],
    invocationId: 'fixture', sessionId: 'claude-fixture-session', now: () => 0, wallNow: () => 0, startedAt: 0,
    effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 90, stallSeconds: 300, diagnosticGraceSeconds: 60 } });
}

describe('Claude direct CLI profile (#2900)', () => {
  it('CD01 pins installed bytes and coexists with the preloaded legacy adapter', () => {
    expect(APPROVED.source).toBe(MODULE); expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(installed.ids).toEqual(['claude-direct']); expect(installed.owner.getName()).toBe(metadata().id);
    // The install fixture copies provider-adapter.mjs (to satisfy the
    // installed loader's own relative resolution of its dependency closure),
    // and that copy's module-load side effect re-imports claude-adapter.mjs
    // without the sha256 query that marks the digest-pinned installed load,
    // producing a second, legitimate ClaudeAdapter class object distinct
    // from the one imported above. `instanceof` is identity-sensitive to
    // the exact module instance, so it is the wrong check across that
    // boundary; assert identity by constructor name and adapter behavior
    // instead of class reference equality.
    const legacy = createProvider('claude');
    expect(legacy.constructor.name).toBe(ClaudeAdapter.name);
    let proto = Object.getPrototypeOf(legacy);
    const chain: string[] = [];
    while (proto && proto !== Object.prototype) { chain.push(proto.constructor.name); proto = Object.getPrototypeOf(proto); }
    expect(chain).toEqual(['ClaudeAdapter', 'ProviderAdapter']);
    expect(legacy.getName()).toBe('claude');
    expect(legacy.getBinary()).toBe('claude');
    const a = metadata();
    expect(a).toMatchObject({ id: 'claude-direct', runtimeDriver: 'installed:claude', supportedVersions: '>=2.1.295 <2.2.0', qualification: { status: 'unqualified' } });
    expect(CLAUDE_SUPPORTED_VERSIONS).toEqual([a.supportedVersions]);
    expect(a.invocationProfiles!['direct-shell'].supportedVersions).toBe(a.supportedVersions);
    expect(a.invocation).toMatchObject({ stdin: 'brief-text', executable: 'claude' });
    expect(a.invocationProfiles!['direct-shell'].controls.approval.evidence).toContain('--permission-prompts');
  });
  it('CD02 rejects tampered modules and unsupported platforms before import', async () => {
    const bad = await installPackage(Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tamper')]));
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'win32' })).rejects.toThrow(/platform/i);
  });
  it('CD03 renders and executes through the production resolver; brief and secrets stay out of argv/env', async () => {
    const f = await execute();
    expect(f.code, f.stderr).toBe(0); expect(f.invocation.stdin).toBe('brief-text');
    expect(JSON.stringify(f.result)).not.toContain(MARKER);
    const record = JSON.parse(await readFile(f.record, 'utf8'));
    expect(record).toMatchObject({ cwd: f.workdir, brief: f.payload, stdinEof: true, argv: f.invocation.argv.slice(2) });
    expect(record.envNames).not.toContain('UNRELATED_SECRET'); expect(existsSync(path.join(f.root, 'injected'))).toBe(false);
    expect(record.argv).toEqual((metadata().invocation as any).argv.map((arg: string) => arg.replace('${model}', MODEL).replace('${effort}', 'medium')));
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const claims = await installed.owner.parseWorkerFinal(f.stream, { observation });
    expect(claims).toMatchObject({ version: 1, status: 'completed', summary: 'synthetic only' });
    const o = observer(); o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    o.feed(Buffer.from(f.stream), source);
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).toBe('completed');
    expect(o.evidence().events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['setup', 'accepted', 'progress', 'terminal']));
  });
  it.each(['missing', 'truncated', 'double', 'wrong-session', 'exit-zero-error', 'standalone-error'])('CD04 rejects %s even at exit zero', async scenario => {
    const f = await execute(scenario); expect(f.code).toBe(0);
    await expect(installed.owner.parseWorkerFinal(f.stream, { observation })).rejects.toThrow();
    if (scenario.includes('error')) {
      const o = observer(); o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath }); o.feed(Buffer.from(f.stream), source);
      expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).not.toBe('completed');
    }
  });
  it('CD05 extracts structured_output and rejects clean final text after process failure', async () => {
    const f = await execute('structured'); vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    await expect(installed.owner.parseWorkerFinal(f.stream, { observation })).resolves.toMatchObject({ status: 'completed' });
    await expect(installed.owner.parseWorkerFinal(f.stream, { observation: { ...observation, exitCode: 7, status: 'failed' } })).rejects.toThrow();
  });
  it('CD06 duplicate envelope members, malformed UTF-8 and bounded streams fail', async () => {
    const f = await execute();
    for (const stream of [f.stream.replace('"is_error":false', '"is_error":true,"is_error":false'),
      f.stream.replace('"is_error":false', '"is_erro\\u0072":true,"is_error":false'), Buffer.from([0xff])]) {
      await expect(installed.owner.parseWorkerFinal(stream, { observation })).rejects.toThrow();
    }
    await expect(installed.owner.parseWorkerFinal(f.stream, { observation, maxOutputBytes: 10 })).rejects.toThrow(/bound/);
  });
  it('CD07 bundled metadata remains unqualified; unknown CLI versions never render', async () => {
    expect(() => qualifyWorkerInvocationProfile(metadata(), { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION })).toThrow('unqualified');
    expect((await plan(false)).result.invocation).toBeUndefined();
    expect((await plan(true, '2.2.0')).result.invocation).toBeUndefined();
  });
  it.each(['2.1.295', '2.1.296', '2.1.317', '2.1.319', '2.1.320', '2.1.999+build.1'])(
    'CD12 #3845 resolves compatible Claude patch %s through both version gates', async version => {
      expect((await plan(true, version)).result.invocation).toBeDefined();
    });
  it.each(['2.1.294', '2.1.319-rc.1', '2.2.0', '3.0.0'])(
    'CD13 #3845 blocks unsupported Claude version %s', async version => {
      expect((await plan(true, version)).result.invocation).toBeUndefined();
    });
  it('CD08 legacy session and analysis calls no longer inherit permission bypass', () => {
    for (const args of [installed.owner.buildSessionArgs({ prompt: 'synthetic', model: MODEL }), installed.owner.buildAnalysisArgs({ prompt: 'synthetic', model: MODEL })]) {
      expect(args).not.toContain('--dangerously-skip-permissions'); expect(args).toContain('dontAsk'); expect(args).toContain('none');
    }
  });
  it.each(['manual', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'always', 'on-request'])('CD09 denies permission mode %s', approval => {
    expect(() => installed.owner.buildWorkerArgs({ selected: { model: MODEL, effort: { value: 'medium' } }, cwd: os.tmpdir(), brief: 'synthetic' }, null, { approval })).toThrow();
  });
  it('CD10 rejects missing model/effort, aliases, unsupported effort and sandbox; read-only removes write tools', () => {
    const input = { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: os.tmpdir(), brief: 'synthetic' };
    for (const selected of [{ effort: { value: 'medium' } }, { model: MODEL }, { model: 'sonnet', effort: { value: 'medium' } }, { model: MODEL, effort: { value: 'ultra' } },
      // Moving pointers beyond the plain --help aliases: the Max-plan alias,
      // the bracketed context-window modifier, and a dateless family id that
      // still resolves to whatever snapshot is currently latest.
      { model: 'opusplan', effort: { value: 'medium' } }, { model: 'sonnet[1m]', effort: { value: 'medium' } },
      { model: 'claude-sonnet-4-5', effort: { value: 'medium' } }, { model: 'claude-3-5-sonnet-latest', effort: { value: 'medium' } }]) {
      expect(() => installed.owner.buildWorkerArgs({ ...input, selected }, null, {})).toThrow();
    }
    // A dated snapshot of the same family is an exact, non-moving id and must pass.
    expect(installed.owner.buildWorkerArgs({ ...input, selected: { model: 'claude-sonnet-4-5-20250929', effort: { value: 'medium' } } }, null,
      { sandbox: 'read-only', approval: 'never' })).toContain('claude-sonnet-4-5-20250929');
    expect(() => installed.owner.buildWorkerArgs(input, null, { sandbox: 'danger-full-access' })).toThrow();
    const args = installed.owner.buildWorkerArgs(input, null, { sandbox: 'read-only', approval: 'never' });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep'); expect(args).not.toContain('default');
    expect(installed.owner.getAbortInput()).toBeNull();
  });

  it('CD11 never accepts bare claims as a final: terminal validation applies to json-labelled input too', async () => {
    const claims = JSON.stringify({ version: 1, status: 'completed', summary: 'Synthetic', claims: [], artifacts: [], checks: [], limitations: [] });
    const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
    // A worker-written final file handed over as 'json' carries no Claude
    // terminal result, so it must fail instead of bypassing validation.
    await expect(installed.owner.parseWorkerFinal(claims, { format: 'json', observation })).rejects.toThrow();
    await expect(installed.owner.parseWorkerFinal(claims, { format: 'jsonl', observation })).rejects.toThrow();
  });
});
