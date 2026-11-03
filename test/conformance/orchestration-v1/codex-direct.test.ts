import { workerMarkerNames, workerMarkerShell } from '../../fixtures/worker-attribution.js';
import { termAfterReady, TERM_READY } from '../../helpers/term-escalation.js';
import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2897 (B-OG-07) Codex promotion: offline S1 profile work.
 *
 * T-OG-15 renders the version-bound Codex direct-shell profile through the
 * real resolver and #2887 renderer, then executes the rendered shell command
 * against a synthetic `codex` that records argv, cwd, stdin, environment
 * names and output paths. The brief travels on stdin (`-` prompt argument,
 * `stdin: 'brief-text'`), never in argv. T-OG-03/20/21/23 drive the same
 * fake through the #2896 health observer via the production CodexAdapter
 * owner. Spawns are plain child processes (no systemd); nothing reaches a
 * network, model, credential or MC state. Fixture qualification here is
 * synthetic and never live qualification: the bundled Codex profile stays
 * unqualified (CX06).
 *
 * Native MCP is version-blocked on the evidenced CLIs (`codex mcp-server
 * --help` prints the root help on 0.160.1/0.161.0); the AIWG
 * `worker-invoke` bridge remains the MCP route.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { CODEX_DIRECT_STDIN, CODEX_SUPPORTED_VERSIONS, CodexAdapter, summarizeCodexStream } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/codex/fake-codex.mjs');
const VERSION = '0.161.0';
const MODEL = 'synthetic/a%b';
const MARKER = 'CODEX-BRIEF-MARKER-9d4e2b';
const THREAD = 'codex-fixture-thread';
const MODULE = 'tools/ralph-external/lib/codex-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/codex/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const owner = new CodexAdapter();
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved Codex module into a fresh,
 * read-only package root. The adapter file is copied byte-for-byte (the
 * fixture digest pins it); its side-effect-free siblings ride along so the
 * copied module resolves, while worker-installation itself is bridged back
 * to the source file under test so registration lands in the production
 * loader registry that createProvider reads. */
async function installCodexPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-codex-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  // Explicit modes: the installed loader refuses group/other-writable path
  // segments, and the sandbox umask (0002) would leave them writable.
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  // The approved adapter installs byte-for-byte; the tamper case installs
  // modified bytes and must fail the digest check.
  await writeFile(path.join(packageRoot, 'lib', 'codex-adapter.mjs'), bytes, { mode: 0o644 });
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
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  // Inactive health metadata becomes a loader candidate only in this copy;
  // the bundled runtimeDriver is already the installed reference.
  registry.providers.codex.workerAdapter = structuredClone(registry.providers.codex.workerHealthAdapter);
  return registry;
}

// One production-loader install per file: the loader binds adapter IDs to one module key.
let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installCodexPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('codex'), ids };
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-codex-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, ...extra }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-bound Codex profile.
 * `qualify` overlays synthetic fixture qualification so the renderer can be
 * exercised; without it the bundled metadata must block. */
async function codexPlan(options: { qualify?: boolean; effort?: 'ultra'; cliVersion?: string;
  adapterOverride?: (adapter: any) => void; memberModel?: string; discoveryModel?: string; discoveryApiModelId?: string;
  execution?: Record<string, unknown>; envNames?: string[] } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  // Quoting torture (quotes/spaces/Unicode/newlines/leading-`--` inside):
  // the brief travels on stdin with `-` as the prompt argument, so no
  // brief byte ever reaches argv and leading-dash briefs are data, not
  // flags (covered by CX02b).
  const payload = `'double" leading 雪\n$(touch ${root}/injected); \`echo danger\` = value -m other --flag-like ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.codex.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    // Synthetic fixture qualification only: models a host that proved every
    // required control for this test. It is never written to the registry.
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-codex-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-codex-host (not live evidence)' });
    }
    profile.envAllowlist = [...profile.envAllowlist, 'AIWG_FAKE_WORKER_CONFIG'];
    adapter.invocation.envAllowlist = [...adapter.invocation.envAllowlist, 'AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit',
      nestedAgentsControllable: true, nativeFallbackControllable: true,
      sandboxModes: ['read-only', 'workspace-write'] });
  }
  options.adapterOverride?.(adapter);
  registry.providers.codex.workerAdapter = adapter;
  if (options.memberModel) {
    for (const member of f.snapshot.config.parallelism!.groups!.workers.members) member.model = options.memberModel;
    f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  }
  if (options.discoveryApiModelId !== undefined) {
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.apiModelId = options.discoveryApiModelId;
  }
  if (options.effort === 'ultra') {
    Object.assign(f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!,
      { initialEffort: 'ultra', effortLadder: ['ultra'] });
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) {
      row.reasoningEfforts = ['ultra'];
      Object.assign(row.worker!, { efforts: [{ id: 'ultra', selfDelegates: false }] });
    }
  }
  if (options.execution) {
    f.snapshot.config.parallelism!.groups!.workers.execution = options.execution as any;
  }
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: options.cliVersion ?? VERSION };
  f.snapshot.installations = { codex: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.runtimeVersion = options.cliVersion ?? VERSION;
  if (options.discoveryModel) {
    discovery.models = discovery.models.slice(0, 1);
    discovery.models[0].id = options.discoveryModel;
    discovery.models[0].apiModelId = options.discoveryModel;
  }
  for (const row of discovery.models) row.worker!.runtimeVersion = options.cliVersion ?? VERSION;
  const drivers: Record<string, WorkerInvocationDriver> = { codex: {
    qualification: { adapter, adapterId: 'codex', cliVersion: binding.cliVersion },
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: CODEX_DIRECT_STDIN, envNames: options.envNames ?? ['PATH', 'AIWG_FAKE_WORKER_CONFIG'] }),
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

describe('Codex version-bound profile (B-OG-07)', () => {
  it('CX01 bounds compatible releases and pins the evidenced driver, template and health grammar; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.codex.workerHealthAdapter!;
    expect(CODEX_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: '>=0.161.0 <0.200.0', adapterVersion: '1',
      runtimeDriver: 'installed:codex',
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { kind: 'process', executable: 'codex', stdin: 'brief-text', versionArgv: ['--version'] },
      qualification: { status: 'unqualified' } });
    expect(adapter.invocation.argv).toEqual(['--no-daemon', 'exec', '--ignore-user-config', '-m', '${model}', '-c',
      'model_reasoning_effort="${effort}"', '-s', '${sandbox}', '-C', '${workspace}', '-c',
      'approval_policy="${approval}"', '--skip-git-repo-check', '-o', '${final}.last-message', '--json', '-']);
    expect(adapter.invocation.argv.join(' ')).not.toMatch(/bypass|dangerous|ultra|--effort|--fallback|--force/);
    expect(adapter.invocation.argv.join(' ')).not.toContain("'\"");
    expect(adapter.invocation.envAllowlist).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe('>=0.161.0 <0.200.0');
    expect(profile.transport).toBe('shell');
    expect(profile.mcp).toBeUndefined();
    expect(profile.envAllowlist).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
    expect(Object.keys(profile.controls).sort()).toEqual(['approval', 'children', 'effort', 'fallback', 'finalOutput', 'model',
      'sandbox', 'stdin', 'stepCap', 'structuredOutput', 'trust', 'workdir']);
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^H: codex-cli 0\.161\.0/);
    }
    expect(profile.controls.model.mapping).toContain('-m/--model');
    expect(profile.controls.effort.mapping).toContain('model_reasoning_effort');
    expect(profile.controls.effort.mapping).toContain('no --effort flag exists');
    expect(profile.controls.sandbox.mapping).toContain('-s/--sandbox');
    expect(profile.controls.approval.mapping).toContain('approval_policy="never"');
    expect(profile.controls.approval.mapping).toMatch(/root-only/);
    expect(profile.controls.approval.evidence).not.toContain('-a/--ask-for-approval');
    expect(profile.controls.workdir.mapping).toContain('-C/--cd');
    expect(profile.controls.finalOutput.mapping).toContain('-o/--output-last-message');
    expect(profile.controls.stdin.mapping).toMatch(/brief-text/);
    expect(profile.controls.stdin.mapping).not.toMatch(/closed/);
    expect(profile.controls.structuredOutput.mapping).toMatch(/deferred/);
    expect(profile.controls.structuredOutput.mapping).toContain('parseWorkerCommandArgs');
    expect(profile.controls.stepCap.mapping).toMatch(/no step.*cap flag/i);
    expect(profile.controls.children.mapping).toMatch(/subagent/i);
    expect(profile.pitfalls.some(line => /mcp-server.*version-blocked/.test(line))).toBe(true);
    expect(profile.pitfalls.some(line => /bypass.*never part of the direct profile/.test(line))).toBe(true);
    expect(profile.health).toMatchObject({ handshake: 'process-only', outputFraming: 'jsonl',
      signalParser: 'provider-codex-health-v1', coverage: 'degraded', qualificationTarget: 'semantic',
      qualificationOwner: 'B-OG-07', evidenceGrades: ['H', 'R'],
      progressEvidence: ['distinct item.completed'] });
    expect(profile.health!.provenance!.find(row => row.kind === 'help')).toMatchObject({ cliVersion: VERSION });
    expect(profile.health!.qualification).toMatchObject({ status: 'unqualified', authorizedLive: false });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
    expect(adapter.capabilities).toMatchObject({ output: 'validated-file', modelPin: 'unsupported',
      effort: 'unsupported', cancel: 'none', resume: false,
      nestedAgentsControllable: false, nativeFallbackControllable: false });
  });

  it('CX01d pins the one approved module digest and loads Codex through the production installed loader', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:codex', interfaceVersion: 1, adapterIds: ['codex'],
      platforms: ['linux'] });
    expect(installed.ids).toEqual(['codex']);
    expect(installed.owner.getName()).toBe('codex');
    expect(installed.owner.constructor.name).toBe('CodexAdapter');
    // The owner comes from the installed module, so argv/stdin match the
    // production driver exactly (TOML-quoted -c values, stdin brief).
    expect(installed.owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: '/w', brief: 'b', finalPath: '/w/f.json' },
      null, {})).toEqual(['--no-daemon', 'exec', '--ignore-user-config', '-m', MODEL,
      '-c', 'model_reasoning_effort="medium"', '-s', 'workspace-write', '-C', '/w',
      '-c', 'approval_policy="never"', '--skip-git-repo-check', '-o', '/w/f.json.last-message', '--json', '-']);
    expect(CODEX_DIRECT_STDIN).toBe('brief-text');
  });

  it('CX01e a tampered copy, an unapproved second module and a worker-writable install are all refused', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installCodexPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const widened = loadingRegistry();
    widened.providers.openclaw.workerAdapter = { ...structuredClone(widened.providers.openclaw.workerHealthAdapter!), runtimeDriver: 'installed:openclaw' };
    const good = await installCodexPackage(readFileSync(MODULE));
    await expect(loadInstalledWorkerAdapters({ registry: widened, modules: [{ ...APPROVED.entry, packageRoot: good.packageRoot }],
      workerWritableRoots: [good.writable], platform: 'linux' })).rejects.toThrow('Worker module is not installed/approved: installed:openclaw');
    const insideWritable = await installCodexPackage(readFileSync(MODULE));
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: insideWritable.packageRoot }],
      workerWritableRoots: [path.dirname(insideWritable.packageRoot)], platform: 'linux' })).rejects.toThrow(/worker-writable/);
  });

  it('CX01a native MCP stays version-blocked: the fake advertises no worker server', async () => {
    const { workdir } = await scratch();
    const result = await run(process.execPath, [FAKE, 'mcp-server', '--help'], { cwd: workdir, env: {} });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: codex');
    expect(result.stdout).not.toContain('thread.started');
    expect(result.stdout).not.toContain('tools/list');
  });

  it('CX01b the bundled registry stays undispatchable on either transport', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:codex')).toThrow();
    registry.providers.codex.workerAdapter = structuredClone(registry.providers.codex.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:codex');
    for (const transport of ['shell', 'mcp'] as const) {
      expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport, cliVersion: VERSION }))
        .toThrow('Worker transport/profile is unqualified');
    }
  });
});

describe('T-OG-15 Codex direct command contract', () => {
  it('CX02 renders the qualified template; the brief marker never reaches argv, the command or the plan', async () => {
    const { plan, root, workdir, payload, brief } = await codexPlan();
    expect(plan.invocation, messages(plan)).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.selected.model).toBe(MODEL);
    expect(invocation.selected.effort).toEqual({ support: 'explicit', value: 'medium' });
    expect(invocation.stdin).toBe(CODEX_DIRECT_STDIN);
    expect(invocation.stdin).toBe('brief-text');
    expect(invocation.argv.slice(2)).toEqual(['--no-daemon', 'exec', '--ignore-user-config', '-m', MODEL,
      '-c', 'model_reasoning_effort="medium"', '-s', 'workspace-write', '-C', workdir,
      '-c', 'approval_policy="never"', '--skip-git-repo-check', '-o', `${invocation.finalPath}.last-message`, '--json', '-']);
    // The brief travels on stdin only: no argv token carries brief bytes,
    // and the marker appears nowhere in argv.
    expect(invocation.argv.at(-1)).toBe('-');
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    expect(invocation.shellCommand).not.toContain(MARKER);
    // The resolved plan carries no brief text either (paths and digests only).
    expect(JSON.stringify(plan)).not.toContain(MARKER);
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    expect(invocation.shellCommand).toBe(`cd ${quote(workdir)} && env -i PATH="\${PATH-}" AIWG_FAKE_WORKER_CONFIG="\${AIWG_FAKE_WORKER_CONFIG-}"`
      + ` ${workerMarkerShell(invocation)} ${invocation.argv.map(quote).join(' ')} < ${quote(brief)} > ${quote(invocation.stdoutPath)} 2> ${quote(invocation.stderrPath)}`);
    expect(invocation.shellCommand).not.toContain('< /dev/null');
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, CODEX_UNRELATED_SECRET: '[REDACTED]' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ noDaemon: true, ignoreUserConfig: true, model: MODEL, effort: 'medium',
      sandbox: 'workspace-write', approval: 'never', workdir, skipGitRepoCheck: true, jsonStream: true, cwd: workdir,
      outputFile: `${invocation.finalPath}.last-message`, stdinEof: true, stdinBytes: Buffer.byteLength(payload), promptViaStdin: true });
    expect(record.prompt).toBe(payload);
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames, 'PATH']);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    const final = owner.parseOutput(await readFile(`${invocation.finalPath}.last-message`, 'utf8'));
    expect(final).toEqual({ response: `synthetic reply (${payload.length} chars)` });
    const events = (await readFile(invocation.stdoutPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => owner.observeHealthEvent(event, { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 },
      { invocationId: 'cx02', sessionId: THREAD })?.kind ?? null))
      .toEqual(['setup', 'accepted', 'activity', 'activity', 'progress', 'progress', 'terminal']);
  });

  it('CX02d rejects an environment name outside the Codex profile allowlist', async () => {
    const { plan } = await codexPlan({ envNames: ['PATH', 'UNRELATED_SECRET'] });
    expect(plan.invocation?.shellCommand).toBeFalsy();
    expect(plan.status).not.toBe('resolved');
  });

  it('CX02c -c values carry TOML quoting without a shell layer; shell-quoted values are refused', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    // The driver's tokens parse as TOML to the bare enum values.
    const argv = owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: workdir, brief: 'b', finalPath }, null, {});
    const configs = argv.filter((token, index) => argv[index - 1] === '-c');
    expect(configs).toEqual(['model_reasoning_effort="medium"', 'approval_policy="never"']);
    for (const entry of configs) {
      expect(JSON.parse(entry.slice(entry.indexOf('=') + 1))).toMatch(/^(medium|never)$/);
    }
    // The legacy shell-quoted shape keeps its quote characters under TOML
    // parsing, so the CLI refuses it exactly as the real CLI would.
    const { file, recordPath } = await fakeConfig(root, 'success');
    const bad = [process.execPath, FAKE, '--no-daemon', 'exec', '-m', MODEL,
      '-c', 'model_reasoning_effort=\'"medium"\'', '-s', 'workspace-write', '-C', workdir,
      '-c', 'approval_policy="never"', '--skip-git-repo-check', '-o', finalPath, '--json', '-', ];
    const refused = await run(process.execPath, bad.slice(1), { cwd: workdir, stdinData: 'b',
      env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/invalid model_reasoning_effort/);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.error).toMatch(/invalid model_reasoning_effort/);
    expect(record).not.toHaveProperty('prompt');
    expect(existsSync(finalPath)).toBe(false);
    // A genuine TOML literal string -- single-quoted, no embedded quotes --
    // decodes to the bare enum value and is accepted, exactly like the real
    // CLI's TOML parser would accept `model_reasoning_effort='medium'`.
    const { file: okFile, recordPath: okRecordPath } = await fakeConfig(root, 'success');
    const literalOk = [process.execPath, FAKE, '--no-daemon', 'exec', '-m', MODEL,
      '-c', "model_reasoning_effort='medium'", '-s', 'workspace-write', '-C', workdir,
      '-c', 'approval_policy="never"', '--skip-git-repo-check', '-o', finalPath, '--json', '-'];
    const accepted = await run(process.execPath, literalOk.slice(1), { cwd: workdir, stdinData: 'b',
      env: { AIWG_FAKE_WORKER_CONFIG: okFile } });
    expect(accepted.code).toBe(0);
    const okRecord = JSON.parse(await readFile(okRecordPath, 'utf8'));
    expect(okRecord.effort).toBe('medium');
    // A bare, unquoted word is not valid TOML (not a string, boolean or
    // number) even though it happens to spell a valid enum value; the
    // fixture must still refuse it rather than silently accept raw text.
    const { file: bareFile, recordPath: bareRecordPath } = await fakeConfig(root, 'success');
    const bareWord = [process.execPath, FAKE, '--no-daemon', 'exec', '-m', MODEL,
      '-c', 'model_reasoning_effort=medium', '-s', 'workspace-write', '-C', workdir,
      '-c', 'approval_policy="never"', '--skip-git-repo-check', '-o', finalPath, '--json', '-'];
    const bareRefused = await run(process.execPath, bareWord.slice(1), { cwd: workdir, stdinData: 'b',
      env: { AIWG_FAKE_WORKER_CONFIG: bareFile } });
    expect(bareRefused.code).not.toBe(0);
    expect(bareRefused.stderr).toMatch(/invalid --config value|not a valid TOML value/);
    const bareRecord = JSON.parse(await readFile(bareRecordPath, 'utf8'));
    expect(bareRecord).not.toHaveProperty('prompt');
  });

  it('CX02a read-only renders explicitly; on-request approval is refused', async () => {
    const { plan } = await codexPlan({ execution: { sandbox: 'read-only' } });
    expect(plan.invocation, messages(plan)).toBeDefined();
    const argv = plan.invocation!.argv;
    expect(argv.slice(2, 11)).toEqual(['--no-daemon', 'exec', '--ignore-user-config', '-m', MODEL,
      '-c', 'model_reasoning_effort="medium"', '-s', 'read-only']);
    expect(argv).toContain('approval_policy="never"');
    // Non-prompting execution only: a requested on-request never renders.
    expect(() => owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: '/w', brief: 'b', finalPath: '/w/f.json' },
      null, { sandbox: 'read-only', approval: 'on-request' })).toThrow(/not a qualified direct policy/);
    const blocked = await codexPlan({ execution: { sandbox: 'read-only', approval: 'on-request' } });
    expect(blocked.plan.invocation).toBeUndefined();
    expect(messages(blocked.plan).length).toBeGreaterThan(0);
  });

  it('CX02b a leading-dash brief travels on stdin as data, never as CLI syntax', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const dashBrief = `--danger ${MARKER}`;
    const argv = [process.execPath, FAKE, ...owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: workdir, brief: dashBrief, finalPath }, null, {})];
    expect(argv.at(-1)).toBe('-');
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, argv.slice(1), { cwd: workdir, stdinData: dashBrief,
      env: { AIWG_FAKE_WORKER_CONFIG: file } });
    // The `-` prompt argument keeps the leading-dash brief on stdin: the
    // run succeeds and the brief arrives verbatim instead of parsing as a
    // flag.
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('thread.started');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.argv).toEqual(argv.slice(2));
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
    expect(record).toMatchObject({ promptViaStdin: true, prompt: dashBrief, stdinEof: true });
    expect(record.error).toBeUndefined();
  });

  it('CX03 the attached launcher pipes the brief file on stdin; unit/launch and run-dir metadata never carry the brief', async () => {
    const { plan, root, workdir, payload, snapshot, drivers, now } = await codexPlan();
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
    // The stdin-brief template ends argv with `-`; the launcher pipes the
    // brief bytes on the worker's stdin, while argv, the launch record and
    // the published run-dir records below carry no brief bytes.
    expect((launches[0] as any).args.at(-1)).toBe('-');
    expect(JSON.stringify((launches[0] as any).args)).not.toContain(MARKER);
    expect(launches[0]).toMatchObject({ stdin: 'brief-text', args: plan.invocation!.argv.slice(1) });
    const files = await readdir(runDir);
    expect(files).toEqual(expect.arrayContaining(['invocation.json', 'process.json', 'exit.json']));
    for (const name of files.filter(item => item.endsWith('.json'))) {
      expect(await readFile(path.join(runDir, name), 'utf8'), name).not.toContain(MARKER);
    }
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ stdinEof: true, stdinBytes: Buffer.byteLength(payload), cwd: workdir,
      prompt: payload, promptViaStdin: true });
  });

  it.each([
    ['bundled unqualified profile', {}, /Exact model or fallback control is unqualified|Child-agent control is unqualified/],
    ['unsupported CLI version', { cliVersion: '0.160.1' }, /Worker CLI version is outside qualified profile/],
    ['denied ultra effort', { effort: 'ultra' }, /Unsupported, denied or self-delegating effort/],
    ['contributor model', { memberModel: 'team-contributor/x', discoveryModel: 'team-contributor/x' }, /Inference model is denied/],
    ['unknown model', { memberModel: 'synthetic/unknown' }, /./],
    ['selected model differs from the observed API model', { discoveryApiModelId: 'synthetic/renamed' }, /exact observed API model/],
    ['required control left unqualified', { adapterOverride: (a: any) => { a.invocationProfiles['direct-shell'].controls.children.support = 'unqualified'; } }, /Required worker control is unqualified: children/],
  ])('CX04 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await codexPlan({ qualify: _name !== 'bundled unqualified profile' ? undefined : false, ...(options as any) });
    expect(plan.invocation).toBeUndefined();
    const text = messages(plan);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(reason as RegExp);
  });

  it('CX04b a stream that reports a different model than requested stops for review', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file, recordPath } = await fakeConfig(root, 'model-substitution', { substituteModel: 'synthetic/other' });
    const args = [FAKE, ...owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: workdir, brief: 'synthetic brief', finalPath },
      null, {})];
    const result = await run(process.execPath, args, { cwd: workdir, stdinData: 'synthetic brief',
      env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    // The shared qualification summary binds the observed model: a
    // substitution is a stop/review signal, never an accepted run.
    const summary = summarizeCodexStream(result.stdout, MODEL);
    expect(summary.threadBound).toBe(true);
    expect(summary.observedModel).toBe('synthetic/other');
    expect(summary.modelMismatch).toBe(true);
    expect(summary.modelMismatch ? 'review' : 'accept').toBe('review');
    // The same run against the requested model is clean.
    const clean = summarizeCodexStream(result.stdout, 'synthetic/other');
    expect(clean.modelMismatch).toBe(false);
    expect(recordPath).toBeDefined();
  });

  it.each([
    { sandbox: 'read-only', flag: 'read-only' },
    { sandbox: 'workspace-write', flag: 'workspace-write' },
    { sandbox: 'external', flag: 'danger-full-access' },
  ])('renders exact Codex $sandbox sandbox argv with approvals never', ({ sandbox, flag }) => {
    const argv = owner.buildWorkerArgs({ selected: { model: MODEL, effort: { value: 'medium' } },
      cwd: '/w', brief: 'Synthetic brief', finalPath: '/w/final.json' }, null, { sandbox });
    expect(argv).toEqual(['--no-daemon', 'exec', '--ignore-user-config', '-m', MODEL,
      '-c', 'model_reasoning_effort="medium"', '-s', flag, '-C', '/w', '-c', 'approval_policy="never"',
      '--skip-git-repo-check', '-o', '/w/final.json.last-message', '--json', '-']);
  });

  it('CX05 the driver argv carries no brief anywhere and refuses guessed or stale controls', () => {
    const input = { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: '/w',
      brief: `"; rm -rf / #\n--model evil ${MARKER}`, finalPath: '/w/final.json' };
    const argv = owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', approval: 'never' });
    expect(argv).toEqual(['--no-daemon', 'exec', '--ignore-user-config', '-m', MODEL, '-c', 'model_reasoning_effort="medium"',
      '-s', 'workspace-write', '-C', '/w', '-c', 'approval_policy="never"',
      '--skip-git-repo-check', '-o', '/w/final.json.last-message', '--json', '-']);
    expect(argv.join(' ')).not.toContain(MARKER);
    expect(argv.join(' ')).not.toMatch(/bypass|dangerous|yolo|skip-permissions|--fallback|--force|--effort/);
    const xhigh = owner.buildWorkerArgs(
      { selected: { model: MODEL, effort: { value: 'xhigh' } }, cwd: '/w', brief: 'b', finalPath: '/w/f.json' }, null, {});
    expect(xhigh).toContain('model_reasoning_effort="xhigh"');
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'opus', effort: { value: 'medium' } } }, null, {})).toThrow(/exact observed model/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: null } } }, null, {})).toThrow(/explicit qualified effort/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'ultra' } } }, null, {})).toThrow(/explicit qualified effort/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '', effort: { value: 'medium' } } }, null, {})).toThrow(/explicit model/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute workspace/);
    expect(() => owner.buildWorkerArgs({ ...input, finalPath: 'relative.json' }, null, {})).toThrow(/absolute final-output/);
    expect(() => owner.buildWorkerArgs({ ...input }, null, { sandbox: 'danger-full-access' })).toThrow(/not a qualified direct mode/);
    expect(() => owner.buildWorkerArgs({ ...input }, null, { approval: 'always' })).toThrow(/not a qualified direct policy/);
    expect(() => owner.buildWorkerArgs({ ...input }, null, { approval: 'on-request' })).toThrow(/not a qualified direct policy/);
    expect(owner.getAbortInput()).toBeNull();
  });

  it('CX06 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:codex')).toThrow();
    registry.providers.codex.workerAdapter = structuredClone(registry.providers.codex.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:codex');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    expect(fixtureJson('provider-coverage.json').rows.find((row: any) => row.provider === 'codex'))
      .toMatchObject({ scope: 'IN', owner: 'B-OG-07', nativeMcp: 'version-blocked', qualification: 'unqualified' });
  });
});

describe('T-OG-20/21/23 Codex run identity, stall and security signals', () => {
  const health = () => loadProviderModelCapabilities().providers.codex.workerHealthAdapter!.invocationProfiles!['direct-shell'].health!;
  const profile = () => loadProviderModelCapabilities().providers.codex.workerHealthAdapter!.invocationProfiles!['direct-shell'];
  // The profiled argv only: `-` prompt argument with the brief on stdin.
  // Callers pass the same brief as stdinData (or redirect the brief file).
  const BRIEF = 'synthetic brief';
  const argv = (workdir: string, finalPath: string, brief: string = BRIEF) => [FAKE, ...owner.buildWorkerArgs(
    { selected: { model: MODEL, effort: { value: 'medium' } }, cwd: workdir, brief, finalPath },
    profile(), {})];
  const source = { kind: 'stdout' as const, id: 'stdout', generation: 0, offset: 0 };
  const observer = (clock: { t: number }, sessionId = THREAD) => owner.createHealthObserver({ provider: 'codex',
    profile: { health: health() }, invocationId: 'codex-fixture', sessionId,
    now: () => clock.t, wallNow: () => 0, startedAt: 0,
    effectiveHealth: { startupSeconds: 60, checkSeconds: 15, quietSeconds: 112.5, stallSeconds: 375, diagnosticGraceSeconds: 60 } });
  const feedLines = (o: ReturnType<typeof owner.createHealthObserver>, text: string) => {
    for (const line of text.trim().split('\n')) o.feed(Buffer.from(`${line}\n`), source);
  };

  it('CX07 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    const result = await run(path.join(workdir, 'codex'), ['--version'], { cwd: workdir, env: {} });
    expect(result.error?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
    const o = observer({ t: 0 });
    expect(o.finish({ exitCode: null, termination: 'uncertain' }).state).not.toBe('completed');
  });

  it('CX08 success handshakes on turn.started, counts distinct completed items and completes on a strict final', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, 'success');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, stdinData: BRIEF,
      env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    expect(result.code, result.stderr).toBe(0);
    feedLines(o, result.stdout);
    // The version-bound profile declares a process-only handshake: semantic
    // start/progress stay explicitly unavailable while observed clocks advance.
    expect(o.snapshot()).toMatchObject({ handshake: 'process-only' });
    expect(o.snapshot().lastProgressAt).not.toBeNull();
    clock.t = 1000;
    const stdout = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(stdout.filter(event => event.type === 'item.completed').map(event => event.item.id))
      .toEqual(['codex-fixture-item-1', 'codex-fixture-item-2']);
    const snapshot = o.finish({ exitCode: result.code, termination: 'confirmed',
      finalValid: owner.parseOutput(await readFile(`${finalPath}.last-message`, 'utf8')) !== null });
    expect(snapshot).toMatchObject({ state: 'completed' });
    expect(snapshot.lastProgressAt).not.toBeNull();
    expect(snapshot.unavailableSignals).toEqual(expect.arrayContaining(['semantic-start']));
    const record = JSON.parse(await readFile(path.join(root, 'record-success.json'), 'utf8'));
    expect(record).toMatchObject({ stdinEof: true, stdinBytes: Buffer.byteLength(BRIEF), cwd: workdir,
      prompt: BRIEF, promptViaStdin: true, ignoreUserConfig: true });
  });

  it.each([
    ['auth-error', 'AUTH'],
    ['model-not-found', 'MODEL'],
  ])('CX09 %s on stderr is diagnosed and fails the attempt', async (scenario, reasonCode) => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, scenario);
    const o = observer({ t: 0 });
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(1);
    o.feed(Buffer.from(result.stderr), { kind: 'stderr', id: 'stderr', generation: 0, offset: 0 });
    expect(o.snapshot().reasonCode).toBe(reasonCode);
    expect(o.finish({ exitCode: result.code, termination: 'confirmed' }).state).not.toBe('completed');
  });

  it('CX10 exit-zero with an error event fails; the strict final rejects the truncated file', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, 'exit-zero-error');
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    const clock = { t: 0 };
    const o = observer(clock);
    o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    feedLines(o, result.stdout);
    expect(o.evidence().events.some(event => event.kind === 'error')).toBe(true);
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).not.toBe('completed');
    const { file: malformedFile } = await fakeConfig(root, 'malformed');
    const malformed = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: malformedFile } });
    expect(malformed.code).toBe(0);
    expect(owner.parseOutput(await readFile(`${finalPath}.last-message`, 'utf8'))).toBeNull();
    const p = observer({ t: 0 });
    p.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    expect(p.finish({ exitCode: 0, termination: 'confirmed', finalValid: false }).reasonCode).toBe('FINAL_INVALID');
    await expect(owner.parseWorkerFinal(await readFile(`${finalPath}.last-message`, 'utf8'), {
      observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 },
    })).rejects.toThrow();
  });

  it('CX10a a standalone error event fails the run despite a clean terminal and exit zero', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, 'standalone-error');
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, stdinData: BRIEF,
      env: { AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    const o = observer({ t: 0 });
    o.processStarted({ pid: 1, startTicks: 'fixture', executable: process.execPath });
    feedLines(o, result.stdout);
    expect(o.evidence().events.some(event => event.kind === 'error')).toBe(true);
    // The terminal arrives clean with a valid final, yet the standalone
    // error fails the run through the adapter's existing error
    // normalization and raises the stop signal.
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).state).not.toBe('completed');
    expect(o.shouldStop()).toBe(true);
  });

  it('CX11 the worker reads the brief to EOF: delayed EOF still terminates promptly', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, keepStdinOpen: true,
      env: { AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 5_000,
      onStart: child => setTimeout(() => child.stdin!.end(BRIEF), 300) });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ stdinEof: true, stdinBytes: Buffer.byteLength(BRIEF), prompt: BRIEF });
  });

  it('CX12 silent hang crosses the scaled quiet then stall windows and needs a stop', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, 'hang');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 1_000, killSignal: 'SIGTERM',
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    for (let seconds = 15; seconds <= 105; seconds += 15) { clock.t = seconds * 1000; o.check(clock.t); }
    expect(o.snapshot().state).toBe('started');
    for (let seconds = 120; seconds <= 360; seconds += 15) { clock.t = seconds * 1000; o.check(clock.t); }
    expect(o.snapshot().state).toBe('quiet');
    clock.t = 375_000; o.check(clock.t);
    // The profiled grammar has progress evidence, so a confirmed stall is
    // observed rather than suspected; semantic start stays unavailable.
    expect(o.snapshot()).toMatchObject({ state: 'stalled', reasonCode: 'NO_PROGRESS', confidence: 'observed' });
    expect(result.signal).toBe('SIGTERM');
    expect(o.finish({ exitCode: null, signal: result.signal, termination: 'confirmed', stopReason: 'NO_PROGRESS', timedOut: true }).state)
      .toBe('failed');
  });

  it('CX13 endless identical errors never advance the progress clock', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, 'error-loop');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 1_500, killSignal: 'SIGTERM',
      onStart: child => { o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath });
        child.stdout.on('data', chunk => { clock.t += 150; o.feed(chunk, source); o.check(clock.t); }); } });
    expect(result.signal).toBe('SIGTERM');
    expect(o.snapshot().lastProgressAt).toBeNull();
    expect(o.evidence().events.some(event => event.kind === 'error')).toBe(true);
    expect(o.finish({ exitCode: null, signal: result.signal, termination: 'confirmed', stopReason: 'NO_PROGRESS', timedOut: true }).state)
      .toBe('failed');
  });

  it('CX14 TERM ignored requires KILL; the exit records the signal, never zero', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, 'ignore-term');
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      timeoutMs: 8_000, onStart: termAfterReady });
    expect(result.stdout).toContain(TERM_READY);
    expect(result.signal).toBe('SIGKILL');
    expect(result.code).toBeNull();
  });

  it('CX15 secrets stay out of the command and a malicious final is inert data', async () => {
    const { plan, root } = await codexPlan();
    const secret = '[REDACTED]';
    expect(JSON.stringify(plan)).not.toContain(secret);
    const marker = path.join(root, 'executed-marker');
    const { file, recordPath } = await fakeConfig(root, 'malicious-final', { marker });
    const result = await run('/bin/sh', ['-c', plan.invocation!.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH, AIWG_FAKE_WORKER_CONFIG: file, CODEX_API_KEY: secret } });
    expect(result.code).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.envNames).toContain('PATH');
    expect(plan.invocation!.shellCommand).toContain('PATH="${PATH-}"');
    expect(record.envNames).not.toContain('CODEX_API_KEY');
    const stdout = await readFile(plan.invocation!.stdoutPath, 'utf8');
    expect(stdout).not.toContain(secret);
    const final = owner.parseOutput(await readFile(`${plan.invocation!.finalPath}.last-message`, 'utf8'));
    expect(final?.response).toContain('touch');
    expect(existsSync(marker)).toBe(false); // worker-returned commands are never executed
  });

  it('CX16 observer loss is reported as a gap and stdout prose cannot forge progress', async () => {
    const clock = { t: 0 };
    const o = observer(clock);
    o.processStarted({ pid: 2, startTicks: 'fixture', executable: process.execPath });
    o.feed(Buffer.from('synthetic prose without any event grammar\n'), source);
    clock.t = 45_000; o.check(clock.t); // a 45 s gap exceeds the 15 s check cadence
    const snapshot = o.snapshot();
    expect(snapshot.lastProgressAt).toBeNull();
    expect(snapshot.unavailableSignals).toContain('observer-continuity');
    expect(o.evidence().gaps.some(gap => gap.reasonCode === 'OBSERVER_GAP')).toBe(true);
    o.disconnect();
    expect(o.finish({ exitCode: 0, termination: 'confirmed', finalValid: true }).termination).toBe('uncertain');
  });

  it('CX17 crash mid-edit fails the attempt and leaves the truncated final rejected', async () => {
    const { root, workdir } = await scratch();
    const finalPath = path.join(root, 'final.json');
    const { file } = await fakeConfig(root, 'crash-mid');
    const clock = { t: 0 };
    const o = observer(clock);
    const result = await run(process.execPath, argv(workdir, finalPath), { cwd: workdir, env: { AIWG_FAKE_WORKER_CONFIG: file },
      onStart: child => o.processStarted({ pid: child.pid!, startTicks: 'fixture', executable: process.execPath }) });
    expect(result.code).toBe(1);
    feedLines(o, result.stdout);
    expect(owner.parseOutput(await readFile(`${finalPath}.last-message`, 'utf8'))).toBeNull();
    expect(o.finish({ exitCode: result.code, termination: 'confirmed', finalValid: false }).state).not.toBe('completed');
  });
});

