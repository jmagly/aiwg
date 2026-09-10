/**
 * Unit tests for External Ralph Loop State Manager
 *
 * @source @tools/ralph-external/state-manager.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Import the module under test
// @ts-ignore - ESM import
import { StateManager } from '../../../tools/ralph-external/state-manager.mjs';

describe('StateManager', () => {
  let testDir: string;
  let stateManager: InstanceType<typeof StateManager>;

  beforeEach(() => {
    // Exclusive allocation establishes ownership even when clocks collide.
    testDir = mkdtempSync(join(tmpdir(), 'ralph-external-test-'));
    stateManager = new StateManager(testDir);
  });

  afterEach(() => {
    // Cleanup test directory
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    if (testDir) expect(existsSync(testDir)).toBe(false);
  });

  describe('initialize', () => {
    it('should create initial state with required fields', () => {
      const state = stateManager.initialize({
        objective: 'Fix tests',
        completionCriteria: 'npm test passes',
      });

      expect(state.version).toBe('1.0.0');
      expect(state.objective).toBe('Fix tests');
      expect(state.completionCriteria).toBe('npm test passes');
      expect(state.status).toBe('running');
      expect(state.currentIteration).toBe(0);
      expect(state.iterations).toEqual([]);
      const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(state.loopId).toMatch(uuidV4);
      expect(state.sessionId).toMatch(uuidV4);
      expect(state.loopId).not.toBe(state.sessionId);
      expect(new StateManager(testDir).load()).toMatchObject({
        loopId: state.loopId, sessionId: state.sessionId,
      });
    });

    it('should create fresh loop and session identities for each initialization', () => {
      const otherRoot = join(testDir, 'other-project');
      const first = stateManager.initialize({ objective: 'First', completionCriteria: 'done' });
      const second = new StateManager(otherRoot).initialize({ objective: 'Second', completionCriteria: 'done' });
      expect(new Set([first.loopId, first.sessionId, second.loopId, second.sessionId]).size).toBe(4);
      expect(new StateManager(testDir).load()).toMatchObject({
        loopId: first.loopId, sessionId: first.sessionId, objective: 'First',
      });
      expect(new StateManager(otherRoot).load()).toMatchObject({
        loopId: second.loopId, sessionId: second.sessionId, objective: 'Second',
      });
    });

    it('should create state directory structure', () => {
      stateManager.initialize({
        objective: 'Test task',
        completionCriteria: 'criteria',
      });

      const stateDir = join(testDir, '.aiwg', 'ralph-external');
      expect(existsSync(stateDir)).toBe(true);
      expect(existsSync(join(stateDir, 'iterations'))).toBe(true);
      expect(existsSync(join(stateDir, 'prompts'))).toBe(true);
      expect(existsSync(join(stateDir, 'outputs'))).toBe(true);
      expect(existsSync(join(stateDir, 'analysis'))).toBe(true);
    });

    it('should use default values for optional config', () => {
      const state = stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      expect(state.maxIterations).toBe(10);
      const expectedConfig = {
        provider: 'claude', model: 'opus', budgetPerIteration: 2.0,
        budgetLimits: {}, explorationQuota: { enabled: false },
        budgetStopPolicy: 'completion-wins', evalHarness: null, executionMode: 'default',
        timeoutMinutes: 60, mcpConfig: null, workingDir: testDir,
        verbose: false, checkpointIntervalMinutes: 30,
        enableCheckpoints: true, enableSnapshots: true, useClaudeAssessment: false,
        keyFiles: [], memory: 3, crossTask: true, enableAnalytics: true,
        enableBestOutput: true, enableEarlyStopping: true, enablePIDControl: true,
        enableOverseer: true, enableSemanticMemory: true, enableClaudeIntelligence: true,
      };
      expect(state.config).toEqual(expectedConfig);
      expect(state.giteaIntegration).toBeNull();
      expect(new StateManager(testDir).load()).toMatchObject({
        maxIterations: 10, config: expectedConfig, giteaIntegration: null,
      });
    });

    it('should accept custom config values', () => {
      const configuredOptions = {
        provider: 'codex', model: 'sonnet', budgetPerIteration: 5.0,
        budgetLimits: { maxTokens: 5000 }, explorationQuota: { enabled: true, ratio: 0.2 },
        budgetStopPolicy: 'budget-wins', evalHarness: { command: 'fixture-only' },
        executionMode: 'test-fixture', timeoutMinutes: 12,
        mcpConfig: join(testDir, 'fixture-mcp.json'), workingDir: join(testDir, 'work'),
        verbose: true, checkpointIntervalMinutes: 7,
        enableCheckpoints: false, enableSnapshots: false, useClaudeAssessment: true,
        keyFiles: ['src/example.ts'], memory: 8, crossTask: false, enableAnalytics: false,
        enableBestOutput: false, enableEarlyStopping: false, enablePIDControl: false,
        enableOverseer: false, enableSemanticMemory: false, enableClaudeIntelligence: false,
      };
      const expectedConfig = structuredClone(configuredOptions);
      const integration = { enabled: true, owner: 'fixture-owner', repo: 'fixture-repo', issueNumber: 7 };
      const state = stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
        maxIterations: 20,
        ...configuredOptions,
        giteaIntegration: integration,
      });

      expect(state.maxIterations).toBe(20);
      expect(state.config).toEqual(expectedConfig);
      expect(state.giteaIntegration).toEqual({
        enabled: true, owner: 'fixture-owner', repo: 'fixture-repo', issueNumber: 7,
      });
      const loaded = new StateManager(testDir).load();
      expect(loaded?.maxIterations).toBe(20);
      expect(loaded?.config).toEqual(expectedConfig);
      expect(loaded?.giteaIntegration).toEqual({
        enabled: true, owner: 'fixture-owner', repo: 'fixture-repo', issueNumber: 7,
      });
    });
  });

  describe('exists', () => {
    it('should return false when no state exists', () => {
      expect(stateManager.exists()).toBe(false);
    });

    it('should return true after initialization', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      expect(stateManager.exists()).toBe(true);
    });
  });

  describe('save and load', () => {
    it('should save and load state correctly', () => {
      const original = stateManager.initialize({
        objective: 'Original objective',
        completionCriteria: 'test passes',
      });

      const loaded = stateManager.load();

      expect(loaded).not.toBeNull();
      expect(loaded?.loopId).toBe(original.loopId);
      expect(loaded?.objective).toBe('Original objective');
    });

    it('should update lastUpdate timestamp on save', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const state = stateManager.initialize({
          objective: 'Test',
          completionCriteria: 'done',
        });
        expect(state.startTime).toBe('2026-01-01T00:00:00.000Z');
        expect(stateManager.load()).toMatchObject({
          startTime: '2026-01-01T00:00:00.000Z',
          lastUpdate: '2026-01-01T00:00:00.000Z',
        });

        vi.setSystemTime(new Date('2026-01-01T00:00:01.234Z'));
        state.status = 'paused';
        stateManager.save(state);

        const loaded = stateManager.load();
        expect(loaded?.lastUpdate).toBe('2026-01-01T00:00:01.234Z');
        expect(loaded?.startTime).toBe('2026-01-01T00:00:00.000Z');
        expect(loaded?.status).toBe('paused');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should preserve the previous snapshot when staging fails and allow retry', () => {
      const state = stateManager.initialize({ objective: 'Original snapshot', completionCriteria: 'done' });
      const statePath = join(testDir, '.aiwg', 'ralph-external', 'session-state.json');
      const backupPath = `${statePath}.bak`;
      const temporaryPath = `${statePath}.tmp`;
      const previousBytes = readFileSync(statePath, 'utf8');
      // An owned directory cannot be opened as the temporary output file.
      mkdirSync(temporaryPath);
      state.status = 'paused';
      state.objective = 'Replacement snapshot';

      expect(() => stateManager.save(state)).toThrow();
      expect(readFileSync(statePath, 'utf8')).toBe(previousBytes);
      expect(readFileSync(backupPath, 'utf8')).toBe(previousBytes);
      expect(new StateManager(testDir).load()).toEqual(JSON.parse(previousBytes));

      rmSync(temporaryPath, { recursive: true });
      stateManager.save(state);
      expect(new StateManager(testDir).load()).toEqual(state);
      expect(readFileSync(backupPath, 'utf8')).toBe(previousBytes);
      expect(existsSync(temporaryPath)).toBe(false);
    });

    it('should create backup on save', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      // Save again to create backup
      const state = stateManager.load()!;
      state.status = 'paused';
      stateManager.save(state);

      const backupPath = join(testDir, '.aiwg', 'ralph-external', 'session-state.json.bak');
      expect(existsSync(backupPath)).toBe(true);
    });
  });

  describe('update', () => {
    it('should update partial state', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      const updated = stateManager.update({
        status: 'paused',
        currentIteration: 5,
      });

      expect(updated.status).toBe('paused');
      expect(updated.currentIteration).toBe(5);
      expect(updated.objective).toBe('Test'); // Unchanged
    });

    it('should throw when no state exists', () => {
      expect(() => stateManager.update({ status: 'paused' })).toThrow('No existing state');
    });
  });

  describe('setCurrentPid', () => {
    it('should persist the PID and clear it without changing other state', () => {
      stateManager.initialize({ objective: 'PID task', completionCriteria: 'done' });
      stateManager.setCurrentPid(12345);
      expect(new StateManager(testDir).load()).toMatchObject({
        currentPid: 12345, objective: 'PID task', status: 'running',
      });
      stateManager.setCurrentPid(null);
      expect(new StateManager(testDir).load()).toMatchObject({
        currentPid: null, objective: 'PID task', status: 'running',
      });
    });

    it('should reject a PID change without existing state', () => {
      expect(() => stateManager.setCurrentPid(12345)).toThrow('No existing state to update');
      expect(stateManager.exists()).toBe(false);
    });
  });

  describe('setStatus', () => {
    it('should persist successive statuses without changing other state', () => {
      stateManager.initialize({ objective: 'Status task', completionCriteria: 'done' });
      for (const status of ['paused', 'completed']) {
        stateManager.setStatus(status);
        expect(new StateManager(testDir).load()).toMatchObject({
          status, objective: 'Status task', currentIteration: 0,
        });
      }
    });

    it('should reject a status change without existing state', () => {
      expect(() => stateManager.setStatus('paused')).toThrow('No existing state to update');
      expect(stateManager.exists()).toBe(false);
    });
  });

  describe('saveAnalysis', () => {
    it('should create the numbered analysis file without initialized state', () => {
      const analysis = { completed: false, percentage: 25, notes: ['first', 'second'] };
      stateManager.saveAnalysis(7, analysis);
      const analysisPath = join(testDir, '.aiwg', 'ralph-external', 'analysis', '007-analysis.json');
      expect(JSON.parse(readFileSync(analysisPath, 'utf8'))).toEqual(analysis);
      expect(stateManager.exists()).toBe(false);
    });

    it('should isolate relocated roots and iterations when overwriting analysis', () => {
      const rootA = join(testDir, 'analysis-a');
      const rootB = join(testDir, 'analysis-b');
      stateManager.setStateDir(rootA);
      const other = new StateManager(testDir);
      other.setStateDir(rootB);
      stateManager.saveAnalysis(1, { result: 'old' });
      stateManager.saveAnalysis(2, { result: 'sibling' });
      other.saveAnalysis(1, { result: 'other loop' });
      stateManager.saveAnalysis(1, { result: 'replacement', completed: true });
      expect(JSON.parse(readFileSync(join(rootA, 'analysis', '001-analysis.json'), 'utf8')))
        .toEqual({ result: 'replacement', completed: true });
      expect(JSON.parse(readFileSync(join(rootA, 'analysis', '002-analysis.json'), 'utf8')))
        .toEqual({ result: 'sibling' });
      expect(JSON.parse(readFileSync(join(rootB, 'analysis', '001-analysis.json'), 'utf8')))
        .toEqual({ result: 'other loop' });
      expect(existsSync(join(testDir, '.aiwg', 'ralph-external'))).toBe(false);
    });
  });

  describe('addIteration', () => {
    it('should reject an iteration without existing state', () => {
      expect(() => stateManager.addIteration({ number: 1 } as any))
        .toThrow('No existing state');
      expect(stateManager.exists()).toBe(false);
      expect(existsSync(join(testDir, '.aiwg', 'ralph-external'))).toBe(false);
    });

    it('should add iteration record', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      const iteration = {
        number: 1,
        sessionId: 'test-session',
        promptFile: 'prompts/001-prompt.md',
        stdoutFile: 'outputs/001-stdout.log',
        stderrFile: 'outputs/001-stderr.log',
        exitCode: 0,
        duration: 1000,
        status: 'completed',
        analysis: { completed: false, success: null },
        learnings: ['First learning'],
        filesModified: ['file1.ts'],
        progress: 'Started',
      };
      // Keep an independent expected value in case the input is mutated.
      const expectedIteration = structuredClone(iteration);
      const state = stateManager.addIteration(iteration);

      expect(state.iterations).toEqual([expectedIteration]);
      expect(new StateManager(testDir).load()?.iterations).toEqual([expectedIteration]);
    });

    it('should accumulate learnings across iterations', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      stateManager.addIteration({
        number: 1,
        learnings: ['Learning 1'],
        filesModified: [],
      } as any);

      const state = stateManager.addIteration({
        number: 2,
        learnings: ['Learning 2'],
        filesModified: [],
      } as any);

      expect(state.accumulatedLearnings).toContain('Learning 1');
      expect(state.accumulatedLearnings).toContain('Learning 2');
    });

    it('should merge files modified without duplicates', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      stateManager.addIteration({
        number: 1,
        filesModified: ['file1.ts', 'file2.ts'],
      } as any);

      const state = stateManager.addIteration({
        number: 2,
        filesModified: ['file2.ts', 'file3.ts'],
      } as any);

      expect(state.filesModified).toHaveLength(3);
      expect(state.filesModified).toContain('file1.ts');
      expect(state.filesModified).toContain('file2.ts');
      expect(state.filesModified).toContain('file3.ts');
    });
  });

  describe('recovery from corrupted state', () => {
    it('should report corrupt state without a backup and preserve its bytes', () => {
      stateManager.initialize({ objective: 'Corruption test', completionCriteria: 'done' });
      const statePath = join(testDir, '.aiwg', 'ralph-external', 'session-state.json');
      const backupPath = `${statePath}.bak`;
      expect(existsSync(backupPath)).toBe(false);
      writeFileSync(statePath, 'invalid primary JSON');

      expect(() => new StateManager(testDir).load()).toThrow('Failed to load state:');
      expect(readFileSync(statePath, 'utf8')).toBe('invalid primary JSON');
      expect(existsSync(backupPath)).toBe(false);
    });

    it('should recover from corrupted state file using backup', () => {
      // Initialize and create backup
      const original = stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      original.status = 'paused';
      stateManager.save(original);

      // Corrupt the main state file
      const statePath = join(testDir, '.aiwg', 'ralph-external', 'session-state.json');
      writeFileSync(statePath, 'corrupted data');

      // Load should recover from backup
      const recovered = stateManager.load();

      expect(recovered).not.toBeNull();
      expect(recovered?.loopId).toBe(original.loopId);
      // The backup predates the paused primary snapshot. Recovery must repair
      // the primary file as well as return that older state in memory.
      expect(recovered?.status).toBe('running');
      const repairedPrimary = readFileSync(statePath, 'utf8');
      expect(repairedPrimary).not.toBe('corrupted data');
      expect(JSON.parse(repairedPrimary)).toEqual(recovered);
      expect(new StateManager(testDir).load()).toEqual(recovered);
    });

    it('should throw when both state and backup are corrupted', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      // Create backup first
      const state = stateManager.load()!;
      stateManager.save(state);

      // Corrupt both files
      const stateDir = join(testDir, '.aiwg', 'ralph-external');
      writeFileSync(join(stateDir, 'session-state.json'), 'corrupted');
      writeFileSync(join(stateDir, 'session-state.json.bak'), 'also corrupted');

      expect(() => stateManager.load()).toThrow();
    });
  });

  describe('path helpers', () => {
    it('should return correct iteration directory path', () => {
      const path = stateManager.getIterationDir(1);
      expect(path).toBe(join(testDir, '.aiwg', 'ralph-external', 'iterations', '001'));
    });

    it('should return correct prompt path', () => {
      const path = stateManager.getPromptPath(5);
      expect(path).toBe(join(testDir, '.aiwg', 'ralph-external', 'prompts', '005-prompt.md'));
    });

    it('should return correct output paths', () => {
      const paths = stateManager.getOutputPaths(10);
      expect(paths).toEqual({
        stdout: join(testDir, '.aiwg', 'ralph-external', 'outputs', '010-stdout.log'),
        stderr: join(testDir, '.aiwg', 'ralph-external', 'outputs', '010-stderr.log'),
      });
    });

    it('should return correct analysis path', () => {
      const path = stateManager.getAnalysisPath(3);
      expect(path).toBe(join(testDir, '.aiwg', 'ralph-external', 'analysis', '003-analysis.json'));
    });
  });

  describe('clear', () => {
    it('should set status to aborted', () => {
      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      stateManager.clear();

      const state = stateManager.load();
      expect(state?.status).toBe('aborted');
    });

    it('should not throw if no state exists', () => {
      expect(() => stateManager.clear()).not.toThrow();
    });
  });

  describe('setStateDir', () => {
    it('should re-scope all file I/O to the new directory', () => {
      const customDir = join(testDir, 'loops', 'ralph-my-task-a1b2c3d4');
      stateManager.setStateDir(customDir);

      stateManager.initialize({
        objective: 'Test',
        completionCriteria: 'done',
      });

      expect(existsSync(join(customDir, 'session-state.json'))).toBe(true);
      // Default flat dir should NOT have been created
      expect(existsSync(join(testDir, '.aiwg', 'ralph-external', 'session-state.json'))).toBe(false);
    });

    it('should update path helpers to use the new directory', () => {
      const customDir = join(testDir, 'loops', 'ralph-my-task-a1b2c3d4');
      stateManager.setStateDir(customDir);

      expect(stateManager.getStateDir()).toBe(customDir);
      expect(stateManager.getIterationDir(1)).toBe(join(customDir, 'iterations', '001'));
      expect(stateManager.getPromptPath(1)).toBe(join(customDir, 'prompts', '001-prompt.md'));
      expect(stateManager.getOutputPaths(1)).toEqual({
        stdout: join(customDir, 'outputs', '001-stdout.log'),
        stderr: join(customDir, 'outputs', '001-stderr.log'),
      });
      expect(stateManager.getAnalysisPath(1)).toBe(join(customDir, 'analysis', '001-analysis.json'));
    });

    it('should allow load() to find state written after setStateDir', () => {
      const customDir = join(testDir, 'loops', 'ralph-my-task-a1b2c3d4');
      stateManager.setStateDir(customDir);

      const original = stateManager.initialize({
        objective: 'Scoped objective',
        completionCriteria: 'done',
      });

      const loaded = stateManager.load();
      expect(loaded?.loopId).toBe(original.loopId);
      expect(loaded?.objective).toBe('Scoped objective');
    });
  });

  describe('parallel loop isolation', () => {
    it('two StateManagers with different stateDirs should not share files', () => {
      const loopDirA = join(testDir, 'loops', 'ralph-loop-a');
      const loopDirB = join(testDir, 'loops', 'ralph-loop-b');

      const smA = new StateManager(testDir);
      smA.setStateDir(loopDirA);

      const smB = new StateManager(testDir);
      smB.setStateDir(loopDirB);

      smA.initialize({ objective: 'Task A', completionCriteria: 'A done' });
      smB.initialize({ objective: 'Task B', completionCriteria: 'B done' });

      const stateA = smA.load();
      const stateB = smB.load();

      // Each manager reads its own state, not the other's
      expect(stateA?.objective).toBe('Task A');
      expect(stateB?.objective).toBe('Task B');

      // State files are in separate directories
      expect(existsSync(join(loopDirA, 'session-state.json'))).toBe(true);
      expect(existsSync(join(loopDirB, 'session-state.json'))).toBe(true);
    });

    it('updating one loop state should not affect the other', () => {
      const loopDirA = join(testDir, 'loops', 'ralph-loop-a');
      const loopDirB = join(testDir, 'loops', 'ralph-loop-b');

      const smA = new StateManager(testDir);
      smA.setStateDir(loopDirA);

      const smB = new StateManager(testDir);
      smB.setStateDir(loopDirB);

      smA.initialize({ objective: 'Task A', completionCriteria: 'A done' });
      smB.initialize({ objective: 'Task B', completionCriteria: 'B done' });

      smA.update({ status: 'completed' });

      const stateA = smA.load();
      const stateB = smB.load();

      expect(stateA?.status).toBe('completed');
      expect(stateB?.status).toBe('running'); // B is unaffected
    });

    it('iteration files from each loop should be isolated', () => {
      const loopDirA = join(testDir, 'loops', 'ralph-loop-a');
      const loopDirB = join(testDir, 'loops', 'ralph-loop-b');

      const smA = new StateManager(testDir);
      smA.setStateDir(loopDirA);

      const smB = new StateManager(testDir);
      smB.setStateDir(loopDirB);

      smA.initialize({ objective: 'Task A', completionCriteria: 'done' });
      smB.initialize({ objective: 'Task B', completionCriteria: 'done' });

      // Prompt paths for iteration 1 should be in separate directories
      expect(smA.getPromptPath(1)).toContain(loopDirA);
      expect(smB.getPromptPath(1)).toContain(loopDirB);
      expect(smA.getPromptPath(1)).not.toBe(smB.getPromptPath(1));

      // Output paths likewise
      expect(smA.getOutputPaths(1).stdout).not.toBe(smB.getOutputPaths(1).stdout);
    });
  });
});
