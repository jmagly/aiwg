import { copyWorkerAdapterRuntime } from '../../helpers/worker-adapter-runtime.mjs';
/**
 * #2908 (B-OG-43) Antigravity (`agy`) promotion: offline S1 profile work.
 *
 * Loads the production AntigravityAdapter through the real #2885
 * installed-module loader (digest-pinned, mirroring #2897
 * codex-adapter.mjs / #2903 cursor-adapter.mjs), then renders argv through
 * the adapter's own production `buildWorkerArgs` and executes the rendered
 * command against a synthetic `agy` that records argv, cwd, stdin and
 * environment names, and emits the CLI's own (previously evidenced) event
 * grammar. Health and final-extraction assertions drive the production
 * `observeHealthEvent`/`parseDirectFinal`/`parseWorkerFinal` hooks directly
 * (not a hand-fed stand-in), per the task's time-box this intentionally
 * does not re-exercise the full `resolveWorkerInvocation` plan-rendering
 * pipeline the way the larger existing provider suites do; that full-plan
 * coverage is a documented follow-up (see report). Spawns are plain child
 * processes (no systemd); nothing reaches a network, model, credential or
 * MC state. Fixture qualification here is synthetic and never live
 * qualification: the bundled Antigravity profile stays unqualified.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import {
  ANTIGRAVITY_DIRECT_EFFORT_VALUES, ANTIGRAVITY_DIRECT_SANDBOX_MODES, ANTIGRAVITY_DIRECT_STDIN,
  ANTIGRAVITY_SUPPORTED_VERSIONS, buildAntigravityStdinFrame,
} from '../../../tools/ralph-external/lib/antigravity-adapter.mjs';
import { createProvider, loadInstalledWorkerAdapters } from '../../../src/models/worker-installation.mjs';
import { workerStdinBytes } from '../../../src/serve/worker-stdin-frame.mjs';

const FAKE = path.resolve('test/fixtures/providers/antigravity/fake-agy.mjs');
const OBSERVATION = { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 };
const VERSION = '>=1.5.10 <1.6.0';
const MODEL = 'gemini-4-neon-low';
const MODULE = 'tools/ralph-external/lib/antigravity-adapter.mjs';
const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/antigravity/approved-module.json', 'utf8'));
const roots: string[] = [];
const installRoots: string[] = [];
const sha256 = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Host-side install of the one approved Antigravity module into a fresh,
 * read-only package root. antigravity-adapter.mjs imports provider-adapter.mjs
 * and worker-health.mjs as siblings, so they ride along uninstrumented;
 * worker-installation itself is bridged back to the source file under test
 * so registration lands in the production loader registry that
 * createProvider reads. */
async function installAntigravityPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-antigravity-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'pkg');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable, { mode: 0o755 });
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'lib', 'antigravity-adapter.mjs'), bytes, { mode: 0o644 });
  await copyWorkerAdapterRuntime(base, packageRoot);
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  await mkdir(path.join(base, 'src', 'mission-protocol'), { recursive: true });
  const protocol = path.relative(path.join(base, 'src', 'mission-protocol'), path.resolve('src/mission-protocol/index.ts'));
  await writeFile(path.join(base, 'src', 'mission-protocol', 'index.js'), `export * from ${JSON.stringify(protocol)};\n`);
  return { packageRoot, writable };
}

function loadingRegistry() {
  const registry = { ...structuredClone(loadProviderModelCapabilities()), workerAdapters: {} };
  registry.providers.antigravity.workerAdapter = structuredClone(registry.providers.antigravity.workerHealthAdapter);
  return registry;
}

let installed: { owner: any; ids: string[] };
beforeAll(async () => {
  const saved = process.env.AIWG_RESOLVE_IMPL_FROM;
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  try {
    const { packageRoot, writable } = await installAntigravityPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('antigravity'), ids };
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

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function run(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdinData?: string | Buffer; timeoutMs?: number }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdinData ?? buildAntigravityStdinFrame('synthetic brief'));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-antigravity-')); roots.push(root);
  const workdir = path.join(root, 'work'); await mkdir(workdir);
  return { root, workdir };
}

async function fakeConfig(root: string, scenario: string, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  await writeFile(file, JSON.stringify({ scenario, recordPath, knownModels: [MODEL], ...extra }));
  return { file, recordPath };
}

function argvFor(workdir: string, effort = 'low') {
  const owner = installed.owner;
  const input = { brief: 'synthetic brief', cwd: workdir, selected: { model: MODEL, effort: { value: effort } } };
  return owner.buildWorkerArgs(input, null, { sandbox: 'read-only' });
}

describe('Antigravity (agy) version-bound profile (B-OG-43)', () => {
  it('AG01 pins the evidenced release, driver, catalog and argv template; unknown controls stay unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.antigravity.workerHealthAdapter!;
    expect(ANTIGRAVITY_SUPPORTED_VERSIONS).toEqual([VERSION]);
    expect(adapter).toMatchObject({ supportedVersions: VERSION, adapterVersion: APPROVED.entry.packageVersion,
      runtimeDriver: APPROVED.entry.reference,
      catalogAdapter: { kind: 'file', locator: 'agentic/code/providers/model-catalog.v1.json' },
      invocation: { executable: 'agy', stdin: 'adapter-frame' },
      qualification: { status: 'unqualified' } });
    expect(adapter.invocation.argv).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--model', '${model}', '--sandbox', '--disable-slash-commands']);
    expect(adapter.capabilities.sandboxModes).toEqual(['read-only']); // #3: must agree with the adapter's accepted modes
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(VERSION);
    for (const [name, control] of Object.entries<any>(profile.controls)) {
      expect(control.support, name).toBe('unqualified');
      expect(control.evidence, name).toMatch(/^(H|D|R): /);
    }
  });

  it('AG01a pins the one approved module digest and loads it through the production installed loader', () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:antigravity', interfaceVersion: 1,
      adapterIds: ['antigravity'], platforms: ['linux'] });
    expect(installed.ids).toEqual(['antigravity']);
    expect(installed.owner.getName()).toBe('antigravity');
    expect(installed.owner.getBinary()).toBe('agy');
    expect(installed.owner.constructor.name).toBe('AntigravityAdapter');
  });

  it('AG01b a tampered copy is refused and the bundled registry stays undispatchable', async () => {
    const tampered = Buffer.concat([readFileSync(MODULE), Buffer.from('\n// tampered\n')]);
    const bad = await installAntigravityPackage(tampered);
    await expect(loadInstalledWorkerAdapters({ registry: loadingRegistry(), modules: [{ ...APPROVED.entry, packageRoot: bad.packageRoot }],
      workerWritableRoots: [bad.writable], platform: 'linux' })).rejects.toThrow('Installed module digest mismatch');
    const registry = structuredClone(loadProviderModelCapabilities());
    expect(() => resolveWorkerAdapter(registry, 'providers:antigravity')).toThrow();
    registry.providers.antigravity.workerAdapter = structuredClone(registry.providers.antigravity.workerHealthAdapter);
    const adapter = resolveWorkerAdapter(registry, 'providers:antigravity');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: VERSION }))
      .toThrow('Worker transport/profile is unqualified');
  });
});

describe('T-OG-15 Antigravity direct command contract (render via production buildWorkerArgs)', () => {
  it('AG02 renders the explicit template; refuses guessed/unsafe/bypass controls', () => {
    const owner = installed.owner;
    const input = { brief: 'synthetic brief', cwd: '/w', selected: { model: MODEL, effort: { value: 'low' } } };
    expect(owner.buildWorkerArgs(input, null, { sandbox: 'read-only' })).toEqual(['--input-format', 'stream-json',
      '--output-format', 'stream-json', '--model', MODEL, '--sandbox', '--disable-slash-commands']);
    // #1 regression: no --print flag, no prompt value, ever (live probes A/B/C).
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'read-only' })).not.toThrow();
    // Option-like value refusal: a model/effort that looks like a flag can
    // never ride through as an argv value.
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '--dangerously-skip-permissions', effort: { value: 'low' } } },
      null, { sandbox: 'read-only' })).toThrow(/option/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: '--mode=accept-edits' } } },
      null, { sandbox: 'read-only' })).toThrow(/explicit qualified reasoning effort/);
    for (const value of ['auto', 'AUTO', 'default', 'DEFAULT']) {
      expect(() => owner.buildWorkerArgs({ ...input, selected: { model: value, effort: { value: 'low' } } }, null, { sandbox: 'read-only' }))
        .toThrow(/explicit model/);
    }
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: 'opus', effort: { value: 'low' } } }, null, { sandbox: 'read-only' }))
      .toThrow(/generic alias/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: MODEL, effort: { value: 'not-a-level' } } }, null, { sandbox: 'read-only' }))
      .toThrow(/explicit qualified reasoning effort/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'workspace-write' })).toThrow(/sandbox is not a qualified/);
    expect(() => owner.buildWorkerArgs(input, null, { sandbox: 'external' })).toThrow(/sandbox is not a qualified/);
    expect(() => owner.buildWorkerArgs({ ...input, cwd: 'relative' }, null, { sandbox: 'read-only' })).toThrow(/absolute/);
    expect(() => owner.buildWorkerArgs({ ...input, selected: { model: '', effort: { value: 'low' } } }, null, { sandbox: 'read-only' }))
      .toThrow(/explicit model/);
    expect(() => owner.buildWorkerArgs({ ...input, brief: '' }, null, { sandbox: 'read-only' })).toThrow(/non-empty brief/);
    const rendered = owner.buildWorkerArgs(input, null, { sandbox: 'read-only' });
    expect(owner.buildWorkerArgs({ ...input, brief: undefined, briefPath: '/w/brief' }, null, { sandbox: 'read-only' })).toEqual(rendered);
    expect(rendered).not.toContain('--dangerously-skip-permissions');
    expect(rendered).not.toContain('--remote-control');
    expect(rendered).not.toContain('--mode');
    expect(owner.getAbortInput()).toBeNull();
    expect(() => owner.buildSessionArgs({})).toThrow(/Not implemented/);
    expect(() => owner.buildAnalysisArgs({})).toThrow(/Not implemented/);
  });

  it('AG03 executes the rendered argv against the fake: brief rides on one NDJSON stdin line, argv/env stay clean', async () => {
    const { root, workdir } = await scratch();
    const { file, recordPath } = await fakeConfig(root, 'success');
    const argv = argvFor(workdir);
    const result = await run([FAKE, ...argv], { cwd: workdir, stdinData: workerStdinBytes({ stdin: 'adapter-frame' }, 'synthetic brief content', installed.owner)!,
      env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file, ANTIGRAVITY_UNRELATED_SECRET: 'fk-synthetic-should-not-pass' } });
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    expect(record).toMatchObject({ model: MODEL, effort: null, sandbox: true, disableSlash: true, printTimeout: null, viaPrint: false });
    expect(record.brief).toBe('synthetic brief content');
    expect(record.argv).toEqual(argv);
    expect(record.argv).not.toContain('--print');
    const final = installed.owner.parseDirectFinal(result.stdout);
    expect(final).toMatchObject({ status: 'SUCCESS' });
    expect(final.response).toContain('synthetic reply');
    // #5: parseOutput is the installed driver's extractFinal hook; it must
    // be non-null only on an affirmative SUCCESS, driven here directly.
    expect(installed.owner.parseOutput(result.stdout)).toEqual(final);
    // parseWorkerFinal unwraps the stream-json envelope (proven above via
    // parseDirectFinal) and forwards the model's own final answer text to
    // the shared strict claims parser (super.parseWorkerFinal, #2890). This
    // drives the REAL hook end to end (never hand-fed finalValid).
    // #5: a plain English reply correctly fails strict claims validation.
    await expect(installed.owner.parseWorkerFinal(result.stdout, { observation: OBSERVATION })).rejects.toThrow(/Malformed worker final/);
    // #5: successful claims validation through the real hook, when the
    // model's own final text IS a valid workerClaims JSON document.
    const { file: claimsFile } = await fakeConfig(root, 'echo-brief', {});
    const claimsPayload = JSON.stringify({ version: 1, status: 'completed', summary: 'synthetic claims summary',
      claims: [], artifacts: [], checks: [], limitations: [] });
    const claimsResult = await run([FAKE, ...argv],
      { cwd: workdir, stdinData: buildAntigravityStdinFrame(claimsPayload),
        env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: claimsFile } });
    expect(claimsResult.code, claimsResult.stderr).toBe(0);
    const claims = await installed.owner.parseWorkerFinal(claimsResult.stdout, { observation: OBSERVATION });
    expect(claims).toBeDefined();
  });

  it('AG04 the fixture refuses the never-emitted blanket-bypass flags (regression guard)', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const withDangerous = await run([FAKE, ...argvFor(workdir), '--dangerously-skip-permissions'],
      { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(withDangerous.code).not.toBe(0);
    expect(withDangerous.stderr).toMatch(/refused/);
    const withRemote = await run([FAKE, ...argvFor(workdir), '--remote-control'],
      { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(withRemote.code).not.toBe(0);
    expect(withRemote.stderr).toMatch(/refused/);
  });
});

describe('T-OG-03/20/21/23 Antigravity run identity and terminal signals', () => {
  const stdoutSource = { kind: 'stdout', id: 'stdout', generation: 0, offset: 0 };
  const owner = () => installed.owner;
  const observe = (event: unknown) => owner().observeHealthEvent(event, stdoutSource, { invocationId: 'fixture' });

  it('AG05 missing executable is ENOENT, never a synthesized exit zero', async () => {
    const { workdir } = await scratch();
    await expect(new Promise((resolve, reject) => {
      const child = spawn(path.join(workdir, 'agy'), ['--help'], { cwd: workdir });
      child.on('error', reject);
      child.on('exit', resolve);
    })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('AG06 success handshakes on setup/activity/progress and completes on a strict terminal', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const kinds = events.map(event => observe(event)?.kind);
    expect(kinds).toEqual(['setup', 'progress', 'terminal']);
    expect(events.map(event => observe(event))).toMatchObject([{}, {}, { kind: 'terminal', success: true }]);
  });

  it('AG07 a non-SUCCESS status, empty response, or malformed/missing/trailing stream fails closed, never auto-accepted', async () => {
    const { root, workdir } = await scratch();
    const runScenario = async (scenario: string) => {
      const { file } = await fakeConfig(root, scenario);
      const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
      return { result, final: owner().parseDirectFinal(result.stdout) };
    };
    for (const scenario of ['error-status', 'empty-response', 'malformed', 'trailing-after-terminal',
      'missing-final', 'invalid-step-state', 'bare-result']) {
      const { result, final } = await runScenario(scenario);
      expect(final, scenario).toBeNull();
      await expect(owner().parseWorkerFinal(result.stdout, { observation: OBSERVATION }), scenario).rejects.toThrow();
    }
  });

  it('AG08 crash mid-run exits non-zero and leaves no validated terminal', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'crash-mid');
    const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).not.toBe(0);
    expect(owner().parseDirectFinal(result.stdout)).toBeNull();
  });

  it('AG09 hang after start needs an owned stop; TERM is honored by the fixture, no synthesized success', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'hang');
    const result = await run([FAKE, ...argvFor(workdir)],
      { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file }, timeoutMs: 500 });
    expect(result.code).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });

  it('AG10 a malicious final is inert data: no worker-returned command is ever executed by this harness', async () => {
    const { root, workdir } = await scratch();
    const marker = path.join(root, 'executed-marker');
    const { file } = await fakeConfig(root, 'malicious-final', { marker });
    const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code, result.stderr).toBe(0);
    const final = owner().parseDirectFinal(result.stdout);
    expect(final?.response).toContain('touch');
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
  });

  it('AG11 soft-denied tool permission (exit 0, stderr notice) is a documented open risk, not invented away', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'soft-denied');
    const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/permission denied/);
    // parseWorkerFinal/parseDirectFinal cannot see stderr (module doc,
    // ANTIGRAVITY_SOFT_DENY_RISK_NOTE): this run's terminal result event is
    // itself well-formed and SUCCESS, so the stdout-only strict parse
    // currently accepts it. This is the open, honestly-marked gap, not a
    // repaired one.
    expect(owner().parseDirectFinal(result.stdout)).toMatchObject({ status: 'SUCCESS' });
  });

  it('AG12 the sole accepted sandbox mode is read-only; workspace-write is unavailable, never invented', () => {
    expect(ANTIGRAVITY_DIRECT_SANDBOX_MODES).toEqual(['read-only']);
    expect(ANTIGRAVITY_DIRECT_STDIN).toBe('adapter-frame');
    expect(ANTIGRAVITY_DIRECT_EFFORT_VALUES).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // #3: the registry's capabilities.sandboxModes list (what the resolver
    // actually checks) must agree with what the adapter accepts.
    const adapter = loadProviderModelCapabilities().providers.antigravity.workerHealthAdapter!;
    expect((adapter.capabilities as any).sandboxModes).toEqual([...ANTIGRAVITY_DIRECT_SANDBOX_MODES]);
  });

  it('AG13 fix round 1 regression: the real --print swallow/empty-prompt/bad-input-format errors (probes A/B/C/F)', async () => {
    const { root, workdir } = await scratch();
    const { file } = await fakeConfig(root, 'success');
    const env = { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file };
    // Probe A: a bare --print swallows the following flag as its prompt.
    const a = await run([FAKE, '--print', '--output-format', 'bogus-format'], { cwd: workdir, env });
    expect(a.code).not.toBe(0);
    expect(a.stderr).toMatch(/--print took "--output-format" as its prompt/);
    // Probe B: a trailing bare --print has no value at all.
    const b = await run([FAKE, '--output-format', 'bogus-format', '--print'], { cwd: workdir, env });
    expect(b.code).not.toBe(0);
    expect(b.stderr).toMatch(/flag needs an argument: -print/);
    // Probe C: an explicit empty --print is a hard error AND a real
    // ERROR-status stdout result event (live-confirmed shape).
    const c = await run([FAKE, '--print=', '--output-format', 'stream-json'], { cwd: workdir, env });
    expect(c.code).not.toBe(0);
    expect(c.stderr).toMatch(/empty prompt/);
    const cEvents = c.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(cEvents).toEqual([{ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '',
      error: 'Error: empty prompt. Usage: agy --print "your prompt here"' } }]);
    expect(installed.owner.parseDirectFinal(c.stdout)).toBeNull(); // ERROR status fails closed despite a real result event
    // Probe F: flag validation (here, --input-format) happens before auth.
    const f = await run([FAKE, '--print=x', '--input-format', 'bogus', '--output-format', 'stream-json'], { cwd: workdir, env });
    expect(f.code).not.toBe(0);
    expect(f.stderr).toMatch(/unknown --input-format "bogus" \(want text or stream-json\)/);
  });

  it('AG14a init must be the first event, exactly once: a late or duplicate init never validates', () => {
    const line = (event: unknown) => JSON.stringify(event);
    const init = line({ event: 'init', init: {} });
    const step = line({ event: 'step_update', step_update: { state: 'DONE' } });
    const ok = line({ event: 'result', result: { status: 'SUCCESS', response: 'done' } });
    const parse = (...lines: string[]) => installed.owner.parseDirectFinal(lines.join('\n') + '\n');
    expect(parse(init, step, ok)).toEqual({ status: 'SUCCESS', response: 'done' });
    expect(parse(step, init, ok)).toBeNull();
    expect(parse(init, init, ok)).toBeNull();
    expect(parse(init, step, init, ok)).toBeNull();
    expect(installed.owner.parseOutput([step, init, ok].join('\n') + '\n')).toBeNull();
  });

  it('AG14b the installed adapter supplies exact NDJSON bytes while live stdin authority remains unqualified', () => {
    const adapter = loadProviderModelCapabilities().providers.antigravity.workerHealthAdapter!;
    expect(adapter.invocation.stdin).toBe('adapter-frame');
    expect(adapter.invocationProfiles!['direct-shell'].controls.stdin.support).toBe('unqualified');
    expect(workerStdinBytes({ stdin: adapter.invocation.stdin } as any, 'brief', installed.owner))
      .toEqual(buildAntigravityStdinFrame('brief'));
    expect(() => workerStdinBytes({ stdin: 'unknown' } as any, 'brief', installed.owner)).toThrow(/Unsupported worker stdin mode/);
    expect(adapter.qualification.status).toBe('unqualified');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: '1.3.3' } as any)).toThrow();
  });

  it('AG14 a SUCCESS result with no preceding init, or a second result line, fails closed (#4)', async () => {
    const { root, workdir } = await scratch();
    const runScenario = async (scenario: string) => {
      const { file } = await fakeConfig(root, scenario);
      const result = await run([FAKE, ...argvFor(workdir)], { cwd: workdir, env: { PATH: process.env.PATH!, AIWG_FAKE_WORKER_CONFIG: file } });
      return owner().parseDirectFinal(result.stdout);
    };
    // A SUCCESS result arriving with no init at all never satisfies the
    // documented init->step_update->result success sequence.
    expect(await runScenario('missing-init')).toBeNull();
    // Two results in one stream: the second is itself a contract violation
    // (result is documented as the sole terminal), regardless of either
    // one's own shape.
    expect(await runScenario('two-results')).toBeNull();
  });
});
