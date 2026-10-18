/**
 * Claude-Powered Prompt Generator for External Ralph Loop
 *
 * Replaces template-based prompts with Claude-generated dynamic prompts
 * that adapt to project state, previous iteration history, and PID metrics.
 *
 * @implements Issue #22 - Claude Intelligence Layer
 * @references REF-015 Self-Refine, REF-021 Reflexion
 */

import { spawnSync } from 'child_process';
import { importImpl } from '../../_resolve-impl.mjs';

const { positiveTimeoutMs } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

/**
 * @typedef {Object} PromptContext
 * @property {string} objective - Task objective
 * @property {string} completionCriteria - Completion criteria
 * @property {number} iteration - Current iteration number
 * @property {number} maxIterations - Maximum iterations
 * @property {string} loopId - Loop identifier
 * @property {Object} stateAssessment - Output from StateAssessor
 * @property {Object} pidMetrics - PID controller metrics
 * @property {Object} validationResults - Pre-iteration validation results
 * @property {Object} history - Previous iteration history
 * @property {string[]} learnings - Accumulated learnings
 * @property {Object} strategyPlan - Strategy from StrategyPlanner
 */

/**
 * @typedef {Object} GeneratedPrompt
 * @property {string} prompt - Main prompt text
 * @property {string} systemContext - System context injection
 * @property {string[]} focusAreas - Priority focus areas
 * @property {string[]} toolSuggestions - Recommended tools to use
 * @property {Object} metadata - Generation metadata
 */

/**
 * @typedef {Object} ClaudePromptGeneratorOptions
 * @property {string} [model='sonnet'] - Claude model for generation
 * @property {number} [timeout=90000] - Generation timeout in ms
 * @property {boolean} [verbose=false] - Enable verbose output
 */

export class ClaudePromptGenerator {
  /**
   * @param {ClaudePromptGeneratorOptions} options
   */
  constructor(options = {}) {
    this.model = options.model || 'sonnet';
    this.timeout = options.timeout || 90000;
    this.verbose = options.verbose || false;
    /** @type {import('./provider-adapter.mjs').ProviderAdapter|null} */
    this.providerAdapter = null;
  }

  /**
   * Set the provider adapter for CLI abstraction
   * @param {import('./provider-adapter.mjs').ProviderAdapter} adapter
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  /**
   * Generate dynamic prompt using Claude analysis
   * @param {PromptContext} context - Context for prompt generation
   * @returns {Promise<GeneratedPrompt>}
   */
  async generate(context) {
    if (this.verbose) {
      console.log('[ClaudePromptGenerator] Generating dynamic prompt...');
    }

    try {
      // Build analysis prompt for Claude
      const analysisPrompt = this._buildAnalysisPrompt(context);

      // Use adapter for binary and args if available
      const binary = this.providerAdapter ? this.providerAdapter.getBinary() : 'claude';
      const args = this.providerAdapter
        ? this.providerAdapter.buildAnalysisArgs({
            prompt: analysisPrompt,
            model: this.model,
          })
        : [
            '--dangerously-skip-permissions',
            '--print',
            '--output-format', 'json',
            '--model', this.model,
            analysisPrompt,
          ];

      const result = spawnSync(binary, args, {
        encoding: 'utf8',
        input: '',
        // this.timeout is caller-controlled (options.timeout || 90000,
        // which still lets a negative value through); clamp it so it can
        // never disable or invert the bound (#3062 B/C finding 8).
        timeout: positiveTimeoutMs(this.timeout, 90000),
        killSignal: 'SIGKILL',
      });

      if (result.status !== 0) {
        console.error('[ClaudePromptGenerator] Claude invocation failed:', result.stderr);
        return this._buildFallbackPrompt(context);
      }

      // Parse Claude's response
      const generated = this._parseClaudeResponse(result.stdout);

      if (!generated) {
        console.warn('[ClaudePromptGenerator] Failed to parse response, using fallback');
        return this._buildFallbackPrompt(context);
      }

      // Enhance with context-aware tool suggestions
      generated.toolSuggestions = this._suggestTools(context, generated);

      return generated;

    } catch (error) {
      console.error('[ClaudePromptGenerator] Error:', error.message);
      return this._buildFallbackPrompt(context);
    }
  }

  /**
   * Build analysis prompt for Claude
   * @private
   * @param {PromptContext} context
   * @returns {string}
   */
  _buildAnalysisPrompt(context) {
    const parts = [];

    parts.push('# Generate Dynamic Claude Code Session Prompt');
    parts.push('');
    parts.push('You are generating a prompt for a Claude Code session that is part of an External Ralph loop.');
    parts.push('Analyze the provided context and generate a focused, actionable prompt.');
    parts.push('');

    // Task context
    parts.push('## Task Information');
    parts.push('');
    parts.push(`**Objective**: ${context.objective}`);
    parts.push(`**Completion Criteria**: ${context.completionCriteria}`);
    parts.push(`**Iteration**: ${context.iteration} / ${context.maxIterations}`);
    parts.push(`**Loop ID**: ${context.loopId}`);
    parts.push('');

    // State assessment
    if (context.stateAssessment) {
      parts.push('## Current State');
      parts.push('');
      parts.push(`**Progress**: ${context.stateAssessment.estimatedProgress || 0}%`);
      parts.push(`**Phase**: ${context.stateAssessment.phase || 'unknown'}`);

      if (context.stateAssessment.accomplishments?.length > 0) {
        parts.push('');
        parts.push('**Accomplishments**:');
        for (const acc of context.stateAssessment.accomplishments.slice(0, 5)) {
          parts.push(`- ${acc}`);
        }
      }

      if (context.stateAssessment.blockers?.length > 0) {
        parts.push('');
        parts.push('**Blockers**:');
        for (const blocker of context.stateAssessment.blockers) {
          parts.push(`- ${blocker}`);
        }
      }
    }

    // PID metrics
    if (context.pidMetrics) {
      parts.push('');
      parts.push('## Control Metrics');
      parts.push('');
      parts.push(`**Completion Gap**: ${(context.pidMetrics.proportional * 100).toFixed(1)}%`);
      parts.push(`**Accumulated Error**: ${(context.pidMetrics.integral || 0).toFixed(2)}`);
      parts.push(`**Trend**: ${context.pidMetrics.trend || 'unknown'}`);

      if (context.pidMetrics.velocity !== undefined) {
        const velocitySign = context.pidMetrics.velocity >= 0 ? '+' : '';
        parts.push(`**Velocity**: ${velocitySign}${(context.pidMetrics.velocity * 100).toFixed(1)}%/iteration`);
      }
    }

    // Strategy plan
    if (context.strategyPlan) {
      parts.push('');
      parts.push('## Recommended Strategy');
      parts.push('');
      parts.push(`**Approach**: ${context.strategyPlan.approach || 'continue'}`);

      if (context.strategyPlan.reasoning) {
        parts.push(`**Reasoning**: ${context.strategyPlan.reasoning}`);
      }

      if (context.strategyPlan.priorities?.length > 0) {
        parts.push('');
        parts.push('**Priorities**:');
        for (let i = 0; i < Math.min(3, context.strategyPlan.priorities.length); i++) {
          parts.push(`${i + 1}. ${context.strategyPlan.priorities[i]}`);
        }
      }
    }

    // Validation results
    if (context.validationResults) {
      parts.push('');
      parts.push('## Pre-Iteration Validation');
      parts.push('');
      parts.push(`**Status**: ${context.validationResults.passed ? 'PASSED' : 'FAILED'}`);

      if (context.validationResults.issues?.length > 0) {
        parts.push('');
        parts.push('**Issues to Address**:');
        for (const issue of context.validationResults.issues.slice(0, 3)) {
          parts.push(`- ${issue.message} (${issue.severity})`);
        }
      }
    }

    // Learnings
    if (context.learnings?.length > 0) {
      parts.push('');
      parts.push('## Accumulated Learnings');
      parts.push('');
      for (const learning of context.learnings.slice(-5)) {
        parts.push(`- ${learning}`);
      }
    }

    // Output format instructions
    parts.push('');
    parts.push('## Output Format');
    parts.push('');
    parts.push('Provide a JSON response with:');
    parts.push('');
    parts.push('```json');
    parts.push('{');
    parts.push('  "prompt": "The main prompt text for Claude Code session",');
    parts.push('  "systemContext": "System context to inject before the prompt",');
    parts.push('  "focusAreas": ["Priority 1", "Priority 2", "Priority 3"],');
    parts.push('  "reasoning": "Why this prompt structure is appropriate",');
    parts.push('  "urgency": "low|normal|high|critical"');
    parts.push('}');
    parts.push('```');
    parts.push('');
    parts.push('**Guidelines**:');
    parts.push('');
    parts.push('1. Make the prompt specific and actionable');
    parts.push('2. Reference concrete files/paths when available');
    parts.push('3. Prioritize based on PID metrics and validation results');
    parts.push('4. If blockers exist, address them first');
    parts.push('5. Include completion signal instructions: `{"ralph_external_completion": true, "success": boolean}`');
    parts.push('6. Adapt tone based on urgency level');

    return parts.join('\n');
  }

  /**
   * Parse Claude's JSON response
   * @private
   * @param {string} stdout
   * @returns {GeneratedPrompt|null}
   */
  _parseClaudeResponse(stdout) {
    try {
      // Extract JSON from stdout
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate required fields
      if (!parsed.prompt || typeof parsed.prompt !== 'string') {
        console.error('[ClaudePromptGenerator] Invalid response: missing prompt');
        return null;
      }

      return {
        prompt: parsed.prompt,
        systemContext: parsed.systemContext || '',
        focusAreas: Array.isArray(parsed.focusAreas) ? parsed.focusAreas : [],
        toolSuggestions: [], // Populated by _suggestTools
        metadata: {
          reasoning: parsed.reasoning || '',
          urgency: parsed.urgency || 'normal',
          generatedAt: new Date().toISOString(),
          model: this.model,
        },
      };

    } catch (error) {
      console.error('[ClaudePromptGenerator] Parse error:', error.message);
      return null;
    }
  }

  /**
   * Build fallback prompt when Claude generation fails
   * @private
   * @param {PromptContext} context
   * @returns {GeneratedPrompt}
   */
  _buildFallbackPrompt(context) {
    const parts = [];

    parts.push('# Continue External Ralph Loop');
    parts.push('');
    parts.push(`**Objective**: ${context.objective}`);
    parts.push(`**Completion Criteria**: ${context.completionCriteria}`);
    parts.push(`**Iteration**: ${context.iteration} / ${context.maxIterations}`);
    parts.push('');

    if (context.stateAssessment?.estimatedProgress !== undefined) {
      parts.push(`**Current Progress**: ~${context.stateAssessment.estimatedProgress}%`);
      parts.push('');
    }

    if (context.stateAssessment?.blockers?.length > 0) {
      parts.push('## Priority: Address Blockers');
      parts.push('');
      for (const blocker of context.stateAssessment.blockers) {
        parts.push(`- ${blocker}`);
      }
      parts.push('');
    }

    if (context.validationResults?.issues?.length > 0) {
      parts.push('## Pre-Iteration Issues');
      parts.push('');
      for (const issue of context.validationResults.issues) {
        parts.push(`- ${issue.message}`);
      }
      parts.push('');
    }

    parts.push('## Instructions');
    parts.push('');
    parts.push('1. Continue working toward the objective');
    parts.push('2. Address any blockers or validation issues first');
    parts.push('3. Use /ralph for iterative subtasks if needed');
    parts.push('4. Update .aiwg/ artifacts to track progress');
    parts.push('5. When complete, output: `{"ralph_external_completion": true, "success": true}`');

    return {
      prompt: parts.join('\n'),
      systemContext: `Resuming External Ralph loop ${context.loopId}, iteration ${context.iteration}`,
      focusAreas: context.stateAssessment?.blockers || ['Continue implementation'],
      toolSuggestions: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      metadata: {
        reasoning: 'Fallback prompt due to Claude generation failure',
        urgency: 'normal',
        generatedAt: new Date().toISOString(),
        model: 'fallback',
      },
    };
  }

  /**
   * Suggest appropriate tools based on context
   * @private
   * @param {PromptContext} context
   * @param {GeneratedPrompt} generated
   * @returns {string[]}
   */
  _suggestTools(context, generated) {
    const suggestions = new Set();

    // Always suggest basic tools
    suggestions.add('Read');
    suggestions.add('Write');

    // State-based suggestions
    if (context.stateAssessment) {
      const { phase, filesChanged } = context.stateAssessment;

      // Early phase - exploration
      if (phase === 'early') {
        suggestions.add('Glob');
        suggestions.add('Grep');
        suggestions.add('Read');
      }

      // Mid/late phase - implementation
      if (phase === 'mid' || phase === 'late') {
        suggestions.add('Edit');
        suggestions.add('Write');
        suggestions.add('Bash');
      }

      // If tests involved
      if (filesChanged?.byCategory?.test?.length > 0) {
        suggestions.add('Bash'); // For running tests
      }

      // If config changes
      if (filesChanged?.byCategory?.config?.length > 0) {
        suggestions.add('Edit');
      }
    }

    // Validation-based suggestions
    if (context.validationResults?.issues?.length > 0) {
      suggestions.add('Grep'); // For finding issues
      suggestions.add('Edit'); // For fixing issues
    }

    // Strategy-based suggestions
    if (context.strategyPlan?.approach === 'debug') {
      suggestions.add('Bash'); // For debugging commands
      suggestions.add('Grep'); // For searching logs
    }

    return Array.from(suggestions);
  }

  /**
   * Validate generated prompt quality
   * @param {GeneratedPrompt} generated
   * @returns {{valid: boolean, issues: string[]}}
   */
  validatePrompt(generated) {
    const issues = [];

    if (!generated.prompt || generated.prompt.length < 50) {
      issues.push('Prompt is too short (< 50 characters)');
    }

    if (!generated.prompt.includes('ralph_external_completion')) {
      issues.push('Prompt missing completion signal instructions');
    }

    if (generated.focusAreas.length === 0) {
      issues.push('No focus areas specified');
    }

    if (generated.toolSuggestions.length === 0) {
      issues.push('No tool suggestions provided');
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Get summary of prompt generation
   * @param {GeneratedPrompt} generated
   * @returns {Object}
   */
  getSummary(generated) {
    return {
      promptLength: generated.prompt.length,
      focusAreaCount: generated.focusAreas.length,
      toolSuggestionCount: generated.toolSuggestions.length,
      urgency: generated.metadata.urgency,
      model: generated.metadata.model,
      generatedAt: generated.metadata.generatedAt,
    };
  }
}

export default ClaudePromptGenerator;
