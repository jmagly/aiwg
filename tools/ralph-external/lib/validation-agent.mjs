/**
 * Validation Agent for External Ralph Loop
 *
 * Performs pre- and post-iteration validation to detect regressions,
 * test failures, build breaks, and other quality issues.
 *
 * @implements Issue #22 - Claude Intelligence Layer
 * @references REF-013 MetaGPT (Executable Feedback)
 */

import { spawnSync, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { importImpl } from '../../_resolve-impl.mjs';

const { positiveTimeoutMs } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} passed - Whether validation passed
 * @property {string} severity - 'ok'|'warning'|'error'|'critical'
 * @property {Array<ValidationIssue>} issues - Detected issues
 * @property {Object} details - Detailed validation data
 * @property {number} timestamp - When validation was performed
 */

/**
 * @typedef {Object} ValidationIssue
 * @property {string} type - Issue type (test_failure, build_error, etc.)
 * @property {string} severity - 'info'|'warning'|'error'|'critical'
 * @property {string} message - Issue description
 * @property {string} [file] - Affected file
 * @property {number} [line] - Affected line number
 * @property {string} [suggestion] - Suggested fix
 */

/**
 * @typedef {Object} ValidationAgentOptions
 * @property {string} [projectRoot] - Project root directory
 * @property {boolean} [runTests=true] - Whether to run tests
 * @property {boolean} [checkBuild=true] - Whether to check build
 * @property {boolean} [checkLint=true] - Whether to run linting
 * @property {number} [timeout=60000] - Command timeout in ms
 * @property {boolean} [verbose=false] - Enable verbose output
 */

export class ValidationAgent {
  /**
   * @param {ValidationAgentOptions} options
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.runTests = options.runTests !== false;
    this.checkBuild = options.checkBuild !== false;
    this.checkLint = options.checkLint !== false;
    // Caller-controlled; every spawnSync call below clamps it again via
    // positiveTimeoutMs so a negative value (which `||` doesn't catch)
    // can't invert the bound either (#3062 B/C finding 8).
    this.timeout = options.timeout || 60000;
    this.verbose = options.verbose || false;
  }

  /**
   * Perform pre-iteration validation
   * Validates that the project is in a good state before starting iteration
   *
   * @param {Object} context - Iteration context
   * @returns {Promise<ValidationResult>}
   */
  async validatePre(context) {
    if (this.verbose) {
      console.log('[ValidationAgent] Running pre-iteration validation...');
    }

    const issues = [];
    const details = {};

    // Check git status
    const gitCheck = this._checkGitStatus();
    details.git = gitCheck;
    if (gitCheck.issues?.length > 0) {
      issues.push(...gitCheck.issues);
    }

    // Check for package.json and dependencies
    const depsCheck = this._checkDependencies();
    details.dependencies = depsCheck;
    if (depsCheck.issues?.length > 0) {
      issues.push(...depsCheck.issues);
    }

    // Check for common blockers
    const blockerCheck = this._checkCommonBlockers();
    details.blockers = blockerCheck;
    if (blockerCheck.issues?.length > 0) {
      issues.push(...blockerCheck.issues);
    }

    // Determine overall severity
    const severity = this._determineSeverity(issues);
    const passed = severity !== 'error' && severity !== 'critical';

    return {
      passed,
      severity,
      issues,
      details,
      timestamp: Date.now(),
    };
  }

  /**
   * Perform post-iteration validation
   * Validates that the iteration didn't introduce regressions
   *
   * @param {Object} context - Iteration context
   * @param {Object} output - Iteration output
   * @returns {Promise<ValidationResult>}
   */
  async validatePost(context, output) {
    if (this.verbose) {
      console.log('[ValidationAgent] Running post-iteration validation...');
    }

    const issues = [];
    const details = {};

    // Run tests if enabled
    if (this.runTests) {
      const testResult = this._runTests();
      details.tests = testResult;
      if (testResult.issues?.length > 0) {
        issues.push(...testResult.issues);
      }
    }

    // Check build if enabled
    if (this.checkBuild) {
      const buildResult = this._checkBuild();
      details.build = buildResult;
      if (buildResult.issues?.length > 0) {
        issues.push(...buildResult.issues);
      }
    }

    // Check linting if enabled
    if (this.checkLint) {
      const lintResult = this._runLint();
      details.lint = lintResult;
      if (lintResult.issues?.length > 0) {
        issues.push(...lintResult.issues);
      }
    }

    // Check for new broken imports
    const importCheck = this._checkImports();
    details.imports = importCheck;
    if (importCheck.issues?.length > 0) {
      issues.push(...importCheck.issues);
    }

    // Determine overall severity
    const severity = this._determineSeverity(issues);
    const passed = severity !== 'error' && severity !== 'critical';

    return {
      passed,
      severity,
      issues,
      details,
      timestamp: Date.now(),
    };
  }

  /**
   * Check git status for uncommitted changes, conflicts, etc.
   * @private
   * @returns {Object}
   */
  _checkGitStatus() {
    const result = {
      clean: true,
      uncommitted: 0,
      conflicts: false,
      issues: [],
    };

    try {
      // Check for conflicts
      const conflictCheck = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
        killSignal: 'SIGKILL',
      });

      if (conflictCheck.stdout && conflictCheck.stdout.trim()) {
        result.conflicts = true;
        result.clean = false;
        result.issues.push({
          type: 'git_conflict',
          severity: 'critical',
          message: 'Git merge conflicts detected',
          suggestion: 'Resolve conflicts before continuing',
        });
      }

      // Check for uncommitted changes (informational only)
      const statusCheck = spawnSync('git', ['status', '--porcelain'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
        killSignal: 'SIGKILL',
      });

      if (statusCheck.stdout) {
        const lines = statusCheck.stdout.trim().split('\n').filter(l => l);
        result.uncommitted = lines.length;
        result.clean = lines.length === 0;
      }

    } catch (error) {
      // Git not available or error - not critical
      result.issues.push({
        type: 'git_unavailable',
        severity: 'warning',
        message: `Git check failed: ${error.message}`,
      });
    }

    return result;
  }

  /**
   * Check dependencies are installed
   * @private
   * @returns {Object}
   */
  _checkDependencies() {
    const result = {
      packageJsonExists: false,
      nodeModulesExists: false,
      issues: [],
    };

    const packageJsonPath = join(this.projectRoot, 'package.json');
    const nodeModulesPath = join(this.projectRoot, 'node_modules');

    result.packageJsonExists = existsSync(packageJsonPath);
    result.nodeModulesExists = existsSync(nodeModulesPath);

    if (result.packageJsonExists && !result.nodeModulesExists) {
      result.issues.push({
        type: 'missing_dependencies',
        severity: 'warning',
        message: 'node_modules not found but package.json exists',
        suggestion: 'Run npm install or pnpm install',
      });
    }

    return result;
  }

  /**
   * Check for common blockers
   * @private
   * @returns {Object}
   */
  _checkCommonBlockers() {
    const result = {
      issues: [],
    };

    // Check for .aiwg/working/ blocker markers
    const blockerFile = join(this.projectRoot, '.aiwg', 'working', 'BLOCKERS.md');
    if (existsSync(blockerFile)) {
      result.issues.push({
        type: 'documented_blocker',
        severity: 'warning',
        message: 'Blocker file exists in .aiwg/working/BLOCKERS.md',
        file: '.aiwg/working/BLOCKERS.md',
        suggestion: 'Review and address documented blockers',
      });
    }

    return result;
  }

  /**
   * Run tests and collect results
   * @private
   * @returns {Object}
   */
  _runTests() {
    const result = {
      ran: false,
      passed: 0,
      failed: 0,
      total: 0,
      issues: [],
    };

    try {
      // Try npm test
      const testResult = spawnSync('npm', ['test', '--', '--reporter=json'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: positiveTimeoutMs(this.timeout, 60000),
        killSignal: 'SIGKILL',
      });

      result.ran = true;

      // Try to parse test output
      const output = testResult.stdout || testResult.stderr || '';

      // Simple pattern matching for common test output
      const passMatch = output.match(/(\d+)\s+pass/i);
      const failMatch = output.match(/(\d+)\s+fail/i);

      if (passMatch) {
        result.passed = parseInt(passMatch[1], 10);
      }

      if (failMatch) {
        result.failed = parseInt(failMatch[1], 10);
      }

      result.total = result.passed + result.failed;

      if (result.failed > 0) {
        result.issues.push({
          type: 'test_failure',
          severity: 'error',
          message: `${result.failed} test(s) failing`,
          suggestion: 'Fix failing tests before continuing',
        });
      }

      // Non-zero exit code but couldn't parse results
      if (testResult.status !== 0 && result.total === 0) {
        result.issues.push({
          type: 'test_error',
          severity: 'error',
          message: 'Tests exited with error but results unclear',
          suggestion: 'Review test output manually',
        });
      }

    } catch (error) {
      result.issues.push({
        type: 'test_unavailable',
        severity: 'warning',
        message: `Could not run tests: ${error.message}`,
      });
    }

    return result;
  }

  /**
   * Check if build passes
   * @private
   * @returns {Object}
   */
  _checkBuild() {
    const result = {
      ran: false,
      success: false,
      issues: [],
    };

    try {
      // Try tsc for TypeScript projects
      const tsconfigPath = join(this.projectRoot, 'tsconfig.json');
      if (existsSync(tsconfigPath)) {
        const buildResult = spawnSync('npx', ['tsc', '--noEmit'], {
          cwd: this.projectRoot,
          encoding: 'utf8',
          timeout: positiveTimeoutMs(this.timeout, 60000),
          killSignal: 'SIGKILL',
        });

        result.ran = true;
        result.success = buildResult.status === 0;

        if (!result.success) {
          const errorCount = (buildResult.stdout || '').match(/error TS\d+:/g)?.length || 0;
          result.issues.push({
            type: 'build_error',
            severity: 'error',
            message: `TypeScript build has ${errorCount} error(s)`,
            suggestion: 'Fix TypeScript errors',
          });
        }
      }

    } catch (error) {
      result.issues.push({
        type: 'build_unavailable',
        severity: 'info',
        message: `Build check skipped: ${error.message}`,
      });
    }

    return result;
  }

  /**
   * Run linting
   * @private
   * @returns {Object}
   */
  _runLint() {
    const result = {
      ran: false,
      errors: 0,
      warnings: 0,
      issues: [],
    };

    try {
      const lintResult = spawnSync('npm', ['run', 'lint', '--', '--format=json'], {
        cwd: this.projectRoot,
        encoding: 'utf8',
        timeout: positiveTimeoutMs(this.timeout, 60000),
        killSignal: 'SIGKILL',
      });

      result.ran = true;

      // Simple pattern matching for common lint output
      const errorMatch = (lintResult.stdout || '').match(/(\d+)\s+error/i);
      const warnMatch = (lintResult.stdout || '').match(/(\d+)\s+warning/i);

      if (errorMatch) {
        result.errors = parseInt(errorMatch[1], 10);
      }

      if (warnMatch) {
        result.warnings = parseInt(warnMatch[1], 10);
      }

      if (result.errors > 0) {
        result.issues.push({
          type: 'lint_error',
          severity: 'warning',
          message: `${result.errors} linting error(s)`,
          suggestion: 'Fix linting errors',
        });
      }

    } catch (error) {
      // Linting is optional
      result.issues.push({
        type: 'lint_unavailable',
        severity: 'info',
        message: 'Linting not available',
      });
    }

    return result;
  }

  /**
   * Check for broken imports
   * @private
   * @returns {Object}
   */
  _checkImports() {
    const result = {
      checked: false,
      broken: [],
      issues: [],
    };

    // This is a placeholder - full implementation would use ESLint or similar
    // For now, just return empty result
    result.checked = true;

    return result;
  }

  /**
   * Determine overall severity from issues
   * @private
   * @param {ValidationIssue[]} issues
   * @returns {string}
   */
  _determineSeverity(issues) {
    if (issues.length === 0) {
      return 'ok';
    }

    const severities = issues.map(i => i.severity);

    if (severities.includes('critical')) {
      return 'critical';
    }

    if (severities.includes('error')) {
      return 'error';
    }

    if (severities.includes('warning')) {
      return 'warning';
    }

    return 'ok';
  }

  /**
   * Get summary of validation results
   * @param {ValidationResult} result
   * @returns {Object}
   */
  getSummary(result) {
    return {
      passed: result.passed,
      severity: result.severity,
      issueCount: result.issues.length,
      criticalCount: result.issues.filter(i => i.severity === 'critical').length,
      errorCount: result.issues.filter(i => i.severity === 'error').length,
      warningCount: result.issues.filter(i => i.severity === 'warning').length,
      timestamp: result.timestamp,
    };
  }

  /**
   * Format validation result for display
   * @param {ValidationResult} result
   * @returns {string}
   */
  format(result) {
    const lines = [];

    lines.push(`Validation: ${result.passed ? 'PASSED' : 'FAILED'} (${result.severity})`);

    if (result.issues.length > 0) {
      lines.push('');
      lines.push('Issues:');
      for (const issue of result.issues) {
        lines.push(`  [${issue.severity.toUpperCase()}] ${issue.message}`);
        if (issue.suggestion) {
          lines.push(`    → ${issue.suggestion}`);
        }
      }
    }

    return lines.join('\n');
  }
}

export default ValidationAgent;
