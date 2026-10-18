/**
 * State Assessor for External Ralph Loop
 *
 * Implements two-phase assessment for long-running Claude sessions:
 * 1. Orient Phase: Understand what happened in the session
 * 2. Prompt Phase: Generate the next prompt based on assessment
 *
 * This enables intelligent continuation after 6-8 hour sessions that
 * exhaust context memory.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';

/**
 * @typedef {Object} OrientationResult
 * @property {string} summary - High-level summary of what happened
 * @property {string} phase - Current phase (early/mid/late/complete)
 * @property {number} estimatedProgress - 0-100 progress estimate
 * @property {string[]} accomplishments - What was achieved
 * @property {string[]} pendingTasks - What remains to be done
 * @property {string[]} blockers - Current blockers
 * @property {string[]} learnings - Key learnings from session
 * @property {string} lastAction - The last significant action taken
 * @property {string} recommendedNextStep - Suggested next action
 * @property {Object} filesChanged - Summary of file changes
 * @property {Object} testStatus - Test pass/fail status if available
 */

/**
 * @typedef {Object} PromptGenerationResult
 * @property {string} prompt - Generated continuation prompt
 * @property {string} systemContext - System context to inject
 * @property {string[]} prioritizedTasks - Ordered list of tasks
 * @property {Object} contextFiles - Key files to reference
 */

/**
 * @typedef {Object} AssessmentContext
 * @property {string} objective - Original task objective
 * @property {string} completionCriteria - How to know when done
 * @property {Object} preSnapshot - Pre-session state
 * @property {Object} postSnapshot - Post-session state
 * @property {Object} diff - Calculated diff
 * @property {Object} parsedEvents - Parsed stream events
 * @property {string} transcriptPath - Path to session transcript
 * @property {number} iteration - Current iteration number
 * @property {string[]} accumulatedLearnings - Learnings from previous iterations
 */

export class StateAssessor {
  /**
   * @param {string} projectRoot - Project root directory
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    /** @type {import('./lib/provider-adapter.mjs').ProviderAdapter|null} */
    this.providerAdapter = null;
  }

  /**
   * Set the provider adapter for CLI abstraction
   * @param {import('./lib/provider-adapter.mjs').ProviderAdapter} adapter
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  /**
   * Phase 1: Orient - Understand what happened in the session
   *
   * This phase analyzes all available artifacts to build a comprehensive
   * understanding of the session state.
   *
   * @param {AssessmentContext} context - Assessment context
   * @returns {Promise<OrientationResult>}
   */
  async orient(context) {
    const orientationData = {
      summary: '',
      phase: 'unknown',
      estimatedProgress: 0,
      accomplishments: [],
      pendingTasks: [],
      blockers: [],
      learnings: [],
      lastAction: '',
      recommendedNextStep: '',
      filesChanged: {},
      testStatus: null,
    };

    try {
      // Analyze file changes from diff
      if (context.diff) {
        orientationData.filesChanged = this._analyzeFileChanges(context.diff);
      }

      // Analyze test results if available
      if (context.postSnapshot?.testResults) {
        orientationData.testStatus = this._analyzeTestResults(context.postSnapshot.testResults);
      }

      // Analyze parsed events for activity patterns
      if (context.parsedEvents) {
        const eventAnalysis = this._analyzeEvents(context.parsedEvents);
        orientationData.lastAction = eventAnalysis.lastAction;
        orientationData.accomplishments.push(...eventAnalysis.accomplishments);
      }

      // Analyze .aiwg artifacts for structured progress
      const aiwgAnalysis = await this._analyzeAiwgArtifacts(context);
      orientationData.accomplishments.push(...aiwgAnalysis.accomplishments);
      orientationData.pendingTasks.push(...aiwgAnalysis.pendingTasks);

      // Analyze internal Ralph state if present
      const ralphState = this._analyzeInternalRalphState(context);
      if (ralphState) {
        orientationData.learnings.push(...ralphState.learnings);
        if (ralphState.currentTask) {
          orientationData.lastAction = ralphState.currentTask;
        }
      }

      // Calculate phase and progress
      orientationData.phase = this._determinePhase(orientationData);
      orientationData.estimatedProgress = this._estimateProgress(context, orientationData);

      // Generate summary
      orientationData.summary = this._generateOrientationSummary(context, orientationData);

      // Determine recommended next step
      orientationData.recommendedNextStep = this._determineNextStep(context, orientationData);

    } catch (error) {
      orientationData.summary = `Orientation failed: ${error.message}`;
      orientationData.blockers.push(`Assessment error: ${error.message}`);
    }

    return orientationData;
  }

  /**
   * Phase 2: Generate Prompt - Create continuation prompt based on orientation
   *
   * Uses orientation results to create an intelligent, context-aware prompt
   * for the next session.
   *
   * @param {AssessmentContext} context - Assessment context
   * @param {OrientationResult} orientation - Result from orient phase
   * @returns {Promise<PromptGenerationResult>}
   */
  async generatePrompt(context, orientation) {
    const result = {
      prompt: '',
      systemContext: '',
      prioritizedTasks: [],
      contextFiles: {},
    };

    try {
      // Prioritize tasks based on orientation
      result.prioritizedTasks = this._prioritizeTasks(context, orientation);

      // Identify key context files to reference
      result.contextFiles = this._identifyContextFiles(context, orientation);

      // Build system context
      result.systemContext = this._buildSystemContext(context, orientation);

      // Generate the main prompt
      result.prompt = this._buildContinuationPrompt(context, orientation, result);

    } catch (error) {
      // Fallback to basic prompt
      result.prompt = this._buildFallbackPrompt(context, orientation, error);
    }

    return result;
  }

  /**
   * Run full two-phase assessment
   *
   * @param {AssessmentContext} context - Assessment context
   * @returns {Promise<{orientation: OrientationResult, prompt: PromptGenerationResult}>}
   */
  async assess(context) {
    const orientation = await this.orient(context);
    const prompt = await this.generatePrompt(context, orientation);

    return { orientation, prompt };
  }

  /**
   * Use Claude to enhance assessment (when pattern matching is insufficient)
   *
   * @param {AssessmentContext} context - Assessment context
   * @param {OrientationResult} orientation - Initial orientation
   * @returns {Promise<OrientationResult>}
   */
  async enhanceWithClaude(context, orientation) {
    try {
      const analysisPrompt = this._buildClaudeAnalysisPrompt(context, orientation);

      // Use adapter for binary and args if available
      const binary = this.providerAdapter ? this.providerAdapter.getBinary() : 'claude';
      const args = this.providerAdapter
        ? this.providerAdapter.buildAnalysisArgs({
            prompt: analysisPrompt,
            model: 'sonnet',
          })
        : [
            '--dangerously-skip-permissions',
            '--print',
            '--output-format', 'json',
            '--model', 'sonnet',
            analysisPrompt,
          ];

      const result = spawnSync(binary, args, {
        encoding: 'utf8',
        timeout: 120000, // 2 minute timeout
        cwd: this.projectRoot,
        killSignal: 'SIGKILL',
      });

      if (result.status === 0) {
        const enhanced = this._parseClaudeEnhancement(result.stdout, orientation);
        return enhanced;
      }

      return orientation;
    } catch (error) {
      // Return unenhanced orientation on failure
      return orientation;
    }
  }

  // ============================================================
  // Private Helper Methods
  // ============================================================

  /**
   * Analyze file changes from diff
   * @private
   */
  _analyzeFileChanges(diff) {
    const changes = {
      added: [],
      modified: [],
      deleted: [],
      byCategory: {
        source: [],
        test: [],
        config: [],
        docs: [],
        aiwg: [],
        other: [],
      },
    };

    if (diff.files?.added) {
      changes.added = diff.files.added;
    }
    if (diff.files?.modified) {
      changes.modified = diff.files.modified;
    }
    if (diff.files?.deleted) {
      changes.deleted = diff.files.deleted;
    }

    // Categorize files
    const allFiles = [...changes.added, ...changes.modified];
    for (const file of allFiles) {
      if (file.includes('.aiwg/')) {
        changes.byCategory.aiwg.push(file);
      } else if (file.includes('test') || file.includes('spec')) {
        changes.byCategory.test.push(file);
      } else if (file.endsWith('.json') || file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.toml')) {
        changes.byCategory.config.push(file);
      } else if (file.endsWith('.md') || file.endsWith('.txt') || file.includes('doc')) {
        changes.byCategory.docs.push(file);
      } else if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.tsx') || file.endsWith('.jsx')) {
        changes.byCategory.source.push(file);
      } else {
        changes.byCategory.other.push(file);
      }
    }

    return changes;
  }

  /**
   * Analyze test results
   * @private
   */
  _analyzeTestResults(testResults) {
    const status = {
      ran: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      summary: '',
    };

    if (!testResults) return status;

    status.ran = true;
    status.passed = testResults.passed || 0;
    status.failed = testResults.failed || 0;
    status.skipped = testResults.skipped || 0;
    status.total = status.passed + status.failed + status.skipped;

    if (status.failed > 0) {
      status.summary = `${status.failed}/${status.total} tests failing`;
    } else if (status.total > 0) {
      status.summary = `All ${status.total} tests passing`;
    }

    return status;
  }

  /**
   * Analyze parsed stream events
   * @private
   */
  _analyzeEvents(parsedEvents) {
    const analysis = {
      lastAction: '',
      accomplishments: [],
      toolsUsed: [],
      errorsEncountered: [],
    };

    if (!parsedEvents?.events) return analysis;

    const events = parsedEvents.events;

    // Find tool calls and their results
    for (const event of events) {
      if (event.type === 'tool_call') {
        const toolName = event.data?.name || event.data?.tool || 'unknown';
        if (!analysis.toolsUsed.includes(toolName)) {
          analysis.toolsUsed.push(toolName);
        }
      }
      if (event.type === 'error') {
        analysis.errorsEncountered.push(event.data?.error || event.data?.message || 'Unknown error');
      }
    }

    // Get last meaningful action
    const lastToolCall = [...events].reverse().find(e => e.type === 'tool_call');
    if (lastToolCall) {
      analysis.lastAction = `Used ${lastToolCall.data?.name || 'tool'}`;
    }

    // Derive accomplishments from tool usage
    if (analysis.toolsUsed.includes('Write') || analysis.toolsUsed.includes('Edit')) {
      analysis.accomplishments.push('Made code modifications');
    }
    if (analysis.toolsUsed.includes('Bash')) {
      analysis.accomplishments.push('Executed shell commands');
    }

    return analysis;
  }

  /**
   * Analyze .aiwg artifacts for progress
   * @private
   */
  async _analyzeAiwgArtifacts(context) {
    const analysis = {
      accomplishments: [],
      pendingTasks: [],
    };

    const aiwgDir = join(this.projectRoot, '.aiwg');
    if (!existsSync(aiwgDir)) {
      return analysis;
    }

    // Check for common artifact indicators
    const checkPaths = [
      { path: 'requirements', msg: 'Requirements documented' },
      { path: 'architecture', msg: 'Architecture defined' },
      { path: 'testing', msg: 'Test strategy created' },
      { path: 'planning', msg: 'Planning completed' },
    ];

    for (const check of checkPaths) {
      if (existsSync(join(aiwgDir, check.path))) {
        analysis.accomplishments.push(check.msg);
      }
    }

    // Check for Ralph state
    const ralphDir = join(aiwgDir, 'ralph');
    if (existsSync(ralphDir)) {
      analysis.accomplishments.push('Internal Ralph loop tracking established');
    }

    return analysis;
  }

  /**
   * Analyze internal Ralph state
   * @private
   */
  _analyzeInternalRalphState(context) {
    const ralphStatePath = join(this.projectRoot, '.aiwg', 'ralph', 'current-loop.json');

    if (!existsSync(ralphStatePath)) {
      return null;
    }

    try {
      const state = JSON.parse(readFileSync(ralphStatePath, 'utf8'));
      return {
        active: state.active || false,
        currentTask: state.task || state.currentTask || '',
        iteration: state.currentIteration || 0,
        learnings: state.learnings || [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Determine project phase
   * @private
   */
  _determinePhase(orientationData) {
    const { accomplishments, pendingTasks, estimatedProgress, testStatus } = orientationData;

    if (testStatus?.ran && testStatus.failed === 0 && accomplishments.length > 3) {
      return 'complete';
    }

    if (estimatedProgress > 80) return 'late';
    if (estimatedProgress > 40) return 'mid';
    return 'early';
  }

  /**
   * Estimate overall progress
   * @private
   */
  _estimateProgress(context, orientationData) {
    let score = 0;

    // Base score from accomplishments
    score += Math.min(orientationData.accomplishments.length * 10, 30);

    // Score from file changes
    const fileCount = (orientationData.filesChanged?.modified?.length || 0) +
                      (orientationData.filesChanged?.added?.length || 0);
    score += Math.min(fileCount * 5, 25);

    // Score from test status
    if (orientationData.testStatus?.ran) {
      if (orientationData.testStatus.failed === 0) {
        score += 30;
      } else {
        const passRate = orientationData.testStatus.passed /
                        (orientationData.testStatus.total || 1);
        score += Math.floor(passRate * 20);
      }
    }

    // Penalties for blockers
    score -= orientationData.blockers.length * 10;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Generate orientation summary
   * @private
   */
  _generateOrientationSummary(context, orientationData) {
    const parts = [];

    parts.push(`Iteration ${context.iteration} assessment.`);
    parts.push(`Phase: ${orientationData.phase}.`);
    parts.push(`Progress: ~${orientationData.estimatedProgress}%.`);

    if (orientationData.accomplishments.length > 0) {
      parts.push(`Accomplished: ${orientationData.accomplishments.slice(0, 3).join(', ')}.`);
    }

    if (orientationData.blockers.length > 0) {
      parts.push(`Blockers: ${orientationData.blockers.join(', ')}.`);
    }

    if (orientationData.lastAction) {
      parts.push(`Last action: ${orientationData.lastAction}.`);
    }

    return parts.join(' ');
  }

  /**
   * Determine recommended next step
   * @private
   */
  _determineNextStep(context, orientationData) {
    // If tests failing, fix them
    if (orientationData.testStatus?.failed > 0) {
      return `Fix ${orientationData.testStatus.failed} failing tests`;
    }

    // If blockers, address them
    if (orientationData.blockers.length > 0) {
      return `Address blocker: ${orientationData.blockers[0]}`;
    }

    // If pending tasks, continue
    if (orientationData.pendingTasks.length > 0) {
      return `Continue with: ${orientationData.pendingTasks[0]}`;
    }

    // If near complete, verify
    if (orientationData.phase === 'late') {
      return 'Verify completion criteria and finalize';
    }

    return 'Continue implementation per objective';
  }

  /**
   * Prioritize tasks based on orientation
   * @private
   */
  _prioritizeTasks(context, orientation) {
    const tasks = [];

    // High priority: fix failing tests
    if (orientation.testStatus?.failed > 0) {
      tasks.push({
        priority: 1,
        task: 'Fix failing tests',
        reason: `${orientation.testStatus.failed} tests failing`,
      });
    }

    // High priority: address blockers
    for (const blocker of orientation.blockers) {
      tasks.push({
        priority: 1,
        task: `Resolve: ${blocker}`,
        reason: 'Blocking progress',
      });
    }

    // Medium priority: pending tasks
    for (const pending of orientation.pendingTasks) {
      tasks.push({
        priority: 2,
        task: pending,
        reason: 'Identified pending work',
      });
    }

    // Sort by priority
    tasks.sort((a, b) => a.priority - b.priority);

    return tasks.map(t => t.task);
  }

  /**
   * Identify key context files
   * @private
   */
  _identifyContextFiles(context, orientation) {
    const files = {};

    // Recently modified source files
    const sourceFiles = orientation.filesChanged?.byCategory?.source || [];
    if (sourceFiles.length > 0) {
      files.recentlyModified = sourceFiles.slice(0, 5);
    }

    // Test files if tests failing
    if (orientation.testStatus?.failed > 0) {
      const testFiles = orientation.filesChanged?.byCategory?.test || [];
      files.testFiles = testFiles.slice(0, 3);
    }

    // AIWG artifacts
    const aiwgFiles = orientation.filesChanged?.byCategory?.aiwg || [];
    if (aiwgFiles.length > 0) {
      files.artifacts = aiwgFiles.slice(0, 5);
    }

    return files;
  }

  /**
   * Build system context for continuation
   * @private
   */
  _buildSystemContext(context, orientation) {
    const lines = [];

    lines.push('# Session Continuation Context');
    lines.push('');
    lines.push(`You are resuming work on iteration ${context.iteration + 1} of an External Ralph loop.`);
    lines.push('');
    lines.push('## Previous Session Summary');
    lines.push(orientation.summary);
    lines.push('');

    if (orientation.learnings.length > 0) {
      lines.push('## Key Learnings');
      for (const learning of orientation.learnings) {
        lines.push(`- ${learning}`);
      }
      lines.push('');
    }

    if (context.accumulatedLearnings?.length > 0) {
      lines.push('## Accumulated Learnings from All Iterations');
      lines.push(context.accumulatedLearnings.join('\n'));
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build continuation prompt
   * @private
   */
  _buildContinuationPrompt(context, orientation, promptResult) {
    const lines = [];

    lines.push('# Continue External Ralph Loop');
    lines.push('');
    lines.push(`**Objective**: ${context.objective}`);
    lines.push('');
    lines.push(`**Completion Criteria**: ${context.completionCriteria}`);
    lines.push('');
    lines.push('## Current Status');
    lines.push('');
    lines.push(`- **Progress**: ${orientation.estimatedProgress}%`);
    lines.push(`- **Phase**: ${orientation.phase}`);
    lines.push('');

    if (orientation.accomplishments.length > 0) {
      lines.push('## Already Accomplished');
      for (const acc of orientation.accomplishments) {
        lines.push(`- ${acc}`);
      }
      lines.push('');
    }

    if (promptResult.prioritizedTasks.length > 0) {
      lines.push('## Priority Tasks');
      for (let i = 0; i < Math.min(5, promptResult.prioritizedTasks.length); i++) {
        lines.push(`${i + 1}. ${promptResult.prioritizedTasks[i]}`);
      }
      lines.push('');
    }

    lines.push('## Instructions');
    lines.push('');
    lines.push(`1. ${orientation.recommendedNextStep}`);
    lines.push('2. Use /ralph for iterative subtasks if needed');
    lines.push('3. Update .aiwg/ artifacts to track progress');
    lines.push('4. When complete, output: {"ralph_external_completion": true, "success": true}');
    lines.push('');

    if (Object.keys(promptResult.contextFiles).length > 0) {
      lines.push('## Key Files to Review');
      for (const [category, files] of Object.entries(promptResult.contextFiles)) {
        if (files?.length > 0) {
          lines.push(`- ${category}: ${files.join(', ')}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Build fallback prompt when generation fails
   * @private
   */
  _buildFallbackPrompt(context, orientation, error) {
    return `# Continue External Ralph Loop

**Objective**: ${context.objective}

**Completion Criteria**: ${context.completionCriteria}

**Previous Progress**: ${orientation.estimatedProgress}%

Continue working toward the objective. The assessment process encountered an issue (${error.message}), so review the current state manually.

When complete, output: {"ralph_external_completion": true, "success": true}
`;
  }

  /**
   * Build Claude analysis prompt
   * @private
   */
  _buildClaudeAnalysisPrompt(context, orientation) {
    return `Analyze this External Ralph loop session state and provide enhanced assessment.

Objective: ${context.objective}
Current Progress: ${orientation.estimatedProgress}%
Phase: ${orientation.phase}

Accomplishments: ${JSON.stringify(orientation.accomplishments)}
Pending Tasks: ${JSON.stringify(orientation.pendingTasks)}
Blockers: ${JSON.stringify(orientation.blockers)}

Files Changed: ${JSON.stringify(orientation.filesChanged)}
Test Status: ${JSON.stringify(orientation.testStatus)}

Provide a JSON response with:
{
  "enhancedSummary": "...",
  "additionalLearnings": ["..."],
  "refinedProgress": 0-100,
  "suggestedApproach": "..."
}`;
  }

  /**
   * Parse Claude enhancement response
   * @private
   */
  _parseClaudeEnhancement(stdout, orientation) {
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const enhanced = JSON.parse(jsonMatch[0]);

        return {
          ...orientation,
          summary: enhanced.enhancedSummary || orientation.summary,
          learnings: [...orientation.learnings, ...(enhanced.additionalLearnings || [])],
          estimatedProgress: enhanced.refinedProgress || orientation.estimatedProgress,
          recommendedNextStep: enhanced.suggestedApproach || orientation.recommendedNextStep,
        };
      }
    } catch {
      // Return unmodified on parse error
    }

    return orientation;
  }

  /**
   * Save assessment results to file
   *
   * @param {string} outputDir - Directory to save results
   * @param {OrientationResult} orientation - Orientation results
   * @param {PromptGenerationResult} prompt - Prompt generation results
   */
  saveAssessment(outputDir, orientation, prompt) {
    mkdirSync(outputDir, { recursive: true });

    const assessmentPath = join(outputDir, 'assessment.json');
    writeFileSync(assessmentPath, JSON.stringify({
      orientation,
      prompt: {
        ...prompt,
        // Truncate long prompt for JSON
        promptPreview: prompt.prompt?.slice(0, 500) + '...',
      },
      timestamp: new Date().toISOString(),
    }, null, 2));

    const promptPath = join(outputDir, 'next-prompt.md');
    writeFileSync(promptPath, prompt.prompt);

    const systemContextPath = join(outputDir, 'system-context.md');
    writeFileSync(systemContextPath, prompt.systemContext);

    return { assessmentPath, promptPath, systemContextPath };
  }
}

export default StateAssessor;
