/**
 * Unit tests for ExternalMultiLoopStateManager
 *
 * @tests @tools/ralph-external/external-multi-loop-state-manager.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ExternalMultiLoopStateManager } from './external-multi-loop-state-manager.mjs';

describe('ExternalMultiLoopStateManager', () => {
  let manager;
  let testRoot;

  beforeEach(() => {
    // Create temporary test directory
    testRoot = join(tmpdir(), `ralph-test-${randomUUID()}`);
    mkdirSync(testRoot, { recursive: true });
    manager = new ExternalMultiLoopStateManager(testRoot);
  });

  afterEach(() => {
    // Cleanup test directory
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should initialize base directories', () => {
      manager.ensureBaseDir();

      assert(existsSync(manager.baseDir), 'Base dir should exist');
      assert(existsSync(manager.loopsDir), 'Loops dir should exist');
      assert(existsSync(manager.archiveDir), 'Archive dir should exist');
      assert(existsSync(manager.sharedDir), 'Shared dir should exist');
    });

    it('should create registry if missing', () => {
      const registry = manager.loadRegistry();

      assert.strictEqual(registry.version, '2.0.0');
      assert.strictEqual(registry.max_concurrent_loops, 4);
      assert.strictEqual(registry.active_loops.length, 0);
      assert.strictEqual(registry.total_active, 0);
      assert.strictEqual(registry.total_completed, 0);
      assert.strictEqual(registry.total_aborted, 0);
    });
  });

  describe('generateLoopId', () => {
    it('should generate valid loop ID from task', () => {
      const loopId = manager.generateLoopId('Fix all failing tests');

      assert(loopId.startsWith('ralph-fix-all-failing-tests-'));
      assert(loopId.match(/^ralph-[a-z0-9-]+-[a-f0-9]{8}$/));
    });

    it('should handle special characters', () => {
      const loopId = manager.generateLoopId('Fix: tests & docs!');

      assert(loopId.startsWith('ralph-fix-tests-docs-'));
      assert(loopId.match(/^ralph-[a-z0-9-]+-[a-f0-9]{8}$/));
    });

    it('should truncate long task names', () => {
      const longTask = 'a'.repeat(100);
      const loopId = manager.generateLoopId(longTask);

      // Slug is max 30 chars + prefix + uuid
      assert(loopId.length <= 30 + 6 + 8 + 2); // ralph- + slug + - + uuid
    });
  });

  describe('calculateCommunicationPaths', () => {
    it('should calculate correct paths for various loop counts', () => {
      assert.strictEqual(manager.calculateCommunicationPaths(2), 1);
      assert.strictEqual(manager.calculateCommunicationPaths(3), 3);
      assert.strictEqual(manager.calculateCommunicationPaths(4), 6);
      assert.strictEqual(manager.calculateCommunicationPaths(5), 10);
      assert.strictEqual(manager.calculateCommunicationPaths(7), 21);
    });
  });

  describe('createLoop', () => {
    it('should create new loop with generated ID', async () => {
      const config = {
        objective: 'Fix all tests',
        completionCriteria: 'npm test passes',
        maxIterations: 10,
      };

      const { loopId, state } = await manager.createLoop(config);

      assert(loopId.startsWith('ralph-fix-all-tests-'));
      assert.strictEqual(state.objective, 'Fix all tests');
      assert.strictEqual(state.status, 'running');
      assert.strictEqual(state.currentIteration, 0);

      // Verify directory structure
      const loopDir = manager.getLoopDir(loopId);
      assert(existsSync(loopDir));
      assert(existsSync(join(loopDir, 'iterations')));
      assert(existsSync(join(loopDir, 'prompts')));
      assert(existsSync(join(loopDir, 'outputs')));
      assert(existsSync(join(loopDir, 'checkpoints')));

      // Verify state file
      const statePath = join(loopDir, 'session-state.json');
      assert(existsSync(statePath));

      // Verify registry
      const registry = manager.loadRegistry();
      assert.strictEqual(registry.active_loops.length, 1);
      assert.strictEqual(registry.active_loops[0].loop_id, loopId);
    });

    it('should create new loop with explicit ID', async () => {
      const config = {
        loopId: 'ralph-explicit-loop-deadbeef',
        objective: 'Fix all tests',
        completionCriteria: 'npm test passes',
      };

      const { loopId, state } = await manager.createLoop(config);

      assert.strictEqual(loopId, 'ralph-explicit-loop-deadbeef');
      assert.strictEqual(state.loopId, 'ralph-explicit-loop-deadbeef');
      assert(existsSync(manager.getLoopDir('ralph-explicit-loop-deadbeef')));

      const registry = manager.loadRegistry();
      assert.strictEqual(registry.active_loops[0].loop_id, 'ralph-explicit-loop-deadbeef');
    });

    it('should enforce MAX_CONCURRENT_LOOPS', async () => {
      // Create 4 loops
      for (let i = 0; i < 4; i++) {
        await manager.createLoop({
          objective: `Task ${i}`,
          completionCriteria: 'done',
        });
      }

      // 5th should fail
      await assert.rejects(
        async () => {
          await manager.createLoop({
            objective: 'Task 5',
            completionCriteria: 'done',
          });
        },
        /Cannot create loop: 4 loops already active/
      );
    });

    it('should allow override with --force', async () => {
      // Create 4 loops
      for (let i = 0; i < 4; i++) {
        await manager.createLoop({
          objective: `Task ${i}`,
          completionCriteria: 'done',
        });
      }

      // 5th with --force should succeed
      const { loopId } = await manager.createLoop(
        {
          objective: 'Task 5',
          completionCriteria: 'done',
        },
        { force: true }
      );

      assert(loopId);
      const registry = manager.loadRegistry();
      assert.strictEqual(registry.active_loops.length, 5);
    });

    it('should create legacy symlink for single loop', async (t) => {
      const probe = join(testRoot, 'symlink-probe');
      try {
        symlinkSync('target', probe);
        unlinkSync(probe);
      } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
          t.skip(`Symlink prerequisite unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const { loopId } = await manager.createLoop({
        objective: 'Single task',
        completionCriteria: 'done',
      });

      const legacyPath = join(manager.baseDir, 'session-state.json');

      assert(lstatSync(legacyPath).isSymbolicLink());
      assert.strictEqual(readlinkSync(legacyPath), join('loops', loopId, 'session-state.json'));
      assert.strictEqual(JSON.parse(readFileSync(legacyPath, 'utf8')).loopId, loopId);
    });
  });

  describe('getLoop', () => {
    it('should retrieve loop state by ID', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      const state = manager.getLoop(loopId);

      assert.strictEqual(state.loopId, loopId);
      assert.strictEqual(state.objective, 'Test task');
    });

    it('should throw error for non-existent loop', () => {
      assert.throws(
        () => {
          manager.getLoop('ralph-nonexistent-12345678');
        },
        /Loop not found/
      );
    });
  });

  describe('updateLoop', () => {
    it('should update loop state', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      const updated = manager.updateLoop(loopId, {
        status: 'paused',
        currentIteration: 5,
      });

      assert.strictEqual(updated.status, 'paused');
      assert.strictEqual(updated.currentIteration, 5);
      assert(updated.lastUpdate); // Should be updated

      // Verify persistence
      const reloaded = manager.getLoop(loopId);
      assert.strictEqual(reloaded.status, 'paused');
      assert.strictEqual(reloaded.currentIteration, 5);
    });
  });

  describe('listActiveLoops', () => {
    it('should list all active loops', async () => {
      await manager.createLoop({
        objective: 'Task 1',
        completionCriteria: 'done',
      });

      await manager.createLoop({
        objective: 'Task 2',
        completionCriteria: 'done',
      });

      const loops = manager.listActiveLoops();

      assert.strictEqual(loops.length, 2);
      assert(loops[0].task_summary.includes('Task 1'));
      assert(loops[1].task_summary.includes('Task 2'));
    });

    it('should return empty array when no loops', () => {
      const loops = manager.listActiveLoops();
      assert.strictEqual(loops.length, 0);
    });
  });

  describe('updateLoopPid', () => {
    it('should update PID in both state and registry', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      await manager.updateLoopPid(loopId, 99999);

      // Check state
      const state = manager.getLoop(loopId);
      assert.strictEqual(state.currentPid, 99999);

      // Check registry
      const registry = manager.loadRegistry();
      const loop = registry.active_loops.find((l) => l.loop_id === loopId);
      assert.strictEqual(loop.pid, 99999);
    });
  });

  describe('isLoopAlive', () => {
    it('should return true for current process', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      // Set to current process
      await manager.updateLoopPid(loopId, process.pid);

      assert.strictEqual(manager.isLoopAlive(loopId), true);
    });

    it('should return false for non-existent process', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      // Model a dead process explicitly; an arbitrary PID may be live on CI.
      await manager.updateLoopPid(loopId, 99999);
      manager.processExists = pid => { assert.strictEqual(pid, 99999); return false; };

      assert.strictEqual(manager.isLoopAlive(loopId), false);
    });

    it('should return false for null PID', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      await manager.updateLoopPid(loopId, null);

      assert.strictEqual(manager.isLoopAlive(loopId), false);
    });
  });

  describe('archiveLoop', () => {
    it('should move loop to archive and update registry', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      // Mark as completed
      manager.updateLoop(loopId, { status: 'completed' });

      await manager.archiveLoop(loopId);

      // Verify moved to archive
      const archiveDir = join(manager.archiveDir, loopId);
      assert(existsSync(archiveDir));

      // Verify removed from loops
      const loopDir = join(manager.loopsDir, loopId);
      assert(!existsSync(loopDir));

      // Verify registry updated
      const registry = manager.loadRegistry();
      assert.strictEqual(registry.active_loops.length, 0);
      assert.strictEqual(registry.total_completed, 1);
    });

    it('should increment aborted counter for aborted loops', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      manager.updateLoop(loopId, { status: 'aborted' });

      await manager.archiveLoop(loopId);

      const registry = manager.loadRegistry();
      assert.strictEqual(registry.total_aborted, 1);
    });
  });

  describe('detectCrashedLoops', () => {
    it('should detect loops with dead PIDs', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      // Inject the process boundary rather than assuming a PID is unused.
      await manager.updateLoopPid(loopId, 99999);
      manager.processExists = pid => { assert.strictEqual(pid, 99999); return false; };

      const crashed = manager.detectCrashedLoops();

      assert.strictEqual(crashed.length, 1);
      assert.strictEqual(crashed[0].loop_id, loopId);
    });

    it('should not detect paused loops', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      manager.updateLoop(loopId, { status: 'paused' });
      await manager.updateLoopPid(loopId, 99999);
      manager.processExists = () => { assert.fail('Paused loops must not probe process liveness'); };

      const crashed = manager.detectCrashedLoops();

      assert.strictEqual(crashed.length, 0);
    });

    it('should not detect loops with null PID', async () => {
      await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      const crashed = manager.detectCrashedLoops();

      // Current process is alive
      assert.strictEqual(crashed.length, 0);
    });
  });

  describe('file locking', () => {
    it('rejects a corrupt lock within bounded attempts without a synchronous hang', () => {
      manager.ensureBaseDir();
      writeFileSync(manager.lockPath, '{broken');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { ExternalMultiLoopStateManager } from ${JSON.stringify(new URL('./external-multi-loop-state-manager.mjs', import.meta.url).href)};
        const manager = new ExternalMultiLoopStateManager(process.argv[1]);
        manager.maxLockAttempts = 2;
        let waits = 0;
        manager.sleep = async () => { waits++; };
        await assert.rejects(manager.acquireLock('corrupt-probe'), /after 2 attempts/);
        assert.equal(waits, 1);
        console.log('bounded-rejection');
      `, testRoot], { encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.trim(), 'bounded-rejection');
      assert.strictEqual(readFileSync(manager.lockPath, 'utf8'), '{broken');
    });

    it('should acquire and release lock', async () => {
      const { acquired } = await manager.acquireLock('test-lock');

      assert.strictEqual(acquired, true);
      assert(existsSync(manager.lockPath));

      manager.releaseLock('test-lock');

      assert(!existsSync(manager.lockPath));
    });

    it('should detect stale locks', async () => {
      // Ensure base directory exists before writing lock file
      manager.ensureBaseDir();

      // Create expired lock
      const staleLock = {
        pid: 99999,
        loopId: 'stale',
        timestamp: Date.now() - 60000,
        leaseExpiry: Date.now() - 30000, // Expired
        fencingToken: Date.now(),
      };

      const lockPath = manager.lockPath;
      const fs = await import('fs');
      fs.writeFileSync(lockPath, JSON.stringify(staleLock));

      // Should acquire despite existing lock
      const { acquired } = await manager.acquireLock('new-lock');

      assert.strictEqual(acquired, true);
    });

    it('should timeout waiting for lock', async () => {
      // Acquire lock
      await manager.acquireLock('holder');

      // Create new manager to try acquiring
      const manager2 = new ExternalMultiLoopStateManager(testRoot);

      // Override max attempts for faster test (instance property)
      manager2.maxLockAttempts = 3;

      await assert.rejects(
        async () => {
          await manager2.acquireLock('waiter');
        },
        /Failed to acquire lock/
      );

      // Cleanup
      manager.releaseLock('holder');
    });
  });

  describe('path helpers', () => {
    for (const status of ['completed', 'failed', 'aborted', 'limit_reached', 'budget_exhausted', 'plateau', 'interrupted']) {
      it(`archives the real orchestrator terminal status ${status}`, async () => {
        const { loopId } = await manager.createLoop({ objective: 'terminal status', completionCriteria: 'done' });
        manager.updateLoop(loopId, { status });
        await manager.archiveLoop(loopId);
        const archived = JSON.parse(readFileSync(join(manager.archiveDir, loopId, 'session-state.json'), 'utf8'));
        assert.strictEqual(archived.status, status);
        assert(!existsSync(manager.getLoopDir(loopId)));
        const registry = manager.loadRegistry();
        assert.deepStrictEqual(registry.active_loops, []);
        assert.strictEqual(registry.total_completed, status === 'completed' ? 1 : 0);
        assert.strictEqual(registry.total_aborted, status === 'completed' ? 0 : 1);
      });
    }

    it('migrates legacy state and artifacts once without losing contents', async () => {
      manager.ensureBaseDir();
      const legacy = { objective: 'Legacy task', completionCriteria: 'done', status: 'paused', currentIteration: 2, maxIterations: 5, currentPid: null };
      const legacyPath = join(manager.baseDir, 'session-state.json');
      writeFileSync(legacyPath, JSON.stringify(legacy));
      for (const name of ['iterations', 'prompts', 'outputs', 'analysis', 'checkpoints']) {
        mkdirSync(join(manager.baseDir, name));
        writeFileSync(join(manager.baseDir, name, 'preserved.txt'), name);
      }
      assert.strictEqual(await manager.migrateLegacyState(), true);
      const registry = manager.loadRegistry();
      assert.strictEqual(registry.active_loops.length, 1);
      const entry = registry.active_loops[0];
      assert.strictEqual(entry.task_summary, 'Legacy task');
      assert.strictEqual(entry.status, 'paused');
      assert.strictEqual(entry.iteration, 2);
      assert.strictEqual(entry.max_iterations, 5);
      assert.deepStrictEqual(manager.getLoop(entry.loop_id), legacy);
      for (const name of ['iterations', 'prompts', 'outputs', 'analysis', 'checkpoints']) {
        assert(!existsSync(join(manager.baseDir, name)));
        assert.strictEqual(readFileSync(join(manager.getLoopDir(entry.loop_id), name, 'preserved.txt'), 'utf8'), name);
      }
      assert.strictEqual(await manager.migrateLegacyState(), false);
      assert.deepStrictEqual(manager.loadRegistry(), registry);
      assert(!existsSync(manager.lockPath));
    });

    it('leaves missing or malformed legacy state untouched and releases the lock', async () => {
      assert.strictEqual(await manager.migrateLegacyState(), false);
      manager.ensureBaseDir();
      const legacyPath = join(manager.baseDir, 'session-state.json');
      writeFileSync(legacyPath, '{broken');
      await assert.rejects(manager.migrateLegacyState(), SyntaxError);
      assert.strictEqual(readFileSync(legacyPath, 'utf8'), '{broken');
      assert(!existsSync(manager.lockPath));
    });

    it('does not replace regular legacy state while creating another loop', async () => {
      manager.ensureBaseDir();
      const legacyPath = join(manager.baseDir, 'session-state.json');
      writeFileSync(legacyPath, '{"owned":"legacy"}');
      await manager.createLoop({ objective: 'new loop', completionCriteria: 'done' });
      assert.strictEqual(readFileSync(legacyPath, 'utf8'), '{"owned":"legacy"}');
      assert(lstatSync(legacyPath).isFile());
    });

    it('rejects unsafe identities in every public path boundary', async () => {
      for (const loopId of ['../../escaped', '../loop', '/tmp/loop', 'ralph-a/b-deadbeef', 'ralph-a\\b-deadbeef', '', '.', '..']) {
        for (const method of ['getLoop', 'getLoopDir', 'isLoopAlive']) {
          assert.throws(() => manager[method](loopId), /loopId/);
        }
        for (const method of ['getIterationDir', 'getPromptPath', 'getOutputPaths']) {
          assert.throws(() => manager[method](loopId, 1), /loopId/);
        }
        assert.throws(() => manager.updateLoop(loopId, {}), /loopId/);
        await assert.rejects(manager.archiveLoop(loopId), /loopId/);
        await assert.rejects(manager.updateLoopPid(loopId, process.pid), /loopId/);
        await assert.rejects(manager.createLoop({ loopId, objective: 'test', completionCriteria: 'done' }), /loopId/);
      }
      assert(!existsSync(manager.baseDir), 'invalid input must not create persistent state');
    });

    it('generates usable identities for punctuation and truncated separators', async () => {
      for (const objective of ['!!!', `${'a'.repeat(29)} b`]) {
        const { loopId } = await manager.createLoop({ objective, completionCriteria: 'done' });
        assert.match(loopId, /^ralph-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}$/);
        assert.strictEqual(manager.getLoop(loopId).objective, objective);
      }
    });

    it('rejects duplicate identities without modifying state or registry', async () => {
      const config = { loopId: 'ralph-duplicate-deadbeef', objective: 'first', completionCriteria: 'done' };
      await manager.createLoop(config);
      const statePath = join(manager.getLoopDir(config.loopId), 'session-state.json');
      const state = readFileSync(statePath, 'utf8');
      const registry = manager.loadRegistry();
      await assert.rejects(manager.createLoop({ ...config, objective: 'overwrite' }), /already exists/);
      assert.strictEqual(readFileSync(statePath, 'utf8'), state);
      assert.deepStrictEqual(manager.loadRegistry(), registry);
    });

    it('rejects invalid creation options before creating state', async () => {
      for (const [field, values] of [
        ['objective', ['', ' ', null]], ['completionCriteria', ['', null]],
        ['maxIterations', [0, -1, 1.5, Infinity]],
        ['budgetPerIteration', [0, -1, NaN, Infinity, '5']],
        ['timeoutMinutes', [0, -1, NaN, Infinity]],
        ['priority', ['invalid']], ['tags', ['tag', [1]]],
      ]) {
        for (const value of values) {
          await assert.rejects(manager.createLoop({ objective: 'test', completionCriteria: 'done', [field]: value }), new RegExp(field));
        }
      }
      assert(!existsSync(manager.baseDir));
    });

    it('should generate correct paths', async () => {
      const { loopId } = await manager.createLoop({
        objective: 'Test task',
        completionCriteria: 'done',
      });

      const loopDir = manager.getLoopDir(loopId);
      assert(loopDir.endsWith(loopId));

      const iterDir = manager.getIterationDir(loopId, 5);
      assert(iterDir.endsWith('iterations/005'));

      const promptPath = manager.getPromptPath(loopId, 3);
      assert(promptPath.endsWith('prompts/003-prompt.md'));

      const { stdout, stderr } = manager.getOutputPaths(loopId, 2);
      assert(stdout.endsWith('outputs/002-stdout.log'));
      assert(stderr.endsWith('outputs/002-stderr.log'));
    });
  });
});
