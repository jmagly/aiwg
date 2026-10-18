/**
 * Output Analyzer for External Ralph Loop
 *
 * Analyzes Claude Code session output to determine completion status,
 * extract learnings, and decide on next actions.
 *
 * Uses a separate Claude session for intelligent analysis, with
 * pattern-matching fallback.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 */

import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import PromptGenerator from './prompt-generator.mjs';

/**
 * @typedef {Object} AnalysisResult
 * @property {boolean} completed - Whether the task completed
 * @property {boolean|null} success - Whether completion was successful
 * @property {string|null} failureClass - Classification of failure
 * @property {number} completionPercentage - Estimated progress 0-100
 * @property {boolean} shouldContinue - Whether to try another iteration
 * @property {string} learnings - Extracted insights for next iteration
 * @property {string[]} artifactsModified - Files that were changed
 * @property {string[]} blockers - Things preventing completion
 * @property {string} nextApproach - Suggested approach for continuation
 */

/**
 * @typedef {Object} AnalysisOptions
 * @property {string} stdoutPath - Path to stdout log
 * @property {string} stderrPath - Path to stderr log
 * @property {number} exitCode - Process exit code
 * @property {Object} context - Task context
 * @property {string} context.objective - Original objective
 * @property {string} context.criteria - Completion criteria
 * @property {boolean} [useClaude=true] - Whether to use Claude for analysis
 * @property {string} [model='sonnet'] - Model for analysis
 */

// Maximum characters to include in analysis
const MAX_OUTPUT_CHARS = 50000;

// Completion marker patterns
const COMPLETION_PATTERNS = [
  /\{"ralph_external_completion":\s*true.*?\}/s,
  /Ralph Loop:\s*(SUCCESS|COMPLETE)/i,
  /\[Ralph\]\s*Completed/i,
];

// Failure patterns
const FAILURE_PATTERNS = {
  context_exhausted: [
    /context.*limit/i,
    /maximum context/i,
    /token limit/i,
  ],
  budget_exceeded: [
    /budget.*exceeded/i,
    /spending limit/i,
    /cost limit/i,
  ],
  internal_loop_limit: [
    /MAX_ITERATIONS/i,
    /maximum iterations/i,
    /iteration limit/i,
  ],
  crash: [
    /SIGTERM/i,
    /SIGKILL/i,
    /process.*killed/i,
    /unexpected.*termination/i,
  ],
};

export class OutputAnalyzer {
  constructor() {
    this.promptGenerator = new PromptGenerator();
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
   * Read and truncate output file
   * @param {string} path - File path
   * @param {number} maxChars - Maximum characters
   * @returns {string}
   */
  readOutput(path, maxChars = MAX_OUTPUT_CHARS) {
    if (!existsSync(path)) {
      return '';
    }
    const content = readFileSync(path, 'utf8');
    // Take last N characters (most recent output is most relevant)
    return content.slice(-maxChars);
  }

  /**
   * Analyze output using Claude
   * @param {AnalysisOptions} options
   * @returns {AnalysisResult|null}
   */
  analyzeWithClaude(options) {
    const stdout = this.readOutput(options.stdoutPath);
    const stderr = this.readOutput(options.stderrPath);

    const analysisPrompt = this.promptGenerator.buildAnalysisPrompt({
      stdout,
      stderr,
      exitCode: options.exitCode,
      objective: options.context.objective,
      criteria: options.context.criteria,
    });

    try {
      // Use adapter for binary and args if available
      const binary = this.providerAdapter ? this.providerAdapter.getBinary() : 'claude';
      const args = this.providerAdapter
        ? this.providerAdapter.buildAnalysisArgs({
            prompt: analysisPrompt,
            model: options.model || 'sonnet',
            agent: 'ralph-output-analyzer',
          })
        : [
            '--dangerously-skip-permissions',
            '--print',
            '--output-format', 'json',
            '--model', options.model || 'sonnet',
            '--agent', 'ralph-output-analyzer',
            analysisPrompt,
          ];

      const result = spawnSync(binary, args, {
        encoding: 'utf8',
        timeout: 60000, // 1 minute timeout for analysis
        killSignal: 'SIGKILL',
      });

      if (result.status !== 0) {
        console.error('Claude analysis failed:', result.stderr);
        return null;
      }

      // Parse JSON from output.
      // For providers that emit newline-delimited JSON events (e.g., opencode
      // --format json), use the adapter's parseOutput() to extract the model's
      // text response first, then look for embedded JSON within that text.
      // For plain-text providers (codex, claude --output-format json), fall back
      // to searching the raw stdout directly.
      let output;
      if (this.providerAdapter && typeof this.providerAdapter.parseOutput === 'function') {
        const parsed = this.providerAdapter.parseOutput(result.stdout);
        output = parsed?.text ?? result.stdout.trim();
      } else {
        output = result.stdout.trim();
      }

      // Try to extract JSON from the output
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Merge with defaults to ensure all fields are present
        return {
          completed: false,
          success: null,
          failureClass: null,
          completionPercentage: 0,
          shouldContinue: true,
          learnings: '',
          artifactsModified: [],
          blockers: [],
          nextApproach: 'Continue with accumulated context',
          ...parsed,
        };
      }

      return null;
    } catch (e) {
      console.error('Claude analysis error:', e.message);
      return null;
    }
  }

  /**
   * Analyze output using pattern matching (fallback)
   * @param {AnalysisOptions} options
   * @returns {AnalysisResult}
   */
  analyzeWithPatterns(options) {
    const stdout = this.readOutput(options.stdoutPath);
    const stderr = this.readOutput(options.stderrPath);
    const combined = stdout + '\n' + stderr;

    // Default result
    /** @type {AnalysisResult} */
    const result = {
      completed: false,
      success: null,
      failureClass: null,
      completionPercentage: 0,
      shouldContinue: true,
      learnings: '',
      artifactsModified: [],
      blockers: [],
      nextApproach: 'Continue with accumulated context',
    };

    // Check for explicit completion markers
    for (const pattern of COMPLETION_PATTERNS) {
      const match = combined.match(pattern);
      if (match) {
        result.completed = true;

        // Try to parse JSON completion marker
        if (match[0].startsWith('{')) {
          try {
            const marker = JSON.parse(match[0]);
            result.success = marker.success;
            result.shouldContinue = !marker.success;
            if (marker.reason) {
              result.learnings = marker.reason;
            }
          } catch {
            result.success = true;
          }
        } else {
          result.success = true;
        }

        result.shouldContinue = !result.success;
        return result;
      }
    }

    // Check for failure patterns
    for (const [failureClass, patterns] of Object.entries(FAILURE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(combined)) {
          result.failureClass = failureClass;
          result.learnings = `Session ended due to: ${failureClass}`;

          // Context exhaustion should continue
          if (failureClass === 'context_exhausted') {
            result.shouldContinue = true;
            result.nextApproach = 'Continue in new session with accumulated context';
          } else if (failureClass === 'internal_loop_limit') {
            result.shouldContinue = true;
            result.nextApproach = 'Retry with different approach based on learnings';
          } else {
            result.shouldContinue = false;
          }

          return result;
        }
      }
    }

    // Check exit code
    if (options.exitCode !== 0) {
      result.failureClass = 'crash';
      result.learnings = `Session exited with code ${options.exitCode}`;
      result.shouldContinue = true;
      result.nextApproach = 'Retry after crash recovery';
    }

    // Estimate completion percentage from output characteristics
    result.completionPercentage = this.estimateProgress(stdout);

    // Extract modified files from git-like patterns
    result.artifactsModified = this.extractModifiedFiles(stdout);

    return result;
  }

  /**
   * Estimate completion percentage from output
   * @param {string} output
   * @returns {number}
   */
  estimateProgress(output) {
    let score = 0;

    // Look for progress indicators
    if (/tests?\s+(pass|passing)/i.test(output)) score += 30;
    if (/build.*success/i.test(output)) score += 20;
    if (/commit/i.test(output)) score += 10;
    if (/created.*file/i.test(output)) score += 10;
    if (/modified.*file/i.test(output)) score += 10;
    if (/ralph.*iteration/i.test(output)) score += 10;

    // Cap at 90% unless explicitly complete
    return Math.min(score, 90);
  }

  /**
   * Extract modified files from output
   * @param {string} output
   * @returns {string[]}
   */
  extractModifiedFiles(output) {
    const files = new Set();

    // Git-style patterns
    const patterns = [
      /modified:\s+(\S+)/g,
      /created:\s+(\S+)/g,
      /Writing.*?(\S+\.(?:ts|js|mjs|md|json))/g,
      /Edit.*?(\S+\.(?:ts|js|mjs|md|json))/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        files.add(match[1]);
      }
    }

    return Array.from(files);
  }

  /**
   * Analyze session output
   * @param {AnalysisOptions} options
   * @returns {Promise<AnalysisResult>}
   */
  async analyze(options) {
    const useClaude = options.useClaude !== false;

    if (useClaude) {
      const claudeResult = this.analyzeWithClaude(options);
      if (claudeResult) {
        return claudeResult;
      }
      console.log('Claude analysis failed, falling back to pattern matching');
    }

    return this.analyzeWithPatterns(options);
  }
}

export default OutputAnalyzer;
