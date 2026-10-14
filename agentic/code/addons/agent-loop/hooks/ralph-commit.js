#!/usr/bin/env node
/**
 * Ralph Auto-Commit Hook
 *
 * Automatically commits changes after each Ralph iteration.
 * Creates a clear git history of the iteration process.
 *
 * Usage:
 * Can be called after each iteration to commit progress.
 *
 * Commit message format:
 *   ralph: iteration {N} - {summary}
 *
 * Environment Variables:
 * - RALPH_STATE_DIR: Directory for state files (default: .aiwg/ralph)
 * - RALPH_VERBOSE: Enable verbose logging to stderr
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const RALPH_STATE_DIR = process.env.RALPH_STATE_DIR || '.aiwg/ralph';
const VERBOSE = process.env.RALPH_VERBOSE === 'true';

/**
 * Read current loop state
 */
function readLoopState() {
  const stateFile = path.resolve(RALPH_STATE_DIR, 'current-loop.json');

  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check if there are uncommitted changes
 */
function hasChanges() {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get list of changed files
 */
function getChangedFiles() {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    return status.trim().split('\n').filter(Boolean).map(line => line.slice(3));
  } catch {
    return [];
  }
}

/**
 * Create commit for current iteration
 */
function commitIteration(state, summary) {
  if (!hasChanges()) {
    if (VERBOSE) {
      console.error('[RALPH-COMMIT] No changes to commit');
    }
    return { committed: false, reason: 'no_changes' };
  }

  const iteration = state?.currentIteration || 0;
  const changedFiles = getChangedFiles();

  // Build commit message
  const shortSummary = summary || 'progress';
  const message = `ralph: iteration ${iteration} - ${shortSummary}`;

  // Build detailed body
  const body = [
    '',
    `Task: ${state?.task || 'unknown'}`,
    `Iteration: ${iteration}/${state?.maxIterations || '?'}`,
    '',
    'Files changed:',
    ...changedFiles.map(f => `  - ${f}`)
  ].join('\n');

  try {
    // Stage all changes
    execFileSync('git', ['add', '-A'], { stdio: 'pipe' });

    // Commit with message
    const fullMessage = `${message}\n${body}`;
    execFileSync('git', ['commit', '-m', fullMessage], { stdio: 'pipe' });

    if (VERBOSE) {
      console.error(`[RALPH-COMMIT] Committed iteration ${iteration}: ${changedFiles.length} files`);
    }

    return {
      committed: true,
      iteration,
      message,
      files: changedFiles
    };

  } catch (err) {
    if (VERBOSE) {
      console.error(`[RALPH-COMMIT] Commit failed: ${err.message}`);
    }
    return {
      committed: false,
      reason: 'commit_failed',
      error: err.message
    };
  }
}

/**
 * Main CLI handler
 */
async function main() {
  const command = process.argv[2];
  const summary = process.argv[3];

  const state = readLoopState();

  // Check if auto-commit is disabled
  if (state && state.autoCommit === false) {
    console.log(JSON.stringify({ committed: false, reason: 'auto_commit_disabled' }));
    return;
  }

  switch (command) {
    case 'commit':
      const result = commitIteration(state, summary);
      console.log(JSON.stringify(result, null, 2));
      break;

    case 'status':
      console.log(JSON.stringify({
        hasChanges: hasChanges(),
        changedFiles: getChangedFiles(),
        loopActive: state?.active || false,
        iteration: state?.currentIteration || 0
      }, null, 2));
      break;

    default:
      console.error(`
Ralph Auto-Commit Hook

Usage:
  ralph-commit.js commit [summary]    Commit current changes
  ralph-commit.js status              Show change status

Examples:
  ralph-commit.js commit "Fixed auth test"
  ralph-commit.js commit              # Uses "progress" as summary
  ralph-commit.js status

Environment:
  RALPH_STATE_DIR   State directory (default: .aiwg/ralph)
  RALPH_VERBOSE     Enable verbose logging
`);
      process.exit(1);
  }
}

// Export for programmatic use
module.exports = {
  commitIteration,
  hasChanges,
  getChangedFiles
};

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error(`[RALPH-COMMIT] Error: ${err.message}`);
    process.exit(1);
  });
}
