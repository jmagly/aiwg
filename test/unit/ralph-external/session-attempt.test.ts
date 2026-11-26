import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProvider, ensureProvidersRegistered } from '../../../tools/ralph-external/lib/provider-adapter.mjs';
import { prepareNativeAttempt, finishNativeAttempt } from '../../../tools/ralph-external/lib/session-attempt.mjs';
import { launchRalphCycle } from '../../../tools/ralph-external/lib/ralph-cycle-launch.mjs';
import { StateManager } from '../../../tools/ralph-external/state-manager.mjs';
import { CheckpointManager } from '../../../tools/ralph-external/checkpoint-manager.mjs';

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ralph-attempt-'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  await ensureProvidersRegistered();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const bindings = { provider: 'synthetic', model: 'synthetic/model', policyDigest: 'synthetic-policy', sessionId: 'native-session' };

describe('T-OG-03/08/13 native Ralph continuation', () => {
  it.each(['claude', 'codex', 'muse', 'opencode', 'factory', 'pi', 'omp', 'deepseek-harness'])(
    '%s classifies continuation using its declared capability', name => {
      const adapter = createProvider(name);
      const result = adapter.classifySessionAttempt({ sessionId: 'native-session', original: bindings, current: bindings });
      expect(result.kind).toBe(adapter.hasCapability('sessionResume') ? 'continuation' : 'fresh');
      if (result.kind === 'fresh') expect(result.reason).toBe('resume-unsupported');
    });

  it.each([null, '', 'bad\nsession', '--injection', 'a'.repeat(257)])('uses a fresh attempt for invalid session %j', sessionId => {
    expect(createProvider('claude').classifySessionAttempt({ sessionId, original: bindings, current: bindings }).kind).toBe('fresh');
  });

  it.each(['policyDigest', 'model', 'sessionId', 'provider'])('discloses changed %s before refusing native continuation', key => {
    const current = { ...bindings, [key]: 'changed' };
    expect(createProvider('claude').classifySessionAttempt({ sessionId: 'native-session', original: bindings, current }))
      .toMatchObject({ kind: 'fresh', reason: 'bindings-changed', changes: [{ binding: key, previous: bindings[key as keyof typeof bindings], current: 'changed' }] });
  });

  function fixture(provider: string) {
    const stateManager = new StateManager(root);
    const state = stateManager.initialize({ provider, model: 'synthetic/model', maxIterations: 3 });
    const adapter = createProvider(provider);
    const owner = { stateManager, providerAdapter: adapter, projectRoot: root, sessionLauncher: { launch: vi.fn() } };
    const options = { model: 'sonnet', budget: 1, workingDir: root, outputDir: root };
    return { state, owner, options };
  }

  it('re-resolves Codex on each fresh bounded cycle and persists the reason through reload', async () => {
    const { state, owner } = fixture('codex');
    state.currentIteration = 1;
    state.config.enableCheckpoints = false;
    const map = vi.spyOn(owner.providerAdapter, 'mapModel');
    owner.sessionLauncher.launch.mockImplementation(async () => ({ exitCode: 0, timedOut: false, stdoutBuffer: '' }));
    const call = { prompt: 'synthetic', outputPaths: { stdout: join(root, 'stdout'), stderr: join(root, 'stderr') },
      iterationDir: root, timeoutMs: 1234 };
    const first = await launchRalphCycle(owner, state, call);
    state.currentIteration++;
    const second = await launchRalphCycle(owner, state, call);
    expect(map).toHaveBeenCalledTimes(2);
    expect(first.attempt.kind).toBe('fresh');
    expect(second.attempt).toMatchObject({ kind: 'fresh', reason: 'resume-unsupported', previousAttemptId: first.attempt.attemptId });
    expect(owner.sessionLauncher.launch.mock.calls[1][0]).toMatchObject({ sessionId: null, resumeSession: null, timeoutMs: 1234 });
    expect(owner.stateManager.load().currentAttempt).toEqual(second.attempt);
    expect(JSON.parse(readFileSync(join(root, 'session-attempt.json'), 'utf8'))).toEqual(second.attempt);
  });

  it('continues a successful bound session and uses Claude resume argv', () => {
    const { state, owner, options } = fixture('claude');
    const first = prepareNativeAttempt(owner, state, options);
    finishNativeAttempt(owner, state, first, { exitCode: 0, stdoutBuffer: '' });
    const second = prepareNativeAttempt(owner, state, options);
    expect(second.attempt.kind).toBe('continuation');
    const argv = owner.providerAdapter.buildSessionArgs({ ...second, prompt: 'synthetic' });
    expect(argv).toContain('--resume'); expect(argv).not.toContain('--session-id');
    expect(argv[argv.indexOf('--resume') + 1]).toBe(first.sessionId);
    finishNativeAttempt(owner, state, second, { exitCode: 1 });
    expect(prepareNativeAttempt(owner, state, options).attempt.reason).toBe('invalid-session');
  });

  it('does not mistake a tracking UUID for an OMP native session', () => {
    const { state, owner, options } = fixture('omp');
    const first = prepareNativeAttempt(owner, state, options);
    expect(first.sessionId).toBeNull();
    finishNativeAttempt(owner, state, first, { exitCode: 0, stdoutBuffer: JSON.stringify({ sessionId: 'native-omp' }) });
    expect(prepareNativeAttempt(owner, state, options)).toMatchObject({ resumeSession: 'native-omp', attempt: { kind: 'continuation' } });
  });

  it.each([
    ['pi', { type: 'session', id: 'pi-native' }],
    ['opencode', { type: 'step_start', sessionID: 'opencode-native' }],
  ])('uses the existing %s event grammar to bind a reported native session', (provider, event) => {
    const { state, owner, options } = fixture(provider as string);
    const first = prepareNativeAttempt(owner, state, options);
    expect(first.sessionId).toBeNull();
    finishNativeAttempt(owner, state, first, { exitCode: 0, stdoutBuffer: JSON.stringify(event) });
    expect(prepareNativeAttempt(owner, state, options).attempt.kind).toBe('continuation');
  });

  it('invalidates conflicting provider session evidence and failed launches', async () => {
    const { state, owner, options } = fixture('muse');
    const first = prepareNativeAttempt(owner, state, options);
    finishNativeAttempt(owner, state, first, { exitCode: 0,
      stdoutBuffer: '{"sessionId":"one"}\n{"sessionId":"two"}' });
    expect(state.sessionBinding.valid).toBe(false);
    expect(prepareNativeAttempt(owner, state, options).attempt.reason).toBe('invalid-session');
    state.sessionBinding.valid = true;
    state.config.enableCheckpoints = false;
    owner.sessionLauncher.launch.mockRejectedValue(new Error('synthetic spawn failure'));
    await expect(launchRalphCycle(owner, state, { prompt: 'synthetic',
      outputPaths: { stdout: join(root, 'stdout'), stderr: join(root, 'stderr') },
      iterationDir: root, timeoutMs: 1 })).rejects.toThrow(/synthetic spawn failure/);
    expect(owner.stateManager.load().sessionBinding.valid).toBe(false);
  });

  it('records changed assumptions in checkpoints before a replacement launch', () => {
    const { state, owner, options } = fixture('muse');
    const first = prepareNativeAttempt(owner, state, options);
    finishNativeAttempt(owner, state, first, { exitCode: 0 });
    const next = prepareNativeAttempt(owner, state, { ...options, budget: 2 });
    expect(next.attempt).toMatchObject({ kind: 'fresh', reason: 'bindings-changed', changes: [{ binding: 'policyDigest' }] });
    const checkpoints = new CheckpointManager({ stateDir: root, projectRoot: root, attempt: next.attempt });
    vi.spyOn(checkpoints, 'captureGitStatus').mockReturnValue({ modified: [], untracked: [], staged: [] });
    vi.spyOn(checkpoints, 'captureAiwgState').mockReturnValue({ files: [], sizes: {} });
    checkpoints.ensureCheckpointsDir();
    expect(checkpoints.captureCheckpoint(1).attempt).toEqual(next.attempt);
  });
});
