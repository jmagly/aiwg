/**
 * Unit tests for External Ralph Loop Recovery Engine
 *
 * @source @tools/ralph-external/recovery-engine.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';

// Import the module under test
// @ts-ignore - ESM import
import { RecoveryEngine } from '../../../tools/ralph-external/recovery-engine.mjs';
// @ts-ignore - ESM import
import { StateManager } from '../../../tools/ralph-external/state-manager.mjs';

describe('RecoveryEngine', () => {
  let testDir: string;
  let recoveryEngine: InstanceType<typeof RecoveryEngine>;
  let stateManager: InstanceType<typeof StateManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ralph-external-recovery-test-'));
    recoveryEngine = new RecoveryEngine(testDir);
    stateManager = new StateManager(testDir);
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    if (testDir) expect(existsSync(testDir)).toBe(false);
  });

  describe('constructor', () => {
    it('should initialize with project root', () => {
      expect(recoveryEngine.projectRoot).toBe(testDir);
    });

    it('should create state manager', () => {
      expect(recoveryEngine.stateManager).toBeDefined();
    });

    it('should set internal ralph state path', () => {
      expect(recoveryEngine.internalRalphStatePath).toContain('.aiwg');
      expect(recoveryEngine.internalRalphStatePath).toContain('ralph');
    });
  });

  describe('readInternalRalphState', () => {
    it('should return null when no internal state exists', () => {
      expect(recoveryEngine.readInternalRalphState()).toBeNull();
    });

    it('should return parsed state when file exists', () => {
      const internalRalphDir = join(testDir, '.aiwg', 'ralph');
      mkdirSync(internalRalphDir, { recursive: true });
      writeFileSync(
        join(internalRalphDir, 'current-loop.json'),
        JSON.stringify({ active: true, task: 'Fix tests' })
      );

      const state = recoveryEngine.readInternalRalphState();
      expect(state).toEqual({ active: true, task: 'Fix tests' });
    });

    it('should return null when file is corrupted', () => {
      const internalRalphDir = join(testDir, '.aiwg', 'ralph');
      mkdirSync(internalRalphDir, { recursive: true });
      writeFileSync(join(internalRalphDir, 'current-loop.json'), 'not json');

      expect(recoveryEngine.readInternalRalphState()).toBeNull();
    });
  });

  describe('checkpoint recovery', () => {
    const loopId = 'checkpoint-loop';
    const paths = () => {
      const loopDir = join(testDir, '.aiwg', 'ralph', 'loops', loopId);
      return { checkpointDir: join(loopDir, 'checkpoints'), stateFile: join(loopDir, 'state.json') };
    };
    const checkpoint = (id: string, state: object) => {
      const { checkpointDir } = paths();
      mkdirSync(checkpointDir, { recursive: true });
      const file = join(checkpointDir, `${id}.json.gz`);
      writeFileSync(file, gzipSync(JSON.stringify(state)));
      return file;
    };

    it('should return no latest checkpoint for absent, empty or ineligible directories', () => {
      expect(recoveryEngine.getLatestCheckpoint(loopId)).toBeNull();
      mkdirSync(paths().checkpointDir, { recursive: true });
      expect(recoveryEngine.getLatestCheckpoint(loopId)).toBeNull();
      writeFileSync(join(paths().checkpointDir, 'notes.txt'), 'not a checkpoint');
      writeFileSync(join(paths().checkpointDir, 'invalid.json.gz'), 'not a named checkpoint');
      expect(recoveryEngine.getLatestCheckpoint(loopId)).toBeNull();
    });

    it('should select the highest numeric timestamp rather than filename or iteration order', () => {
      checkpoint('checkpoint-90-9', { marker: 'older' });
      const latestPath = checkpoint('checkpoint-2-100', { marker: 'newest' });
      checkpoint('checkpoint-3-20', { marker: 'middle' });
      expect(recoveryEngine.getLatestCheckpoint(loopId)).toEqual({
        checkpointId: 'checkpoint-2-100', path: latestPath, iteration: 2, timestamp: 100,
      });
    });

    it('should restore an explicitly selected checkpoint and leave other loop state untouched', () => {
      const selected = { objective: 'Selected', currentIteration: 2, status: 'paused', nested: { value: 7 } };
      checkpoint('checkpoint-2-100', selected);
      checkpoint('checkpoint-3-200', { objective: 'Unselected' });
      writeFileSync(paths().stateFile, JSON.stringify({ objective: 'Old primary' }));
      const otherDir = join(testDir, '.aiwg', 'ralph', 'loops', 'other-loop');
      mkdirSync(otherDir, { recursive: true });
      const otherFile = join(otherDir, 'state.json');
      writeFileSync(otherFile, '{"objective":"Other loop"}');

      expect(recoveryEngine.restoreFromCheckpoint(loopId, 'checkpoint-2-100')).toEqual(selected);
      expect(JSON.parse(readFileSync(paths().stateFile, 'utf8'))).toEqual(selected);
      expect(readFileSync(otherFile, 'utf8')).toBe('{"objective":"Other loop"}');
    });

    it('should restore and persist the latest checkpoint when no ID is provided', () => {
      checkpoint('checkpoint-90-9', { marker: 'older' });
      const newest = { marker: 'newest', iterations: [1, 2] };
      checkpoint('checkpoint-2-100', newest);
      expect(recoveryEngine.restoreFromCheckpoint(loopId)).toEqual(newest);
      expect(JSON.parse(readFileSync(paths().stateFile, 'utf8'))).toEqual(newest);
    });

    it('should reject restoration when the checkpoint directory is absent', () => {
      expect(() => recoveryEngine.restoreFromCheckpoint(loopId)).toThrow(`No checkpoints found for loop ${loopId}`);
      expect(existsSync(paths().stateFile)).toBe(false);
    });

    it('should reject a missing explicit checkpoint and preserve existing state', () => {
      mkdirSync(paths().checkpointDir, { recursive: true });
      writeFileSync(paths().stateFile, 'previous state bytes');
      expect(() => recoveryEngine.restoreFromCheckpoint(loopId, 'checkpoint-1-10'))
        .toThrow('Checkpoint checkpoint-1-10 not found');
      expect(readFileSync(paths().stateFile, 'utf8')).toBe('previous state bytes');
    });

    it('should reject restoration without eligible checkpoints', () => {
      mkdirSync(paths().checkpointDir, { recursive: true });
      writeFileSync(join(paths().checkpointDir, 'notes.txt'), 'not a checkpoint');
      expect(() => recoveryEngine.restoreFromCheckpoint(loopId)).toThrow(`No checkpoints available for loop ${loopId}`);
      expect(existsSync(paths().stateFile)).toBe(false);
    });

    it.each([
      ['invalid gzip', Buffer.from('not gzip')],
      ['invalid JSON', gzipSync('not JSON')],
    ])('should preserve the primary when decoding %s fails', (_name, payload) => {
      mkdirSync(paths().checkpointDir, { recursive: true });
      writeFileSync(paths().stateFile, 'previous state bytes');
      writeFileSync(join(paths().checkpointDir, 'checkpoint-1-10.json.gz'), payload);
      expect(() => recoveryEngine.restoreFromCheckpoint(loopId, 'checkpoint-1-10')).toThrow();
      expect(readFileSync(paths().stateFile, 'utf8')).toBe('previous state bytes');
    });
  });

  describe('isProcessAlive', () => {
    it.each([null, undefined, 0, -1])('should skip controlled process check for invalid PID %s', pid => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        expect(recoveryEngine.isProcessAlive(pid)).toBe(false);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    });

    it('should use signal zero for a successful controlled process check', () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        expect(recoveryEngine.isProcessAlive(12345)).toBe(true);
        expect(kill.mock.calls).toEqual([[12345, 0]]);
      } finally {
        kill.mockRestore();
      }
    });

    it.each([
      ['ESRCH', false],
      ['EPERM', true],
      ['EINVAL', false],
    ] as const)('should classify %s from a controlled process check', (code, expected) => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('controlled process error'), { code });
      });
      try {
        expect(recoveryEngine.isProcessAlive(12345)).toBe(expected);
        expect(kill.mock.calls).toEqual([[12345, 0]]);
      } finally {
        kill.mockRestore();
      }
    });

    it('should return false for null pid', () => {
      expect(recoveryEngine.isProcessAlive(null)).toBe(false);
    });

    it('should return false for undefined pid', () => {
      expect(recoveryEngine.isProcessAlive(undefined)).toBe(false);
    });

    it('should return false for non-existent pid', () => {
      // Use a very high PID that likely doesn't exist
      expect(recoveryEngine.isProcessAlive(999999999)).toBe(false);
    });

    it('should return true for current process', () => {
      // Current process is always alive
      expect(recoveryEngine.isProcessAlive(process.pid)).toBe(true);
    });
  });

  describe('detectCrashedLoops', () => {
    it('should return no crashes for absent or empty loop roots without checking processes', () => {
      const alive = vi.spyOn(recoveryEngine, 'isProcessAlive');
      try {
        expect(recoveryEngine.detectCrashedLoops()).toEqual([]);
        mkdirSync(join(testDir, '.aiwg', 'ralph', 'loops'), { recursive: true });
        expect(recoveryEngine.detectCrashedLoops()).toEqual([]);
        expect(alive).not.toHaveBeenCalled();
      } finally {
        alive.mockRestore();
      }
    });

    it('should find only dead running loops and corrupt state in a mixed directory', () => {
      const loopsDir = join(testDir, '.aiwg', 'ralph', 'loops');
      const entries = [
        ['dead', { status: 'running', currentPid: 101 }],
        ['live', { status: 'running', currentPid: 202 }],
        ['completed', { status: 'completed', currentPid: 303 }],
        ['no-pid', { status: 'running' }],
        ['null-pid', { status: 'running', currentPid: null }],
      ] as const;
      for (const [id, state] of entries) {
        mkdirSync(join(loopsDir, id), { recursive: true });
        writeFileSync(join(loopsDir, id, 'state.json'), JSON.stringify(state));
      }
      mkdirSync(join(loopsDir, 'corrupt'));
      writeFileSync(join(loopsDir, 'corrupt', 'state.json'), 'not JSON');
      mkdirSync(join(loopsDir, 'missing-state'));
      writeFileSync(join(loopsDir, 'ordinary-file'), 'not a loop directory');
      const alive = vi.spyOn(recoveryEngine, 'isProcessAlive').mockImplementation(pid => {
        if (pid === 101) return false;
        if (pid === 202) return true;
        throw new Error(`Unexpected PID check: ${pid}`);
      });
      try {
        expect(recoveryEngine.detectCrashedLoops().sort()).toEqual(['corrupt', 'dead']);
        expect(alive.mock.calls.map(([pid]) => pid).sort()).toEqual([101, 202]);
      } finally {
        alive.mockRestore();
      }
    });
  });

  describe('detectCrash', () => {
    it('should return not crashed when no state', () => {
      expect(recoveryEngine.detectCrash()).toEqual({ crashed: false });
    });

    it('should return not crashed when status is completed', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });
      stateManager.update({ status: 'completed' });

      expect(recoveryEngine.detectCrash()).toEqual({ crashed: false });
    });

    it('should return crashed when running but process is dead', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });
      stateManager.update({
        status: 'running',
        currentIteration: 2,
        currentPid: 999999999, // Non-existent PID
      });

      const result = recoveryEngine.detectCrash();
      expect(result.crashed).toBe(true);
      expect(result.iteration).toBe(2);
      expect(result.lastCheckpoint).toBe('iteration-2');
      expect(result.recoveryStrategy).toBeDefined();
    });

    it('should return not crashed when running and process is alive', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });
      stateManager.update({
        status: 'running',
        currentPid: process.pid, // Current process is alive
      });

      expect(recoveryEngine.detectCrash()).toEqual({ crashed: false });
    });
  });

  describe('determineRecoveryStrategy', () => {
    it('should suggest resume_internal when internal Ralph is active', () => {
      // Create internal Ralph state
      const internalRalphDir = join(testDir, '.aiwg', 'ralph');
      mkdirSync(internalRalphDir, { recursive: true });
      writeFileSync(
        join(internalRalphDir, 'current-loop.json'),
        JSON.stringify({ active: true, task: 'Fix tests', currentIteration: 3 })
      );

      const state = stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });

      const strategy = recoveryEngine.determineRecoveryStrategy(state);
      expect(strategy.type).toBe('resume_internal');
      expect(strategy.action).toContain('Resume internal Ralph');
      expect(strategy.prompt).toContain('/ralph-status');
      expect(strategy.prompt).toContain('Task: Fix tests');
      expect(strategy.prompt).toContain(state.loopId);
    });

    it('should suggest continue_external when analysis says continue', () => {
      const state = stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });

      stateManager.addIteration({
        number: 1,
        analysis: {
          shouldContinue: true,
          completionPercentage: 50,
          learnings: 'Made progress',
          nextApproach: 'Continue',
        },
      } as any);

      const updatedState = stateManager.load()!;
      const strategy = recoveryEngine.determineRecoveryStrategy(updatedState);
      expect(strategy.type).toBe('continue_external');
      expect(strategy.action).toContain('Continue');
      expect(strategy.prompt).toContain('Made progress');
      expect(strategy.prompt).toContain('50%');
      expect(strategy.prompt).toContain(updatedState.loopId);
    });

    it('should suggest restart when no other options', () => {
      const state = stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });

      const strategy = recoveryEngine.determineRecoveryStrategy(state);
      expect(strategy.type).toBe('restart');
      expect(strategy.action).toContain('Restart');
      expect(strategy.prompt).toContain(state.loopId);
      expect(strategy.prompt).toContain('Completion Criteria: Done');
    });

    it('should prioritize active internal recovery over external continuation', () => {
      const state = stateManager.initialize({ objective: 'Priority fixture', completionCriteria: 'Done' });
      mkdirSync(join(testDir, '.aiwg', 'ralph'), { recursive: true });
      writeFileSync(join(testDir, '.aiwg', 'ralph', 'current-loop.json'), JSON.stringify({ active: true, task: 'Internal priority' }));
      state.iterations = [{ analysis: { shouldContinue: true, learnings: 'External lower priority' } }];
      const strategy = recoveryEngine.determineRecoveryStrategy(state);
      expect(strategy.type).toBe('resume_internal');
      expect(strategy.prompt).toContain('Task: Internal priority');
      expect(strategy.prompt).not.toContain('External lower priority');
    });

    it('should use the latest analysis rather than an older continuation decision', () => {
      const state = stateManager.initialize({ objective: 'Latest decision', completionCriteria: 'Done' });
      state.iterations = [
        { analysis: { shouldContinue: true, learnings: 'Obsolete continuation' } },
        { analysis: { shouldContinue: false } },
      ];
      const strategy = recoveryEngine.determineRecoveryStrategy(state);
      expect(strategy.type).toBe('restart');
      expect(strategy.prompt).toContain('Latest decision');
      expect(strategy.prompt).not.toContain('Obsolete continuation');
    });
  });

  describe('buildInternalResumePrompt', () => {
    it('should include external loop context', () => {
      const externalState = {
        loopId: 'ext-123',
        currentIteration: 2,
        objective: 'Fix bugs',
        accumulatedLearnings: 'Found root cause',
      };
      const internalState = { currentIteration: 5, task: 'Refactor' };

      const prompt = recoveryEngine.buildInternalResumePrompt(externalState, internalState);

      expect(prompt).toContain('ext-123');
      expect(prompt).toContain('Fix bugs');
      expect(prompt).toContain('/ralph-status');
      expect(prompt).toContain('/ralph-resume');
      expect(prompt).toContain('Found root cause');
      expect(prompt).toContain('External Iteration: 2');
      expect(prompt).toContain('Internal Iteration: 5');
      expect(prompt).toContain('Task: Refactor');
    });

    it('should provide internal defaults when optional state is absent', () => {
      const prompt = recoveryEngine.buildInternalResumePrompt({ loopId: 'fallback', currentIteration: 1, objective: 'Use external objective' }, {});
      expect(prompt).toContain('Internal Iteration: unknown');
      expect(prompt).toContain('Task: Use external objective');
      expect(prompt).toContain('None recorded');
      expect(prompt).not.toMatch(/undefined|null/);
    });
  });

  describe('buildContinuationPrompt', () => {
    it('should include state context', () => {
      const state = {
        loopId: 'loop-456',
        objective: 'Add feature',
        completionCriteria: 'Tests pass',
      };
      const lastAnalysis = {
        completionPercentage: 75,
        learnings: 'Almost done',
        nextApproach: 'Fix last test',
        blockers: ['Flaky test'],
      };

      const prompt = recoveryEngine.buildContinuationPrompt(state, lastAnalysis);

      expect(prompt).toContain('loop-456');
      expect(prompt).toContain('Add feature');
      expect(prompt).toContain('75%');
      expect(prompt).toContain('Almost done');
      expect(prompt).toContain('Fix last test');
      expect(prompt).toContain('Flaky test');
      expect(prompt).toContain('Tests pass');
    });

    it('should provide continuation defaults without analysis', () => {
      const prompt = recoveryEngine.buildContinuationPrompt({ loopId: 'fallback', objective: 'Keep working', completionCriteria: 'All checks pass' }, undefined);
      for (const expected of ['fallback', 'Keep working', 'All checks pass', 'Progress: 0%', 'No learnings recorded', 'Continue with accumulated context', 'None identified']) {
        expect(prompt).toContain(expected);
      }
      expect(prompt).not.toMatch(/undefined|null/);
    });
  });

  describe('buildRestartPrompt', () => {
    it('should include accumulated learnings', () => {
      const state = {
        loopId: 'loop-789',
        objective: 'Migrate database',
        completionCriteria: 'Migration completes',
        currentIteration: 3,
        accumulatedLearnings: 'Backup first',
        filesModified: ['db/schema.sql', 'migrations/001.sql'],
      };

      const prompt = recoveryEngine.buildRestartPrompt(state);

      expect(prompt).toContain('loop-789');
      expect(prompt).toContain('Migrate database');
      expect(prompt).toContain('Previous Iterations: 3');
      expect(prompt).toContain('Backup first');
      expect(prompt).toContain('db/schema.sql');
      expect(prompt).toContain('migrations/001.sql');
      expect(prompt).toContain('Migration completes');
      expect(prompt).toContain('/ralph');
    });
  });

  describe('notifyCrash', () => {
    it('should create and append timestamped diagnostics without changing sibling logs', () => {
      const target = join(testDir, '.aiwg', 'ralph', 'loops', 'target');
      const sibling = join(testDir, '.aiwg', 'ralph', 'loops', 'sibling');
      mkdirSync(target, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'crash.log'), 'sibling history');
      const output = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const first = new Error('first failure');
        first.stack = 'Error: first failure\n    at first-fixture';
        vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
        recoveryEngine.notifyCrash('target', first);
        const firstEntry = '[2026-09-10T12:00:00.000Z] first failure\nError: first failure\n    at first-fixture\n\n';
        expect(readFileSync(join(target, 'crash.log'), 'utf8')).toBe(firstEntry);

        const second = new Error('second failure');
        second.stack = 'Error: second failure\n    at second-fixture';
        vi.setSystemTime(new Date('2026-09-10T12:00:01.234Z'));
        recoveryEngine.notifyCrash('target', second);
        expect(readFileSync(join(target, 'crash.log'), 'utf8')).toBe(
          firstEntry + '[2026-09-10T12:00:01.234Z] second failure\nError: second failure\n    at second-fixture\n\n'
        );
        expect(readFileSync(join(sibling, 'crash.log'), 'utf8')).toBe('sibling history');
        expect(output.mock.calls).toEqual([
          ['[Recovery] Loop target crashed: first failure'],
          ['[Recovery] Loop target crashed: second failure'],
        ]);
      } finally {
        vi.useRealTimers();
        output.mockRestore();
      }
    });

    it.each(['missing-parent', 'directory-at-log'])('should still report when logging fails for %s', obstruction => {
      const logPath = join(testDir, '.aiwg', 'ralph', 'loops', 'target', 'crash.log');
      if (obstruction === 'directory-at-log') {
        mkdirSync(logPath, { recursive: true });
        writeFileSync(join(logPath, 'sentinel'), 'preserve');
      }
      const output = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => recoveryEngine.notifyCrash('target', new Error('report despite log failure'))).not.toThrow();
        expect(output.mock.calls).toEqual([['[Recovery] Loop target crashed: report despite log failure']]);
        if (obstruction === 'directory-at-log') {
          expect(readFileSync(join(logPath, 'sentinel'), 'utf8')).toBe('preserve');
        } else {
          expect(existsSync(join(testDir, '.aiwg'))).toBe(false);
        }
      } finally {
        output.mockRestore();
      }
    });
  });

  describe('per-loop recovery lifecycle', () => {
    const stateFile = (id: string) => join(testDir, '.aiwg', 'ralph', 'loops', id, 'state.json');
    const putState = (id: string, state: object) => {
      mkdirSync(join(testDir, '.aiwg', 'ralph', 'loops', id), { recursive: true });
      writeFileSync(stateFile(id), JSON.stringify(state));
    };
    const runningState = () => ({
      loopId: 'target', status: 'running', currentPid: null, currentIteration: 7,
      objective: 'Recover selected loop', completionCriteria: 'State preserved',
      iterations: [], accumulatedLearnings: 'Keep context', filesModified: ['one.ts'],
    });

    it('should not recover or create missing scoped state', () => {
      expect(recoveryEngine.detectCrash('missing')).toEqual({ crashed: false });
      expect(recoveryEngine.recoverLoop('missing')).toBeNull();
      expect(recoveryEngine.recover('missing')).toBeNull();
      expect(() => recoveryEngine.markRecovered('missing')).not.toThrow();
      expect(existsSync(join(testDir, '.aiwg'))).toBe(false);
    });

    it('should preserve corrupt scoped state when detection cannot parse it', () => {
      putState('target', {});
      writeFileSync(stateFile('target'), 'broken JSON');
      expect(recoveryEngine.detectCrash('target')).toEqual({ crashed: false });
      expect(recoveryEngine.recoverLoop('target')).toBeNull();
      expect(readFileSync(stateFile('target'), 'utf8')).toBe('broken JSON');
    });

    it.each(['completed', 'running'])('should leave non-crashed %s state byte-identical', status => {
      putState('target', { ...runningState(), status, currentPid: process.pid });
      const original = readFileSync(stateFile('target'), 'utf8');
      expect(recoveryEngine.detectCrash('target')).toEqual({ crashed: false });
      expect(recoveryEngine.recoverLoop('target')).toBeNull();
      recoveryEngine.markRecovered('target');
      expect(readFileSync(stateFile('target'), 'utf8')).toBe(original);
    });

    it.each([undefined, 4])('should persist isolated recovery with previous attempts %s', attempts => {
      const initial = { ...runningState(), ...(attempts === undefined ? {} : { recoveryAttempts: attempts }) };
      putState('target', initial);
      putState('sibling', { status: 'recovering', marker: 'untouched' });
      stateManager.initialize({ objective: 'Default stays separate', completionCriteria: 'Unchanged' });
      const sibling = readFileSync(stateFile('sibling'), 'utf8');
      const defaultBefore = stateManager.load();
      const crash = recoveryEngine.detectCrash('target');
      expect(crash).toMatchObject({ crashed: true, iteration: 7, lastCheckpoint: 'iteration-7', recoveryStrategy: { type: 'restart' } });
      expect(crash.recoveryStrategy.prompt).toContain('Recover selected loop');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-10T12:34:56.789Z'));
      try {
        const options = { reason: 'test recovery' };
        const expected = { ...initial, status: 'recovering', recoveryAttempts: (attempts ?? 0) + 1, lastRecoveryAt: '2026-09-10T12:34:56.789Z' };
        const result = recoveryEngine.recoverLoop('target', options);
        expect(result).toEqual({ loopId: 'target', state: expected, strategy: crash.recoveryStrategy, options });
        expect(JSON.parse(readFileSync(stateFile('target'), 'utf8'))).toEqual(expected);
        recoveryEngine.markRecovered('target');
        expect(JSON.parse(readFileSync(stateFile('target'), 'utf8'))).toEqual({ ...expected, status: 'running' });
        expect(readFileSync(stateFile('sibling'), 'utf8')).toBe(sibling);
        expect(stateManager.load()).toEqual(defaultBefore);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should dispatch recover by ID and use default recovery options', () => {
      putState('target', runningState());
      const result = recoveryEngine.recover('target');
      expect(result).toMatchObject({ loopId: 'target', options: {}, state: { status: 'recovering', recoveryAttempts: 1 }, strategy: { type: 'restart' } });
      expect(JSON.parse(readFileSync(stateFile('target'), 'utf8'))).toEqual(result.state);
      expect(stateManager.load()).toBeNull();
    });
  });

  describe('recover', () => {
    it('should return null when no crash detected', () => {
      expect(recoveryEngine.recover()).toBeNull();
    });

    it('should return recovery context when crash detected', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });
      stateManager.update({
        status: 'running',
        currentIteration: 2,
        currentPid: 999999999,
      });

      const before = structuredClone(stateManager.load()!);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-09-10T12:00:00.123Z'));
        const expected = { ...before, status: 'recovering', lastUpdate: '2026-09-10T12:00:00.123Z' };
        const recovery = recoveryEngine.recover();
        expect(recovery?.state).toEqual(expected);
        expect(stateManager.load()).toEqual(expected);
        expect(recovery?.strategy.type).toBe('restart');
        expect(recovery?.strategy.action).toContain('Restart');
        expect(recovery?.strategy.prompt).toContain(before.loopId);
        expect(recovery?.strategy.prompt).toContain('Objective: Test');
        expect(recovery?.strategy.prompt).toContain('Completion Criteria: Done');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('markRecovered', () => {
    it('should update status to running', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });
      stateManager.update({ status: 'recovering' });
      const before = structuredClone(stateManager.load()!);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-09-10T12:00:02.345Z'));
        recoveryEngine.markRecovered();
        expect(stateManager.load()).toEqual({ ...before, status: 'running', lastUpdate: '2026-09-10T12:00:02.345Z' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not change status if not recovering', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'Done',
      });
      stateManager.update({ status: 'completed' });
      const before = structuredClone(stateManager.load()!);
      recoveryEngine.markRecovered();
      expect(stateManager.load()).toEqual(before);
    });

    it('should handle no state', () => {
      expect(() => recoveryEngine.markRecovered()).not.toThrow();
    });
  });
});
