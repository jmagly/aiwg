import { workerMarkerNames } from '../../fixtures/worker-attribution.js';
/** #2898: offline mappings only, never authenticated Muse qualification. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { loadProviderModelCapabilities, qualifyWorkerInvocationProfile } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, resolveWorkerEffectiveHealth, prepareWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { MuseAdapter, MUSE_DIRECT_VERSION, museQuotaEvidence } from '../../../tools/ralph-external/lib/muse-adapter.mjs';
import { registerWorkerInvokeToolset } from '../../../src/mcp/tools/worker-invoke.mjs';

const FAKE = path.resolve('test/fixtures/providers/muse/fake-muse.mjs');
const owner = new MuseAdapter();
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<any> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', ended = false;
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.on('error', () => {}); child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (value: object) => { if (ended) return; ended = true; clearTimeout(timer); resolve({ stdout, stderr, ...value }); };
    child.on('error', error => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

async function fixture(options: { qualified?: boolean; model?: string; effort?: string; version?: string } = {}) {
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-muse-direct-')); roots.push(root);
  const cwd = path.join(root, "work '雪"); await mkdir(cwd);
  const brief = path.join(root, "brief '雪\n.md");
  const payload = `--leading 雪\n'quotes' \"double\" $(touch ${root}/injected); \`echo dangerous\``;
  await writeFile(brief, payload, { mode: 0o600 });
  const schema = JSON.parse(readFileSync('schemas/mission-v1.schema.json', 'utf8'));
  const claimsSchema = { $schema: schema.$schema, $id: schema.$id, $defs: schema.$defs, $ref: '#/$defs/workerClaims' };
  const schemaFile = path.join(root, 'claims schema.json');
  // Projection of the existing owner; no new contract or schema family.
  await writeFile(schemaFile, JSON.stringify(claimsSchema), { mode: 0o600 });
  const validate = addFormats(new Ajv2020({ strict: true })).compile(claimsSchema);
  const adapter: any = structuredClone(loadProviderModelCapabilities().providers.muse.workerHealthAdapter!);
  const profile = adapter.invocationProfiles['direct-shell'];
  if (options.qualified !== false) {
    adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-muse'),
      verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    for (const [name, control] of Object.entries(profile.controls) as any) {
      control.support = ['sandbox', 'children', 'fallback', 'finalOutput', 'stdin'].includes(name) ? 'external' : 'native';
      control.evidence = 'fixture:synthetic-only';
    }
    profile.controls.structuredOutput.mapping = JSON.stringify(['--output-schema', schemaFile]);
    profile.installationQualification = { scopeDigest: workerConfigDigest('synthetic-muse-scope'),
      fixtureDigest: workerConfigDigest('synthetic-only'), verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
    profile.envAllowlist = adapter.invocation.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
    Object.assign(adapter.capabilities, { nestedAgentsControllable: true, nativeFallbackControllable: true,
      sandboxModes: ['read-only', 'workspace-write', 'external'] });
  }
  const boundary = { kind: 'os' as const, identity: 'synthetic-boundary', digest: workerConfigDigest('synthetic-boundary'),
    controls: ['sandbox', 'children', 'fallback', 'finalOutput', 'stdin'] };
  delete f.snapshot.registry.providers.codex.workerAdapter;
  f.snapshot.registry.providers.muse.workerAdapter = adapter;
  const model = options.model ?? 'muse-spark-1.3';
  const group = f.snapshot.config.parallelism!.groups!.workers;
  group.members = [{ ...group.members[0], cli: 'muse', model }]; group.fallback = [];
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'muse'; discovery.runtimeVersion = MUSE_DIRECT_VERSION;
  discovery.models = discovery.models.slice(0, 1);
  Object.assign(discovery.models[0], { id: model, apiModelId: model });
  Object.assign(discovery.models[0].worker!, { cliId: 'muse', runtimeVersion: MUSE_DIRECT_VERSION });
  f.snapshot.catalog.discovery!.instances = { muse: discovery };
  f.snapshot.installations = { muse: { ...f.snapshot.installations.codex, profile: 'direct-shell',
    cliVersion: options.version ?? MUSE_DIRECT_VERSION, boundary } };
  if (options.effort) f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!.initialEffort = options.effort;
  let builds = 0;
  const drivers: any = { muse: { qualification: { adapter, adapterId: 'muse', cliVersion: options.version ?? MUSE_DIRECT_VERSION, boundary,
    installation: { evidence: profile.installationQualification, boundary } },
    // Synthetic installation recheck; the real preparation owner still checks
    // all policy, tuple, environment, path and matching-boundary bindings.
    prepareWorkerInvocation: (invocation: any, qualification: any) => prepareWorkerInvocation(invocation, qualification),
    buildInvocation: async (input: any) => { builds++; return { argv: [process.execPath, FAKE, ...owner.buildWorkerArgs(input, profile, input.permissions)],
      stdin: 'closed', envNames: ['AIWG_FAKE_WORKER_CONFIG'] }; } } };
  const request = { role: 'coding' as const, group: 'workers', task: 'implementation', brief, workdir: cwd,
    final_output: path.join(cwd, "final '雪.json"), transport: 'shell' as const };
  const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
  return { root, cwd, payload, adapter, profile, plan, request, snapshot: f.snapshot, drivers, builds, validate };
}

async function execute(f: Awaited<ReturnType<typeof fixture>>, scenario: string, shell = false) {
  const config = path.join(f.root, `config-${scenario}.json`), record = path.join(f.root, `record-${scenario}.json`);
  await writeFile(config, JSON.stringify({ scenario, recordPath: record }), { mode: 0o600 });
  const invocation = f.plan.invocation!;
  const result = shell ? await run('/bin/sh', ['-c', invocation.shellCommand!], f.root,
    { AIWG_FAKE_WORKER_CONFIG: config, SYNTHETIC_SECRET: 'must-not-inherit' })
    : await run(invocation.argv[0], invocation.argv.slice(1), f.cwd, { AIWG_FAKE_WORKER_CONFIG: config },
      ['hang', 'no-handshake'].includes(scenario) ? 500 : 5000);
  if (shell) { result.stdout = await readFile(invocation.stdoutPath, 'utf8'); result.stderr = await readFile(invocation.stderrPath, 'utf8'); }
  return { ...result, record: existsSync(record) ? JSON.parse(await readFile(record, 'utf8')) : null };
}

describe('Muse S1 offline profile and direct execution', () => {
  it('MD01 records compatible syntax versions, unavailable signals and separate live qualification', () => {
    const adapter = loadProviderModelCapabilities().providers.muse.workerHealthAdapter!;
    expect(adapter.supportedVersions).toBe('>=1.4.4-R5419.1 <2.0.0');
    expect(adapter.qualification.status).toBe('unqualified');
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.supportedVersions).toBe(adapter.supportedVersions);
    expect(profile.controls.trust.mapping).toBe('["--trust-workspace"]');
    expect(profile.controls.approval.mapping).toBe('["--approval-mode","never","--approval-judge","off"]');
    expect(profile.health).toMatchObject({ coverage: 'degraded', sessionLogLocator: null, progressEvidence: [],
      qualification: { authorizedLive: false } });
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: MUSE_DIRECT_VERSION })).toThrow('unqualified');
    expect(adapter.invocationProfiles!['echo']).toBeUndefined();
  });

  it('MD02 renders and executes shell and JSON argv with exact model/effort, prompt/schema and closed stdin; no MC', async () => {
    const f = await fixture();
    expect(f.plan.invocation, JSON.stringify(f.plan.diagnostics)).toBeDefined();
    const invocation = f.plan.invocation!;
    expect(invocation.selected.effort.value).toBe('medium');
    expect(invocation.argv).toEqual([process.execPath, FAKE, 'exec', '--json', '--provider', 'meta', '--model', 'muse-spark-1.3',
      '--reasoning-effort', 'medium', '--workspace', f.cwd, '--trust-workspace', '--approval-mode', 'never', '--approval-judge', 'off',
      '--max-model-steps', String(invocation.health!.maxSteps), '--output-schema', path.join(f.root, 'claims schema.json'), '--prompt-file', f.request.brief]);
    expect(invocation.shellCommand).toContain('< /dev/null');
    expect(invocation.shellCommand).not.toContain(f.payload);
    const shell = await execute(f, 'success', true), json = await execute(f, 'success');
    expect(shell.code).toBe(0); expect(json.code).toBe(0);
    expect(json.record.envNames).toEqual(['AIWG_FAKE_WORKER_CONFIG']);
    expect(shell.record).toEqual({ ...json.record, envNames: ['AIWG_FAKE_WORKER_CONFIG', ...workerMarkerNames] });
    expect(shell.record).toMatchObject({ argv: invocation.argv.slice(2), cwd: f.cwd, brief: f.payload, stdinEof: true, stdinBytes: 0 });
    expect(shell.record.envNames).not.toContain('SYNTHETIC_SECRET');
    expect(f.validate(JSON.parse(owner.parseOutput(shell.stdout)!.text!))).toBe(true);
    expect(existsSync(path.join(f.root, 'injected'))).toBe(false);
    expect(existsSync(path.join(f.root, '.aiwg'))).toBe(false);
  });

  it.each([{ qualified: false }, { model: 'muse-spark-1.3-contributor' }, { effort: 'ultra' }, { version: '1.4.3-R5018.1' }])
    ('MD03 blocked tuple %j produces no launch command', async options => {
      const f = await fixture(options);
      expect(f.plan.invocation).toBeUndefined(); expect(f.builds).toBe(0);
    });

  it('MD04 missing schema/model/effort/step authority cannot fall back to CLI defaults or weaken sandbox', async () => {
    const f = await fixture();
    const input: any = { ...f.plan.invocation, permissions: { sandbox: 'workspace-write' } };
    expect(() => owner.buildWorkerArgs(input, { controls: { structuredOutput: { mapping: '--output-schema' } } }, input.permissions)).toThrow('output-schema');
    for (const altered of [ { ...input, selected: { ...input.selected, model: '' } },
      { ...input, selected: { ...input.selected, effort: { value: 'undeclared' } } }, { ...input, health: { maxSteps: 0 } } ]) {
      expect(() => owner.buildWorkerArgs(altered, f.profile, input.permissions)).toThrow();
    }
    const argv = owner.buildWorkerArgs(input, f.profile, { sandbox: 'read-only' });
    expect(argv).toContain('--disable-write');
    expect(argv).toContain('--disable-shell');
    for (const bypass of ['--yolo', '--disable-sandbox', '--disable-approval', '--allow-workspace-switch']) expect(argv).not.toContain(bypass);
  });

  it.each(['trust', 'auth', 'model', 'eperm', 'erofs', 'stdin-wait', 'malformed', 'missing-final', 'double-final', 'truncated-final', 'exit-zero-error'])
    ('MD05 %s never establishes a healthy successful final', async scenario => {
      const f = await fixture(), result = await execute(f, scenario);
      const observer = owner.createHealthObserver({ profile: f.profile, invocationId: 'synthetic', effectiveHealth: f.plan.invocation!.health });
      observer.feed(Buffer.from(result.stdout), { kind: 'stdout' }); observer.feed(Buffer.from(result.stderr), { kind: 'stderr' });
      const parsed = owner.parseOutput(result.stdout);
      expect(observer.finish({ exitCode: result.code, termination: 'confirmed', finalValid: parsed?.settled === true }).state).not.toBe('completed');
      expect(parsed?.settled === true).toBe(false);
    });

  it('MD06 quota retains domain/reset/retry and partial output; unknown domain/reset stays null', async () => {
    const f = await fixture(), result = await execute(f, 'quota');
    expect(result.code).toBe(1);
    expect(owner.parseOutput(result.stdout)).toMatchObject({ settled: false, text: 'synthetic partial evidence',
      quota: { quotaScope: 'account:synthetic', resetAt: '2026-10-09T12:00:00.000Z', retryAfterSeconds: 30 } });
    expect(museQuotaEvidence({ reason: '429' })).toEqual({ reasonCode: 'RATE_LIMIT', quotaScope: null, resetAt: null, retryAfterSeconds: null });
    expect(museQuotaEvidence({ reason: '429', quota_scope: 'Bearer secret with spaces', reset_at: 'invalid' })).toMatchObject({ quotaScope: null, resetAt: null });
  });

  it('MD07 activity-only grammar, configured model and foreign logs never prove progress/backend identity', async () => {
    const f = await fixture(), result = await execute(f, 'success');
    let now = 0;
    const observer = owner.createHealthObserver({ profile: { health: { ...f.profile.health, handshake: 'semantic' } },
      now: () => now, wallNow: () => Date.UTC(2026, 9, 9), invocationId: 'synthetic' });
    const lines = result.stdout.trim().split('\n');
    observer.feed(Buffer.from(lines[0] + '\n'));
    expect(observer.snapshot().handshake).toBe('semantic');
    now = 1000; observer.feed(Buffer.from(lines[1] + '\n'));
    expect(observer.snapshot().lastActivityAt).not.toBeNull();
    expect(observer.snapshot().lastProgressAt).toBeNull();
    const binding = { sessionId: 'synthetic-session', runId: 'synthetic-run' };
    expect(owner.observeHealthEvent({ ...JSON.parse(lines[0]), payload_type: 'run.model.configured',
      payload: { model_id: 'muse-spark-1.3', run_id: binding.runId } }, { kind: 'stdout' }, binding)).toBeNull();
    expect(owner.observeHealthEvent(JSON.parse(lines[1]), { kind: 'session-log' }, { ...binding, runId: 'other' })).toBeNull();
    expect(owner.observeHealthEvent(JSON.parse(lines[1]), { kind: 'stdout' }, {})).toBeNull();
  });

  it.each(['hang', 'no-handshake'])('MD08 executes %s fixture, observes scaled boundaries and confirmed owned stop', async scenario => {
    const f = await fixture(), result = await execute(f, scenario);
    expect(result.signal).toBe('SIGKILL');
    let now = 0;
    const effective = resolveWorkerEffectiveHealth({ roleScale: { coding: 1.25 } }, { role: 'coding', effort: 'medium',
      modelKey: 'meta/muse-spark-1.3', profileRef: 'direct-shell', wallSeconds: 1800, stepEnforcement: 'unavailable' });
    expect(effective.quietSeconds).toBe(112.5); expect(effective.stallSeconds).toBe(375);
    const observer = owner.createHealthObserver({ profile: { health: { ...f.profile.health, handshake: 'semantic' } },
      effectiveHealth: effective, now: () => now, wallNow: () => Date.UTC(2026, 9, 9) });
    observer.feed(Buffer.from(result.stdout));
    now = scenario === 'hang' ? 375_000 : 60_000; observer.check();
    expect(observer.snapshot().state).toBe(scenario === 'hang' ? 'stalled' : 'failed-to-start');
    expect(observer.snapshot().lastProgressAt).toBeNull();
    expect(observer.finish({ exitCode: null, signal: result.signal, termination: 'confirmed', finalValid: false }).state).not.toBe('completed');
  });

  it('MD09 strict generic parser blocks Muse envelopes, including forged exit; shared normalization remains a gate', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const f = await fixture(), result = await execute(f, 'success');
    await expect(owner.parseWorkerFinal(result.stdout, { observation: { transport: 'shell', status: 'completed', exitCode: 0, termination: 'confirmed' } }))
      .rejects.toThrow('Unknown or error worker stream event');
  });

  it('MD10 AIWG bridge runs Muse without MC and honestly fails unsupported native envelope normalization', async () => {
    const f = await fixture();
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, _config: unknown, handler: any) { tools.set(name, handler); } }, {
      projectRoot: f.root, workerWorktreesRoot: f.cwd, loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      // Synthetic bridge fixture: the run must launch the fake CLI without
      // spawning a real context deploy (dedicated ensure coverage lives in
      // the worker-context suites); the test below asserts nothing is
      // written to the project.
      ensureWorkerContext: false,
      now: () => new Date(f.snapshot.catalog.discovery!.instances!.muse.models[0].worker!.observedAt),
      launchShellWorker: async (invocation: any) => {
        const result = await execute(f, 'success'); await writeFile(invocation.finalPath, result.stdout);
        return { launched: true, mode: 'systemd-unit', unit: 'synthetic-no-systemd' };
      },
      waitForUnitTermination: async () => ({ exitCode: 0, termination: 'confirmed' }),
    });
    const response = await tools.get('worker-invoke')({ operation: 'run', request_id: 'muse-bridge-synthetic', ...f.request });
    const body = JSON.parse(response.content[0].text);
    expect(body.status).toBe('failed');
    expect(existsSync(path.join(f.root, '.aiwg'))).toBe(false);
  });
  it('MD11 real raw version banner cannot qualify the semver pin; fixtures simulate mechanics only', async () => {
    const f = await fixture();
    const result = await run(process.execPath, [FAKE, '--version'], f.cwd, { AIWG_FAKE_WORKER_CONFIG: await configForVersion(f.root) });
    const banner = result.stdout.trim();
    expect(banner).toBe('Muse Code 1.4.4 (1.4.4-R5419.1)');
    expect(banner).not.toBe(MUSE_DIRECT_VERSION);
    expect(() => qualifyWorkerInvocationProfile(f.adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: banner }))
      .toThrow('CLI version is outside qualified profile');
  });

});

async function configForVersion(root: string) {
  const filename = path.join(root, 'version-config.json');
  await writeFile(filename, '{}');
  return filename;
}
