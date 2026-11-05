/** Shared synthetic one-shot launcher fixture; all writes stay in os.tmpdir(). */
import { trackWorkerProcess } from './ralph-external/worker-process-inventory.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { workerResolutionFixture } from './worker-resolution.js';
import { qualificationDigest } from '../../src/models/qualification-digest.mjs';
import { resolveWorkerInvocation } from '../../src/serve/worker-invocation.js';
import { SessionLauncher } from '../../tools/ralph-external/session-launcher.mjs';
import { ScopedFailureBreaker } from '../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';

export async function workerInvocationFixture({ stdin = 'closed', scenario = 'success', stdoutOnly = false, forgeRealExitCode, semanticHealth = false, waitForIdentity = false, artifacts = [], recoveryClock = () => 0, hardTimeoutSeconds = 30 }: any = {}, { roots, breakers }: { roots: string[]; breakers: ScopedFailureBreaker[] }) {
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const f = workerResolutionFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-one-shot-')); roots.push(root);
  const runDir = path.join(root, 'run');
  const cwd = path.join(root, 'work tree'); await mkdir(cwd);
  const brief = path.join(root, 'brief.json');
  const prompt = `secret-prompt '" 雪\n$(touch ${root}/injected) --leading`;
  await writeFile(brief, prompt);
  const final = path.join(root, 'final.json');
  const configPath = path.join(root, 'fake.json');
  const recordPath = path.join(cwd, 'record.json');
  await writeFile(configPath, JSON.stringify({ scenario, recordPath, ...(waitForIdentity ? { waitForIdentity: path.join(runDir, 'process.json'), waitForIdentityMs: hardTimeoutSeconds * 1000 } : {}), ...(stdoutOnly ? { outputFlags: [] } : {}),
    ...(scenario === 'forge-exit' ? { forgeRunDir: runDir, forgeRealExitCode: forgeRealExitCode ?? 7 } : {}) }));
  vi.stubEnv('AIWG_FAKE_WORKER_CONFIG', configPath);
  vi.stubEnv('AIWG_SYNTHETIC_ALLOWED', 'secret-environment-value');
  vi.stubEnv('AIWG_UNRELATED_SECRET', 'unrelated-value');
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const profile = adapter.invocationProfiles!['fixture-shell'];
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG', 'AIWG_SYNTHETIC_ALLOWED'];
  profile.health = { version: 1, handshake: semanticHealth ? 'semantic' : 'process-only', outputFraming: 'jsonl', signalParser: 'fixture:jsonl',
    sessionLogLocator: null, progressEvidence: semanticHealth ? ['item.completed'] : [], stopEvidence: 'fixture:wait-only', fixtureRef: 'fixture:one-shot', qualifiedAt: f.request.now,
    statusOperation: null, cancelOperation: null };
  f.snapshot.config.parallelism!.health = { hardTimeoutSeconds, terminateGraceSeconds: 1 };
  const driver: any = { qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0',
    boundary: { kind: 'os', identity: 'fixture:boundary', digest: qualificationDigest('boundary'), controls: ['sandbox'] } },
    buildInvocation: async (input: any) => ({ argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'),
      '--model', input.selected.model, '--final-output', input.finalPath,
      ...(artifacts.length ? ['--generated-artifact', '${artifact:patch}'] : []), '--', prompt], stdin,
      ...(artifacts.length ? { artifacts } : {}),
      envNames: profile.envAllowlist }),
    extractFinal: (text: string) => { try { const rows = text.trim().split('\n').map(line => JSON.parse(line));
      return rows.length === 1 && rows[0].type === 'result' ? rows[0].result : null; } catch { return null; } },
  };
  const drivers = { codex: driver };
  f.snapshot.installations.codex.boundary = driver.qualification.boundary;
  const request: any = { role: 'coding', task: 'implementation', group: 'workers', brief, workdir: cwd, final_output: final };
  const plan = await resolveWorkerInvocation(f.snapshot, request, drivers, f.request.now);
  expect(plan.invocation, JSON.stringify({ diagnostics: plan.diagnostics, exclusions: plan.exclusions })).toBeDefined();
  const invocationPath = path.join(root, 'plan.json'); await writeFile(invocationPath, JSON.stringify(plan));
  const launchSpy = vi.fn();
  // Recovery scope state belongs to this test, never the process singleton.
  // The recovery clock is frozen by default: a loaded runner must not spend
  // the one-second dispatch budget on fixture preparation (#3505). Tests of
  // deadline enforcement pass their own moving clock. The execution hard
  // timeout is likewise generous unless a test exercises it (hang/deadline).
  const scopedBreaker = new ScopedFailureBreaker({ nowMs: recoveryClock }); breakers.push(scopedBreaker);
  const options: any = { invocationPath, runDir, inputs: { snapshot: f.snapshot, drivers }, now: f.request.now,
    scopedBreaker,
    checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
    isolation: { mode: 'degraded', reason: 'synthetic unavailable manager' }, allowDegraded: true };
  const launcher = new SessionLauncher(); launcher.on('launched', ({ pid }: any) => trackWorkerProcess(pid));
  const launch = (extra: any = {}) => launcher.launchWorker({ ...options, ...extra });
  return { ...f, root, cwd, brief, prompt, final, recordPath, runDir, invocationPath, plan, drivers, options, launcher, launch, launchSpy };
}

