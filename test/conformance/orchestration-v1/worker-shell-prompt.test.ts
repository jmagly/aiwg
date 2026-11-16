// Raw shell contracts, artifact refusal and prompt ownership use offline local workers.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createModelsHandler } from '../../../src/cli/handlers/models.js';
import { prepareWorkerInvocation, resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { requiredWorkerControls } from '../../../src/models/provider-policy.js';
import { qualificationDigest } from '../../../src/models/qualification-digest.mjs';
import { inspectWorkerInstallation, workerNegativeFixtureDigest, workerNegativeFixtureSuite } from '../../../src/models/worker-installation.mjs';
import { reserveShellWorkerCapture } from '../../../tools/ralph-external/lib/worker-shell-capture.mjs';
import { WarpAdapter } from '../../../tools/ralph-external/lib/warp-adapter.mjs';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';

const execute = promisify(execFile), roots: string[] = [];
beforeEach(() => vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'));
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(mode: 'brief-text' | 'brief-json' | 'closed' | 'warp') {
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-shell-contract-')); roots.push(root);
  const cwd = path.join(root, 'worker'); await mkdir(cwd);
  const brief = path.join(root, "brief '雪.md"), finalPath = path.join(root, "final '雪.json");
  const text = "Task $(touch injected) '雪\nbody"; await writeFile(brief, text);
  const capture = path.join(root, 'capture.mjs');
  await writeFile(capture, `import { readFileSync } from 'node:fs';
const file = process.argv[2];
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), prompt: readFileSync(file || 0, 'utf8') }));`);
  const metadata = f.snapshot.registry.providers.codex.workerAdapter!;
  const driver: WorkerInvocationDriver = { qualification: { adapter: metadata, adapterId: metadata.id,
    cliVersion: '1.0.0' }, buildInvocation: async input => {
    if (mode === 'warp') {
      const owner = new WarpAdapter();
      // Synthetic qualification only; real Warp registration remains unqualified.
      const worker = { ...input, selected: { ...input.selected, effort: { value: null } } };
      return { argv: ['/synthetic/warp-terminal', ...owner.buildWorkerArgs(worker, null, {})], stdin: 'closed', envNames: [],
        artifacts: owner.buildWorkerArtifacts(worker) };
    }
    return { argv: [process.execPath, capture, ...(mode === 'closed' ? [input.briefPath] : [])], stdin: mode, envNames: [] };
  } };
  const drivers = { codex: driver };
  const request = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd,
    final_output: finalPath, transport: 'shell' as const };
  const resolve = () => resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
  return { ...f, now: f.request.now, root, cwd, text, brief, finalPath, request, drivers, driver, resolve };
}

it.each(['brief-text', 'brief-json', 'closed'] as const)('T-OG-15 delivers exact contract bytes through %s', async mode => {
  const f = await fixture(mode), plan = await f.resolve();
  expect(plan.diagnostics).toEqual([]);
  const invocation = plan.invocation!;
  expect(invocation.shellCommand).not.toContain(f.text);
  await execute('/bin/sh', ['-c', invocation.shellCommand!], { timeout: 5000, env: { AIWG_RESOLVE_IMPL_FROM: 'dist' } });
  const record = JSON.parse(await readFile(invocation.stdoutPath!, 'utf8'));
  const prompt = mode === 'brief-json' ? JSON.parse(record.prompt).message : record.prompt;
  expect(prompt).toBe(workerPromptBrief(f.text, f.finalPath).toString());
  expect(prompt).toContain(JSON.stringify(f.finalPath));
  expect(prompt).toContain('Each claim and check is an object');
  expect(record.argv).toEqual(mode === 'closed' ? [`${f.finalPath}.worker-brief`] : []);
  expect(await readFile(`${f.finalPath}.worker-brief`)).toEqual(workerPromptBrief(f.text, f.finalPath));
  expect(await readFile(`${f.finalPath}.worker-brief.launch-owner`, 'utf8')).toContain('invocationId');
  expect(await readFile(f.brief, 'utf8')).toBe(f.text);
});

it('T-OG-15 raw adapter-frame shell execution delivers the exact contract through a signed installed framer', async () => {
  const f = await fixture('brief-text'), plan = await f.resolve();
  expect(plan.diagnostics).toEqual([]);
  const now = Date.now(), verifiedAt = new Date(now).toISOString();
  const invocation = { ...plan.invocation!, stdin: 'adapter-frame' as const, expiresAt: new Date(now + 60000).toISOString() };
  const adapter = structuredClone(f.driver.qualification.adapter);
  adapter.provider = 'codex';
  adapter.qualification.verifiedAt = verifiedAt;
  if (adapter.invocation.kind !== 'process') throw new Error('Process fixture required');
  adapter.invocation.stdin = 'adapter-frame';
  const versionFile = path.join(f.root, 'version.mjs');
  await writeFile(versionFile, "console.log('1.0.0');\n", { mode: 0o644 });
  adapter.invocation.versionArgv = [versionFile];
  const profile = adapter.invocationProfiles!['fixture-shell'];
  for (const control of Object.values(profile.controls)) {
    control.support = 'external'; control.mapping = 'synthetic executor';
  }
  // The child loader uses the real clock; refresh only synthetic evidence.
  const policy = plan.policy!;
  const modelObservation = { ...f.observation, observedAt: verifiedAt, fetchedAt: verifiedAt, verifiedAt,
    qualification: { ...f.observation.qualification, verifiedAt } };
  const permissions = {};
  const requiredControls = requiredWorkerControls({ policy, permissions, effort: invocation.selected.effort.value });
  const boundary = { kind: 'executor' as const, identity: 'fixture:executor', digest: qualificationDigest('executor'), controls: requiredControls };
  const packageRoot = path.join(f.root, 'installed'); await mkdir(packageRoot, { mode: 0o755 });
  const source = `export const interfaceVersion = 1;
export function register(factory) { factory('${adapter.id}', () => ({
  getName: () => '${adapter.id}', parseOutput: value => value,
  buildWorkerStdinFrame: (brief, invocation) => JSON.stringify({ prompt: brief.toString(), model: invocation.selected.model })
})); }`;
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-framer', version: adapter.adapterVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, 'driver.mjs'), source, { mode: 0o644 });
  const installation: any = { adapter, profile: 'fixture-shell', cliVersion: '1.0.0',
    executable: process.execPath, platform: 'linux', cwd: f.cwd, workerWritableRoots: [f.cwd],
    inputRoots: [f.root], outputRoots: [f.root], runtimeFiles: [versionFile],
    effectiveConfigDigest: qualificationDigest(policy), accountScope: 'synthetic', policy, permissions,
    effort: invocation.selected.effort.value, requiredControls, boundary, environment: {},
    modules: [{ reference: adapter.runtimeDriver, packageRoot, packageName: 'fixture-framer', packageVersion: adapter.adapterVersion,
      modulePath: 'driver.mjs', interfaceVersion: 1, sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
      adapterIds: [adapter.id], platforms: ['linux'] }] };
  const scope = await inspectWorkerInstallation({ getName: () => adapter.id }, installation);
  installation.evidence = { scopeDigest: scope.scopeDigest, fixtureDigest: await workerNegativeFixtureDigest(),
    verifiedAt, evidenceRef: 'fixture:synthetic-only',
    cases: Object.fromEntries(Object.keys(workerNegativeFixtureSuite.cases).map(id => [id, 'passed'])) };
  const { cases: _cases, ...proof } = installation.evidence;
  profile.installationQualification = proof;
  const signing = await workerSigningFixture(f.root, f.cwd);
  const { adapter: _metadata, ...storedInstallation } = installation;
  const record = signing.sign({ cli: invocation.selected.cli, adapter, installation: storedInstallation,
    binding: { profile: installation.profile, cliVersion: '1.0.0', accountScope: 'synthetic', boundary } });
  const storePath = path.join(f.root, 'worker-installations.json');
  const store = JSON.stringify({ version: 1, registrations: [record] });
  await writeFile(storePath, store, { mode: 0o600 });
  invocation.selected = { ...invocation.selected, qualificationDigest: scope.scopeDigest };
  const prepared = await prepareWorkerInvocation(invocation, { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
    now, role: 'coding', policy, permissions, requiredControls, boundary, installation,
    modelObservation, stdinFramerBinding: { storePath, storeDigest: `sha256:${createHash('sha256').update(store).digest('hex')}` } });
  expect(prepared.shellCommand).not.toContain(f.text);
  expect(prepared.shellCommand).toContain("'--adapter-frame'");
  await execute('/bin/sh', ['-c', prepared.shellCommand!], { timeout: 10000, env: { AIWG_RESOLVE_IMPL_FROM: 'dist' } });
  const captured = JSON.parse(await readFile(prepared.stdoutPath!, 'utf8'));
  expect(captured.argv).toEqual([]);
  expect(JSON.parse(captured.prompt)).toEqual({
    prompt: workerPromptBrief(f.text, f.finalPath).toString(), model: prepared.selected.model,
  });
  expect(await readFile(`${f.finalPath}.worker-brief`)).toEqual(workerPromptBrief(f.text, f.finalPath));
});

it('T-OG-15 closed-stdin no-input probes do not stage or reserve a prompt and still deliver EOF', async () => {
  const f = await fixture('closed');
  f.driver.buildInvocation = async () => ({ argv: [process.execPath, path.join(f.root, 'capture.mjs')], stdin: 'closed', envNames: [] });
  const plan = await f.resolve();
  expect(plan.diagnostics).toEqual([]);
  await unlink(f.brief); // The raw probe has no input-file dependency.
  expect(plan.invocation!.shellCommand).not.toContain('--stage');
  expect(plan.invocation!.shellCommand).not.toContain('.worker-brief');
  await execute('/bin/sh', ['-c', plan.invocation!.shellCommand!], { timeout: 5000, env: { AIWG_RESOLVE_IMPL_FROM: 'dist' } });
  expect(JSON.parse(await readFile(plan.invocation!.stdoutPath!, 'utf8'))).toEqual({ argv: [], prompt: '' });
  expect((await readdir(f.root)).some(name => name.includes('.worker-brief'))).toBe(false);
});

it('T-OG-15 Warp raw rendering refuses with a typed supported-route diagnostic; JSON keeps launcher artifacts', async () => {
  const f = await fixture('warp');
  const plan = await f.resolve();
  expect(plan.diagnostics).toEqual([]);
  expect(plan.invocation!.artifacts?.[0]).toMatchObject({ location: 'workspace-relative', content: expect.stringContaining(f.text) });
  expect(plan.invocation!.argv).toContain('--skill');
  expect(plan.invocation!.shellCommand).toContain('--refuse-artifacts');
  await expect(execute('/bin/sh', ['-c', plan.invocation!.shellCommand!], { timeout: 5000, env: { AIWG_RESOLVE_IMPL_FROM: 'dist' } }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/OG_ADAPTER_UNQUALIFIED.*launcher.*MCP worker-invoke/) });
  const handler = createModelsHandler({ load: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => f.now });
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const args = ['resolve', ...Object.entries(f.request).map(([key, value]) => `--${key.replace('_', '-')}=${value}`), '--format=shell'];
  expect((await handler.execute({ args, rawArgs: ['models', ...args], cwd: f.root, frameworkRoot: process.cwd() })).exitCode).toBe(2);
  expect(stdout).not.toHaveBeenCalled();
  expect(JSON.parse(String(stderr.mock.calls.at(-1)![0]))).toMatchObject({ status: 'blocked', diagnostics: [{
    code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/request/format', message: expect.stringMatching(/launcher.*JSON plan.*MCP worker-invoke/),
  }] });
  expect(await readdir(f.cwd)).toEqual([]);
});

it('T-OG-15 derived prompts are reserved before staging, including concurrent resolves with distinct outputs', async () => {
  const f = await fixture('brief-text'), plan = await f.resolve();
  const i = plan.invocation!;
  // Extract the real renderer's guard binding, without executing its stage command.
  const binding = JSON.parse(i.shellCommand!.match(/'\{"request"[\s\S]*?\}'(?= &&)/)![0].slice(1, -1).replaceAll("'\"'\"'", "'"));
  expect(binding.paths.workerBrief).toBe(`${f.finalPath}.worker-brief`);
  const other = structuredClone(binding); other.request.task = 'bugfix';
  for (const key of ['final', 'stdout', 'stderr']) other.paths[key] += '.other';
  const results = await Promise.allSettled([reserveShellWorkerCapture(binding), reserveShellWorkerCapture(other)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  await expect(readFile(binding.paths.workerBrief)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(`${binding.paths.workerBrief}.launch-owner`, 'utf8')).invocationId).toBeTruthy();
});

it.each(['file', 'reservation'])('T-OG-15 an existing prompt %s refuses at the guard before staging or output reservations', async kind => {
  const f = await fixture('brief-text'), plan = await f.resolve();
  const filename = `${f.finalPath}.worker-brief${kind === 'reservation' ? '.launch-owner' : ''}`;
  await writeFile(filename, 'retained');
  await expect(execute('/bin/sh', ['-c', plan.invocation!.shellCommand!], { timeout: 5000, env: { AIWG_RESOLVE_IMPL_FROM: 'dist' } }))
    .rejects.toMatchObject({ stderr: expect.stringMatching(/Worker shell handoff refused:/) });
  expect(await readFile(filename, 'utf8')).toBe('retained');
  await expect(readFile(`${f.finalPath}.launch-owner`)).rejects.toMatchObject({ code: 'ENOENT' });
});
