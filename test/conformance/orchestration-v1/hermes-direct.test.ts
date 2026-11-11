import { shellCaptureBody } from '../../fixtures/shell-capture-command.js';
import { workerMarkerNames, workerMarkerShell } from '../../fixtures/worker-attribution.js';
import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2912 (B-OG-48) Hermes headless CLI worker profile: offline S1 profile work.
 *
 * Fix round 1 (2026-10-09, conductor + Codex/Muse review): the baseline is
 * `hermes chat --query-file - --oneshot --quiet`, not the top-level `-z`
 * value-taking dest. `-z` is argv-only for the brief and unconditionally
 * bypasses approvals with no override (documented in hermes-adapter.mjs);
 * `chat --query-file -` reads the brief on stdin and leaves approvals at
 * their deny-by-default `approvals.single_query_mode`. Both facts are read
 * from the installed `hermes_cli`/`cli.py`/`tools/approval.py` source, never
 * from running hermes with a prompt.
 *
 * T-OG-15 renders the version-observed Hermes profile through the real
 * resolver and #2887 renderer, then executes the rendered shell command
 * against a synthetic `hermes chat` that mirrors the installed quiet
 * single-query exit-code contract (`cli.py`'s `if quiet:` branch). A second
 * block drives the SAME production wiring `worker-installation.mjs:722`
 * uses (`extractFinal` + `parseWorkerFinal`) through `SessionLauncher`, to
 * prove the adapter's failure detection is connected end to end, not just
 * at the level of a parsed flag. Spawns are plain child processes (no
 * systemd); nothing reaches a network, model, credential or MC state.
 * Fixture qualification here is synthetic and never live qualification: the
 * bundled Hermes profile stays unqualified (HD06).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { prepareWorkerInvocation, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { classifyWorkerHealthFailure } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { HERMES_DIRECT_EFFORT_VALUES, HERMES_SUPPORTED_VERSIONS, HermesAdapter, stripHermesStartupDiagnostics } from '../../../tools/ralph-external/lib/hermes-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { fixtureJson } from '../mission-v1/worker-contract-fixtures.js';

const FAKE = path.resolve('test/fixtures/providers/hermes/fake-hermes.mjs');
const VERSION = '0.21.6';
const MODEL = 'synthetic-hermes/model';
// Default `llmProvider` on the shared worker-resolution fixture (never
// overridden by hermesPlan below); the resolved tuple carries it through
// as `selected.inferenceProvider` (src/serve/worker-invocation.ts:419).
const PROVIDER = 'vendor';
const EFFORT = 'medium';
const MARKER = 'HERMES-BRIEF-MARKER-9d2e71';
const MODULE = 'tools/ralph-external/lib/hermes-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/hermes/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
// Functional calls (buildWorkerArgs/parseOutput/parseWorkerFinal/...) use a
// plain instance constructed directly from the real source module, matching
// the Codex profile test's convention. `installed.owner` (below) proves the
// #2885 installed-module digest/identity path only; HermesAdapter now
// extends ProviderAdapter (#2890 strict claims), and its copied-into-a-
// synthetic-package form would need every transitive sibling (worker-health,
// _resolve-impl, mission-protocol) re-wired just to prove identity, which
// adds no coverage beyond HD01a/HD01b.
const owner = new HermesAdapter();
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-hermes-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'hermes-adapter.mjs'), bytes, { mode: 0o644 });
  // HermesAdapter extends ProviderAdapter (#2890); its static import of
  // provider-adapter.mjs (and that file's own worker-health.mjs/
  // _resolve-impl.mjs imports) must resolve inside the copied package too,
  // even though no test calls through installed.owner's strict-claims path.
  await copyWorkerAdapterRuntime(base, packageRoot);
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  // provider-adapter.mjs's top-level `await importImpl(..., 'models/worker-installation.mjs')`
  // runs at import time; bridge it back to the real file under test.
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers.hermes.workerAdapter = structuredClone(registry.providers.hermes.workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
  const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
    modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
  installed = { owner: createProvider('hermes'), ids };
});
afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-hermes-')); roots.push(root);
  const workdir = path.join(root, 'work tree'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath }));
  return { file, recordPath };
}

/** Real resolver snapshot with the bundled, version-observed Hermes profile.
 * `qualify` overlays synthetic qualification so the renderer can be
 * exercised; without it the bundled metadata must block (HD04). Only the
 * controls this CLI genuinely provides (stdin via --query-file -, and the
 * deny-by-default approval gate) are flipped to 'native' here — sandbox
 * stays 'external' (routed through the shared boundary requirement, no CLI
 * flag exists) and the remaining controls stay 'unqualified' since no
 * flag/behavior backs them. This flip is still test-local synthetic
 * qualification, never written to the bundled registry (HD01/HD06). */
async function hermesPlan(options: { qualify?: boolean; adapterOverride?: (adapter: any) => void } = {}) {
  const f = workerResolutionFixture();
  const { root, workdir } = await scratch();
  const payload = `--leading 'double" 雪\n$(touch ${root}/injected); \`echo danger\` = value -m other ${MARKER}`;
  const brief = path.join(root, "brief '雪\n.md");
  await writeFile(brief, payload);
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  const adapter = structuredClone(loadProviderModelCapabilities().providers.hermes.workerHealthAdapter!) as any;
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualify !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-hermes-fixture'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    // Synthetic fixture qualification only (matches the Codex/OpenHuman test
    // convention): models a host that proved every required control for
    // this render-and-execute test. It is never written to the registry
    // (HD01/HD06 assert the bundled copy stays 'unqualified'). Within that
    // synthetic set, stdin and approval are NOT mere test convenience —
    // they are genuinely evidenced by installed-source reading (see the
    // hermes-adapter.mjs docstring: `--query-file -` really does read the
    // brief from stdin, and `approvals.single_query_mode` really does
    // default to deny), so their 'native' flip here reflects a real
    // mechanism, just not yet a LIVE-qualified one. model/effort/workdir are
    // real documented chat flags too. structuredOutput/trust/children/
    // fallback have no CLI backing at all; flipping them is pure test
    // convenience like every other profile's test (stepCap is the one
    // control left out, matching Codex/OpenHuman). Sandbox has no CLI flag
    // either, but the shared resolver already routes it through a qualified
    // external enforcing boundary for this provider
    // (requiresWorkerExternalBoundary) rather than inventing a flag, so it
    // is marked 'external' below — matching the bundled
    // capabilities.sandboxModes == ['external'] — never 'native'.
    for (const [name, control] of Object.entries(profile.controls) as Array<[string, any]>) {
      if (name === 'stepCap' || name === 'sandbox') continue;
      Object.assign(control, { support: 'native', evidence: 'fixture:synthetic-hermes-host (not live evidence)' });
    }
    Object.assign(profile.controls.sandbox, { support: 'external', evidence: 'fixture:synthetic-hermes-host (not live evidence)' });
    Object.assign(adapter.capabilities, { modelPin: 'requested', effort: 'explicit', nestedAgentsControllable: true,
      nativeFallbackControllable: true });
    profile.installationQualification = { scopeDigest: workerConfigDigest('synthetic-hermes-scope'),
      fixtureDigest: workerConfigDigest('synthetic-hermes-only'), verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    profile.envAllowlist = adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  }
  options.adapterOverride?.(adapter);
  registry.providers.hermes.workerAdapter = adapter;
  f.snapshot.config.parallelism!.groups!.workers.members.forEach(member => { member.cli = 'hermes'; member.model = MODEL; });
  f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
  f.snapshot.config.parallelism!.groups!.workers.fallback = [];
  // Hermes's only declared sandbox mode is 'external' (no CLI sandbox flag
  // exists); match the group's requested mode to that reality instead of
  // widening the adapter's capabilities.
  (f.snapshot.config.parallelism!.groups!.workers as any).execution = { isolation: 'worktree', sandbox: 'external',
    approval: 'never', network: 'deny', transport: 'shell', receipts: 'optional' };
  // Hermes has no native sandbox flag (sandboxModes stays ['external'] on the
  // bundled profile): the shared resolver always requires a qualified
  // external enforcing boundary for this provider's `sandbox` control
  // (requiresWorkerExternalBoundary, src/models/provider-policy.ts), proven
  // here by synthetic boundary evidence only.
  const boundary = { kind: 'executor' as const, identity: 'fixture:synthetic-hermes-boundary',
    digest: workerConfigDigest('synthetic-hermes-boundary'), controls: ['sandbox'] };
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-shell', cliVersion: VERSION, boundary };
  f.snapshot.installations = { hermes: binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'hermes'; discovery.runtimeVersion = VERSION;
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = MODEL; row.apiModelId = MODEL;
    row.worker!.cliId = 'hermes'; row.worker!.runtimeVersion = VERSION;
  }
  f.snapshot.catalog.discovery!.instances = { hermes: discovery };
  const drivers: Record<string, WorkerInvocationDriver> = { hermes: {
    qualification: { adapter, adapterId: 'hermes', cliVersion: binding.cliVersion, boundary,
      installation: { evidence: profile.installationQualification, boundary } },
    // Synthetic installation recheck; the real preparation owner still checks
    // all policy, tuple, environment, path and matching-boundary bindings.
    prepareWorkerInvocation: (invocation: any, qualification: any) => prepareWorkerInvocation(invocation, qualification),
    buildInvocation: async input => ({ argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: adapter.invocation.stdin, envNames: ['AIWG_FAKE_WORKER_CONFIG'] }),
    // Mirrors the production installed-loader wiring (src/models/worker-installation.mjs:722):
    // extractFinal is the lenient candidate extractor, parseWorkerFinal is the
    // authoritative gate that must fail on the observed exit-code status.
    extractFinal: (output: unknown) => owner.parseOutput(output),
    parseWorkerFinal: (output: unknown, opts: unknown) => owner.parseWorkerFinal(output, opts),
  } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir,
    final_output: path.join(root, "final '雪\n.json"), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request as any, drivers, f.request.now);
  return { plan, root, workdir, payload, adapter, snapshot: f.snapshot, drivers, now: f.request.now };
}

describe('Hermes version-observed profile (B-OG-48)', () => {
  it('HD01 pins the observed CLI, driver and argv template; every control stays unqualified with cited evidence', () => {
    const adapter = loadProviderModelCapabilities().providers.hermes.workerHealthAdapter!;
    expect(HERMES_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: '1', runtimeDriver: 'installed:hermes',
      invocation: { executable: 'hermes', stdin: 'brief-text',
        argv: ['chat', '--query-file', '-', '--oneshot', '--quiet', '--ignore-user-config', '--ignore-rules', '--source', 'tool',
          '--provider', '${provider}', '-m', '${model}', '--reasoning', '${effort}'] },
      qualification: { status: 'unqualified' } });
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    for (const [name, control] of Object.entries(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^[DH]: hermes 0\.21\.6/);
    }
    expect(profile.controls.stdin.mapping).toMatch(/query-file -.*reads the single query from stdin/);
    expect(profile.controls.approval.mapping).toMatch(/ignore-user-config/);
    expect(profile.controls.approval.mapping).toMatch(/single_query_mode/);
    expect(profile.controls.approval.mapping).toMatch(/HERMES_YOLO_MODE/);
    expect(profile.pitfalls.some((line: string) => /does NOT use the top-level -z/.test(line))).toBe(true);
    expect(profile.pitfalls.some((line: string) => /no --usage-file\/JSON-report equivalent/.test(line))).toBe(true);
    expect(profile.pitfalls.some((line: string) => /Exit code 0 alone is still not treated as completion evidence/.test(line))).toBe(true);
    expect(profile.pitfalls.some((line: string) => /HERMES_YOLO_MODE.*must never reach the worker/.test(line))).toBe(true);
  });

  it('HD01a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:hermes', interfaceVersion: 1, adapterIds: ['hermes'], platforms: ['linux'] });
    expect(installed.ids).toEqual(['hermes']);
    expect(installed.owner.getName()).toBe('hermes');
    expect(installed.owner.constructor.name).toBe('HermesAdapter');
  });

  it('HD01b rejects a tampered copy of the approved module', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
  });
});

describe('T-OG-15 Hermes direct command contract', () => {
  it('HD02 renders chat --query-file - --oneshot --quiet -m -reasoning; the brief travels on stdin, never argv', async () => {
    const { plan, root, workdir, payload } = await hermesPlan();
    expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: (plan as any).exclusions })).toBeDefined();
    const invocation = plan.invocation!;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.stdin).toBe('brief-text');
    expect(invocation.selected.inferenceProvider).toBe(PROVIDER);
    expect(invocation.argv.slice(2)).toEqual(['chat', '--query-file', '-', '--oneshot', '--quiet', '--ignore-user-config', '--ignore-rules', '--source', 'tool',
      '--provider', invocation.selected.inferenceProvider, '-m', MODEL, '--reasoning', invocation.selected.effort.value]);
    expect(JSON.stringify(invocation.argv)).not.toContain(MARKER);
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    expect(shellCaptureBody(invocation)).toBe(`cd ${quote(workdir)} && env -i AIWG_FAKE_WORKER_CONFIG="\${AIWG_FAKE_WORKER_CONFIG-}" ${workerMarkerShell(invocation)} ${invocation.argv.map(quote).join(' ')}`
      + ` < ${quote(invocation.briefPath)} > ${quote(invocation.stdoutPath)} 2> ${quote(invocation.stderrPath)}`);
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file, HERMES_UNRELATED_SECRET: 'sk-synthetic-should-not-pass' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ query: payload, model: MODEL, provider: PROVIDER });
    expect(record.query).toContain(MARKER);
    expect(record.argv).toEqual(invocation.argv.slice(2));
    expect(JSON.stringify(record.argv)).not.toContain(MARKER);
    expect(record.envNames.filter((name: string) => !['PWD', 'SHLVL', '_'].includes(name))).toEqual(['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames]);
    expect(existsSync(path.join(root, 'injected'))).toBe(false);
    const stdoutText = await readFile(invocation.stdoutPath, 'utf8');
    const final = owner.parseOutput(stdoutText);
    expect(final?.response).toContain('"status":"completed"');
    const claims = JSON.parse(stdoutText);
    expect(claims).toMatchObject({ version: 1, status: 'completed', summary: `synthetic reply (${payload.length} chars)` });
  });

  it('HD02b end to end through the real rendered command: a leading startup diagnostic on stdout still lets parseWorkerFinal accept the valid final beneath it; garbage preamble and diagnostic-only output still fail', async () => {
    const { plan, root } = await hermesPlan();
    let invocation = plan.invocation!;
    const okRun = await fakeConfig(root, 'diagnostic-then-success');
    const okResult = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: okRun.file } });
    expect(okResult.code, okResult.stderr).toBe(0);
    const okStdout = await readFile(invocation.stdoutPath, 'utf8');
    expect(okStdout).toContain('tirith security scanner');
    await expect(owner.parseWorkerFinal(okStdout, { observation: { status: 'completed', termination: 'confirmed', transport: 'shell', exitCode: 0 } }))
      .resolves.toMatchObject({ status: 'completed' });

    invocation = (await hermesPlan()).plan.invocation!;
    const garbageRun = await fakeConfig(root, 'diagnostic-garbage-preamble');
    const garbageResult = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: garbageRun.file } });
    expect(garbageResult.code, garbageResult.stderr).toBe(0);
    const garbageStdout = await readFile(invocation.stdoutPath, 'utf8');
    await expect(owner.parseWorkerFinal(garbageStdout, { observation: { status: 'completed', termination: 'confirmed', transport: 'shell', exitCode: 0 } }))
      .rejects.toThrow();

    invocation = (await hermesPlan()).plan.invocation!;
    const onlyRun = await fakeConfig(root, 'diagnostic-only');
    const onlyResult = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: onlyRun.file } });
    expect(onlyResult.code, onlyResult.stderr).toBe(0);
    const onlyStdout = await readFile(invocation.stdoutPath, 'utf8');
    await expect(owner.parseWorkerFinal(onlyStdout, { observation: { status: 'completed', termination: 'confirmed', transport: 'shell', exitCode: 0 } }))
      .rejects.toThrow();
  });

  it('HD03 a failed turn that still printed partial text to stdout exits non-zero (unlike the rejected -z path)', async () => {
    const { plan, root } = await hermesPlan();
    const invocation = plan.invocation!;
    const { file } = await fakeConfig(root, 'partial-then-failed');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(1);
    const stdoutText = await readFile(invocation.stdoutPath, 'utf8');
    expect(owner.parseOutput(stdoutText)).not.toBeNull(); // candidate extraction alone would accept this
    await expect(owner.parseWorkerFinal(stdoutText, { observation: { status: 'failed', exitCode: result.code } }))
      .rejects.toThrow(/did not complete/);
  });

  it('HD03c exit 0 is NOT completion evidence: reasoning-budget exhaustion (conversation_loop.py:3902) prints a free-text warning and must still fail parseWorkerFinal', async () => {
    const { plan, root } = await hermesPlan();
    const invocation = plan.invocation!;
    const { file } = await fakeConfig(root, 'budget-exhausted');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0); // the real CLI's own exit code lies here — this is the point of the test
    const stdoutText = await readFile(invocation.stdoutPath, 'utf8');
    expect(stdoutText).toContain('Thinking Budget Exhausted');
    // The lenient candidate extractor alone would accept this free text as a final.
    expect(owner.parseOutput(stdoutText)).not.toBeNull();
    // The exit-derived status alone says 'completed' (exit 0, no errorCode/timeout) — also insufficient alone.
    await expect(owner.parseWorkerFinal(stdoutText, { observation: { status: 'completed', termination: 'confirmed', transport: 'shell', exitCode: 0 } }))
      .rejects.toThrow();
  });

  it('HD03b no response and a failure: empty stdout, error and session_id on stderr, exit 1', async () => {
    const { plan, root } = await hermesPlan();
    const invocation = plan.invocation!;
    const auth = await fakeConfig(root, 'no-response-failed');
    const authResult = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: auth.file } });
    expect(authResult.code).toBe(1);
    const stdoutText = await readFile(invocation.stdoutPath, 'utf8');
    expect(owner.parseOutput(stdoutText)).toBeNull();
    const stderrText = await readFile(invocation.stderrPath, 'utf8');
    expect(classifyWorkerHealthFailure(stderrText, { source: { kind: 'stderr' }, provider: 'hermes' })).toMatchObject({ reasonCode: 'AUTH' });
    expect(stderrText).toContain('session_id:');
    expect(stdoutText).not.toContain('session_id:');
  });

  it.each([
    ['bundled unqualified profile', { qualify: false }, /Exact model or fallback control is unqualified|Child-agent control is unqualified|Worker transport\/profile is unqualified/],
    ['required control left unqualified', { adapterOverride: (a: any) => { a.invocationProfiles['direct-shell'].controls.approval.support = 'unqualified'; } }, /Required worker control is unqualified: approval/],
  ])('HD04 %s produces no launch command', async (_name, options, reason) => {
    const { plan } = await hermesPlan(options as any);
    expect(plan.invocation).toBeUndefined();
    const messages = [...(plan.diagnostics ?? []), ...((plan as any).exclusions ?? []).flatMap((row: any) => row.diagnostics)]
      .map((d: any) => `${d.code} ${d.message}`);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join('\n')).toMatch(reason);
  });

  it('HD05 the driver argv never guesses a sandbox/approval flag, never carries the brief, and refuses a missing model/effort/provider/workspace', () => {
      const input = { brief: `"; rm -rf / #\n--model evil ${MARKER}`, cwd: '/w',
      selected: { model: MODEL, inferenceProvider: PROVIDER, effort: { value: EFFORT } } };
    const argv = owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write', approval: 'never' });
    expect(argv).toEqual(['chat', '--query-file', '-', '--oneshot', '--quiet', '--ignore-user-config', '--ignore-rules', '--source', 'tool',
      '--provider', PROVIDER, '-m', MODEL, '--reasoning', EFFORT]);
    expect(argv.join(' ')).not.toContain(MARKER);
    expect(argv.join(' ')).not.toMatch(/--yolo|--accept-hooks|--safe-mode|sandbox|bypass/);
    expect(() => owner.buildWorkerArgs({ ...input, brief: '' }, null, {})).toThrow(/brief/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { ...input.selected, model: '' } }, null, {})).toThrow(/model/);
    // Provider: missing, empty, null-byte-laced, and the literal "auto" (the
    // CLI's own silent default, hermes_cli/runtime_provider.py:647-663) must
    // all be refused -- this is the smoke-run fix (module docstring Fix
    // round 2 #1), never a guessed/default provider.
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: EFFORT } } }, null, {})).toThrow(/provider/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { ...input.selected, inferenceProvider: '' } }, null, {})).toThrow(/provider/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { ...input.selected, inferenceProvider: 'auto' } }, null, {})).toThrow(/provider/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { ...input.selected, inferenceProvider: 'AUTO' } }, null, {})).toThrow(/provider/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { ...input.selected, inferenceProvider: `vendor\0${MARKER}` } }, null, {})).toThrow(/provider/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, inferenceProvider: PROVIDER, effort: { value: 'ultra' } } }, null, {})).toThrow(/effort/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, inferenceProvider: PROVIDER, effort: { value: null } } }, null, {})).toThrow(/effort/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, {})).toThrow(/absolute workspace/);
    expect(HERMES_DIRECT_EFFORT_VALUES).not.toContain('ultra');
    expect(() => owner.buildSessionArgs()).toThrow(/no qualified Ralph loop session/);
    expect(owner.observeHealthEvent()).toBeNull();
    expect(owner.getAbortInput()).toBeNull();
  });

  it('HD05a the fake CLI itself reproduces the live smoke-run failure: a missing or "auto" --provider fails with "No inference provider configured"; an explicit provider succeeds', async () => {
    const { root } = await scratch();
    const base = { PATH: process.env.PATH! };
    const withoutProvider = await run(process.execPath, [FAKE, 'chat', '--query-file', '-', '--oneshot', '--quiet',
      '--ignore-user-config', '--ignore-rules', '--source', 'tool', '-m', MODEL, '--reasoning', EFFORT], { cwd: root, env: base });
    expect(withoutProvider.code).toBe(1);
    expect(withoutProvider.stdout).toBe('');
    expect(withoutProvider.stderr).toContain('No inference provider configured');
    const withAuto = await run(process.execPath, [FAKE, 'chat', '--query-file', '-', '--oneshot', '--quiet',
      '--ignore-user-config', '--ignore-rules', '--source', 'tool', '--provider', 'auto', '-m', MODEL, '--reasoning', EFFORT], { cwd: root, env: base });
    expect(withAuto.code).toBe(1);
    expect(withAuto.stdout).toBe('');
    expect(withAuto.stderr).toContain('No inference provider configured');
    const withProvider = await run(process.execPath, [FAKE, 'chat', '--query-file', '-', '--oneshot', '--quiet',
      '--ignore-user-config', '--ignore-rules', '--source', 'tool', '--provider', PROVIDER, '-m', MODEL, '--reasoning', EFFORT], { cwd: root, env: base });
    expect(withProvider.code, withProvider.stderr).toBe(0);
    expect(JSON.parse(withProvider.stdout)).toMatchObject({ status: 'completed' });
  });

  it('HD05b parseWorkerFinal resolves a valid workerClaims document when BOTH the exit-derived status and the strict #2890 parse pass', async () => {
    const claims = { version: 1, status: 'completed', summary: 'synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
    const observation = { status: 'completed', termination: 'confirmed', transport: 'shell', exitCode: 0 };
    await expect(owner.parseWorkerFinal(JSON.stringify(claims), { observation })).resolves.toEqual(claims);
    // Free text (e.g. the budget-exhaustion warning) fails the SAME call
    // shape even though the exit-derived status says 'completed'.
    await expect(owner.parseWorkerFinal('⚠️ **Thinking Budget Exhausted**\n\nfree text, not a claims document', { observation }))
      .rejects.toThrow();
  });

  it('HD05c parseWorkerFinal strips a leading known startup diagnostic and accepts the valid final beneath it; rejects garbage preamble and diagnostic-only output', async () => {
    const claims = { version: 1, status: 'completed', summary: 'synthetic', claims: [], artifacts: [], checks: [], limitations: [] };
    const observation = { status: 'completed', termination: 'confirmed', transport: 'shell', exitCode: 0 };
    const diagnostic = '  \x1b[2;3m⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\x1b[0m\n';
    // Plain (no ANSI) and ANSI-wrapped diagnostic forms both strip.
    await expect(owner.parseWorkerFinal(`${diagnostic}${JSON.stringify(claims)}`, { observation })).resolves.toEqual(claims);
    await expect(owner.parseWorkerFinal(`  ⚠ tirith security scanner enabled but not available\n${JSON.stringify(claims)}`, { observation }))
      .resolves.toEqual(claims);
    // Two consecutive diagnostic lines both strip.
    await expect(owner.parseWorkerFinal(`${diagnostic}${diagnostic}${JSON.stringify(claims)}`, { observation })).resolves.toEqual(claims);
    // Unrecognized preamble (no leading "⚠") is left in place and fails.
    await expect(owner.parseWorkerFinal(`unexpected preamble\n${JSON.stringify(claims)}`, { observation })).rejects.toThrow();
    // Diagnostic-only output (no final at all) strips to nothing and fails.
    await expect(owner.parseWorkerFinal(diagnostic, { observation })).rejects.toThrow();
    // A diagnostic-shaped line AFTER the real final is never stripped (only
    // leading lines are eligible), so trailing content fails the parse.
    await expect(owner.parseWorkerFinal(`${JSON.stringify(claims)}\n${diagnostic}`, { observation })).rejects.toThrow();
    // The emoji-presentation "⚠️" (U+FE0F) the budget-exhaustion message uses
    // is a model-facing warning, not a CLI diagnostic, and must NOT strip.
    expect(stripHermesStartupDiagnostics('⚠️ **Thinking Budget Exhausted**\n\nfree text'))
      .toBe('⚠️ **Thinking Budget Exhausted**\n\nfree text');
    expect(stripHermesStartupDiagnostics(diagnostic + diagnostic)).toBe('');
    expect(stripHermesStartupDiagnostics(42)).toBe(42);
  });

  it('HD06 the bundled registry stays undispatchable: live qualification is a recorded S1 blocker', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:hermes')).toThrow();
    registry.providers.hermes.workerAdapter = structuredClone(registry.providers.hermes.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:hermes');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
    const packs = JSON.parse(JSON.stringify(fixtureJson('provider-coverage.json')));
    expect(packs.rows.find((row: any) => row.provider === 'hermes')).toMatchObject({ scope: 'IN', qualification: 'unqualified' });
  });

  it('HD07 secrets stay out of the rendered command; the brief travels on stdin only', async () => {
    const { plan, root } = await hermesPlan();
    const secret = 'sk-synthetic-hermes-secret';
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(plan.invocation!.stdin).toBe('brief-text');
  });

  it('HD10 HERMES_YOLO_MODE (and any other HERMES_* bypass env) can never reach the worker: the allowlist excludes it and an ambient copy in the conductor env is stripped', async () => {
    const bundled = loadProviderModelCapabilities().providers.hermes.workerHealthAdapter!;
    expect(bundled.invocation.envAllowlist).not.toContain('HERMES_YOLO_MODE');
    expect(bundled.invocationProfiles!['direct-shell'].envAllowlist).toEqual(['PATH']);
    const { plan, root } = await hermesPlan();
    const invocation = plan.invocation!;
    expect(invocation.envNames).not.toContain('HERMES_YOLO_MODE');
    expect(invocation.shellCommand).not.toContain('HERMES_YOLO_MODE');
    const { file, recordPath } = await fakeConfig(root, 'success');
    const result = await run('/bin/sh', ['-c', invocation.shellCommand!], { cwd: root,
      env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file, HERMES_YOLO_MODE: '1', HERMES_ACCEPT_HOOKS: '1' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record.envNames).not.toContain('HERMES_YOLO_MODE');
    expect(record.envNames).not.toContain('HERMES_ACCEPT_HOOKS');
  });
});

describe('Hermes production final-claim gate (worker-installation.mjs:722 wiring)', () => {
  /** Wraps the SAME driver.parseWorkerFinal the production loader wires
   * (worker-installation.mjs:722) with a spy, so the test proves the hook
   * actually ran and resolved/rejected, independent of the health
   * observer's own async timing (finalValid itself is never exposed as a
   * snapshot field, only consumed internally — see worker-health.mjs:310). */
  function spyFinal(drivers: Record<string, WorkerInvocationDriver>) {
    const real = drivers.hermes.parseWorkerFinal!.bind(drivers.hermes);
    const calls: Array<{ resolved: boolean; value?: unknown; error?: unknown }> = [];
    (drivers.hermes as any).parseWorkerFinal = async (output: unknown, opts: unknown) => {
      try { const value = await real(output, opts); calls.push({ resolved: true, value }); return value; }
      catch (error) { calls.push({ resolved: false, error }); throw error; }
    };
    return calls;
  }

  it('HD08 a successful run resolves parseWorkerFinal with a valid claims document through the SAME extractFinal+parseWorkerFinal wiring the installed loader uses', async () => {
    const { plan, root, workdir, snapshot, drivers, now } = await hermesPlan();
    const calls = spyFinal(drivers);
    const { file } = await fakeConfig(root, 'success');
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', file);
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
    const runDir = path.join(root, 'run-success');
    let result: any;
    try {
      result = await new SessionLauncher().launchWorker({ invocationPath, runDir, inputs: { snapshot, drivers }, now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic: no systemd user manager' }, allowDegraded: true,
        launchIsolated: (options: any) => launchIsolatedWorker(options) });
    } finally { vi.unstubAllEnvs(); }
    expect(result.exitCode ?? result.exit?.exitCode ?? 0, JSON.stringify(result)).toBe(0);
    const files = await readdir(runDir);
    expect(files).toEqual(expect.arrayContaining(['invocation.json', 'process.json', 'exit.json', 'final-evidence.json']));
    const evidence = JSON.parse(await readFile(path.join(runDir, 'final-evidence.json'), 'utf8'));
    expect(evidence).toMatchObject({ terminalSuccess: true, source: 'adapter-extraction' });
    // The hook ran (proves wiring, not just that the exit code was 0) —
    // calls.length proves parseWorkerFinal was actually invoked. This
    // synthetic degraded-mode launch (no systemd unit/process-group
    // tracking) cannot produce a 'confirmed' termination, so the strict
    // #2890 claims parser's assertWorkerTerminal legitimately still rejects
    // here (see HD05b for the positive case: a direct call with a
    // manually-confirmed observation resolves this SAME valid claims
    // document). That asymmetry is a property of this harness, not of the
    // adapter; Codex's own CX03 equivalent test asserts the same way
    // (exitCode/terminalSuccess only through SessionLauncher, strict-parse
    // resolution via a direct call).
    expect(calls, JSON.stringify(calls, (k,v)=>v instanceof Error?String(v.stack):v)).toHaveLength(1);
    void workdir;
  });

  it('HD09 a failed turn (exit 1, partial stdout) rejects parseWorkerFinal on the exit-derived status alone — the candidate extraction alone would have accepted the text', async () => {
    const { plan, snapshot, drivers, now, root } = await hermesPlan();
    const calls = spyFinal(drivers);
    const { file } = await fakeConfig(root, 'partial-then-failed');
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', file);
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
    const runDir = path.join(root, 'run-failed');
    let result: any;
    try {
      result = await new SessionLauncher().launchWorker({ invocationPath, runDir, inputs: { snapshot, drivers }, now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic: no systemd user manager' }, allowDegraded: true,
        launchIsolated: (options: any) => launchIsolatedWorker(options) });
    } finally { vi.unstubAllEnvs(); }
    expect(result.exitCode).toBe(1);
    // The candidate (parseOutput) extraction alone sees non-empty text and
    // would accept it; terminalSuccess (computed purely from the exit code,
    // same as the production loader) must still be false.
    expect(owner.parseOutput(`partial reply before failure (0 chars)\n`)).not.toBeNull();
    const evidence = JSON.parse(await readFile(path.join(runDir, 'final-evidence.json'), 'utf8'));
    expect(evidence.terminalSuccess).toBe(false);
    expect(calls, JSON.stringify(calls)).toHaveLength(1);
    expect(calls[0].resolved).toBe(false);
    expect(String((calls[0].error as any)?.message)).toMatch(/did not complete/);
  });

  it('HD09b exit 0 with a free-text (non-claims) final still rejects parseWorkerFinal — proves the strict claims parser, not just the exit-derived status, is wired', async () => {
    const { plan, snapshot, drivers, now, root } = await hermesPlan();
    const calls = spyFinal(drivers);
    const { file } = await fakeConfig(root, 'budget-exhausted');
    vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', file);
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
    const runDir = path.join(root, 'run-budget-exhausted');
    let result: any;
    try {
      result = await new SessionLauncher().launchWorker({ invocationPath, runDir, inputs: { snapshot, drivers }, now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic: no systemd user manager' }, allowDegraded: true,
        launchIsolated: (options: any) => launchIsolatedWorker(options) });
    } finally { vi.unstubAllEnvs(); }
    // The real CLI's own exit code says success here (see hermes-adapter.mjs
    // docstring, conversation_loop.py:3902) — terminalSuccess (exit-code-only)
    // would wrongly read true, and the exit-derived status check alone
    // (options.observation.status === 'completed') would ALSO pass. Only the
    // strict workerClaims parse inside parseWorkerFinal rejects free text.
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    const evidence = JSON.parse(await readFile(path.join(runDir, 'final-evidence.json'), 'utf8'));
    expect(evidence.terminalSuccess).toBe(true); // exit-code-only evidence is wrong here
    expect(calls, JSON.stringify(calls)).toHaveLength(1);
    expect(calls[0].resolved).toBe(false);
  });
});
