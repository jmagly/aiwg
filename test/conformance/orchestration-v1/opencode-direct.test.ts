import { workerMarkerNames } from '../../fixtures/worker-attribution.js';
import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2904 (B-OG-39) OpenCode promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound OpenCode direct-shell profile through
 * the real resolver and #2887 renderer, then executes the rendered shell
 * command against a synthetic `opencode` that records argv, cwd, env names
 * and the attached brief file it received. Stdin is confirmed unsupported
 * by binary disassembly of the installed `opencode` 2.0.26 (the compiled
 * `run` chunk has no stdin/isTTY handling; see
 * tools/ralph-external/lib/opencode-adapter.mjs), so the brief travels as
 * an attached file via `-f`/`--file`; the argv positional carries only a
 * fixed, content-free instruction and never brief text. T-OG-03/20 drive
 * the same fake through the #2896 health observer via the production
 * OpenCodeAdapter owner. Spawns are plain child processes (no systemd);
 * nothing reaches a network, model, credential or MC state. Fixture
 * qualification here is synthetic and never live qualification: the
 * bundled OpenCode profile stays unqualified (OC06).
 *
 * Native MCP is not advertised on the evidenced CLI (`opencode serve` is an
 * HTTP API, not MCP; `opencode mcp` manages MCP *clients*); the AIWG
 * `worker-invoke` bridge remains the MCP route.
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
import { OPENCODE_DIRECT_STDIN, OPENCODE_FIXED_MESSAGE, OPENCODE_SUPPORTED_VERSIONS, OpenCodeAdapter } from '../../../tools/ralph-external/lib/opencode-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/opencode/fake-opencode.mjs');
const VERSION = '2.0.26';
const MODEL = 'synthetic/a%b';
const MARKER = 'OPENCODE-BRIEF-MARKER-7f1c9a';
const MODULE = 'tools/ralph-external/lib/opencode-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/opencode/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const owner = new OpenCodeAdapter();
const BOUNDARY_DIGEST = workerConfigDigest('synthetic-opencode-boundary');
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved OpenCode module into a fresh,
 * read-only package root (mirrors #2897 codex-direct.test.ts). The adapter
 * file is copied byte-for-byte (the fixture digest pins it); its
 * side-effect-free siblings ride along so the copied module resolves. */
async function installOpenCodePackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-opencode-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'opencode-adapter.mjs'), bytes, { mode: 0o644 });
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
  registry.providers.opencode.workerAdapter = structuredClone(registry.providers.opencode.workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installOpenCodePackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('opencode-direct'), ids };
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-opencode-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound OpenCode profile.
 * `qualify` overlays synthetic fixture qualification so the renderer can be
 * exercised; without it the bundled metadata must block. */
async function opencodePlan(options: { qualify?: boolean; effort?: 'ultra'; cliVersion?: string;
  memberModel?: string; execution?: Record<string, unknown> } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `plain brief text with a 雪 unicode glyph, newline\nand marker ${MARKER}`;
  const brief = path.join(root, 'brief.md');
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.opencode.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-opencode-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      Object.assign(control, { support: name === 'sandbox' ? 'external' : 'native',
        evidence: 'fixture:synthetic-opencode-host (not live evidence)' });
    }
    Object.assign(adapter.capabilities, { modelPin: 'requested', nestedAgentsControllable: true,
      nativeFallbackControllable: true });
    profile.envAllowlist = adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    profile.installationQualification = { scopeDigest: BOUNDARY_DIGEST,
      fixtureDigest: workerConfigDigest('synthetic-opencode-install'), verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
  }
  registry.providers.opencode.workerAdapter = adapter;
  if (options.effort === 'ultra') {
    Object.assign(f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!,
      { initialEffort: 'ultra', effortLadder: ['ultra'], allowNotApplicableEffort: false });
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) {
      row.reasoningEfforts = ['ultra'];
      Object.assign(row.worker!, { efforts: [{ id: 'ultra', selfDelegates: false }], effortSupport: 'explicit' });
    }
  } else {
    // No evidenced effort control (see module doc): the role must request
    // no effort at all, and the observation must declare it not-applicable,
    // rather than silently inheriting the base fixture's 'medium' default.
    Object.assign(f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!,
      { initialEffort: null, effortLadder: [], allowNotApplicableEffort: true });
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) {
      row.reasoningEfforts = [];
      Object.assign(row.worker!, { efforts: [], effortSupport: 'not-applicable' });
    }
  }
  // The CLI has no scoped sandbox flag (see module doc); the qualified
  // direct-shell profile only accepts externally-enforced sandboxing, so
  // the execution policy must request `sandbox: 'external'` explicitly
  // rather than the config default of `workspace-write`.
  f.snapshot.config.parallelism!.groups!.workers.execution = {
    ...f.snapshot.config.parallelism!.groups!.workers.execution, sandbox: 'external', ...(options.execution as any),
  };
  // Sandbox is externally-enforced for this CLI (no scoped flag; see module
  // doc), so a qualified boundary naming the `sandbox` control is required,
  // exactly like the Muse direct profile's externally-enforced controls.
  const boundary = { kind: 'os' as const, identity: 'synthetic-opencode-boundary',
    digest: BOUNDARY_DIGEST, controls: ['sandbox'] };
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION, boundary };
  f.snapshot.installations = { opencode: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'opencode';
  discovery.runtimeVersion = options.cliVersion ?? VERSION;
  for (const row of discovery.models) Object.assign(row.worker!, { cliId: 'opencode', runtimeVersion: options.cliVersion ?? VERSION });
  f.snapshot.catalog.discovery!.instances = { opencode: discovery };
  // One member only (mirrors muse-direct.test.ts): two candidate members for
  // the same role is an unrelated ambiguity this profile does not exercise.
  const soleMember = { ...f.snapshot.config.parallelism!.groups!.workers.members[0], cli: 'opencode',
    model: options.memberModel ?? MODEL };
  f.snapshot.config.parallelism!.groups!.workers.members = [soleMember];
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  const drivers: Record<string, WorkerInvocationDriver> = { opencode: {
    qualification: { adapter, adapterId: adapter.id, cliVersion: binding.cliVersion, boundary,
      installation: { evidence: profile.installationQualification, boundary } },
    // Synthetic installation recheck (mirrors muse-direct.test.ts); the real
    // preparation owner still checks all policy, tuple, environment, path
    // and matching-boundary bindings.
    prepareWorkerInvocation: (invocation: any, qualification: any) => prepareWorkerInvocation(invocation, qualification),
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: OPENCODE_DIRECT_STDIN, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
  } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, 'final.json'), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
  return { plan, root, workdir, payload, brief, adapter, snapshot: f.snapshot, drivers };
}

function messages(plan: any): string {
  return [...(plan.diagnostics ?? []), ...(plan.exclusions ?? []).flatMap((row: any) => row.diagnostics ?? [])]
    .map((d: any) => `${d.code} ${d.message}`).join('\n');
}

describe('OpenCode version-bound profile (B-OG-39)', () => {
  it('OC01 pins the evidenced release, driver, template and health grammar; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.opencode.workerHealthAdapter!;
    expect(OPENCODE_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: '1',
      runtimeDriver: 'installed:opencode',
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { kind: 'process', executable: 'opencode', stdin: 'closed', versionArgv: ['--version'] },
      qualification: { status: 'unqualified' } });
    expect(adapter.invocation.argv).toEqual(['run', '--format', 'json', '-m', '${model}', '-f', '${briefFile}',
      'Follow the instructions in the attached file exactly.']);
    expect(adapter.invocation.argv.join(' ')).not.toMatch(/--auto|bypass|dangerous|--effort/);
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    expect(profile.transport).toBe('shell');
    expect(profile.mcp).toBeUndefined();
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    const binaryEvidenced = ['stdin', 'effort', 'approval'];
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(binaryEvidenced.includes(name) ? /^R: conductor binary disassembly/ : /^H: opencode 2\.0\.26/);
    }
    expect(profile.controls.model.mapping).toContain('-m/--model');
    expect(profile.controls.effort.mapping).toContain('#<variant>');
    expect(profile.controls.effort.mapping).toContain('reasoning_effort');
    expect(profile.controls.approval.mapping).toMatch(/reject/);
    expect(profile.controls.sandbox.mapping).toContain('--auto');
    expect(profile.controls.stdin.mapping).toMatch(/confirmed unsupported/);
    expect(profile.controls.stdin.mapping).toMatch(/-f\/--file/);
    expect(profile.controls.workdir.mapping).toMatch(/cd \$\{workspace\}/);
    expect(profile.pitfalls.some(line => /confirmed unsupported/.test(line) && /attached file/.test(line))).toBe(true);
    expect(profile.pitfalls.some(line => /--auto is a blanket/.test(line))).toBe(true);
    expect(profile.health).toMatchObject({ handshake: 'process-only', outputFraming: 'jsonl',
      signalParser: 'provider-opencode-health-v1', coverage: 'degraded', qualificationTarget: 'semantic',
      qualificationOwner: 'B-OG-39', evidenceGrades: ['H', 'R'] });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
    expect(adapter.capabilities).toMatchObject({ output: 'text', modelPin: 'unsupported',
      effort: 'unsupported', cancel: 'none', resume: false, sandboxModes: ['external'] });
  });

  it('OC01d pins the one approved module digest and loads OpenCode through the production installed loader', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:opencode', interfaceVersion: 1, adapterIds: ['opencode-direct'],
      platforms: ['linux'] });
    expect(installed.ids).toEqual(['opencode-direct']);
    expect(installed.owner.getName()).toBe('opencode-direct');
    expect(installed.owner.constructor.name).toBe('OpenCodeDirectAdapter');
    expect(installed.owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: null } }, cwd: '/w', briefPath: '/w/brief.md' }, null, {}))
      .toEqual(['run', '--format', 'json', '-m', MODEL, '-f', '/w/brief.md', OPENCODE_FIXED_MESSAGE]);
    expect(OPENCODE_DIRECT_STDIN).toBe('closed');
  });

  it("(#2995 round 4, item 3) inspectWorkerInstallation accepts the direct adapter's identity (adapter.id === instance.getName())", async () => {
    const { inspectWorkerInstallation } = await import('../../../src/models/worker-installation.mjs');
    const adapter = structuredClone(loadProviderModelCapabilities().providers['opencode'].workerHealthAdapter!);
    let error: any;
    try {
      await inspectWorkerInstallation(installed.owner, { adapter, platform: 'linux', profile: 'direct-shell',
        cliVersion: adapter.supportedVersions, workerWritableRoots: [], effectiveConfigDigest: `sha256:${'a'.repeat(64)}`,
        accountScope: 'synthetic', boundary: null, cwd: '/tmp' });
    } catch (e) { error = e; }
    // Before this fix, this threw 'Unsupported installation identity/platform'
    // because the Direct subclass's getName() still returned the bare id
    // while adapter.id is now `opencode-direct`. Any OTHER error here (this minimal
    // request is deliberately incomplete past the identity gate) proves
    // the identity check itself passed.
    expect(error?.message).not.toBe('Unsupported installation identity/platform');
  });

  it('OC01e a tampered copy is refused by the installed loader', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installOpenCodePackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
  });

  it('OC01b the bundled registry stays undispatchable on either transport', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:opencode')).toThrow();
    registry.providers.opencode.workerAdapter = structuredClone(registry.providers.opencode.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:opencode');
    for (const transport of ['shell', 'mcp'] as const) {
      expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport, cliVersion: VERSION }))
        .toThrow('Worker transport/profile is unqualified');
    }
  });
});

describe('T-OG-15 OpenCode direct command contract', () => {
  it('OC02 renders the qualified template; the brief travels via -f, never argv or the plan', async () => {
    const { plan, root, workdir, payload, brief } = await opencodePlan();
    expect(plan.invocation, messages(plan)).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.selected.model).toBe(MODEL);
    expect(invocation.stdin).toBe('closed');
    expect(invocation.briefPath).toBe(brief);
    expect(invocation.argv.slice(2)).toEqual(['run', '--format', 'json', '-m', MODEL, '-f', brief, OPENCODE_FIXED_MESSAGE]);
    // The planted marker lives only in the brief FILE's content; it must
    // never leak into argv or the serialized plan.
    expect(invocation.argv.join(' ')).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    expect(JSON.stringify(plan)).not.toContain(MARKER);
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, OPENCODE_UNRELATED_SECRET: '[REDACTED]' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ model: MODEL, format: 'json', message: OPENCODE_FIXED_MESSAGE, file: brief, brief: payload, cwd: workdir });
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
    // The marker DOES reach the fake, but only through the attached file.
    expect(record.brief).toContain(MARKER);
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    const stdout = await readFile(invocation.stdoutPath, 'utf8');
    expect(owner.parseOutput(stdout)).toEqual({ text: `synthetic reply (${payload.length} chars)` });
    const events = stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => owner.observeHealthEvent(event, { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 },
      { invocationId: 'oc02' })?.kind ?? null)).toEqual(['setup', 'activity', 'terminal']);
  });

  it.each([
    ['bundled unqualified profile', {}, /Exact model or fallback control is unqualified|Child-agent control is unqualified/],
    ['unsupported CLI version', { cliVersion: '1.9.0' }, /Worker CLI version is outside qualified profile/],
    ['denied ultra effort', { effort: 'ultra' }, /Unsupported, denied or self-delegating effort/],
    ['unknown model', { memberModel: 'synthetic/unknown' }, /./],
  ])('OC03 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await opencodePlan({ qualify: _name !== 'bundled unqualified profile' ? undefined : false, ...(options as any) });
    expect(plan.invocation).toBeUndefined();
    const text = messages(plan);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(reason as RegExp);
  });

  it('OC04 the driver argv maps an explicit effort to #<variant>, refuses malformed effort/alias/path', () => {
    const input = { selected: { model: MODEL, effort: { value: null } }, cwd: '/w', briefPath: '/w/brief.md' };
    expect(owner.buildWorkerArgs(input, null, {})).toEqual(['run', '--format', 'json', '-m', MODEL, '-f', '/w/brief.md', OPENCODE_FIXED_MESSAGE]);
    // An explicit effort is a reasoning-effort variant id, appended as #<effort>.
    expect(owner.buildWorkerArgs({ ...input, selected: { ...input.selected, effort: { value: 'high' } } }, null, {}))
      .toEqual(['run', '--format', 'json', '-m', `${MODEL}#high`, '-f', '/w/brief.md', OPENCODE_FIXED_MESSAGE]);
    expect(owner.buildWorkerArgs({ ...input, selected: { ...input.selected, effort: { value: 'max' } } }, null, {}))
      .toContain(`${MODEL}#max`);
    for (const bad of ['#high', 'high/low', 'high denied', 'high\nmore', '']) {
      expect(() => owner.buildWorkerArgs({ ...input, selected: { ...input.selected, effort: { value: bad } } }, null, {}))
        .toThrow(/plain variant id/);
    }
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'opus', effort: { value: null } } }, null, {}))
      .toThrow(/exact observed model/);
    expect(() => owner.buildWorkerArgs({ ...input, briefPath: 'relative/brief.md' }, null, {}))
      .toThrow(/absolute brief-file path/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute workspace/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write' })).toThrow(/not a qualified direct mode/);
    expect(owner.buildWorkerArgs(input, null, {}).join(' ')).not.toContain(MARKER);
    expect(owner.getAbortInput()).toBeNull();
  });

  it('OC06 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    registry.providers.opencode.workerAdapter = structuredClone(registry.providers.opencode.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:opencode');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    expect(fixtureJson('provider-coverage.json').rows.find((row: any) => row.provider === 'opencode'))
      .toMatchObject({ scope: 'IN', owner: 'B-OG-39', nativeMcp: 'http-not-mcp', qualification: 'unqualified' });
  });
});

describe('T-OG-20 OpenCode run identity and signals', () => {
  const health = () => loadProviderModelCapabilities().providers.opencode.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  const profile = () => loadProviderModelCapabilities().providers.opencode.workerHealthAdapter!.invocationProfiles!['direct-shell'];
  const BRIEF = 'synthetic brief';
  const argv = (briefPath: string) => [FAKE, ...owner.buildWorkerArgs(
    { selected: { model: MODEL, effort: { value: null } }, cwd: '/unused', briefPath }, profile(), {})];
  const source = { kind: 'stdout' as const, id: 'stdout', generation: 0, offset: 0 };
  const observer = (clock: { t: number }) => owner.createHealthObserver({ provider: 'opencode',
    profile: { health: health() }, invocationId: 'opencode-fixture', now: () => clock.t, wallNow: () => 0, startedAt: 0 });
  const feedLines = (o: ReturnType<typeof owner.createHealthObserver>, text: string) => {
    for (const line of text.trim().split('\n')) if (line) o.feed(Buffer.from(`${line}\n`), source);
  };

  it('OC07 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'opencode'), ['--version'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    const o = observer({ t: 0 });
    expect(o.finish({ exitCode: null, termination: 'uncertain' }).state).not.toBe('completed');
  });

  it('OC08 success handshakes on step_start, observes activity and completes on step_finish("stop")', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, BRIEF);
    const { file } = await fakeConfig(root, 'success');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    expect(result.code, result.stderr).toBe(0);
    feedLines(o, result.stdout);
    expect(o.snapshot()).toMatchObject({ handshake: 'process-only' });
    expect(o.snapshot().lastProgressAt ?? o.snapshot().lastActivityAt).not.toBeNull();
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed',
      finalValid: owner.parseOutput(result.stdout) !== null });
    expect(snapshot).toMatchObject({ state: 'completed' });
  });

  it.each([
    ['auth-error', 'AUTH'],
    ['model-not-found', 'MODEL'],
  ])('OC09 %s on stderr is diagnosed and fails the attempt', async (scenario, reasonCode) => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, BRIEF);
    const { file } = await fakeConfig(root, scenario);
    const o = observer({ t: 0 });
    const result = await run(process.execPath, argv(briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(1);
    o.feed(Buffer.from(result.stderr), { kind: 'stderr', id: 'stderr', generation: 0, offset: 0 });
    expect(o.snapshot().reasonCode).toBe(reasonCode);
    expect(o.finish({ exitCode: result.code, termination: 'confirmed' }).state).not.toBe('completed');
  });

  it('OC10 exit-zero with a non-"stop" step_finish fails; a truncated stream yields no valid final', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, BRIEF);
    const { file } = await fakeConfig(root, 'step-error');
    const result = await run(process.execPath, argv(briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    const o = observer({ t: 0 });
    o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    feedLines(o, result.stdout);
    expect(o.evidence().events.some(event => event.kind === 'error')).toBe(true);
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).not.toBe('completed');
    // The strict final parser independently rejects a non-"stop" reason, even
    // though the process exited 0 with readable text on stdout.
    expect(owner.parseOutput(result.stdout)).toBeNull();
    const { file: malformedFile } = await fakeConfig(root, 'malformed');
    const malformed = await run(process.execPath, argv(briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: malformedFile } });
    expect(malformed.code).toBe(0);
    expect(owner.parseOutput(malformed.stdout)).toBeNull();
  });

  it('OC10a a text part with no recorded time.end and no step_finish is rejected (exit code alone never substitutes for a positive signal)', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, BRIEF);
    const { file } = await fakeConfig(root, 'truncated-after-text');
    const result = await run(process.execPath, argv(briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('synthetic reply with no terminal');
    expect(owner.parseOutput(result.stdout)).toBeNull();
  });

  it('OC10b a single complete text event with NO step_start/step_finish IS a valid final (live opencode 2.0.26 shape)', async () => {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, BRIEF);
    const { file } = await fakeConfig(root, 'success-v2');
    const result = await run(process.execPath, argv(briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('text');
    expect(owner.parseOutput(result.stdout)).toEqual({ text: `synthetic reply (${BRIEF.length} chars)` });
  });

  it('OC11 secrets stay out of the recorded command', async () => {
    const { plan, root } = await opencodePlan();
    const secret = '[REDACTED]';
    expect(JSON.stringify(plan)).not.toContain(secret);
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', plan.invocation!.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, OPENCODE_API_KEY: secret } });
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.envNames).not.toContain('OPENCODE_API_KEY');
  });

  // #2995: production marks a run `completed` only when `parseWorkerFinal`
  // succeeds. These cases drive the real installed-owner hook, never a
  // hand-fed finalValid.
  const observation = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
  async function streamFor(scenario: string): Promise<string> {
    const { root, workdir } = await scratch();
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, BRIEF);
    const { file } = await fakeConfig(root, scenario);
    const result = await run(process.execPath, argv(briefPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  it('OC12 parseWorkerFinal resolves a successful stream whose final answer is a valid claims document', async () => {
    const stream = await streamFor('claims-final');
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).resolves.toMatchObject({ version: 1, status: 'completed' });
  });

  it('OC13 parseWorkerFinal rejects a successful stream whose final answer is plain text (not claims)', async () => {
    const stream = await streamFor('success');
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });

  it.each(['step-error', 'malformed', 'truncated-after-text'])('OC14 parseWorkerFinal rejects a %s stream', async scenario => {
    const stream = await streamFor(scenario);
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });

  it('OC15 parseWorkerFinal accepts Uint8Array/Buffer bytes input', async () => {
    const stream = await streamFor('claims-final');
    await expect(installed.owner.parseWorkerFinal(Buffer.from(stream, 'utf8'), { observation })).resolves.toMatchObject({ status: 'completed' });
  });

  // #2995 round 3 (item A.3): before this fix, every `text` part across
  // the WHOLE run was concatenated and an earlier completion signal (a
  // finished `text` part) was never discarded by a later step. This proves
  // an earlier step's complete claims followed by an empty final step
  // never resolves.
  it('OC16a a tool step followed by an answer step resolves with the last step only; non-emitter events reject', () => {
    const line = (event: unknown) => JSON.stringify(event);
    const text = (value: string, end: number | null = 2) => line({ type: 'text', sessionID: 's', part: { type: 'text', text: value, time: end ? { start: 1, end } : { start: 1 } } });
    const start = line({ type: 'step_start', sessionID: 's', part: { type: 'step-start' } });
    const finish = (reason: string) => line({ type: 'step_finish', sessionID: 's', part: { type: 'step-finish', reason } });
    const tool = line({ type: 'tool_use', sessionID: 's', part: { type: 'tool', state: { status: 'completed' } } });
    const reasoning = line({ type: 'reasoning', sessionID: 's', part: { type: 'reasoning', text: 'thinking' } });
    const parse = (...lines: string[]) => installed.owner.parseDirectFinal(lines.join('\n') + '\n');
    // 'tool-calls' is the one evidenced continue reason (2.0.26: finish && !["tool-calls","unknown"].includes(finish)).
    expect(parse(start, text('PRE-TOOL'), tool, finish('tool-calls'), start, reasoning, text('ANSWER'), finish('stop'))).toEqual({ text: 'ANSWER' });
    expect(parse(start, tool, finish('tool_use'), start, text('A'), finish('stop'))).toBeNull(); // not a normalized reason
    expect(parse(start, text('A'), finish('unknown'))).toBeNull();
    expect(parse(start, text('A'), line({ type: 'mystery', sessionID: 's' }), finish('stop'))).toBeNull(); // outside the emitter's six types
    expect(parse(text('CLAIMS'), text('junk', null))).toBeNull(); // an unfinished part after a complete one invalidates it
  });

  it('OC16 (regression) an earlier complete claims step followed by an empty final step never resolves', async () => {
    const claims = JSON.stringify({ version: 1, status: 'completed', summary: 'stale', claims: [], artifacts: [], checks: [], limitations: [] });
    const SID = 'opencode-fixture-session';
    const line = (event: unknown) => JSON.stringify(event);
    const stream = [
      line({ type: 'step_start', sessionID: SID, part: {} }),
      line({ type: 'text', sessionID: SID, part: { id: 'p1', sessionID: SID, type: 'text', text: claims, time: { start: 1, end: 2 } } }),
      line({ type: 'step_start', sessionID: SID, part: {} }),
      line({ type: 'step_finish', sessionID: SID, part: { reason: 'stop' } }),
    ].join('\n') + '\n';
    expect(installed.owner.parseOutput(stream)).toBeNull();
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });

  // #2995 round 4 (item 1): an intermediate step ending for a CONTINUE
  // reason (the model called a tool, not run completion) must not be
  // terminal and must not fail; the run resolves with the LAST step's text.
  it('OC17 (regression) step_start -> step_finish(tool-calls) -> step_start -> text(claims) -> step_finish(stop) RESOLVES with the last step\'s text', async () => {
    const claims = JSON.stringify({ version: 1, status: 'completed', summary: 'x', claims: [], artifacts: [], checks: [], limitations: [] });
    const SID = 'opencode-fixture-session';
    const line = (event: unknown) => JSON.stringify(event);
    const stream = [
      line({ type: 'step_start', sessionID: SID, part: {} }),
      line({ type: 'step_finish', sessionID: SID, part: { reason: 'tool-calls' } }),
      line({ type: 'step_start', sessionID: SID, part: {} }),
      line({ type: 'text', sessionID: SID, part: { id: 'p1', sessionID: SID, type: 'text', text: claims, time: { start: 1, end: 2 } } }),
      line({ type: 'step_finish', sessionID: SID, part: { reason: 'stop' } }),
    ].join('\n') + '\n';
    expect(installed.owner.parseOutput(stream)).toMatchObject({ text: claims });
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).resolves.toMatchObject({ status: 'completed' });
  });

  // #2995 round 4 (item 1): any text part WITHOUT time.end arriving after
  // an established complete candidate invalidates that candidate -- never
  // silently discarded in favor of the earlier, already-complete one.
  it.each([
    ['whitespace', '   '],
    ['non-claims', 'unfinished but not whitespace either'],
  ])('OC18 (regression) a complete claims text followed by an unfinished %s text part REJECTS', async (_label, unfinishedText) => {
    const claims = JSON.stringify({ version: 1, status: 'completed', summary: 'x', claims: [], artifacts: [], checks: [], limitations: [] });
    const SID = 'opencode-fixture-session';
    const line = (event: unknown) => JSON.stringify(event);
    const stream = [
      line({ type: 'step_start', sessionID: SID, part: {} }),
      line({ type: 'text', sessionID: SID, part: { id: 'p1', sessionID: SID, type: 'text', text: claims, time: { start: 1, end: 2 } } }),
      line({ type: 'text', sessionID: SID, part: { id: 'p2', sessionID: SID, type: 'text', text: unfinishedText } }),
      line({ type: 'step_finish', sessionID: SID, part: { reason: 'stop' } }),
    ].join('\n') + '\n';
    expect(installed.owner.parseOutput(stream)).toBeNull();
    await expect(installed.owner.parseWorkerFinal(stream, { observation })).rejects.toThrow();
  });
});
