/**
 * Orchestrator for External Ralph Loop
 *
 * Main loop logic that coordinates session launching, output analysis,
 * and state management for the external Ralph supervisor.
 *
 * Enhanced with comprehensive state capture for long-running sessions (6-8 hours):
 * - Pre/post session snapshots (git, .aiwg, file hashes)
 * - Periodic checkpoints during sessions
 * - Two-phase state assessment (orient + prompt generation)
 * - Session transcript and stream-json capture
 *
 * Epic #26 Integration:
 * - PID Control Layer: Dynamic parameter adjustment
 * - Claude Intelligence Layer: Strategic planning and validation
 * - Memory Layer: Cross-loop learning and knowledge persistence
 * - Overseer Layer: Health monitoring and intervention
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { StateManager } from './state-manager.mjs';
import { SessionLauncher } from './session-launcher.mjs';
import { OutputAnalyzer } from './output-analyzer.mjs';
import { PromptGenerator } from './prompt-generator.mjs';
import { SnapshotManager } from './snapshot-manager.mjs';
import { launchRalphCycle } from './lib/ralph-cycle-launch.mjs';
import { processLoopControl } from './lib/loop-pid-control.mjs';
import { handleInitializationFailure, recordedOutputs, noRecordedOutput } from './lib/loop-initialization.mjs';
import { StateAssessor } from './state-assessor.mjs';
// Research-backed modules (REF-015 Self-Refine, REF-021 Reflexion)
import { BestOutputTracker } from './best-output-tracker.mjs';
import { MemoryManager } from './memory-manager.mjs';
import { EarlyStopping } from './early-stopping.mjs';
import { IterationAnalytics } from './iteration-analytics.mjs';
import { EvalHarness, statusToVerification } from './eval-harness.mjs';
import { CrossTaskLearner } from './cross-task-learner.mjs';
// Multi-loop coordination (REF-086, REF-088)
import { ExternalMultiLoopStateManager } from './external-multi-loop-state-manager.mjs';
// Process reliability (Phase 4)
import { ProcessMonitor } from './process-monitor.mjs';
import { RecoveryEngine } from './recovery-engine.mjs';

// ========== EPIC #26 COMPONENTS ==========
// PID Control Layer (#23)
import { PIDController } from './pid-controller.mjs';
import { GainScheduler } from './gain-scheduler.mjs';
import { MetricsCollector } from './metrics-collector.mjs';
import { ControlAlarms } from './control-alarms.mjs';

// Claude Intelligence Layer (#22)
import { ClaudePromptGenerator } from './lib/claude-prompt-generator.mjs';
import { ValidationAgent } from './lib/validation-agent.mjs';
import { StrategyPlanner } from './lib/strategy-planner.mjs';

// Memory Layer (#24)
import { SemanticMemory } from './lib/semantic-memory.mjs';
import { MemoryPromotion } from './lib/memory-promotion.mjs';
import { LearningExtractor } from './lib/learning-extractor.mjs';
import { MemoryRetrieval } from './lib/memory-retrieval.mjs';

// Overseer Layer (#25)
import { Overseer } from './lib/overseer.mjs';
import { BehaviorDetector } from './lib/behavior-detector.mjs';
import { InterventionSystem } from './lib/intervention-system.mjs';
import { EscalationHandler } from './lib/escalation-handler.mjs';

// Multi-Provider Support
import { createProvider, ensureProvidersRegistered } from './lib/provider-adapter.mjs';

/**
 * @typedef {Object} OrchestratorConfig
 * @property {string} objective - Task objective
 * @property {string} completionCriteria - Completion criteria
 * @property {number} [maxIterations=5] - Maximum external iterations
 * @property {string} [model='opus'] - Claude model
 * @property {number} [budgetPerIteration=2.0] - Budget per iteration USD
 * @property {Object} [budgetLimits] - Hard cumulative LFD budget ceilings
 * @property {Object} [explorationQuota] - Flat-cycle structural-variation control
 * @property {number} [timeoutMinutes=60] - Timeout per iteration
 * @property {Object} [groupWorker] - Optional existing managed resolver request (intent + prepared brief)
 * @property {Object} [mcpConfig] - MCP server configuration
 * @property {string} [workingDir] - Working directory
 * @property {Object} [giteaIntegration] - Gitea issue tracking
 * @property {boolean} [verbose=false] - Enable verbose Claude output
 * @property {number} [checkpointIntervalMinutes=30] - Checkpoint interval
 * @property {boolean} [enableCheckpoints=true] - Enable periodic checkpoints
 * @property {boolean} [enableSnapshots=true] - Enable pre/post session snapshots
 * @property {boolean} [useClaudeAssessment=false] - Use Claude for state assessment
 * @property {string[]} [keyFiles=[]] - Key files to track hashes
 * @property {number} [memory=3] - Memory capacity Ω for MemoryManager (REF-021)
 * @property {boolean} [crossTask=true] - Enable cross-task learning
 * @property {boolean} [enableAnalytics=true] - Enable iteration analytics
 * @property {boolean} [enableBestOutput=true] - Enable best output tracking (REF-015)
 * @property {boolean} [enableEarlyStopping=true] - Enable early stopping on high confidence
 * @property {boolean} [force=false] - Force creation despite concurrent loop limit
 * @property {boolean} [enablePIDControl=true] - Enable PID control system
 * @property {boolean} [enableOverseer=true] - Enable overseer monitoring
 * @property {boolean} [enableSemanticMemory=true] - Enable semantic memory
 * @property {string} [provider='claude'] - CLI provider (claude, codex)
 */

/**
 * @typedef {Object} OrchestratorResult
 * @property {boolean} success - Whether loop completed successfully
 * @property {string} reason - Reason for completion/failure
 * @property {number} iterations - Number of iterations executed
 * @property {string} loopId - Loop identifier
 */

export class Orchestrator {
  /**
   * @param {string} projectRoot - Project root directory
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.stateManager = new StateManager(projectRoot);
    this.sessionLauncher = new SessionLauncher();
    this.outputAnalyzer = new OutputAnalyzer();
    this.promptGenerator = new PromptGenerator();
    this.snapshotManager = new SnapshotManager(projectRoot);
    this.checkpointManager = null; // Created per-session with config
    this.stateAssessor = new StateAssessor({ projectRoot });
    this.aborted = false;
    this.currentPreSnapshot = null;

    // Research-backed modules (initialized per-loop in execute())
    this.bestOutputTracker = null;
    this.memoryManager = null;
    this.earlyStopping = null;
    this.iterationAnalytics = null;
    this.evalHarness = null;
    this.crossTaskLearner = null;
    this.crossTaskLearnings = null;

    // Multi-loop coordination (initialized lazily)
    this.multiLoopManager = null;
    this.registeredLoopId = null;

    // Process reliability (Phase 4)
    this.processMonitor = null;
    this.recoveryEngine = new RecoveryEngine(projectRoot);

    // ========== EPIC #26 COMPONENTS ==========
    // PID Control Layer
    this.pidController = null;
    this.gainScheduler = null;
    this.metricsCollector = null;
    this.controlAlarms = null;

    // Claude Intelligence Layer
    this.claudePromptGenerator = null;
    this.validationAgent = null;
    this.strategyPlanner = null;

    // Memory Layer
    this.semanticMemory = null;
    this.memoryPromotion = null;
    this.learningExtractor = null;
    this.memoryRetrieval = null;

    // Overseer Layer
    this.overseer = null;
    this.behaviorDetector = null;
    this.interventionSystem = null;
    this.escalationHandler = null;
  }

  /**
   * Log a message only when verbose mode is enabled.
   * @param {string} msg
   * @param {*} [data]
   */
  verboseLog(msg, data) {
    if (!this._verbose) return;
    if (data !== undefined) {
      console.log(`[External Ralph][VERBOSE] ${msg}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    } else {
      console.log(`[External Ralph][VERBOSE] ${msg}`);
    }
  }

  /**
   * Execute the external Ralph loop
   * @param {OrchestratorConfig} config
   * @returns {Promise<OrchestratorResult>}
   */
  async execute(config) {
    this._verbose = config.verbose || false;

    // ========== MULTI-PROVIDER SUPPORT ==========
    await ensureProvidersRegistered();
    const providerName = config.provider || 'claude';
    this.providerAdapter = createProvider(providerName);
    this.sessionLauncher.setProviderAdapter(this.providerAdapter);
    this.outputAnalyzer.setProviderAdapter(this.providerAdapter);
    this.stateAssessor.setProviderAdapter(this.providerAdapter);
    console.log(`[External Ralph] Provider: ${providerName}`);

    // ========== MULTI-LOOP COORDINATION (REF-086, REF-088) ==========
    // Registration happens BEFORE stateManager.initialize() so we can scope
    // the StateManager to the per-loop directory before any files are written,
    // preventing collisions between concurrent loops (#586).
    try {
      this.multiLoopManager = new ExternalMultiLoopStateManager(this.projectRoot);
      this.multiLoopManager.ensureBaseDir();

      // Check concurrent loop limit
      const activeLoops = this.multiLoopManager.listActiveLoops();
      console.log(`[External Ralph] Active loops: ${activeLoops.length}`);

      // Register this loop (will enforce limit unless --force was used)
      const registration = await this.multiLoopManager.createLoop(
        {
          objective: config.objective,
          completionCriteria: config.completionCriteria,
          loopId: config.loopId || config.groupWorker?.managedIntent?.parent?.id || process.env.RALPH_LOOP_ID,
          maxIterations: config.maxIterations || 5,
          model: config.model || 'opus',
          budgetPerIteration: config.budgetPerIteration || 2.0,
          budgetLimits: config.budgetLimits || {},
          explorationQuota: config.explorationQuota || { enabled: false },
          timeoutMinutes: config.timeoutMinutes || 60,
          mcpConfig: config.mcpConfig,
          workingDir: config.workingDir || this.projectRoot,
          giteaIntegration: config.giteaIntegration,
        },
        { force: config.force || false }
      );

      this.registeredLoopId = registration.loopId;
      console.log(`[External Ralph] Registered in multi-loop registry: ${registration.loopId}`);

      // Re-scope StateManager to the per-loop directory so all file I/O
      // (session-state.json, iterations/, prompts/, outputs/, analysis/)
      // is isolated from other concurrent loops.
      const loopDir = join(this.projectRoot, '.aiwg', 'ralph-external', 'loops', this.registeredLoopId);
      this.stateManager.setStateDir(loopDir);
    } catch (error) {
      // If multi-loop manager fails, continue with single-loop mode (flat dir)
      console.warn(`[External Ralph] Multi-loop coordination unavailable: ${error.message}`);
      console.log('[External Ralph] Continuing in single-loop mode');
    }

    // Initialize state — now in the per-loop dir if registered, flat dir otherwise
    const state = this.stateManager.initialize({
      objective: config.objective,
      completionCriteria: config.completionCriteria,
      maxIterations: config.maxIterations || 5,
      provider: providerName,
      loopId: this.registeredLoopId ?? config.loopId ?? config.groupWorker?.managedIntent?.parent?.id,
      groupWorker: config.groupWorker,
      model: config.model || 'opus',
      budgetPerIteration: config.budgetPerIteration || 2.0,
      budgetLimits: config.budgetLimits || {},
      explorationQuota: config.explorationQuota || { enabled: false },
      budgetStopPolicy: config.budgetStopPolicy || 'completion-wins',
      evalHarness: config.evalHarness || null,
      executionMode: config.executionMode || 'default',
      timeoutMinutes: config.timeoutMinutes || 60,
      mcpConfig: config.mcpConfig,
      workingDir: config.workingDir || this.projectRoot,
      giteaIntegration: config.giteaIntegration,
      // Enhanced capture options
      verbose: config.verbose || false,
      checkpointIntervalMinutes: config.checkpointIntervalMinutes || 30,
      enableCheckpoints: config.enableCheckpoints !== false,
      enableSnapshots: config.enableSnapshots !== false,
      useClaudeAssessment: config.useClaudeAssessment || false,
      keyFiles: config.keyFiles || [],
      // Research-backed options (REF-015, REF-021)
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
    });

    console.log(`[External Ralph] Starting loop ${state.loopId}`);
    console.log(`[External Ralph] Objective: ${config.objective}`);
    console.log(`[External Ralph] Max iterations: ${state.maxIterations}`);
    if (state.config.enableSnapshots) {
      console.log('[External Ralph] Pre/post session snapshots: ENABLED');
    }
    if (state.config.enableCheckpoints) {
      console.log(`[External Ralph] Periodic checkpoints: ENABLED (${state.config.checkpointIntervalMinutes} min)`);
    }

    // ========== INITIALIZE RESEARCH + CONTROL MODULES ==========
    this.initializeModules(state, providerName);

    // ========== PROCESS MONITOR (Phase 4) ==========
    this.processMonitor = new ProcessMonitor({
      projectRoot: this.projectRoot,
      heartbeatIntervalMs: 30000, // 30 seconds
      staleThresholdMs: 120000, // 2 minutes
    });

    // Record initial heartbeat
    this.processMonitor.recordHeartbeat(state.loopId, {
      iteration: 0,
      status: 'starting',
    });
    console.log('[External Ralph] Process monitoring: ENABLED');

    return this.runLoop(state);
  }

  /**
   * Initialize research, control, intelligence, memory, and overseer modules.
   *
   * Shared by execute() and resume() so resumed loops carry the same control
   * surface — LFD budget stops, exploration quota, analytics, best-output
   * selection, early stopping — as fresh loops. Before #1765 resume() skipped
   * this entirely, silently disabling every LFD control on the recovery path.
   *
   * @param {Object} state - Loop state
   * @param {string} providerName - Active provider name
   * @param {{resume?: boolean}} [opts] - resume=true restores persisted analytics counters
   */
  initializeModules(state, providerName, { resume = false } = {}) {
    const stateDir = this.stateManager.getStateDir();

    // Best Output Tracker (REF-015 Self-Refine)
    if (state.config.enableBestOutput) {
      this.bestOutputTracker = new BestOutputTracker(state.loopId, { storage_path: stateDir });
      console.log('[External Ralph] Best output tracking: ENABLED (REF-015)');
    }

    // Memory Manager (REF-021 Reflexion)
    this.memoryManager = new MemoryManager({
      stateDir,
      capacity: state.config.memory,
    });
    console.log(`[External Ralph] Memory manager: ENABLED (Ω=${state.config.memory})`);

    // Early Stopping
    if (state.config.enableEarlyStopping) {
      this.earlyStopping = new EarlyStopping({
        confidenceThreshold: 0.95,
        minIterations: 2,
        requireVerification: true,
      });
      console.log('[External Ralph] Early stopping: ENABLED');
    }

    // Eval Harness (LFD Track 3, #1776) — opt-in. When a loop declares an
    // eval-harness contract, each iteration is scored by the harness; a lint
    // violation VOIDs the iteration and only VOID-safe aggregate feedback
    // reaches the agent. Holdout isolation is strict under holdout-isolated mode.
    if (state.config.evalHarness) {
      this.evalHarness = new EvalHarness(state.config.evalHarness, {
        workingDir: state.config.workingDir || this.projectRoot,
        executionMode: state.config.executionMode || 'default',
      });
      console.log(`[External Ralph] Eval harness: ENABLED (execution-mode: ${state.config.executionMode || 'default'})`);
    }

    // Iteration Analytics — cumulative budget counters MUST survive resume,
    // otherwise any crash/restart resets declared ceilings to zero (#1765).
    if (state.config.enableAnalytics) {
      const analyticsDir = join(stateDir, 'analytics');
      const analyticsFile = join(analyticsDir, `${state.loopId}.json`);
      let restored = false;

      if (resume && existsSync(analyticsFile)) {
        try {
          this.iterationAnalytics = IterationAnalytics.load(analyticsFile);
          this.iterationAnalytics.config.storagePath = analyticsDir;
          this.iterationAnalytics.config.budgetLimits = state.config.budgetLimits || {};
          this.iterationAnalytics.config.explorationQuota =
            state.config.explorationQuota || { enabled: false };
          restored = true;
          console.log(`[External Ralph] Iteration analytics: RESTORED (${this.iterationAnalytics.iterations.length} prior iterations)`);
        } catch (error) {
          console.warn(`[External Ralph] Analytics restore failed (${error.message}); starting fresh counters`);
        }
      }

      if (!restored) {
        this.iterationAnalytics = new IterationAnalytics(
          state.loopId,
          state.objective,
          {
            storagePath: analyticsDir,
            budgetLimits: state.config.budgetLimits || {},
            explorationQuota: state.config.explorationQuota || { enabled: false },
          }
        );
        console.log('[External Ralph] Iteration analytics: ENABLED');
      }

      if (Object.keys(state.config.budgetLimits || {}).length > 0) {
        console.log(`[External Ralph] LFD hard budgets: ${JSON.stringify(state.config.budgetLimits)}`);
      }
    }

    // Cross-Task Learner
    if (state.config.crossTask) {
      this.crossTaskLearner = new CrossTaskLearner({
        memory_path: join(this.projectRoot, '.aiwg', 'ralph', 'memory'),
      });
      // Get relevant learnings before starting
      this.crossTaskLearnings = this.crossTaskLearner.getRelevantLearnings(state.objective);
      if (this.crossTaskLearnings.similar_tasks.length > 0) {
        console.log(`[External Ralph] Cross-task learning: Found ${this.crossTaskLearnings.similar_tasks.length} similar tasks`);
      } else {
        console.log('[External Ralph] Cross-task learning: ENABLED (no similar tasks found)');
      }
    }

    // ========== INITIALIZE EPIC #26 COMPONENTS ==========

    // PID Control Layer
    if (state.config.enablePIDControl) {
      this.metricsCollector = new MetricsCollector({
        windowSize: 5,
        integralDecay: 0.9,
        noiseThreshold: 0.05,
      });

      this.gainScheduler = new GainScheduler();

      this.pidController = new PIDController({
        kp: 0.5,  // Initial proportional gain
        ki: 0.2,  // Initial integral gain
        kd: 0.3,  // Initial derivative gain
        outputMin: 0,
        outputMax: 1,
      });

      this.controlAlarms = new ControlAlarms({
        projectRoot: this.projectRoot,
        loopId: state.loopId,
      });

      console.log('[External Ralph] PID control system: ENABLED (#23)');
    }

    // Claude Intelligence Layer
    if (state.config.enableClaudeIntelligence !== false) {
      if (providerName === 'claude') {
        this.claudePromptGenerator = new ClaudePromptGenerator({
          projectRoot: this.projectRoot,
        });
        if (this.providerAdapter) {
          this.claudePromptGenerator.setProviderAdapter(this.providerAdapter);
        }
      } else {
        console.log(`[External Ralph] Dynamic Claude prompt generation: DISABLED for provider ${providerName}`);
      }

      this.validationAgent = new ValidationAgent({
        projectRoot: this.projectRoot,
      });

      this.strategyPlanner = new StrategyPlanner({
        projectRoot: this.projectRoot,
      });

      console.log('[External Ralph] Claude intelligence layer: ENABLED (#22)');
    }

    // Memory Layer
    if (state.config.enableSemanticMemory) {
      const memoryPath = join(this.projectRoot, '.aiwg', 'ralph', 'semantic-memory');

      this.semanticMemory = new SemanticMemory(memoryPath);

      this.memoryPromotion = new MemoryPromotion(memoryPath);

      this.learningExtractor = new LearningExtractor({
        projectRoot: this.projectRoot,
      });

      this.memoryRetrieval = new MemoryRetrieval(memoryPath);

      console.log('[External Ralph] Semantic memory layer: ENABLED (#24)');
    }

    // Overseer Layer
    if (state.config.enableOverseer) {
      this.behaviorDetector = new BehaviorDetector({
        projectRoot: this.projectRoot,
      });

      this.interventionSystem = new InterventionSystem({
        projectRoot: this.projectRoot,
      });

      this.escalationHandler = new EscalationHandler({
        projectRoot: this.projectRoot,
        loopId: state.loopId,
      });

      this.overseer = new Overseer({
        projectRoot: this.projectRoot,
        loopId: state.loopId,
        behaviorDetector: this.behaviorDetector,
        interventionSystem: this.interventionSystem,
        escalationHandler: this.escalationHandler,
      });

      console.log('[External Ralph] Overseer monitoring: ENABLED (#25)');
    }
  }

  /**
   * Resume an interrupted loop
   * @param {Object} [overrides] - Configuration overrides
   * @param {boolean} [overrides.allowExhaustedResume=false] - Explicitly permit
   *   resuming a loop whose declared budget ceilings are already exhausted
   * @returns {Promise<OrchestratorResult>}
   */
  async resume(overrides = {}) {
    const state = this.stateManager.load();
    if (!state) {
      throw new Error('No external Ralph loop to resume');
    }

    // A budget-exhausted loop must not silently regain a fresh budget (#1765)
    if (state.status === 'budget_exhausted' && !overrides.allowExhaustedResume) {
      throw new Error(
        'Loop ended with status budget_exhausted; resuming would bypass its declared ceilings. ' +
        'Raise the relevant --max-* limits and pass --allow-exhausted-resume to continue.'
      );
    }

    console.log(`[External Ralph] Resuming loop ${state.loopId}`);
    console.log(`[External Ralph] Current iteration: ${state.currentIteration}`);

    // Re-establish the provider adapter — before #1765 resumed loops ran with
    // no adapter wiring at all.
    await ensureProvidersRegistered();
    const providerName = state.config.provider || 'claude';
    this.providerAdapter = createProvider(providerName);
    this.sessionLauncher.setProviderAdapter(this.providerAdapter);
    this.outputAnalyzer.setProviderAdapter(this.providerAdapter);
    this.stateAssessor.setProviderAdapter(this.providerAdapter);
    this._verbose = state.config.verbose || false;
    console.log(`[External Ralph] Provider: ${providerName}`);

    // ========== CRASH RECOVERY (Phase 4) ==========
    const crashState = this.recoveryEngine.detectCrash();
    if (crashState.crashed) {
      console.log(`[External Ralph] Crash detected at iteration ${crashState.iteration}`);
      console.log(`[External Ralph] Recovery strategy: ${crashState.recoveryStrategy?.type || 'continue'}`);

      // Log recovery attempt
      this.recoveryEngine.notifyCrash(state.loopId, new Error('Process crash detected during resume'));

      // Check for checkpoint recovery
      const latestCheckpoint = this.recoveryEngine.getLatestCheckpoint(state.loopId);
      if (latestCheckpoint) {
        console.log(`[External Ralph] Latest checkpoint: iteration ${latestCheckpoint.iteration}`);
        // Could restore from checkpoint here if needed
        // For now, continue from current state with accumulated learnings
      }

      // Mark as recovering (will be marked as running once loop starts)
      state.status = 'recovering';
      state.recoveryAttempts = (state.recoveryAttempts || 0) + 1;
      state.lastRecoveryAt = new Date().toISOString();
    }

    // Apply overrides
    if (overrides.maxIterations) {
      state.maxIterations = overrides.maxIterations;
    }
    if (overrides.budgetPerIteration) {
      state.config.budgetPerIteration = overrides.budgetPerIteration;
    }
    if (overrides.budgetLimits) {
      state.config.budgetLimits = { ...(state.config.budgetLimits || {}), ...overrides.budgetLimits };
    }
    if (overrides.explorationQuota) {
      state.config.explorationQuota = { ...(state.config.explorationQuota || {}), ...overrides.explorationQuota };
    }
    if (overrides.budgetStopPolicy) {
      state.config.budgetStopPolicy = overrides.budgetStopPolicy;
    }

    state.status = 'running';
    this.stateManager.save(state);

    // Mark recovery complete if we were recovering
    if (crashState.crashed) {
      this.recoveryEngine.markRecovered();
      console.log('[External Ralph] Recovery marked complete');
    }

    // Initialize process monitor for resumed loop
    this.processMonitor = new ProcessMonitor({
      projectRoot: this.projectRoot,
      heartbeatIntervalMs: 30000,
      staleThresholdMs: 120000,
    });

    this.processMonitor.recordHeartbeat(state.loopId, {
      iteration: state.currentIteration,
      status: 'resumed',
    });

    // ========== INITIALIZE RESEARCH + CONTROL MODULES (#1765) ==========
    this.initializeModules(state, providerName, { resume: true });

    // Never continue when restored counters already exceed a declared ceiling
    if (this.iterationAnalytics && !overrides.allowExhaustedResume) {
      const budgetDecision = this.iterationAnalytics.checkBudgetLimits();
      if (budgetDecision.exhausted) {
        state.status = 'budget_exhausted';
        this.stateManager.save(state);
        const detail = budgetDecision.exhausted_limits
          .map((l) => `${l.name} ${l.observed} >= ${l.limit}`)
          .join(', ');
        throw new Error(
          `Cannot resume: restored usage already exceeds declared budget ceiling(s): ${detail}. ` +
          'Raise the limit or pass --allow-exhausted-resume.'
        );
      }
    }

    return this.runLoop(state);
  }

  /**
   * Main loop execution
   * @param {Object} state - Loop state
   * @returns {Promise<OrchestratorResult>}
   */
  async runLoop(state) {
    while (state.currentIteration < state.maxIterations && !this.aborted) {
      state.currentIteration++;
      // Save the updated iteration count immediately
      this.stateManager.update({ currentIteration: state.currentIteration });
      console.log(`\n[External Ralph] === Iteration ${state.currentIteration}/${state.maxIterations} ===`);

      // Record iteration heartbeat
      if (this.processMonitor) {
        this.processMonitor.recordHeartbeat(state.loopId, {
          iteration: state.currentIteration,
          status: 'running',
        });
      }

      // Get output paths and iteration directory
      const outputPaths = this.stateManager.getOutputPaths(state.currentIteration);
      const iterationDir = dirname(outputPaths.stdout);
      let workerLaunchAttempted = false;
      this.currentPreSnapshot = null;
      try {
        mkdirSync(iterationDir, { recursive: true });
        // ========== PRE-SESSION SNAPSHOT ==========
        if (state.config.enableSnapshots) {
          console.log('[External Ralph] Capturing pre-session snapshot...');
          this.currentPreSnapshot = this.snapshotManager.capturePreSnapshot(
            this.projectRoot,
            iterationDir
          );
        }

        // ========== PRE-ITERATION: INTELLIGENCE & MEMORY ==========
        let prompt, systemPrompt;
        const promptType = state.currentIteration === 1 ? 'initial' : 'continuation';
        const lastIteration = state.iterations[state.iterations.length - 1];

        // StateAssessor: Assess current situation
        let assessment = null;
        if (state.currentIteration > 1) {
          console.log('[External Ralph] Assessing current state...');
          assessment = await this.stateAssessor.assess({
            stdoutPath: lastIteration?.stdoutFile,
            stderrPath: lastIteration?.stderrFile,
            exitCode: lastIteration?.exitCode || 0,
            timedOut: false,
            preSnapshot: this.currentPreSnapshot,
            postSnapshot: lastIteration?.postSnapshot,
            objective: state.objective,
            completionCriteria: state.completionCriteria,
            iteration: state.currentIteration,
            maxIterations: state.maxIterations,
            accumulatedLearnings: state.accumulatedLearnings,
            outputDir: iterationDir,
          });

          // Save assessment
          writeFileSync(
            join(iterationDir, 'state-assessment.json'),
            JSON.stringify(assessment, null, 2)
          );

          this.verboseLog('Assessment result:', {
            trend: assessment?.trend,
            completionPercentage: assessment?.completionPercentage,
            taskType: assessment?.taskType,
            summary: assessment?.summary?.slice(0, 300),
          });
        }

        // MemoryRetrieval: Get relevant cross-loop knowledge
        let relevantKnowledge = null;
        if (this.memoryRetrieval && state.currentIteration > 1) {
          console.log('[External Ralph] Retrieving relevant knowledge...');
          relevantKnowledge = await this.memoryRetrieval.getRelevantKnowledge({
            objective: state.objective,
            taskType: assessment?.taskType,
            errorPatterns: assessment?.errorPatterns || [],
          });
        }

        // StrategyPlanner: Plan strategy for this iteration
        let strategy = null;
        if (this.strategyPlanner) {
          console.log('[External Ralph] Planning iteration strategy...');
          // StrategyPlanner.plan(history, metrics): history = past iterations array,
          // metrics = { trend, completionPercentage, ... } derived from assessment
          const planMetrics = {
            trend: assessment?.trend || 'unknown',
            completionPercentage: assessment?.completionPercentage || 0,
            iteration: state.currentIteration,
            maxIterations: state.maxIterations,
          };
          strategy = this.strategyPlanner.plan(state.iterations || [], planMetrics);
          this.verboseLog('Strategy:', strategy);
        }

        // Pre-change hypothesis-before-change (#1769): derived from the planner
        // BEFORE the session runs. This is the record's pre-change experiment
        // AND is injected into the prompt so the agent states/tests it before
        // changing files. Falls back to a grounded default when planning is off.
        const plannedExperiment = {
          hypothesis: strategy?.hypothesis
            || lastIteration?.analysis?.nextApproach
            || 'Advance quality toward the completion criteria with the selected approach.',
          expectedFailureMode: strategy?.expectedFailureMode
            || 'Progress stalls with the same symptom as the prior cycle.',
          diagnostic: strategy?.diagnostic
            || `Re-run the completion check (${state.completionCriteria}); an unchanged result signals the approach is exhausted.`,
        };

        // PID Controller: Compute control signals
        let controlSignals = null;
        if (this.pidController && this.metricsCollector && lastIteration) {
          controlSignals = processLoopControl(this, state, lastIteration);
        }

        // ValidationAgent: Pre-iteration validation
        let preValidation = null;
        if (this.validationAgent) {
          console.log('[External Ralph] Running pre-iteration validation...');
          preValidation = await this.validationAgent.validatePre({
            objective: state.objective,
            completionCriteria: state.completionCriteria,
            iteration: state.currentIteration,
            strategy,
            assessment,
          });

          const preValidationPassed = preValidation?.passed ?? preValidation?.valid ?? true;
          const preValidationWarnings = preValidation?.warnings ?? preValidation?.issues ?? [];
          if (!preValidationPassed) {
            console.warn(`[External Ralph] Pre-validation warnings: ${preValidationWarnings.length}`);
          }
        }

        // ClaudePromptGenerator: Generate optimized prompt
        if (this.claudePromptGenerator) {
          console.log('[External Ralph] Generating Claude-optimized prompt...');
          const promptResult = await this.claudePromptGenerator.generate({
            objective: state.objective,
            completionCriteria: state.completionCriteria,
            iteration: state.currentIteration,
            maxIterations: state.maxIterations,
            assessment,
            strategy,
            relevantKnowledge,
            controlSignals,
            previousIterations: state.iterations,
          });

          prompt = promptResult.prompt;
          systemPrompt = promptResult.systemPrompt;
        } else {
          // Fallback to standard prompt generator
          // Get reflection context from MemoryManager (REF-021)
          const reflectionContext = this.memoryManager
            ? this.memoryManager.getContextForPrompt()
            : '';

          // Get cross-task learnings context
          const crossTaskContext = this.crossTaskLearnings?.context_summary || '';

          if (promptType === 'continuation' && state.config.useClaudeAssessment) {
            // Use two-phase state assessment for continuation prompts
            console.log('[External Ralph] Performing two-phase state assessment...');
            const fallbackAssessment = await this.stateAssessor.assess({
              stdoutPath: lastIteration?.stdoutFile,
              stderrPath: lastIteration?.stderrFile,
              exitCode: lastIteration?.exitCode || 0,
              timedOut: false,
              preSnapshot: this.currentPreSnapshot,
              postSnapshot: lastIteration?.postSnapshot,
              objective: state.objective,
              completionCriteria: state.completionCriteria,
              iteration: state.currentIteration,
              maxIterations: state.maxIterations,
              accumulatedLearnings: state.accumulatedLearnings,
              outputDir: iterationDir,
            });

            // Save assessment to iteration directory
            writeFileSync(
              join(iterationDir, 'state-assessment.json'),
              JSON.stringify(fallbackAssessment, null, 2)
            );

            prompt = fallbackAssessment.prompt;
            systemPrompt = this.promptGenerator.buildSystemPrompt({
              objective: state.objective,
              completionCriteria: state.completionCriteria,
              iteration: state.currentIteration,
              maxIterations: state.maxIterations,
              loopId: state.loopId,
            });
          } else {
            // Use standard prompt generator
            const generated = this.promptGenerator.build({
              type: promptType,
              objective: state.objective,
              completionCriteria: state.completionCriteria,
              iteration: state.currentIteration,
              maxIterations: state.maxIterations,
              loopId: state.loopId,
              sessionId: state.sessionId,
              learnings: state.accumulatedLearnings,
              filesModified: state.filesModified,
              previousStatus: lastIteration?.analysis?.success ? 'partial' : 'incomplete',
              previousOutput: lastIteration?.analysis?.learnings,
              lastAnalysis: lastIteration?.analysis?.nextApproach,
              // Research-backed context injection (REF-015, REF-021)
              reflectionContext: reflectionContext,
              crossTaskContext: crossTaskContext,
            });
            prompt = generated.prompt;
            systemPrompt = generated.systemPrompt;
          }
        }

        // ========== LFD PROMPT-INJECTED CONTROLS (all providers) ==========
        // These directives are appended to the prompt, so they apply to every
        // provider that accepts an injected prompt (all command-injection
        // providers), not only Claude (#1768/#1769).
        const lfdDirectives = [];

        // Hypothesis-before-change (#1769): the agent must state/refine the
        // pre-change experiment before touching files.
        lfdDirectives.push(
          '',
          'LFD CONTROL — hypothesis before change: Before modifying any files, state:',
          `  1. Hypothesis: ${plannedExperiment.hypothesis}`,
          `  2. Expected failure mode: ${plannedExperiment.expectedFailureMode}`,
          `  3. Distinguishing diagnostic: ${plannedExperiment.diagnostic}`,
          'Refine these to fit what you actually observe, then act on them.',
        );

        // Stall rule (#1768): after a non-improving cycle, forbid repeating the
        // previous tactic. Fires on a single non-improving cycle.
        if (this.iterationAnalytics) {
          const stall = this.iterationAnalytics.checkStallRule();
          if (stall.active) {
            state.stallRule = { forbiddenAdjustment: stall.forbiddenAdjustment, lastQualityDelta: stall.lastQualityDelta };
            lfdDirectives.push(
              '',
              'LFD CONTROL — stall rule: The previous cycle did not improve quality.',
              `Do NOT repeat the previous adjustment (${stall.forbiddenAdjustment}). Change the approach materially.`,
            );
          } else {
            state.stallRule = null;
          }
        }

        // Structural variant (exploration quota, #1585): stronger requirement
        // after K consecutive flat cycles.
        if (state.lfdControls?.structuralVariantRequired) {
          lfdDirectives.push(
            '',
            'LFD CONTROL: The prior cycles are flat. This iteration must use a structural variant.',
            `Do not repeat the same tactic. Required reason: ${state.lfdControls.reason}`,
          );
        }

        if (lfdDirectives.length > 0) {
          prompt += lfdDirectives.join('\n');
        }

        // Save prompt for debugging
        const promptPath = this.stateManager.getPromptPath(state.currentIteration);
        mkdirSync(dirname(promptPath), { recursive: true });
        writeFileSync(promptPath, prompt);

        this.verboseLog(`Prompt preview (first 600 chars):\n${prompt?.slice(0, 600)}`);
        if (systemPrompt) {
          this.verboseLog(`System prompt preview (first 300 chars):\n${systemPrompt.slice(0, 300)}`);
        }

        // ========== LAUNCH SESSION ==========
        console.log('[External Ralph] Launching Claude session...');
        const startTime = Date.now();
        this.stateManager.setCurrentPid(null);

        // Bound the session timeout by the remaining wall-clock budget (#1766 /
        // audit M5): with a --max-wall-clock-minutes ceiling, a single session
        // must not be allowed to overshoot it by up to a full --timeout.
        // The first iteration always gets the full per-session timeout — one
        // iteration is the minimum unit and the cumulative ceiling is enforced
        // by the post-iteration budget check.
        let sessionTimeoutMs = state.config.timeoutMinutes * 60 * 1000;
        const wallClockLimit = Number(state.config.budgetLimits?.wall_clock_minutes);
        const priorIterations = this.iterationAnalytics ? this.iterationAnalytics.iterations.length : 0;
        if (priorIterations >= 1 && Number.isFinite(wallClockLimit) && wallClockLimit > 0) {
          const usedMinutes = this.iterationAnalytics.getBudgetUsage().wall_clock_minutes;
          const remainingMs = Math.max(0, (wallClockLimit - usedMinutes) * 60 * 1000);
          sessionTimeoutMs = Math.min(sessionTimeoutMs, remainingMs);
          if (sessionTimeoutMs <= 0) {
            console.log('[External Ralph] Wall-clock budget already exhausted before session launch — stopping');
            const budgetStopReport = this.iterationAnalytics.generateBudgetStopReport('wall_clock_exhausted');
            const budgetStopPath = join(this.stateManager.getStateDir(), 'budget-stop-report.json');
            writeFileSync(budgetStopPath, JSON.stringify(budgetStopReport, null, 2));
            state.status = 'budget_exhausted';
            state.budgetStopReport = budgetStopReport;
            state.budgetStopReportPath = budgetStopPath;
            this.stateManager.save(state);
            await this.generateCompletionReport(state, 'budget_exhausted');
            await this.recordTaskCompletion(state, 'partial');
            await this.completeMultiLoop('budget_exhausted');
            return {
              success: false,
              reason: 'Budget exhausted: wall_clock_exhausted',
              iterations: state.currentIteration - 1,
              loopId: state.loopId,
              budgetStopReport,
            };
          }
        }

        workerLaunchAttempted = true;
        const sessionResult = await launchRalphCycle(this, state, {
          prompt, systemPrompt, outputPaths, iterationDir, timeoutMs: sessionTimeoutMs,
        });

        const duration = Date.now() - startTime;

        // ========== STOP CHECKPOINT MANAGER ==========
        let checkpointSummary = null;
        if (this.checkpointManager) {
          console.log('[External Ralph] Stopping checkpoint manager...');
          checkpointSummary = this.checkpointManager.stop();
          this.checkpointManager = null;
        }

        console.log(`[External Ralph] Session completed (${Math.round(duration / 1000)}s, exit: ${sessionResult.exitCode})`);
        if (sessionResult.toolCallCount) {
          console.log(`[External Ralph] Tool calls: ${sessionResult.toolCallCount}, errors: ${sessionResult.errorCount || 0}`);
        }

        // Verbose: show session output tail
        if (this._verbose && outputPaths.stdout) {
          try {
            const { readFileSync: readFS } = await import('fs');
            const stdout = readFS(outputPaths.stdout, 'utf-8');
            const tail = stdout.slice(-1200);
            this.verboseLog(`Session output (last 1200 chars):\n${tail}`);
          } catch (_) { /* file may not exist yet */ }
        }

        // Record session completion heartbeat
        if (this.processMonitor) {
          this.processMonitor.recordHeartbeat(state.loopId, {
            iteration: state.currentIteration,
            status: 'analyzing',
          });
        }

        // ========== POST-SESSION SNAPSHOT ==========
        let postSnapshot = null;
        if (state.config.enableSnapshots && this.currentPreSnapshot) {
          console.log('[External Ralph] Capturing post-session snapshot...');
          postSnapshot = this.snapshotManager.capturePostSnapshot(
            this.projectRoot,
            iterationDir
          );

          const snapshotDiff = this.snapshotManager.calculateDiff(this.currentPreSnapshot, postSnapshot);
          writeFileSync(
            join(iterationDir, 'snapshot-diff.json'),
            JSON.stringify(snapshotDiff, null, 2)
          );

          const totalGitChanges = (snapshotDiff.filesAdded?.length || 0) + (snapshotDiff.filesModified?.length || 0) + (snapshotDiff.filesDeleted?.length || 0);
          const totalAiwgChanges = (snapshotDiff.aiwgArtifactsCreated?.length || 0) + (snapshotDiff.aiwgArtifactsUpdated?.length || 0);
          const totalChanges = totalGitChanges + totalAiwgChanges;
          if (totalChanges > 0) {
            console.log(`[External Ralph] Changes detected: ${totalChanges} (git: ${totalGitChanges}, aiwg: ${totalAiwgChanges})`);
          }
        }

        // ========== ANALYZE OUTPUT ==========
        console.log('[External Ralph] Analyzing output...');
        const analysis = await this.outputAnalyzer.analyze({
          stdoutPath: outputPaths.stdout,
          stderrPath: outputPaths.stderr,
          exitCode: sessionResult.exitCode,
          context: {
            objective: state.objective,
            criteria: state.completionCriteria,
          },
        });

        // Save analysis
        this.stateManager.saveAnalysis(state.currentIteration, analysis);

        // ========== POST-ITERATION: VALIDATION & OVERSIGHT ==========

        // ValidationAgent: Post-iteration validation
        let postValidation = null;
        if (this.validationAgent) {
          console.log('[External Ralph] Running post-iteration validation...');
          postValidation = await this.validationAgent.validatePost({
            objective: state.objective,
            completionCriteria: state.completionCriteria,
            iteration: state.currentIteration,
            analysis,
            sessionResult,
            preValidation,
          });

          const postValidationPassed = postValidation?.passed ?? postValidation?.valid ?? true;
          const postValidationErrors = postValidation?.errors ?? postValidation?.issues ?? [];
          if (!postValidationPassed) {
            console.warn(`[External Ralph] Post-validation issues: ${postValidationErrors.length}`);
          }
        }

        // Overseer: Health check and intervention
        let healthReport = null;
        let interventionResult = null;
        if (this.overseer) {
          console.log('[External Ralph] Running overseer health check...');
          healthReport = await this.overseer.check({
            iteration: state.currentIteration,
            analysis,
            validation: postValidation,
            metrics: this.metricsCollector ? this.metricsCollector.extractIterationMetrics({
              analysis,
              ...sessionResult,
            }) : null,
          });

          // Handle interventions
          if (healthReport.intervention !== 'NONE') {
            console.log(`[External Ralph] Intervention triggered: ${healthReport.intervention}`);
            interventionResult = await this.interventionSystem.intervene(healthReport);

            // Check if we need to pause/abort
            if (healthReport.intervention === 'PAUSE' || healthReport.intervention === 'ABORT') {
              const escalation = await this.escalationHandler.escalate({
                level: healthReport.intervention === 'ABORT' ? 'critical' : 'high',
                reason: healthReport.reason,
                context: {
                  iteration: state.currentIteration,
                  healthReport,
                  analysis,
                },
              });

              if (healthReport.intervention === 'ABORT') {
                state.status = 'aborted';
                state.abortReason = healthReport.reason;
                this.stateManager.save(state);
                await this.completeMultiLoop('aborted');

                return {
                  success: false,
                  reason: `Aborted by overseer: ${healthReport.reason}`,
                  iterations: state.currentIteration,
                  loopId: state.loopId,
                };
              }
            }
          }
        }

        // ========== UPDATE STATE ==========
        state = this.stateManager.addIteration({
          number: state.currentIteration,
          sessionId: sessionResult.attempt?.bindings.sessionId ?? state.sessionId,
          attempt: sessionResult.attempt,
          promptFile: promptPath,
          stdoutFile: outputPaths.stdout,
          stderrFile: outputPaths.stderr,
          exitCode: sessionResult.exitCode,
          duration,
          status: analysis.completed ? 'completed' : 'incomplete',
          analysis,
          learnings: analysis.learnings ? [analysis.learnings] : [],
          filesModified: analysis.artifactsModified || [],
          progress: analysis.nextApproach,
          // Enhanced capture data
          preSnapshot: this.currentPreSnapshot,
          postSnapshot,
          checkpointSummary,
          transcriptPath: sessionResult.transcriptPath,
          parsedEventsPath: sessionResult.parsedEventsPath,
          toolCallCount: sessionResult.toolCallCount,
          inputTokens: sessionResult.inputTokens,
          outputTokens: sessionResult.outputTokens,
          totalTokens: sessionResult.totalTokens,
          costUsd: sessionResult.costUsd,
          errorCount: sessionResult.errorCount,
          // Epic #26 data
          assessment,
          strategy,
          controlSignals,
          preValidation,
          postValidation,
          healthReport,
          interventionResult,
        });

        console.log(`[External Ralph] Analysis: completed=${analysis.completed}, success=${analysis.success}, progress=${analysis.completionPercentage}%`);

        // ========== EVAL HARNESS (LFD Track 3, #1776) ==========
        // Run the declared harness for this iteration BEFORE recording, so a
        // VOID (e.g. lint violation) overrides the verification status and the
        // iteration is fenced out of best-output selection. Only VOID-safe
        // aggregate feedback is surfaced to the agent; detailed diagnostics are
        // written to a private, non-optimizer-readable path.
        let evalResult = null;
        if (this.evalHarness) {
          try {
            evalResult = this.evalHarness.run({ iterationDir });
            const resultPath = join(iterationDir, 'eval-harness-result.json');
            writeFileSync(resultPath, JSON.stringify(evalResult, null, 2));
            console.log(`[External Ralph] Eval harness: status=${evalResult.status}, leakage_audit=${evalResult.leakage_audit.result}`);
          } catch (error) {
            console.warn(`[External Ralph] Eval harness run failed: ${error.message}`);
          }
        }

        // ========== RECORD TO RESEARCH MODULES ==========
        const qualityScore = (analysis.completionPercentage || 0) / 100;
        // The eval harness, when present, is authoritative for verification:
        // a VOID/pass/fail from the harness overrides the analyzer's heuristic.
        const analyzerPassed = analysis.completed && analysis.success;
        const evalVerification = evalResult ? statusToVerification(evalResult.status) : null;
        const verificationStatus = evalVerification || (analyzerPassed ? 'passed' : 'failed');
        const verificationPassed = verificationStatus === 'passed';
        const evalHumanOverride = evalResult?.human_override === true;

        // Best Output Tracker (REF-015)
        if (this.bestOutputTracker) {
          this.bestOutputTracker.recordIteration({
            iteration_number: state.currentIteration,
            dimensions: {
              validation: verificationPassed ? 1 : 0,
              completeness: qualityScore,
              correctness: analysis.success === false ? 0 : qualityScore,
              readability: qualityScore,
              efficiency: qualityScore,
            },
            artifacts: analysis.artifactsModified || [],
            tokens_used: sessionResult.totalTokens || 0,
            token_cost_usd: sessionResult.costUsd || 0,
            execution_time_ms: duration,
            verification_status: verificationStatus,
            eval_human_override: evalHumanOverride,
            reflections: analysis.learnings ? [analysis.learnings] : [],
          });
        }

        // Memory Manager - add reflection (REF-021)
        if (this.memoryManager && analysis.learnings) {
          this.memoryManager.addReflection({
            iteration: state.currentIteration,
            content: analysis.learnings,
            type: analysis.completed ? 'success_pattern' : 'strategy_change',
            effectiveness: verificationPassed ? 'helpful' : 'neutral',
          });
        }

        // Iteration Analytics
        const taskComplete = analysis.completed && analysis.success;
        let analyticsRecord = null;
        if (this.iterationAnalytics) {
          // Unknown vs zero (#1766): when the provider reported no token/cost
          // usage this iteration, record null (unknown) rather than 0 so a
          // declared token/spend ceiling is treated as unobservable instead of
          // silently never firing. tool_calls and wall-clock are always
          // observable (counted/measured by the orchestrator).
          const tokenUsageObserved = sessionResult.tokenUsageObserved === true;
          const costObserved = sessionResult.costObserved === true;
          analyticsRecord = this.iterationAnalytics.recordIteration({
            iteration_number: state.currentIteration,
            quality_score: qualityScore * 100,
            tokens_used: tokenUsageObserved ? (sessionResult.totalTokens || 0) : null,
            input_tokens: tokenUsageObserved ? (sessionResult.inputTokens || 0) : null,
            output_tokens: tokenUsageObserved ? (sessionResult.outputTokens || 0) : null,
            tool_calls: sessionResult.toolCallCount || 0,
            token_cost_usd: costObserved ? (sessionResult.costUsd || 0) : null,
            execution_time_ms: duration,
            verification_status: verificationStatus,
            eval_harness_result: evalResult,
            eval_human_override: evalHumanOverride,
            output_snapshot_path: outputPaths.stdout,
            reflections: analysis.learnings ? [analysis.learnings] : [],
            // Hypothesis-before-change (#1769): captured pre-session from the
            // strategy planner (see planned* below), recorded here alongside
            // the observed result. Falls back only if planning was unavailable.
            experiment: {
              hypothesis: plannedExperiment.hypothesis,
              expected_failure_mode: plannedExperiment.expectedFailureMode,
              distinguishing_diagnostic: plannedExperiment.diagnostic,
              structural_variant: strategy?.approach || strategy?.name || null,
              adjustment_key: strategy?.adjustmentKey || null,
              recorded_before_change: true,
              result: verificationPassed ? 'passed' : 'failed',
              probe_or_generalization_signal: analysis.completed ? 'completion-criteria' : 'iteration-analysis',
            },
          });

          const budgetDecision = this.iterationAnalytics.checkBudgetLimits();
          if (budgetDecision.exhausted) {
            const budgetStopReport = this.iterationAnalytics.generateBudgetStopReport(budgetDecision.trigger);
            const budgetStopPath = join(this.stateManager.getStateDir(), 'budget-stop-report.json');
            writeFileSync(budgetStopPath, JSON.stringify(budgetStopReport, null, 2));
            state.budgetStopReport = budgetStopReport;
            state.budgetStopReportPath = budgetStopPath;

            // Stop-semantics policy (#1767, operator decision 2026-07-11):
            // completion-wins (default) — a task that meets its completion
            // criteria on the ceiling-crossing iteration reports SUCCESS with
            // the crossing annotated; the budget stop exists to halt ongoing
            // optimization, not to negate an achieved completion.
            // budget-wins — the pre-#1767 ordering: exhaustion terminates the
            // loop as budget_exhausted even on a completing iteration.
            const budgetStopPolicy = state.config.budgetStopPolicy || 'completion-wins';
            if (taskComplete && budgetStopPolicy === 'completion-wins') {
              state.budgetCrossedAtCompletion = budgetDecision.trigger;
              console.log(`[External Ralph] Budget ceiling crossed on the completing iteration (${budgetDecision.trigger}) — completion wins (policy: completion-wins)`);
            } else {
              const selection = await this.selectBestOutput(state);
              state.status = 'budget_exhausted';
              this.stateManager.save(state);
              await this.generateCompletionReport(state, 'budget_exhausted');
              await this.recordTaskCompletion(state, 'partial');
              await this.completeMultiLoop('budget_exhausted');

              return {
                success: false,
                reason: `Budget exhausted: ${budgetDecision.trigger}`,
                iterations: state.currentIteration,
                loopId: state.loopId,
                selectedIteration: selection.bestIteration,
                budgetStopReport,
              };
            }
          }

          const explorationDecision = this.iterationAnalytics.checkExplorationQuota();
          state.lfdControls = {
            structuralVariantRequired: explorationDecision.required,
            flatCycleCount: explorationDecision.flat_cycle_count,
            explorationQuotaK: explorationDecision.k,
            reason: explorationDecision.required
              ? `${explorationDecision.flat_cycle_count} flat cycles reached quota ${explorationDecision.k}`
              : null,
          };
          this.stateManager.save(state);
        }

        // Early Stopping — fed AFTER analytics so it sees the CURRENT
        // iteration's quality_delta, not the previous one (#1767 off-by-one)
        if (this.earlyStopping) {
          this.earlyStopping.recordIterationResult(state.currentIteration, {
            quality_score: qualityScore * 100,
            confidence: Math.max(0, Math.min(1, qualityScore)),
            verification_status: verificationPassed ? 'passed' : 'failed',
            quality_delta: analyticsRecord?.quality_delta || 0,
          });
        }

        // LearningExtractor & MemoryPromotion
        if (this.learningExtractor && this.memoryPromotion && verificationPassed) {
          console.log('[External Ralph] Extracting and promoting learnings...');
          const learnings = await this.learningExtractor.extract({
            iteration: state.currentIteration,
            analysis,
            strategy,
            outcome: 'success',
          });

          if (learnings.length > 0) {
            await this.memoryPromotion.promote({
              learnings,
              source: `loop-${state.loopId}-iteration-${state.currentIteration}`,
            });
          }
        }

        // ========== CHECK EARLY STOPPING ==========
        // Skipped when the task just completed — the completion path below is
        // the correct exit for a completed task (#1767).
        if (this.earlyStopping && state.currentIteration >= 2 && !taskComplete) {
          const earlyStopResult = this.earlyStopping.shouldStop();
          if (earlyStopResult.stop) {
            if (earlyStopResult.trigger === 'quality_plateau') {
              // A quality plateau is STAGNATION, not success (#1767). It must
              // never be recorded as a successful completion without
              // verification. When a structural variant is pending from a
              // declared exploration quota, the variant gets its chance first —
              // the quota exists precisely to break plateaus.
              if (state.lfdControls?.structuralVariantRequired) {
                console.log('[External Ralph] Quality plateau detected, but a structural variant is pending — continuing (exploration quota takes precedence)');
              } else {
                console.log(`[External Ralph] Stopping on quality plateau: ${earlyStopResult.reason}`);

                const selection = await this.selectBestOutput(state);
                if (selection.bestIteration !== state.currentIteration) {
                  console.log(`[External Ralph] Selected iteration ${selection.bestIteration} as best output`);
                }

                state.status = 'plateau';
                this.stateManager.save(state);
                await this.generateCompletionReport(state, 'plateau');
                await this.recordTaskCompletion(state, 'partial');
                await this.completeMultiLoop('plateau');

                return {
                  success: false,
                  reason: `Quality plateau (stagnation, not success): ${earlyStopResult.reason}`,
                  iterations: state.currentIteration,
                  loopId: state.loopId,
                  selectedIteration: selection.bestIteration,
                };
              }
            } else {
              // Verified high-confidence stop — a legitimate success exit
              console.log(`[External Ralph] Early stopping triggered: ${earlyStopResult.reason}`);

              const selection = await this.selectBestOutput(state);
              if (selection.bestIteration !== state.currentIteration) {
                console.log(`[External Ralph] Selected iteration ${selection.bestIteration} as best output`);
              }

              state.status = 'completed';
              this.stateManager.save(state);
              await this.generateCompletionReport(state, 'early_stop');
              await this.recordTaskCompletion(state, 'success');
              await this.completeMultiLoop('completed');

              return {
                success: true,
                reason: `Early stop: ${earlyStopResult.reason}`,
                iterations: state.currentIteration,
                loopId: state.loopId,
              };
            }
          }
        }

        // ========== CHECK COMPLETION ==========
        if (taskComplete) {
          // Select best output (may not be final iteration per REF-015)
          const selection = await this.selectBestOutput(state);
          if (selection.bestIteration !== state.currentIteration) {
            console.log(`[External Ralph] Selected iteration ${selection.bestIteration} as best output (not final)`);
          }

          state.status = 'completed';
          this.stateManager.save(state);
          await this.generateCompletionReport(state, 'success');
          await this.recordTaskCompletion(state, 'success');
          await this.completeMultiLoop('completed');

          return {
            success: true,
            reason: state.budgetCrossedAtCompletion
              ? `Task completed successfully (budget ceiling crossed on the completing iteration: ${state.budgetCrossedAtCompletion})`
              : 'Task completed successfully',
            iterations: state.currentIteration,
            loopId: state.loopId,
            selectedIteration: selection.bestIteration,
            budgetCrossed: state.budgetCrossedAtCompletion || null,
          };
        }

        // Check if we should continue
        if (!analysis.shouldContinue) {
          state.status = 'failed';
          this.stateManager.save(state);
          await this.generateCompletionReport(state, 'blocked');
          await this.completeMultiLoop('failed');

          return {
            success: false,
            reason: analysis.failureClass || 'Cannot continue',
            iterations: state.currentIteration,
            loopId: state.loopId,
          };
        }

        console.log(`[External Ralph] Will continue with: ${analysis.nextApproach}`);

      } catch (error) {
        console.error(`[External Ralph] Iteration ${state.currentIteration} error:`, error.message);
        if (error?.stack) {
          console.error(error.stack);
        }

        // Stop checkpoint manager if running
        if (this.checkpointManager) {
          try {
            this.checkpointManager.stop();
          } catch (e) {
            // Ignore stop errors
          }
          this.checkpointManager = null;
        }

        if (!workerLaunchAttempted) {
          const failure = await handleInitializationFailure(this, state, error);
          if (failure) return failure;
          continue;
        }

        // Save error state; keep the loop's copy current so later full-state
        // saves (e.g. attempt persistence) cannot drop this iteration.
        state = this.stateManager.addIteration({
          number: state.currentIteration,
          sessionId: state.sessionId,
          exitCode: -1,
          duration: 0,
          status: 'error',
          analysis: { error: error.message },
          learnings: [`Error: ${error.message}`],
          filesModified: [],
          progress: 'Error recovery needed',
          preSnapshot: this.currentPreSnapshot,
        });

        // Continue to next iteration (crash recovery)
        console.log('[External Ralph] Will retry in next iteration');
      }
    }

    // Loop ended without success
    if (this.aborted) {
      // Stop checkpoint manager if running
      if (this.checkpointManager) {
        try {
          this.checkpointManager.stop();
        } catch (e) {
          // Ignore stop errors
        }
        this.checkpointManager = null;
      }

      state.status = 'aborted';
      this.stateManager.save(state);
      await this.completeMultiLoop('aborted');

      return {
        success: false,
        reason: 'Aborted by user',
        iterations: state.currentIteration,
        loopId: state.loopId,
      };
    }

    // Select best output even on limit reached (REF-015)
    const selection = await this.selectBestOutput(state);
    if (selection.bestIteration != null && selection.bestIteration !== state.currentIteration) {
      console.log(`[External Ralph] Selected iteration ${selection.bestIteration} as best output (limit reached)`);
    }

    state.status = 'limit_reached';
    this.stateManager.save(state);
    await this.generateCompletionReport(state, 'limit');
    await this.recordTaskCompletion(state, 'partial');
    await this.completeMultiLoop('limit_reached');

    return {
      success: false,
      reason: 'Maximum iterations reached',
      iterations: state.currentIteration,
      loopId: state.loopId,
      selectedIteration: selection.bestIteration,
    };
  }

  /**
   * Generate completion report
   * @param {Object} state - Final state
   * @param {string} status - Completion status
   */
  async generateCompletionReport(state, status) {
    const reportPath = join(this.stateManager.getStateDir(), 'completion-report.md');

    const iterations = state.iterations.map((iter, idx) => {
      return `| ${idx + 1} | ${iter.status} | ${iter.duration}ms | ${iter.analysis?.completionPercentage || 0}% |`;
    }).join('\n');

    const report = `# External Ralph Loop Completion Report

## Summary

| Property | Value |
|----------|-------|
| Loop ID | ${state.loopId} |
| Status | ${status} |
| Iterations | ${state.iterations.length} |
| Initialization failures | ${state.initializationFailures?.length || 0} |
| Start Time | ${state.startTime} |
| End Time | ${new Date().toISOString()} |

## Objective

${state.objective}

## Completion Criteria

${state.completionCriteria}

## Iterations

| # | Status | Duration | Progress |
|---|--------|----------|----------|
${iterations}

## Accumulated Learnings

${state.accumulatedLearnings || 'None recorded'}

## LFD Controls

${state.budgetStopReport ? `Budget stop report: ${state.budgetStopReportPath || 'embedded in state'}\n\n\`\`\`json\n${JSON.stringify(state.budgetStopReport, null, 2)}\n\`\`\`` : 'No hard budget stop recorded.'}

## Files Modified

${state.filesModified.length > 0 ? state.filesModified.map(f => `- ${f}`).join('\n') : 'None recorded'}

## Final Status

${state.outputSummary || ''}

**${status.toUpperCase()}**
`;

    writeFileSync(reportPath, report);
    console.log(`[External Ralph] Report saved to: ${reportPath}`);
  }

  /**
   * Abort the loop
   */
  abort() {
    this.aborted = true;
    this.sessionLauncher.kill();

    // Stop process monitor
    if (this.processMonitor) {
      this.processMonitor.stopAll();
    }

    // Stop checkpoint manager if running
    if (this.checkpointManager) {
      try {
        this.checkpointManager.stop();
      } catch {
        // Ignore stop errors
      }
      this.checkpointManager = null;
    }

    console.log('[External Ralph] Abort requested');
  }

  /**
   * Graceful shutdown with state persistence
   * Called on SIGTERM/SIGINT for clean termination
   */
  async gracefulShutdown() {
    console.log('[External Ralph] Graceful shutdown initiated...');

    // Record final heartbeat
    const state = this.stateManager.load();
    if (state && this.processMonitor) {
      this.processMonitor.recordHeartbeat(state.loopId, {
        iteration: state.currentIteration,
        status: 'shutting_down',
      });
    }

    // Stop checkpoint manager and save summary
    let checkpointSummary = null;
    if (this.checkpointManager) {
      console.log('[External Ralph] Stopping checkpoint manager...');
      try {
        checkpointSummary = this.checkpointManager.stop();
      } catch {
        // Ignore stop errors
      }
      this.checkpointManager = null;
    }

    // Save interrupted state with checkpoint summary
    if (state) {
      state.status = 'interrupted';
      state.interruptedAt = new Date().toISOString();
      if (checkpointSummary) {
        state.lastCheckpointSummary = checkpointSummary;
      }
      this.stateManager.save(state);
      console.log(`[External Ralph] State saved (iteration ${state.currentIteration})`);
    }

    // Stop process monitor
    if (this.processMonitor) {
      this.processMonitor.stopAll();
    }

    // Complete multi-loop registration
    await this.completeMultiLoop('interrupted');

    // Kill Claude session gracefully
    this.sessionLauncher.kill();

    console.log('[External Ralph] Graceful shutdown complete');
  }

  /**
   * Get current status
   * @returns {Object|null}
   */
  getStatus() {
    return this.stateManager.load();
  }

  /**
   * Select and apply the best output from iteration history (REF-015 Self-Refine)
   * @param {Object} state - Current loop state
   * @returns {Promise<Object>} Selection result with best iteration info
   */
  async selectBestOutput(state) {
    if (recordedOutputs(state).length === 0) return noRecordedOutput(state);
    console.log('[External Ralph] Selecting best output from iteration history...');

    let bestIteration = recordedOutputs(state).at(-1).number;
    let selectionSource = 'final';

    // Try BestOutputTracker first (quality dimensions approach)
    if (this.bestOutputTracker) {
      try {
        const bestOutput = this.bestOutputTracker.selectOutput();
        if (recordedOutputs(state).some(it => it.number === bestOutput?.selected_iteration) && bestOutput.selected_iteration !== state.currentIteration) {
          bestIteration = bestOutput.selected_iteration;
          selectionSource = 'best-output-tracker';
          console.log(`[External Ralph] BestOutputTracker selected iteration ${bestIteration} (score: ${bestOutput.quality_score})`);
        }
      } catch (error) {
        console.warn('[External Ralph] BestOutputTracker selection failed:', error.message);
      }
    }

    // Fallback to IterationAnalytics if available
    if (selectionSource === 'final' && this.iterationAnalytics) {
      try {
        const bestFromAnalytics = this.iterationAnalytics.selectBestIteration();
        const selected = bestFromAnalytics?.selected || bestFromAnalytics;
        if (recordedOutputs(state).some(it => it.number === selected?.iteration_number) && selected.iteration_number !== state.currentIteration) {
          bestIteration = selected.iteration_number;
          selectionSource = 'iteration-analytics';
          console.log(`[External Ralph] IterationAnalytics selected iteration ${bestIteration} (quality: ${selected.quality_score})`);
        }
      } catch (error) {
        console.warn('[External Ralph] IterationAnalytics selection failed:', error.message);
      }
    }

    // If best iteration differs from final, restore artifacts from that iteration
    if (bestIteration !== state.currentIteration) {
      console.log(`[External Ralph] Restoring artifacts from iteration ${bestIteration} (better than final iteration ${state.currentIteration})`);
      // Note: Actual artifact restoration would require snapshot management
      // For now, we record the selection decision
      state.bestIterationSelected = bestIteration;
      state.selectionSource = selectionSource;
    } else {
      console.log('[External Ralph] Final iteration is the best output');
      state.bestIterationSelected = state.currentIteration;
      state.selectionSource = 'final';
    }

    return {
      bestIteration,
      selectionSource,
      currentIteration: state.currentIteration,
      wasDifferent: bestIteration !== state.currentIteration,
    };
  }

  /**
   * Record task completion for cross-task learning (REF-154)
   * @param {Object} state - Final loop state
   * @param {string} outcome - 'success' | 'failure' | 'partial'
   * @returns {Promise<void>}
   */
  async recordTaskCompletion(state, outcome) {
    console.log(`[External Ralph] Recording task completion (outcome: ${outcome})...`);

    // Extract final learnings for semantic memory
    if (this.learningExtractor && this.semanticMemory && state.iterations.length > 0) {
      try {
        const allLearnings = await this.learningExtractor.extractFromLoop({
          loopId: state.loopId,
          objective: state.objective,
          iterations: state.iterations,
          outcome,
        });

        if (allLearnings.length > 0) {
          await this.semanticMemory.store({
            type: 'loop-completion',
            objective: state.objective,
            outcome,
            learnings: allLearnings,
            loopId: state.loopId,
          });
          console.log(`[External Ralph] Stored ${allLearnings.length} learnings in semantic memory`);
        }
      } catch (error) {
        console.warn('[External Ralph] Semantic memory storage failed:', error.message);
      }
    }

    // Record to CrossTaskLearner for future similar tasks
    if (this.crossTaskLearner) {
      try {
        // Collect reflections from memory manager
        let reflections = [];
        if (this.memoryManager) {
          try {
            reflections = this.memoryManager.getActiveReflections() || [];
          } catch (error) {
            console.warn('[External Ralph] Failed to get reflections:', error.message);
          }
        }

        // Extract key learnings from accumulated learnings
        const keyLearnings = state.accumulatedLearnings
          ? state.accumulatedLearnings.split('\n').filter(l => l.trim())
          : [];

        await this.crossTaskLearner.recordTaskCompletion({
          task_description: state.objective,
          task_type: 'implementation',
          outcome,
          iterations: state.currentIteration,
          final_quality: state.lastAnalysis?.completionPercentage / 100 || 0,
          reflections,
          key_learnings: keyLearnings,
          tags: ['external-ralph', state.loopId],
        });

        console.log('[External Ralph] Task recorded for cross-task learning');
      } catch (error) {
        console.warn('[External Ralph] CrossTaskLearner recording failed:', error.message);
      }
    }

    // Export iteration analytics report
    if (this.iterationAnalytics) {
      try {
        const report = this.iterationAnalytics.generateReport();
        const reportPath = join(this.stateManager.getStateDir(), 'iteration-analytics-report.md');
        writeFileSync(reportPath, report);
        console.log(`[External Ralph] Analytics report saved to: ${reportPath}`);

        // Also export full analytics data
        this.iterationAnalytics.export();
      } catch (error) {
        console.warn('[External Ralph] IterationAnalytics export failed:', error.message);
      }
    }

    // Export best output tracker data
    if (this.bestOutputTracker) {
      try {
        this.bestOutputTracker.exportCSV();
      } catch (error) {
        console.warn('[External Ralph] BestOutputTracker export failed:', error.message);
      }
    }
  }

  /**
   * Complete the loop in the multi-loop registry
   * Archives the loop and updates registry metrics
   * @param {string} finalStatus - 'completed' | 'failed' | 'aborted' | 'limit_reached'
   * @returns {Promise<void>}
   */
  async completeMultiLoop(finalStatus) {
    if (!this.multiLoopManager || !this.registeredLoopId) {
      return; // Single-loop mode, no registry to update
    }

    try {
      // Update loop status before archiving
      this.multiLoopManager.updateLoop(this.registeredLoopId, {
        status: finalStatus,
        lastUpdate: new Date().toISOString(),
      });

      // Archive the loop (moves from active loops/ to archive/)
      await this.multiLoopManager.archiveLoop(this.registeredLoopId);
      console.log(`[External Ralph] Loop archived: ${this.registeredLoopId} (${finalStatus})`);

      // archiveLoop() renamed the loop directory, so re-scope StateManager to
      // the new archive location so load() and getStateDir() remain valid.
      const archiveDir = join(this.projectRoot, '.aiwg', 'ralph-external', 'archive', this.registeredLoopId);
      this.stateManager.setStateDir(archiveDir);
      const archivedState = this.stateManager.load();
      if (archivedState?.budgetStopReportPath) {
        archivedState.budgetStopReportPath = join(archiveDir, basename(archivedState.budgetStopReportPath));
        this.stateManager.save(archivedState);
      }
    } catch (error) {
      console.warn(`[External Ralph] Multi-loop completion failed: ${error.message}`);
    }

    // Also update launcher-registry.json (parallel registry used by CLI)
    this.cleanupLauncherRegistry(this.registeredLoopId, finalStatus);
  }

  /**
   * Remove or update completed loop entry in launcher-registry.json
   * The launcher registry is a parallel tracking file used by the TS CLI layer
   * @param {string} loopId - Loop ID to clean up
   * @param {string} finalStatus - Final status of the loop
   */
  cleanupLauncherRegistry(loopId, finalStatus) {
    try {
      const registryPath = join(
        process.cwd(),
        '.aiwg',
        'ralph-external',
        'launcher-registry.json'
      );
      if (!existsSync(registryPath)) return;

      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      if (registry.loops && registry.loops[loopId]) {
        if (finalStatus === 'completed') {
          // Remove completed entries entirely
          delete registry.loops[loopId];
        } else {
          // Update status for failed/aborted (kept for potential resume)
          registry.loops[loopId].status = finalStatus;
          registry.loops[loopId].lastUpdate = new Date().toISOString();
        }
        registry.updatedAt = new Date().toISOString();
        writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        console.log(`[External Ralph] Launcher registry updated for ${loopId}: ${finalStatus}`);
      }
    } catch (error) {
      console.warn(`[External Ralph] Launcher registry cleanup failed: ${error.message}`);
    }
  }
}

export default Orchestrator;
