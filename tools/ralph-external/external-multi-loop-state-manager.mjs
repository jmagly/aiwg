/**
 * External Multi-Loop State Manager for External Ralph
 *
 * Manages multiple concurrent External Ralph loops with:
 * - Registry at .aiwg/ralph-external/registry.json
 * - Per-loop directories at .aiwg/ralph-external/loops/{loop-id}/
 * - File locking with lease-based expiry and stale detection
 * - PID tracking for crash detection
 * - MAX_CONCURRENT_LOOPS enforcement (REF-086, REF-088)
 *
 * @implements @.aiwg/working/multi-loop-ralph-plan.md Section 7
 * @schema @agentic/code/addons/agent-loop/schemas/multi-loop-registry.yaml
 * @issue #271
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  symlinkSync,
  lstatSync,
} from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

/**
 * @typedef {Object} LoopConfiguration
 * @property {string} objective - Full objective text
 * @property {string} completionCriteria - Verifiable completion criteria
 * @property {number} maxIterations - Maximum external iterations
 * @property {string} model - Model to use (opus, sonnet, etc.)
 * @property {number} budgetPerIteration - Budget per iteration in dollars
 * @property {number} timeoutMinutes - Timeout per iteration
 * @property {Object} mcpConfig - MCP server configuration
 * @property {string} workingDir - Working directory
 * @property {Object} giteaIntegration - Gitea issue tracking
 */

/**
 * @typedef {Object} RegistryEntry
 * @property {string} loop_id - Unique loop identifier
 * @property {string} task_summary - Brief task description
 * @property {string} status - running|paused|waiting|completing
 * @property {string} started_at - ISO timestamp
 * @property {string} owner - User or agent that owns this loop
 * @property {number|null} pid - Process ID if running
 * @property {number} iteration - Current iteration number
 * @property {number} max_iterations - Maximum iterations
 * @property {string} completion_criteria - Verification command
 * @property {string} priority - low|medium|high|critical
 * @property {string[]} tags - Tags for categorization
 */

/**
 * @typedef {Object} Registry
 * @property {string} version - Registry schema version
 * @property {number} max_concurrent_loops - Max concurrent loops (4)
 * @property {string} updated_at - Last update timestamp
 * @property {RegistryEntry[]} active_loops - Active loops
 * @property {number} total_active - Count of active loops
 * @property {number} total_completed - Lifetime completed count
 * @property {number} total_aborted - Lifetime aborted count
 */

const REGISTRY_VERSION = '2.0.0';
const STATE_VERSION = '1.0.0';
const MAX_CONCURRENT_LOOPS = 4; // REF-086, REF-088
const LOCK_LEASE_MS = 30000; // 30 second lease
const LOCK_RETRY_MS = 100;
const MAX_LOCK_ATTEMPTS = 300; // 30 seconds total wait
const LOOP_ID_PATTERN = /^ralph-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}$/;
const LOOP_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const LOOP_STATUSES = new Set(['running', 'paused', 'waiting', 'completing', 'completed', 'aborted', 'failed', 'limit_reached', 'budget_exhausted', 'plateau', 'interrupted']);

export class ExternalMultiLoopStateManager {
  /**
   * @param {string} projectRoot - Project root directory
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.baseDir = join(projectRoot, '.aiwg', 'ralph-external');
    this.registryPath = join(this.baseDir, 'registry.json');
    this.loopsDir = join(this.baseDir, 'loops');
    this.archiveDir = join(this.baseDir, 'archive');
    this.sharedDir = join(this.baseDir, 'shared');
    this.lockPath = `${this.registryPath}.lock`;
  }

  /**
   * Initialize base directories
   */
  ensureBaseDir() {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
    if (!existsSync(this.loopsDir)) {
      mkdirSync(this.loopsDir, { recursive: true });
    }
    if (!existsSync(this.archiveDir)) {
      mkdirSync(this.archiveDir, { recursive: true });
    }
    if (!existsSync(this.sharedDir)) {
      mkdirSync(this.sharedDir, { recursive: true });
    }
  }

  /**
   * Generate loop ID from task description
   * Format: ralph-{slug}-{uuid8}
   * @param {string} task - Task description
   * @returns {string} Loop ID
   */
  generateLoopId(task) {
    const slug = task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/g, '') || 'task';
    const shortUuid = randomUUID().split('-')[0]; // First 8 chars
    return `ralph-${slug}-${shortUuid}`;
  }

  /**
   * Calculate communication paths: n*(n-1)/2 (REF-088)
   * @param {number} n - Number of loops
   * @returns {number} Communication paths
   */
  calculateCommunicationPaths(n) {
    return (n * (n - 1)) / 2;
  }

  /**
   * Load registry with initialization if missing
   * @returns {Registry}
   */
  loadRegistry() {
    this.ensureBaseDir();

    if (!existsSync(this.registryPath)) {
      const registry = {
        version: REGISTRY_VERSION,
        max_concurrent_loops: MAX_CONCURRENT_LOOPS,
        updated_at: new Date().toISOString(),
        active_loops: [],
        total_active: 0,
        total_completed: 0,
        total_aborted: 0,
      };
      this.saveRegistry(registry);
      return registry;
    }

    try {
      const content = readFileSync(this.registryPath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to load registry: ${e.message}`);
    }
  }

  /**
   * Save registry atomically
   * @param {Registry} registry
   */
  saveRegistry(registry) {
    registry.updated_at = new Date().toISOString();
    registry.total_active = registry.active_loops.length;

    const tempPath = `${this.registryPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(registry, null, 2));
    renameSync(tempPath, this.registryPath);
  }

  /**
   * Acquire lease-based lock with stale detection
   * @param {string} loopId - Loop requesting lock
   * @returns {Promise<{acquired: boolean, fencingToken: number}>}
   */
  async acquireLock(loopId) {
    let attempts = 0;

    // Ensure base directory exists before creating lock file
    this.ensureBaseDir();

    const maxAttempts = this.maxLockAttempts ?? MAX_LOCK_ATTEMPTS;
    while (attempts < maxAttempts) {
      try {
        // Try atomic creation
        const fd = openSync(this.lockPath, 'wx');
        const lockData = {
          pid: process.pid,
          loopId,
          timestamp: Date.now(),
          leaseExpiry: Date.now() + LOCK_LEASE_MS,
          fencingToken: Date.now(), // Use timestamp as fencing token
        };
        writeFileSync(fd, JSON.stringify(lockData, null, 2));
        closeSync(fd);
        return { acquired: true, fencingToken: lockData.fencingToken };
      } catch (e) {
        if (e.code === 'EEXIST') {
          // Lock exists - check if stale
          try {
            const lockData = JSON.parse(readFileSync(this.lockPath, 'utf8'));

            // Check 1: Lease expired?
            if (Date.now() > lockData.leaseExpiry) {
              unlinkSync(this.lockPath);
              continue; // Retry immediately
            }

            // Check 2: Process dead? (stale lock)
            if (!this.processExists(lockData.pid)) {
              unlinkSync(this.lockPath);
              continue; // Retry immediately
            }

            // Lock is valid - wait and retry
            await this.sleep(LOCK_RETRY_MS);
            attempts++;
            continue;
          } catch (readError) {
            // A concurrently removed or unreadable lock still consumes a
            // bounded attempt and yields; corrupt data must never busy-spin.
            attempts++;
            if (attempts < maxAttempts) await this.sleep(LOCK_RETRY_MS);
            continue;
          }
        }
        throw e;
      }
    }

    throw new Error(`Failed to acquire lock after ${maxAttempts} attempts`);
  }

  /**
   * Release lock (only if we own it)
   * @param {string} loopId - Loop releasing lock
   */
  releaseLock(loopId) {
    if (!existsSync(this.lockPath)) return;

    try {
      const lockData = JSON.parse(readFileSync(this.lockPath, 'utf8'));

      // Only release if we own the lock
      if (lockData.loopId === loopId && lockData.pid === process.pid) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Lock file corrupted or already deleted - ignore
    }
  }

  /**
   * Check if process exists (cross-platform)
   * @param {number} pid - Process ID
   * @returns {boolean}
   */
  processExists(pid) {
    try {
      process.kill(pid, 0); // Signal 0 = check existence
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sleep for milliseconds
   * @param {number} ms - Milliseconds
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create new loop with unique ID
   * @param {LoopConfiguration} config - Loop configuration
   * @param {Object} options - Creation options
   * @param {boolean} options.force - Force creation despite limits
   * @returns {Promise<{loopId: string, state: Object}>}
   */
  async createLoop(config, options = {}) {
    this.validateLoopConfig(config);
    await this.acquireLock('create-loop');

    try {
      const registry = this.loadRegistry();

      // Enforce concurrent loop limit
      if (registry.active_loops.length >= MAX_CONCURRENT_LOOPS) {
        const paths = this.calculateCommunicationPaths(registry.active_loops.length + 1);
        if (!options.force) {
          throw new Error(
            `Cannot create loop: ${registry.active_loops.length} loops already active ` +
              `(max: ${MAX_CONCURRENT_LOOPS}).\n` +
              `Adding another would create ${paths} communication paths (REF-088).\n` +
              `Use --force to override or complete/abort an existing loop.`
          );
        }
        // Log warning for post-analysis when --force used
        console.warn(`WARNING: Exceeding recommended MAX_CONCURRENT_LOOPS (${MAX_CONCURRENT_LOOPS})`);
        console.warn(`Communication paths: ${paths} (overhead increases quadratically)`);
      }

      const loopId = config.loopId || this.generateLoopId(config.objective);
      const loopDir = join(this.loopsDir, loopId);
      if (registry.active_loops.some(loop => loop.loop_id === loopId) || existsSync(loopDir)) {
        throw new Error(`Loop already exists: ${loopId}`);
      }
      mkdirSync(loopDir, { recursive: true });

      // Create subdirectories
      const subdirs = ['iterations', 'prompts', 'outputs', 'analysis', 'checkpoints'];
      for (const subdir of subdirs) {
        const path = join(loopDir, subdir);
        mkdirSync(path, { recursive: true });
      }

      // Initialize loop state
      const now = new Date().toISOString();
      const sessionId = randomUUID();

      const state = {
        version: STATE_VERSION,
        loopId,
        objective: config.objective,
        completionCriteria: config.completionCriteria,
        status: 'running',
        maxIterations: config.maxIterations ?? 10,
        currentIteration: 0,
        startTime: now,
        lastUpdate: now,
        sessionId,
        currentPid: process.pid,
        iterations: [],
        accumulatedLearnings: '',
        filesModified: [],
        giteaIntegration: config.giteaIntegration || null,
        config: {
          // #1450 P0: pin claude-sonnet-4-6 (500K); 'opus' bare alias under a
          // 1M-context parent hits credit gate on most plans. Budget bumped to
          // 5.0 to clear cache-creation cost (~$1.60 sonnet / ~$3.90 opus).
          model: config.model ?? 'claude-sonnet-4-6',
          budgetPerIteration: config.budgetPerIteration ?? 5.0,
          timeoutMinutes: config.timeoutMinutes ?? 60,
          mcpConfig: config.mcpConfig ?? null,
          workingDir: config.workingDir ?? this.projectRoot,
        },
      };

      // Save loop state
      const statePath = join(loopDir, 'session-state.json');
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      // Register in registry
      const registryEntry = {
        loop_id: loopId,
        task_summary: config.objective.slice(0, 200),
        status: 'running',
        started_at: now,
        owner: config.owner || `user:${process.env.USER || 'unknown'}`,
        pid: process.pid,
        iteration: 0,
        max_iterations: state.maxIterations,
        completion_criteria: config.completionCriteria,
        priority: config.priority || 'medium',
        tags: config.tags || [],
      };

      registry.active_loops.push(registryEntry);
      this.saveRegistry(registry);

      // Create backward compatibility symlink if only loop
      this.updateLegacySymlink();

      return { loopId, state };
    } finally {
      this.releaseLock('create-loop');
    }
  }

  /**
   * Get loop state by ID
   * @param {string} loopId - Loop ID
   * @returns {Object} Loop state
   */
  getLoop(loopId) {
    this.validateLoopId(loopId);
    const statePath = join(this.loopsDir, loopId, 'session-state.json');
    if (!existsSync(statePath)) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    try {
      const content = readFileSync(statePath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to load loop state: ${e.message}`);
    }
  }

  /**
   * Update loop state
   * @param {string} loopId - Loop ID
   * @param {Object} changes - State changes
   * @returns {Object} Updated state
   */
  updateLoop(loopId, changes) {
    this.validateLoopId(loopId);
    this.validateLoopChanges(changes);
    const state = this.getLoop(loopId);
    const updated = { ...state, ...changes };
    updated.lastUpdate = new Date().toISOString();

    const statePath = join(this.loopsDir, loopId, 'session-state.json');
    const tempPath = `${statePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(updated, null, 2));
    renameSync(tempPath, statePath);

    // Sync status changes to registry
    if (changes.status) {
      const registry = this.loadRegistry();
      const entry = registry.active_loops.find((l) => l.loop_id === loopId);
      if (entry) {
        entry.status = changes.status;
        this.saveRegistry(registry);
      }
    }

    return updated;
  }

  /**
   * List all active loops
   * @returns {RegistryEntry[]}
   */
  listActiveLoops() {
    const registry = this.loadRegistry();
    return registry.active_loops;
  }

  /**
   * Update loop PID for crash detection
   * @param {string} loopId - Loop ID
   * @param {number|null} pid - Process ID
   */
  async updateLoopPid(loopId, pid) {
    this.validateLoopId(loopId);
    if (pid !== null && (!Number.isInteger(pid) || pid < 1)) throw new RangeError('pid must be null or a positive integer');
    await this.acquireLock(`update-pid-${loopId}`);

    try {
      // Update loop state
      this.updateLoop(loopId, { currentPid: pid });

      // Update registry
      const registry = this.loadRegistry();
      const loop = registry.active_loops.find((l) => l.loop_id === loopId);
      if (loop) {
        loop.pid = pid;
        this.saveRegistry(registry);
      }
    } finally {
      this.releaseLock(`update-pid-${loopId}`);
    }
  }

  /**
   * Check if loop process is alive
   * @param {string} loopId - Loop ID
   * @returns {boolean}
   */
  isLoopAlive(loopId) {
    this.validateLoopId(loopId);
    try {
      const state = this.getLoop(loopId);
      if (!state.currentPid) return false;
      return this.processExists(state.currentPid);
    } catch {
      return false;
    }
  }

  /**
   * Archive completed loop
   * @param {string} loopId - Loop ID
   */
  async archiveLoop(loopId) {
    this.validateLoopId(loopId);
    await this.acquireLock(`archive-${loopId}`);

    try {
      const srcDir = join(this.loopsDir, loopId);
      const destDir = join(this.archiveDir, loopId);

      if (!existsSync(srcDir)) {
        throw new Error(`Loop directory not found: ${loopId}`);
      }

      // Move to archive
      renameSync(srcDir, destDir);

      // Update registry
      const registry = this.loadRegistry();
      const loopIndex = registry.active_loops.findIndex((l) => l.loop_id === loopId);
      if (loopIndex !== -1) {
        const loop = registry.active_loops[loopIndex];
        registry.active_loops.splice(loopIndex, 1);

        // Update counters
        if (loop.status === 'completed' || loop.status === 'completing') {
          registry.total_completed++;
        } else {
          registry.total_aborted++;
        }

        this.saveRegistry(registry);
      }

      // Update legacy symlink
      this.updateLegacySymlink();
    } finally {
      this.releaseLock(`archive-${loopId}`);
    }
  }

  /**
   * Update legacy session-state.json symlink for backward compatibility
   * If only one loop active, symlink to it
   */
  updateLegacySymlink() {
    const legacyPath = join(this.baseDir, 'session-state.json');

    // Remove existing symlink ONLY if it's actually a symlink
    // Do NOT delete regular files (StateManager uses this path for its state)
    if (existsSync(legacyPath)) {
      try {
        const stats = lstatSync(legacyPath);
        if (stats.isSymbolicLink()) {
          unlinkSync(legacyPath);
        } else {
          // Regular file exists - don't touch it, StateManager owns this
          return;
        }
      } catch {
        // Ignore errors
      }
    }

    const registry = this.loadRegistry();

    // If exactly one active loop, create symlink
    if (registry.active_loops.length === 1) {
      const loopId = registry.active_loops[0].loop_id;
      const targetPath = join('loops', loopId, 'session-state.json');
      try {
        symlinkSync(targetPath, legacyPath);
      } catch {
        // Ignore symlink errors (may not be supported)
      }
    }
  }

  /**
   * Detect crashed loops
   * @returns {RegistryEntry[]} Crashed loops
   */
  detectCrashedLoops() {
    const registry = this.loadRegistry();
    const crashed = [];

    for (const loop of registry.active_loops) {
      if (loop.status === 'running' && loop.pid) {
        if (!this.processExists(loop.pid)) {
          crashed.push(loop);
        }
      }
    }

    return crashed;
  }

  /**
   * Migrate legacy single-loop state to multi-loop structure
   * @returns {boolean} True if migration performed
   */
  async migrateLegacyState() {
    const legacyStatePath = join(this.baseDir, 'session-state.json');

    // Check if legacy state exists and is not a symlink
    if (!existsSync(legacyStatePath)) {
      return false;
    }

    try {
      const stats = lstatSync(legacyStatePath);
      if (stats.isSymbolicLink()) {
        // Already migrated
        return false;
      }
    } catch {
      return false;
    }

    await this.acquireLock('migrate-legacy');

    try {
      // Load legacy state
      const legacyState = JSON.parse(readFileSync(legacyStatePath, 'utf8'));

      // Generate loop ID from objective
      const loopId = this.generateLoopId(legacyState.objective || 'migrated-loop');

      // Create loop directory
      const loopDir = join(this.loopsDir, loopId);
      mkdirSync(loopDir, { recursive: true });

      // Move state file
      const newStatePath = join(loopDir, 'session-state.json');
      renameSync(legacyStatePath, newStatePath);

      // Move subdirectories if they exist
      const subdirs = ['iterations', 'prompts', 'outputs', 'analysis', 'checkpoints'];
      for (const subdir of subdirs) {
        const oldPath = join(this.baseDir, subdir);
        const newPath = join(loopDir, subdir);
        if (existsSync(oldPath)) {
          renameSync(oldPath, newPath);
        }
      }

      // Register in registry
      const registry = this.loadRegistry();
      const registryEntry = {
        loop_id: loopId,
        task_summary: (legacyState.objective || 'Migrated loop').slice(0, 200),
        status: legacyState.status || 'running',
        started_at: legacyState.startTime || new Date().toISOString(),
        owner: `user:${process.env.USER || 'unknown'}`,
        pid: legacyState.currentPid || null,
        iteration: legacyState.currentIteration || 0,
        max_iterations: legacyState.maxIterations || 10,
        completion_criteria: legacyState.completionCriteria || 'unknown',
        priority: 'medium',
        tags: ['migrated'],
      };

      registry.active_loops.push(registryEntry);
      this.saveRegistry(registry);

      // Create symlink for backward compatibility
      this.updateLegacySymlink();

      console.log(`Migrated legacy state to loop: ${loopId}`);
      return true;
    } finally {
      this.releaseLock('migrate-legacy');
    }
  }

  /**
   * Get loop directory path
   * @param {string} loopId - Loop ID
   * @returns {string}
   */
  getLoopDir(loopId) {
    this.validateLoopId(loopId);
    return join(this.loopsDir, loopId);
  }

  /**
   * Get iteration directory path
   * @param {string} loopId - Loop ID
   * @param {number} iteration - Iteration number
   * @returns {string}
   */
  getIterationDir(loopId, iteration) {
    this.validateLoopId(loopId);
    if (!Number.isInteger(iteration) || iteration < 0) throw new RangeError('iteration must be a non-negative integer');
    return join(this.loopsDir, loopId, 'iterations', String(iteration).padStart(3, '0'));
  }

  /**
   * Get prompt file path
   * @param {string} loopId - Loop ID
   * @param {number} iteration - Iteration number
   * @returns {string}
   */
  getPromptPath(loopId, iteration) {
    this.validateLoopId(loopId);
    if (!Number.isInteger(iteration) || iteration < 0) throw new RangeError('iteration must be a non-negative integer');
    return join(this.loopsDir, loopId, 'prompts', `${String(iteration).padStart(3, '0')}-prompt.md`);
  }

  /**
   * Get output file paths
   * @param {string} loopId - Loop ID
   * @param {number} iteration - Iteration number
   * @returns {{stdout: string, stderr: string}}
   */
  getOutputPaths(loopId, iteration) {
    this.validateLoopId(loopId);
    if (!Number.isInteger(iteration) || iteration < 0) throw new RangeError('iteration must be a non-negative integer');
    const prefix = String(iteration).padStart(3, '0');
    return {
      stdout: join(this.loopsDir, loopId, 'outputs', `${prefix}-stdout.log`),
      stderr: join(this.loopsDir, loopId, 'outputs', `${prefix}-stderr.log`),
    };
  }

  validateLoopId(loopId) {
    if (typeof loopId !== 'string' || !LOOP_ID_PATTERN.test(loopId)) {
      throw new TypeError('loopId must match ralph-{slug}-{8 lowercase hex characters}');
    }
  }

  validateLoopConfig(config) {
    if (!config || typeof config !== 'object') throw new TypeError('Loop configuration must be an object');
    if (typeof config.objective !== 'string' || config.objective.trim().length === 0) throw new TypeError('objective must be a non-empty string');
    if (typeof config.completionCriteria !== 'string' || config.completionCriteria.trim().length === 0) throw new TypeError('completionCriteria must be a non-empty string');
    if (config.loopId !== undefined) this.validateLoopId(config.loopId);
    if (config.maxIterations !== undefined && (!Number.isInteger(config.maxIterations) || config.maxIterations < 1)) throw new RangeError('maxIterations must be a positive integer');
    for (const name of ['budgetPerIteration', 'timeoutMinutes']) {
      if (config[name] !== undefined && (typeof config[name] !== 'number' || !Number.isFinite(config[name]) || config[name] <= 0)) throw new RangeError(`${name} must be a finite positive number`);
    }
    for (const name of ['model', 'workingDir', 'owner']) {
      if (config[name] !== undefined && (typeof config[name] !== 'string' || config[name].trim().length === 0)) throw new TypeError(`${name} must be a non-empty string`);
    }
    if (config.priority !== undefined && !LOOP_PRIORITIES.has(config.priority)) throw new TypeError(`Invalid priority: ${config.priority}`);
    if (config.tags !== undefined && (!Array.isArray(config.tags) || config.tags.some(tag => typeof tag !== 'string'))) throw new TypeError('tags must be an array of strings');
    for (const name of ['mcpConfig', 'giteaIntegration']) {
      if (config[name] !== undefined && config[name] !== null && (typeof config[name] !== 'object' || Array.isArray(config[name]))) throw new TypeError(`${name} must be an object or null`);
    }
  }

  validateLoopChanges(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Loop changes must be an object');
    if (changes.loopId !== undefined || changes.version !== undefined || changes.sessionId !== undefined) throw new TypeError('Loop identity fields cannot be changed');
    if (changes.status !== undefined && !LOOP_STATUSES.has(changes.status)) throw new TypeError(`Invalid loop status: ${changes.status}`);
    if (changes.currentIteration !== undefined && (!Number.isInteger(changes.currentIteration) || changes.currentIteration < 0)) throw new RangeError('currentIteration must be a non-negative integer');
    if (changes.maxIterations !== undefined && (!Number.isInteger(changes.maxIterations) || changes.maxIterations < 1)) throw new RangeError('maxIterations must be a positive integer');
    if (changes.currentPid !== undefined && changes.currentPid !== null && (!Number.isInteger(changes.currentPid) || changes.currentPid < 1)) throw new RangeError('currentPid must be null or a positive integer');
  }
}

export default ExternalMultiLoopStateManager;
