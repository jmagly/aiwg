/**
 * State Manager for External Ralph Loop
 *
 * Provides atomic state persistence with backup/recovery support.
 * State is stored in .aiwg/ralph-external/ directory.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 */

import { existsSync, mkdirSync, copyFileSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

/**
 * @typedef {Object} IterationRecord
 * @property {number} number - Iteration number
 * @property {string} sessionId - Claude session ID
 * @property {string} promptFile - Path to prompt file
 * @property {string} stdoutFile - Path to stdout capture
 * @property {string} stderrFile - Path to stderr capture
 * @property {number} exitCode - Process exit code
 * @property {number} duration - Duration in milliseconds
 * @property {string} status - completed|failed|crashed
 * @property {Object} analysis - Output analysis result
 * @property {string[]} learnings - Extracted learnings
 * @property {string[]} filesModified - Files changed during iteration
 * @property {string} progress - Progress summary
 */

/**
 * @typedef {Object} GiteaIntegration
 * @property {boolean} enabled - Whether Gitea tracking is enabled
 * @property {string} owner - Repository owner
 * @property {string} repo - Repository name
 * @property {number} issueNumber - Issue number for tracking
 * @property {number} [lastCommentId] - ID of last progress comment
 */

/**
 * @typedef {Object} LoopState
 * @property {string} version - State schema version
 * @property {string} loopId - Unique loop identifier
 * @property {string} objective - Full objective text
 * @property {string} completionCriteria - Verifiable completion criteria
 * @property {string} status - running|completed|failed|paused|aborted
 * @property {number} maxIterations - Maximum external iterations
 * @property {number} currentIteration - Current iteration number
 * @property {string} startTime - ISO timestamp of loop start
 * @property {string} lastUpdate - ISO timestamp of last update
 * @property {string} sessionId - Base session ID for Claude
 * @property {number} [currentPid] - PID of current Claude process
 * @property {IterationRecord[]} iterations - History of iterations
 * @property {string} accumulatedLearnings - Combined learnings from all iterations
 * @property {string[]} filesModified - All files modified across iterations
 * @property {GiteaIntegration} [giteaIntegration] - Gitea issue tracking
 * @property {Object} config - Original configuration
 */

const STATE_VERSION = '1.0.0';
const STATE_FILENAME = 'session-state.json';
const BACKUP_SUFFIX = '.bak';

export class StateManager {
  /**
   * @param {string} projectRoot - Project root directory
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.stateDir = join(projectRoot, '.aiwg', 'ralph-external');
    this.statePath = join(this.stateDir, STATE_FILENAME);
    this.backupPath = `${this.statePath}${BACKUP_SUFFIX}`;
  }

  /**
   * Initialize a new loop state
   * @param {Object} config - Loop configuration
   * @returns {LoopState}
   */
  initialize(config) {
    const now = new Date().toISOString();
    const loopId = config.loopId || randomUUID();
    const sessionId = randomUUID();

    /** @type {LoopState} */
    const state = {
      version: STATE_VERSION,
      loopId,
      objective: config.objective,
      completionCriteria: config.completionCriteria,
      status: 'running',
      maxIterations: config.maxIterations || 10,
      currentIteration: 0,
      startTime: now,
      lastUpdate: now,
      sessionId,
      currentPid: null,
      iterations: [],
      accumulatedLearnings: '',
      filesModified: [],
      giteaIntegration: config.giteaIntegration || null,
      config: {
        provider: config.provider || 'claude',
        ...(config.groupWorker ? { groupWorker: config.groupWorker } : {}),
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.workerTier === undefined ? {} : { workerTier: config.workerTier }),
        ...(config.modelElection === undefined ? {} : { modelElection: config.modelElection }),
        budgetPerIteration: config.budgetPerIteration || 2.0,
        budgetLimits: config.budgetLimits || {},
        explorationQuota: config.explorationQuota || { enabled: false },
        budgetStopPolicy: config.budgetStopPolicy || 'completion-wins',
        // Eval-harness contract + execution mode (LFD Track 3, #1776)
        evalHarness: config.evalHarness || null,
        executionMode: config.executionMode || 'default',
        timeoutMinutes: config.timeoutMinutes || 60,
        mcpConfig: config.mcpConfig || null,
        workingDir: config.workingDir || this.projectRoot,
        // Enhanced capture options
        verbose: config.verbose || false,
        checkpointIntervalMinutes: config.checkpointIntervalMinutes || 30,
        enableCheckpoints: config.enableCheckpoints !== false,
        enableSnapshots: config.enableSnapshots !== false,
        useClaudeAssessment: config.useClaudeAssessment || false,
        keyFiles: config.keyFiles || [],
        // Research-backed options
        memory: config.memory || 3,
        crossTask: config.crossTask !== false,
        enableAnalytics: config.enableAnalytics !== false,
        enableBestOutput: config.enableBestOutput !== false,
        enableEarlyStopping: config.enableEarlyStopping !== false,
        // Epic #26 options
        enablePIDControl: config.enablePIDControl !== false,
        enableOverseer: config.enableOverseer !== false,
        enableSemanticMemory: config.enableSemanticMemory !== false,
        enableClaudeIntelligence: config.enableClaudeIntelligence !== false,
      },
    };

    // Ensure state directory exists
    this.ensureStateDir();

    // Save initial state
    this.save(state);

    return state;
  }

  /**
   * Ensure state directory exists
   */
  ensureStateDir() {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }

    // Create subdirectories
    const subdirs = ['iterations', 'prompts', 'outputs', 'analysis'];
    for (const subdir of subdirs) {
      const path = join(this.stateDir, subdir);
      if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
      }
    }
  }

  /**
   * Check if a loop state exists
   * @returns {boolean}
   */
  exists() {
    return existsSync(this.statePath);
  }

  /**
   * Load existing state with recovery from backup
   * @returns {LoopState|null}
   */
  load() {
    if (!this.exists()) {
      return null;
    }

    try {
      const content = readFileSync(this.statePath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      // Try backup
      if (existsSync(this.backupPath)) {
        try {
          const backupContent = readFileSync(this.backupPath, 'utf8');
          const state = JSON.parse(backupContent);
          // Restore from backup
          this.save(state);
          return state;
        } catch (backupError) {
          throw new Error(`State corrupted and backup recovery failed: ${backupError.message}`);
        }
      }
      throw new Error(`Failed to load state: ${e.message}`);
    }
  }

  /**
   * Save state atomically with backup
   * @param {LoopState} state
   */
  save(state) {
    this.ensureStateDir();

    // Update timestamp
    state.lastUpdate = new Date().toISOString();

    // Create backup of existing state
    if (existsSync(this.statePath)) {
      copyFileSync(this.statePath, this.backupPath);
    }

    // Write to temp file then rename (atomic)
    const tempPath = `${this.statePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2));
    renameSync(tempPath, this.statePath);
  }

  /**
   * Update state with partial changes
   * @param {Partial<LoopState>} changes
   * @returns {LoopState}
   */
  update(changes) {
    const state = this.load();
    if (!state) {
      throw new Error('No existing state to update');
    }

    const updated = { ...state, ...changes };
    this.save(updated);
    return updated;
  }

  /**
   * Add an iteration record
   * @param {IterationRecord} iteration
   * @returns {LoopState}
   */
  addIteration(iteration) {
    const state = this.load();
    if (!state) {
      throw new Error('No existing state');
    }

    state.iterations.push(iteration);

    // Merge learnings
    if (iteration.learnings && iteration.learnings.length > 0) {
      const newLearnings = iteration.learnings.join('\n');
      state.accumulatedLearnings = state.accumulatedLearnings
        ? `${state.accumulatedLearnings}\n\n### Iteration ${iteration.number}\n${newLearnings}`
        : `### Iteration ${iteration.number}\n${newLearnings}`;
    }

    // Merge files modified
    if (iteration.filesModified) {
      const existingFiles = new Set(state.filesModified);
      for (const file of iteration.filesModified) {
        existingFiles.add(file);
      }
      state.filesModified = Array.from(existingFiles);
    }

    this.save(state);
    return state;
  }

  /**
   * Set current process PID
   * @param {number|null} pid
   */
  setCurrentPid(pid) {
    this.update({ currentPid: pid });
  }

  /**
   * Set loop status
   * @param {string} status
   */
  setStatus(status) {
    this.update({ status });
  }

  /**
   * Get iteration directory path
   * @param {number} iteration
   * @returns {string}
   */
  getIterationDir(iteration) {
    return join(this.stateDir, 'iterations', String(iteration).padStart(3, '0'));
  }

  /**
   * Get prompt file path
   * @param {number} iteration
   * @returns {string}
   */
  getPromptPath(iteration) {
    return join(this.stateDir, 'prompts', `${String(iteration).padStart(3, '0')}-prompt.md`);
  }

  /**
   * Get output file paths
   * @param {number} iteration
   * @returns {{stdout: string, stderr: string}}
   */
  getOutputPaths(iteration) {
    const prefix = String(iteration).padStart(3, '0');
    return {
      stdout: join(this.stateDir, 'outputs', `${prefix}-stdout.log`),
      stderr: join(this.stateDir, 'outputs', `${prefix}-stderr.log`),
    };
  }

  /**
   * Get analysis file path
   * @param {number} iteration
   * @returns {string}
   */
  getAnalysisPath(iteration) {
    return join(this.stateDir, 'analysis', `${String(iteration).padStart(3, '0')}-analysis.json`);
  }

  /**
   * Save analysis result
   * @param {number} iteration
   * @param {Object} analysis
   */
  saveAnalysis(iteration, analysis) {
    const path = this.getAnalysisPath(iteration);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(analysis, null, 2));
  }

  /**
   * Clear state (for cleanup/abort)
   */
  clear() {
    if (existsSync(this.statePath)) {
      const state = this.load();
      if (state) {
        state.status = 'aborted';
        this.save(state);
      }
    }
  }

  /**
   * Get state directory path
   * @returns {string}
   */
  getStateDir() {
    return this.stateDir;
  }

  /**
   * Re-scope all file I/O to a new directory.
   *
   * Call this before initialize() to route state into an isolated per-loop
   * directory (e.g. after receiving a loopId from ExternalMultiLoopStateManager).
   *
   * @param {string} dir - Absolute path to the new state directory
   */
  setStateDir(dir) {
    this.stateDir = dir;
    this.statePath = join(dir, STATE_FILENAME);
    this.backupPath = `${this.statePath}${BACKUP_SUFFIX}`;
  }
}

// Re-export multi-loop manager for backward compatibility and future use
export { ExternalMultiLoopStateManager } from './external-multi-loop-state-manager.mjs';

export default StateManager;
