/** #3657: offline Codex final-file separation through the real resolver and launcher (T-OG-15, partial). */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { rm } from '../../helpers/worker-capture-cleanup.mjs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { CodexAdapter } from '../../../tools/ralph-external/lib/codex-adapter.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(scenario = 'structured-final-with-prose', writeProseFinal = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-codex-final-')); roots.push(root);
  const cwd = path.join(root, 'worker'); await mkdir(cwd);
  const brief = path.join(cwd, 'brief.md'), final = path.join(cwd, "final '雪\n.json");
  await writeFile(brief, `Write workerClaims JSON to ${final}. Report a brief prose summary afterward.`);
  const config = path.join(root, 'fake.json');
  const recordPath = path.join(root, 'received.json');
  await writeFile(config, JSON.stringify({ scenario, structuredFinalPath: final, writeProseFinal, recordPath }));
  vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', config);
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const f = workerResolutionFixture(), owner = new CodexAdapter();
  const adapter = structuredClone(loadProviderModelCapabilities().providers.codex.workerHealthAdapter!);
  adapter.qualification = f.snapshot.registry.providers.codex.workerAdapter!.qualification;
  const profile = adapter.invocationProfiles!['direct-shell'];
  for (const control of Object.values(profile.controls)) control.support = 'native';
  adapter.capabilities = { ...f.snapshot.registry.providers.codex.workerAdapter!.capabilities, output: 'validated-file' };
  profile.envAllowlist = adapter.invocation.envAllowlist = ['PATH', 'AIWG_FAKE_WORKER_CONFIG'];
  f.snapshot.registry.providers.codex.workerAdapter = adapter;
  f.snapshot.installations.codex = { ...f.snapshot.installations.codex, cliVersion: '0.161.0', profile: 'direct-shell' };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.runtimeVersion = '0.161.0';
  for (const model of discovery.models) model.worker!.runtimeVersion = '0.161.0';
  const drivers: Record<string, WorkerInvocationDriver> = { codex: {
    qualification: { adapter, adapterId: 'codex', cliVersion: '0.161.0' },
    buildInvocation: async input => ({ argv: [process.execPath, path.resolve('test/fixtures/providers/codex/fake-codex.mjs'),
      ...owner.buildWorkerArgs(input, profile, input.permissions)], stdin: 'brief-text', envNames: profile.envAllowlist }),
    // Same hooks as the installed Codex driver, including strict final decoding.
    extractFinal: output => owner.parseOutput(output),
    parseWorkerFinal: (output, options) => owner.parseWorkerFinal(output, options),
  } };
  const request = { role: 'coding' as const, task: 'implementation', group: 'workers', brief, workdir: cwd, final_output: final };
  const resolve = () => resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
  const plan = await resolve();
  expect(plan.invocation, JSON.stringify(plan)).toBeDefined();
  const invocationPath = path.join(root, 'plan.json'), runDir = path.join(root, 'run');
  await writeFile(invocationPath, JSON.stringify(plan));
  const launch = (extra = {}) => new SessionLauncher().launchWorker({ invocationPath, runDir,
    inputs: { snapshot: f.snapshot, drivers }, now: f.request.now, scopedBreaker: null,
    checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
    isolation: { mode: 'degraded', reason: 'synthetic local child; no systemd' }, allowDegraded: true, ...extra });
  return { final, brief, plan, request, resolve, launch, runDir, owner, recordPath };
}

describe('T-OG-15 Codex worker final versus last-message capture (partial)', () => {
  it('records the worker-written structured final after Codex captures a prose last message', async () => {
    const f = await fixture(), result: any = await f.launch({ sampleIdentity: () => null });
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeFalsy();
    const received = JSON.parse(await readFile(f.recordPath, 'utf8'));
    expect(received.prompt).toContain(JSON.stringify(f.final));
    expect(received.prompt).toContain('"version":1,"status":"completed"');
    const bytes = await readFile(f.final);
    const claims = await f.owner.parseWorkerFinal(bytes, { format: 'json',
      observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 } });
    expect(claims.status).toBe('completed');
    const evidence = JSON.parse(await readFile(path.join(f.runDir, 'final-evidence.json'), 'utf8'));
    expect(evidence).toMatchObject({ path: f.final, source: 'worker-output', terminalSuccess: true,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    const capture = `${f.final}.last-message`;
    expect(await readFile(capture, 'utf8')).toMatch(/^Completed the requested work\./);
    const invocation = JSON.parse(await readFile(path.join(f.runDir, 'invocation.json'), 'utf8'));
    expect(invocation.paths).toMatchObject({ final: f.final, lastMessage: capture });
    // Termination is incidental to final capture here: the attached degraded
    // transport never yields a launcher-owned group identity (the sampler is
    // pinned to keep that timing-independent), so termination stays uncertain
    // for a still-valid reason — unknown ownership, not observer coverage.
    // Owned-containment confirmation is covered in worker-termination.test.mjs.
    expect(result.termination).toBe('uncertain');
  });

  it.each([false, true])('rejects prose-only completion (prose at structured path: %s)', async writeProseFinal => {
    const f = await fixture('prose-only', writeProseFinal), result: any = await f.launch();
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe('FINAL_OUTPUT_INVALID');
    await expect(f.owner.parseWorkerFinal(await readFile(f.final), { format: 'json',
      observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 } })).rejects.toThrow();
  });

  it('refuses a brief that aliases the last-message capture', async () => {
    const f = await fixture();
    f.request.brief = `${f.final}.last-message`;
    await writeFile(f.request.brief, 'The brief must survive.');
    expect((await f.resolve()).invocation).toBeUndefined();
    expect(await readFile(f.request.brief, 'utf8')).toBe('The brief must survive.');
  });

  it('refuses a symlink at the last-message capture path', async () => {
    const f = await fixture();
    await symlink(f.brief, `${f.final}.last-message`);
    expect((await f.resolve()).invocation).toBeUndefined();
    await expect(f.launch()).rejects.toMatchObject({ code: 'OG_PIN_MISMATCH' });
  });

  it('refuses a stale last-message capture before spawning', async () => {
    const f = await fixture();
    await writeFile(`${f.final}.last-message`, 'Retained capture');
    await expect(f.launch()).rejects.toThrow(/Fresh worker output/);
    expect(await readFile(`${f.final}.last-message`, 'utf8')).toBe('Retained capture');
  });
});
