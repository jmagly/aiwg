/**
 * Snapshot Manager for External Ralph Loop
 *
 * Captures pre-session and post-session state to enable comprehensive
 * assessment of long-running (6-8 hour) Claude sessions.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { snapshotCompleteness, captureReadableFile, walkSnapshotDirectory, readSnapshotText, listSnapshotDirectory } from './lib/snapshot-access.mjs';
import { importImpl } from '../_resolve-impl.mjs';

const { boundedExecSync, boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

/**
 * @typedef {Object} GitStatus
 * @property {string} branch - Current branch name
 * @property {string} commit - Current HEAD commit hash
 * @property {string[]} staged - Staged files
 * @property {string[]} unstaged - Modified but unstaged files
 * @property {string[]} untracked - Untracked files
 */

/**
 * @typedef {Object} FileSnapshot
 * @property {string} path - Relative path from project root
 * @property {string} hash - SHA256 hash of file content
 * @property {number} size - File size in bytes
 * @property {string} mtime - Last modification time (ISO)
 */

/**
 * @typedef {Object} AiwgState
 * @property {FileSnapshot[]} files - All files in .aiwg/ directory
 * @property {Object|null} ralphState - Internal Ralph state if exists
 */

/**
 * @typedef {Object} PreSnapshot
 * @property {string} timestamp - ISO timestamp of snapshot
 * @property {GitStatus} git - Git repository status
 * @property {FileSnapshot[]} keyFiles - Key project files (package.json, etc.)
 * @property {AiwgState} aiwg - .aiwg directory state
 */

/**
 * @typedef {Object} FileDiff
 * @property {string} path - File path
 * @property {string} status - added|modified|deleted
 * @property {string} [diff] - Git diff output for modified files
 */

/**
 * @typedef {Object} TestResults
 * @property {boolean} found - Whether test results were found
 * @property {string} [file] - Path to test output file
 * @property {Object} [summary] - Parsed test summary
 */

/**
 * @typedef {Object} PostSnapshot
 * @property {string} timestamp - ISO timestamp of snapshot
 * @property {GitStatus} git - Git repository status
 * @property {FileDiff[]} fileDiffs - Files changed since pre-snapshot
 * @property {string[]} commits - Commits made during session
 * @property {AiwgState} aiwg - Updated .aiwg directory state
 * @property {TestResults} tests - Test results if available
 */

/**
 * @typedef {Object} SnapshotDiff
 * @property {string} duration - Human-readable duration
 * @property {number} durationMs - Duration in milliseconds
 * @property {string[]} filesAdded - New files created
 * @property {string[]} filesModified - Existing files modified
 * @property {string[]} filesDeleted - Files deleted
 * @property {string[]} aiwgArtifactsCreated - New .aiwg artifacts
 * @property {string[]} aiwgArtifactsUpdated - Updated .aiwg artifacts
 * @property {number} commitCount - Number of commits made
 * @property {string[]} commits - Commit messages
 * @property {boolean} hasTests - Whether test results were found
 * @property {Object} [testSummary] - Test summary if available
 */

/**
 * Key files to track across sessions
 */
const KEY_FILES = [
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  'CHANGELOG.md',
  '.gitignore',
  'tsconfig.json',
];

/**
 * Test output patterns to search for
 */
const TEST_PATTERNS = [
  '.aiwg/ralph-external/outputs/*.log',
  'test-results.json',
  'coverage/lcov-report/index.html',
  '.aiwg/testing/*.md',
];

export class SnapshotManager {
  /**
   * @param {string} projectRoot - Project root directory
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.completeness = snapshotCompleteness();
  }

  /**
   * Capture pre-session snapshot
   * @param {string} projectRoot - Project root directory
   * @param {string} iterationDir - Iteration directory for outputs
   * @returns {PreSnapshot}
   */
  capturePreSnapshot(projectRoot, iterationDir) {
    const timestamp = new Date().toISOString();
    this.completeness = snapshotCompleteness();

    // Ensure iteration directory exists
    if (!existsSync(iterationDir)) {
      mkdirSync(iterationDir, { recursive: true });
    }

    // Capture git status
    const git = this.captureGitStatus(projectRoot);

    // Capture key files
    const keyFiles = this.captureKeyFiles(projectRoot);

    // Capture .aiwg state
    const aiwg = this.captureAiwgState(projectRoot);

    /** @type {PreSnapshot} */
    const snapshot = {
      timestamp,
      completeness: this.completeness,
      git,
      keyFiles,
      aiwg,
    };

    // Save to file
    const snapshotPath = join(iterationDir, 'pre-snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

    return snapshot;
  }

  /**
   * Capture post-session snapshot
   * @param {string} projectRoot - Project root directory
   * @param {string} iterationDir - Iteration directory for outputs
   * @returns {PostSnapshot}
   */
  capturePostSnapshot(projectRoot, iterationDir) {
    const timestamp = new Date().toISOString();
    this.completeness = snapshotCompleteness();

    // Load pre-snapshot for comparison
    const preSnapshotPath = join(iterationDir, 'pre-snapshot.json');
    if (!existsSync(preSnapshotPath)) {
      throw new Error('Pre-snapshot not found - cannot capture post-snapshot');
    }

    /** @type {PreSnapshot} */
    const preSnapshot = JSON.parse(readFileSync(preSnapshotPath, 'utf8'));

    // Capture current git status
    const git = this.captureGitStatus(projectRoot);

    // Calculate file diffs
    const fileDiffs = this.calculateFileDiffs(projectRoot, preSnapshot.git.commit, git.commit);

    // Get commits made during session
    const commits = this.getCommitsSince(projectRoot, preSnapshot.git.commit);

    // Capture updated .aiwg state
    const aiwg = this.captureAiwgState(projectRoot);

    // Try to find test results
    const tests = this.findTestResults(projectRoot, iterationDir);

    /** @type {PostSnapshot} */
    const snapshot = {
      timestamp,
      completeness: this.completeness,
      git,
      fileDiffs,
      commits,
      aiwg,
      tests,
    };

    // Save to file
    const snapshotPath = join(iterationDir, 'post-snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

    return snapshot;
  }

  /**
   * Calculate diff between pre and post snapshots
   * @param {PreSnapshot} preSnapshot
   * @param {PostSnapshot} postSnapshot
   * @returns {SnapshotDiff}
   */
  calculateDiff(preSnapshot, postSnapshot) {
    // Calculate duration
    const preTime = new Date(preSnapshot.timestamp);
    const postTime = new Date(postSnapshot.timestamp);
    const durationMs = postTime - preTime;
    const duration = this.formatDuration(durationMs);

    // Categorize file changes
    const filesAdded = [];
    const filesModified = [];
    const filesDeleted = [];

    for (const diff of postSnapshot.fileDiffs) {
      if (diff.status === 'added') {
        filesAdded.push(diff.path);
      } else if (diff.status === 'modified') {
        filesModified.push(diff.path);
      } else if (diff.status === 'deleted') {
        filesDeleted.push(diff.path);
      }
    }

    // Track .aiwg changes
    const preAiwgPaths = new Set(preSnapshot.aiwg.files.map(f => f.path));
    const postAiwgPaths = new Set(postSnapshot.aiwg.files.map(f => f.path));

    const aiwgArtifactsCreated = [];
    const aiwgArtifactsUpdated = [];

    for (const file of postSnapshot.aiwg.files) {
      if (!preAiwgPaths.has(file.path)) {
        aiwgArtifactsCreated.push(file.path);
      } else {
        const preFile = preSnapshot.aiwg.files.find(f => f.path === file.path);
        if (preFile && preFile.hash !== file.hash) {
          aiwgArtifactsUpdated.push(file.path);
        }
      }
    }

    // Commit analysis
    const commitCount = postSnapshot.commits.length;
    const commits = postSnapshot.commits;

    // Test analysis
    const hasTests = postSnapshot.tests.found;
    const testSummary = postSnapshot.tests.summary || null;

    /** @type {SnapshotDiff} */
    return {
      duration,
      durationMs,
      filesAdded,
      filesModified,
      filesDeleted,
      aiwgArtifactsCreated,
      aiwgArtifactsUpdated,
      commitCount,
      commits,
      hasTests,
      testSummary,
    };
  }

  /**
   * Capture current git status
   * @param {string} projectRoot
   * @returns {GitStatus}
   */
  captureGitStatus(projectRoot) {
    try {
      // Get current branch
      const branch = boundedExecSync('git rev-parse --abbrev-ref HEAD', 'quick', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();

      // Get current commit
      const commit = boundedExecSync('git rev-parse HEAD', 'quick', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();

      // Get staged files
      const stagedOutput = boundedExecSync('git diff --cached --name-only', 'quick', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();
      const staged = stagedOutput ? stagedOutput.split('\n') : [];

      // Get unstaged files
      const unstagedOutput = boundedExecSync('git diff --name-only', 'quick', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();
      const unstaged = unstagedOutput ? unstagedOutput.split('\n') : [];

      // Get untracked files
      const untrackedOutput = boundedExecSync('git ls-files --others --exclude-standard', 'quick', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();
      const untracked = untrackedOutput ? untrackedOutput.split('\n') : [];

      return {
        branch,
        commit,
        staged,
        unstaged,
        untracked,
      };
    } catch (error) {
      // Not a git repository or git command failed
      return {
        branch: 'unknown',
        commit: 'unknown',
        staged: [],
        unstaged: [],
        untracked: [],
      };
    }
  }

  /**
   * Capture key project files
   * @param {string} projectRoot
   * @returns {FileSnapshot[]}
   */
  captureKeyFiles(projectRoot) {
    const snapshots = [];

    for (const filename of KEY_FILES) {
      const filePath = join(projectRoot, filename);
      if (existsSync(filePath)) {
        const snapshot = this.createFileSnapshot(projectRoot, filePath);
        if (snapshot) snapshots.push(snapshot);
      }
    }

    return snapshots;
  }

  /**
   * Capture .aiwg directory state
   * @param {string} projectRoot
   * @returns {AiwgState}
   */
  captureAiwgState(projectRoot) {
    const aiwgDir = join(projectRoot, '.aiwg');
    const files = [];

    if (existsSync(aiwgDir)) {
      this.walkDirectory(aiwgDir, (filePath) => {
        const snapshot = this.createFileSnapshot(projectRoot, filePath);
        if (snapshot) files.push(snapshot);
      });
    }

    // Try to load internal Ralph state
    let ralphState = null;
    const ralphStatePath = join(aiwgDir, 'ralph', 'current-loop.json');
    if (existsSync(ralphStatePath)) {
      try {
        ralphState = JSON.parse(readFileSync(ralphStatePath, 'utf8'));
      } catch (e) {
        // Invalid JSON, ignore
      }
    }

    return {
      files,
      ralphState,
    };
  }

  /**
   * Create snapshot of a single file
   * @param {string} projectRoot
   * @param {string} filePath
   * @returns {FileSnapshot}
   */
  createFileSnapshot(projectRoot, filePath) {
    return captureReadableFile(this, projectRoot, filePath);
  }

  /**
   * Walk directory recursively
   * @param {string} dir
   * @param {Function} callback
   */
  walkDirectory(dir, callback) {
    return walkSnapshotDirectory(this, dir, callback);
  }

  /**
   * Calculate file diffs between commits
   * @param {string} projectRoot
   * @param {string} fromCommit
   * @param {string} toCommit
   * @returns {FileDiff[]}
   */
  calculateFileDiffs(projectRoot, fromCommit, toCommit) {
    if (fromCommit === 'unknown' || toCommit === 'unknown') {
      return [];
    }

    try {
      // Get list of changed files
      const diffOutput = boundedExecFileSync('git', ['diff', '--name-status', '--end-of-options', `${fromCommit}..${toCommit}`], 'quick', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();

      if (!diffOutput) {
        return [];
      }

      const diffs = [];
      const lines = diffOutput.split('\n');

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;

        const statusCode = parts[0];
        const filePath = parts[1];

        let status;
        if (statusCode === 'A') {
          status = 'added';
        } else if (statusCode === 'D') {
          status = 'deleted';
        } else if (statusCode.startsWith('M')) {
          status = 'modified';
        } else {
          status = 'modified'; // R (renamed), C (copied), etc.
        }

        /** @type {FileDiff} */
        const diff = {
          path: filePath,
          status,
        };

        // Get actual diff for modified files
        if (status === 'modified') {
          try {
            diff.diff = boundedExecFileSync('git', ['diff', '--end-of-options', `${fromCommit}..${toCommit}`, '--', filePath], 'quick', {
              cwd: projectRoot,
              encoding: 'utf8',
            });
          } catch (e) {
            // Diff failed, skip
          }
        }

        diffs.push(diff);
      }

      return diffs;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get commits since a specific commit
   * @param {string} projectRoot
   * @param {string} sinceCommit
   * @returns {string[]}
   */
  getCommitsSince(projectRoot, sinceCommit) {
    if (sinceCommit === 'unknown') {
      return [];
    }

    try {
      const output = boundedExecFileSync('git', ['log', '--pretty=format:%H %s', '--end-of-options', `${sinceCommit}..HEAD`], 'quick', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();

      if (!output) {
        return [];
      }

      return output.split('\n').map(line => line.trim());
    } catch (error) {
      return [];
    }
  }

  /**
   * Find test results in common locations
   * @param {string} projectRoot
   * @param {string} iterationDir
   * @returns {TestResults}
   */
  findTestResults(projectRoot, iterationDir) {
    // Check iteration output logs first
    const outputDir = join(iterationDir, '..');
    if (existsSync(outputDir)) {
      const files = listSnapshotDirectory(this, outputDir);
      for (const file of files) {
        if (file.endsWith('.log')) {
          const content = readSnapshotText(this, join(outputDir, file));
          if (content === null) continue;
          const summary = this.parseTestOutput(content);
          if (summary) {
            return {
              found: true,
              file: join(outputDir, file),
              summary,
            };
          }
        }
      }
    }

    // Check common test result locations
    const testPaths = [
      join(projectRoot, 'test-results.json'),
      join(projectRoot, '.aiwg', 'testing', 'test-results.md'),
      join(projectRoot, 'coverage', 'coverage-summary.json'),
    ];

    for (const path of testPaths) {
      if (existsSync(path)) {
        const content = readSnapshotText(this, path);
        if (content === null) continue;
        const summary = this.parseTestOutput(content);
        if (summary) {
          return {
            found: true,
            file: path,
            summary,
          };
        }
      }
    }

    return {
      found: false,
    };
  }

  /**
   * Parse test output to extract summary
   * @param {string} content
   * @returns {Object|null}
   */
  parseTestOutput(content) {
    // Try to parse as JSON first
    try {
      const json = JSON.parse(content);
      if (json.numTotalTests || json.numPassedTests) {
        return {
          type: 'jest',
          total: json.numTotalTests || 0,
          passed: json.numPassedTests || 0,
          failed: json.numFailedTests || 0,
          skipped: json.numPendingTests || 0,
        };
      }
    } catch (e) {
      // Not JSON, try text parsing
    }

    // Look for common test output patterns
    const patterns = [
      // Jest/Vitest: "Tests: 5 passed, 5 total"
      /Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/i,
      // Mocha: "5 passing"
      /(\d+)\s+passing/i,
      // TAP: "# tests 5"
      /#\s+tests\s+(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return {
          type: 'text',
          snippet: match[0],
        };
      }
    }

    return null;
  }

  /**
   * Format duration in human-readable form
   * @param {number} ms - Duration in milliseconds
   * @returns {string}
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

export default SnapshotManager;
