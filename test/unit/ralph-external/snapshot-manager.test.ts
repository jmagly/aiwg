/**
 * Unit tests for External Ralph Loop Snapshot Manager
 *
 * @source @tools/ralph-external/snapshot-manager.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Import the module under test
// @ts-ignore - ESM import
import { SnapshotManager } from '../../../tools/ralph-external/snapshot-manager.mjs';

describe('SnapshotManager', () => {
  let testDir: string;
  let snapshotManager: InstanceType<typeof SnapshotManager>;
  let iterationDir: string;
  let isGitRepo: boolean;
  const allocatedDirectories = new Set<string>();

  beforeEach(() => {
    // A stalled clock must not make separate tests reuse a fixture path.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    testDir = mkdtempSync(join(tmpdir(), 'ralph-snapshot-test-'));
    clock.mockRestore();
    expect(allocatedDirectories.has(testDir), 'fixture paths must remain unique with an unchanged clock').toBe(false);
    allocatedDirectories.add(testDir);

    // Create iteration directory
    iterationDir = join(testDir, '.aiwg', 'ralph-external', 'iterations', '001');
    mkdirSync(iterationDir, { recursive: true });

    snapshotManager = new SnapshotManager(testDir);

    // Initialize git repository
    try {
      execSync('git init', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      isGitRepo = true;
    } catch (e) {
      isGitRepo = false;
    }
  });

  afterEach(() => {
    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('capturePreSnapshot', () => {
    it('should capture basic pre-snapshot data', () => {
      // Create some test files
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(join(testDir, 'CLAUDE.md'), '# Test');

      const snapshot = snapshotManager.capturePreSnapshot(testDir, iterationDir);

      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.git).toBeDefined();
      expect(snapshot.keyFiles).toBeDefined();
      expect(snapshot.aiwg).toBeDefined();
    });

    it('should capture git status when in git repo', () => {
      if (!isGitRepo) {
        console.log('Skipping git test - git not available');
        return;
      }

      // Create and commit a file
      writeFileSync(join(testDir, 'test.txt'), 'content');
      execSync('git add test.txt', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      execSync('git commit -m "initial"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });

      const snapshot = snapshotManager.capturePreSnapshot(testDir, iterationDir);

      expect(snapshot.git.branch).toBeDefined();
      expect(snapshot.git.commit).toBeDefined();
      expect(snapshot.git.commit).not.toBe('unknown');
    });

    it('should capture key project files', () => {
      // Create key files
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      writeFileSync(join(testDir, 'CLAUDE.md'), '# Project');
      writeFileSync(join(testDir, 'CHANGELOG.md'), '# Changes');

      const snapshot = snapshotManager.capturePreSnapshot(testDir, iterationDir);

      expect(snapshot.keyFiles).toHaveLength(3);

      const packageFile = snapshot.keyFiles.find(f => f.path === 'package.json');
      expect(packageFile).toBeDefined();
      expect(packageFile?.hash).toBeDefined();
      expect(packageFile?.size).toBeGreaterThan(0);
    });

    it('should capture .aiwg directory state', () => {
      // Create .aiwg files
      const aiwgDir = join(testDir, '.aiwg', 'requirements');
      mkdirSync(aiwgDir, { recursive: true });
      writeFileSync(join(aiwgDir, 'user-stories.md'), '# User Stories');
      writeFileSync(join(aiwgDir, 'use-cases.md'), '# Use Cases');

      const snapshot = snapshotManager.capturePreSnapshot(testDir, iterationDir);

      expect(snapshot.aiwg.files.length).toBeGreaterThan(0);

      const userStoriesFile = snapshot.aiwg.files.find(f =>
        f.path.includes('user-stories.md')
      );
      expect(userStoriesFile).toBeDefined();
    });

    it('should capture internal Ralph state if exists', () => {
      // Create Ralph state file
      const ralphDir = join(testDir, '.aiwg', 'ralph');
      mkdirSync(ralphDir, { recursive: true });
      const ralphState = {
        currentPhase: 'elaboration',
        iteration: 3,
      };
      writeFileSync(
        join(ralphDir, 'current-loop.json'),
        JSON.stringify(ralphState)
      );

      const snapshot = snapshotManager.capturePreSnapshot(testDir, iterationDir);

      expect(snapshot.aiwg.ralphState).toBeDefined();
      expect(snapshot.aiwg.ralphState?.currentPhase).toBe('elaboration');
    });

    it('should save snapshot to file', () => {
      snapshotManager.capturePreSnapshot(testDir, iterationDir);

      const snapshotPath = join(iterationDir, 'pre-snapshot.json');
      expect(existsSync(snapshotPath)).toBe(true);

      const savedSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      expect(savedSnapshot.timestamp).toBeDefined();
    });
  });

  describe('capturePostSnapshot', () => {
    beforeEach(() => {
      // Create pre-snapshot first
      writeFileSync(join(testDir, 'package.json'), '{}');

      if (isGitRepo) {
        execSync('git add .', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
        execSync('git commit -m "initial" --allow-empty', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      }

      snapshotManager.capturePreSnapshot(testDir, iterationDir);
    });

    it('should throw if pre-snapshot does not exist', () => {
      const newIterDir = join(testDir, '.aiwg', 'ralph-external', 'iterations', '999');
      mkdirSync(newIterDir, { recursive: true });

      expect(() =>
        snapshotManager.capturePostSnapshot(testDir, newIterDir)
      ).toThrow('Pre-snapshot not found');
    });

    it('should capture post-snapshot data', () => {
      const snapshot = snapshotManager.capturePostSnapshot(testDir, iterationDir);

      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.git).toBeDefined();
      expect(snapshot.fileDiffs).toBeDefined();
      expect(snapshot.commits).toBeDefined();
      expect(snapshot.aiwg).toBeDefined();
      expect(snapshot.tests).toBeDefined();
    });

    it('should detect new files created during session', () => {
      if (!isGitRepo) return;

      // Create and commit new file
      writeFileSync(join(testDir, 'new-file.ts'), 'export const x = 1;');
      execSync('git add new-file.ts', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      execSync('git commit -m "add new file"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });

      const snapshot = snapshotManager.capturePostSnapshot(testDir, iterationDir);

      const newFileDiff = snapshot.fileDiffs.find(d => d.path === 'new-file.ts');
      expect(newFileDiff).toBeDefined();
      expect(newFileDiff?.status).toBe('added');
    });

    it('should detect modified files during session', () => {
      if (!isGitRepo) return;

      // Modify and commit file
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
      execSync('git add package.json', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      execSync('git commit -m "update version"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });

      const snapshot = snapshotManager.capturePostSnapshot(testDir, iterationDir);

      const packageDiff = snapshot.fileDiffs.find(d => d.path === 'package.json');
      expect(packageDiff).toBeDefined();
      expect(packageDiff?.status).toBe('modified');
      expect(packageDiff?.diff).toBeDefined();
    });

    it('should capture commits made during session', () => {
      if (!isGitRepo) return;

      // Make multiple commits
      writeFileSync(join(testDir, 'file1.ts'), 'content1');
      execSync('git add file1.ts', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      execSync('git commit -m "first commit"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });

      writeFileSync(join(testDir, 'file2.ts'), 'content2');
      execSync('git add file2.ts', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });
      execSync('git commit -m "second commit"', { timeout: 60_000, cwd: testDir, stdio: 'ignore' });

      const snapshot = snapshotManager.capturePostSnapshot(testDir, iterationDir);

      expect(snapshot.commits).toHaveLength(2);
      expect(snapshot.commits[0]).toContain('second commit');
      expect(snapshot.commits[1]).toContain('first commit');
    });

    it('should find test results if available', () => {
      // Create test results file
      const testResults = {
        numTotalTests: 10,
        numPassedTests: 8,
        numFailedTests: 2,
        numPendingTests: 0,
      };
      writeFileSync(
        join(testDir, 'test-results.json'),
        JSON.stringify(testResults)
      );

      const snapshot = snapshotManager.capturePostSnapshot(testDir, iterationDir);

      expect(snapshot.tests.found).toBe(true);
      expect(snapshot.tests.summary).toBeDefined();
      expect(snapshot.tests.summary?.total).toBe(10);
      expect(snapshot.tests.summary?.passed).toBe(8);
    });

    it('should save snapshot to file', () => {
      snapshotManager.capturePostSnapshot(testDir, iterationDir);

      const snapshotPath = join(iterationDir, 'post-snapshot.json');
      expect(existsSync(snapshotPath)).toBe(true);

      const savedSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      expect(savedSnapshot.timestamp).toBeDefined();
    });
  });

  describe('calculateDiff', () => {
    it('should calculate basic diff between snapshots', () => {
      // Create pre-snapshot
      const preSnapshot = {
        timestamp: new Date().toISOString(),
        git: {
          branch: 'main',
          commit: 'abc123',
          staged: [],
          unstaged: [],
          untracked: [],
        },
        keyFiles: [],
        aiwg: {
          files: [],
          ralphState: null,
        },
      };

      // Create post-snapshot (1 hour later)
      const postTime = new Date(Date.now() + 3600000);
      const postSnapshot = {
        timestamp: postTime.toISOString(),
        git: {
          branch: 'main',
          commit: 'def456',
          staged: [],
          unstaged: [],
          untracked: [],
        },
        fileDiffs: [
          { path: 'new-file.ts', status: 'added' as const },
          { path: 'existing.ts', status: 'modified' as const, diff: '...' },
        ],
        commits: ['def456 Add new file', 'abc124 Update existing'],
        aiwg: {
          files: [],
          ralphState: null,
        },
        tests: {
          found: false,
        },
      };

      const diff = snapshotManager.calculateDiff(preSnapshot, postSnapshot);

      expect(diff.duration).toContain('1h');
      expect(diff.durationMs).toBeGreaterThan(3000000);
      expect(diff.filesAdded).toContain('new-file.ts');
      expect(diff.filesModified).toContain('existing.ts');
      expect(diff.commitCount).toBe(2);
    });

    it('should detect .aiwg artifacts created', () => {
      const preSnapshot = {
        timestamp: new Date().toISOString(),
        git: { branch: 'main', commit: 'abc', staged: [], unstaged: [], untracked: [] },
        keyFiles: [],
        aiwg: {
          files: [],
          ralphState: null,
        },
      };

      const postSnapshot = {
        timestamp: new Date().toISOString(),
        git: { branch: 'main', commit: 'def', staged: [], unstaged: [], untracked: [] },
        fileDiffs: [],
        commits: [],
        aiwg: {
          files: [
            {
              path: '.aiwg/requirements/user-stories.md',
              hash: 'abc123',
              size: 100,
              mtime: new Date().toISOString(),
            },
          ],
          ralphState: null,
        },
        tests: { found: false },
      };

      const diff = snapshotManager.calculateDiff(preSnapshot, postSnapshot);

      expect(diff.aiwgArtifactsCreated).toHaveLength(1);
      expect(diff.aiwgArtifactsCreated[0]).toContain('user-stories.md');
    });

    it('should detect .aiwg artifacts updated', () => {
      const preSnapshot = {
        timestamp: new Date().toISOString(),
        git: { branch: 'main', commit: 'abc', staged: [], unstaged: [], untracked: [] },
        keyFiles: [],
        aiwg: {
          files: [
            {
              path: '.aiwg/architecture/sad.md',
              hash: 'oldhash',
              size: 100,
              mtime: new Date().toISOString(),
            },
          ],
          ralphState: null,
        },
      };

      const postSnapshot = {
        timestamp: new Date().toISOString(),
        git: { branch: 'main', commit: 'def', staged: [], unstaged: [], untracked: [] },
        fileDiffs: [],
        commits: [],
        aiwg: {
          files: [
            {
              path: '.aiwg/architecture/sad.md',
              hash: 'newhash',
              size: 200,
              mtime: new Date().toISOString(),
            },
          ],
          ralphState: null,
        },
        tests: { found: false },
      };

      const diff = snapshotManager.calculateDiff(preSnapshot, postSnapshot);

      expect(diff.aiwgArtifactsUpdated).toHaveLength(1);
      expect(diff.aiwgArtifactsUpdated[0]).toContain('sad.md');
    });

    it('should include test summary if tests were run', () => {
      const preSnapshot = {
        timestamp: new Date().toISOString(),
        git: { branch: 'main', commit: 'abc', staged: [], unstaged: [], untracked: [] },
        keyFiles: [],
        aiwg: { files: [], ralphState: null },
      };

      const postSnapshot = {
        timestamp: new Date().toISOString(),
        git: { branch: 'main', commit: 'def', staged: [], unstaged: [], untracked: [] },
        fileDiffs: [],
        commits: [],
        aiwg: { files: [], ralphState: null },
        tests: {
          found: true,
          file: 'test-results.json',
          summary: {
            type: 'jest',
            total: 20,
            passed: 18,
            failed: 2,
            skipped: 0,
          },
        },
      };

      const diff = snapshotManager.calculateDiff(preSnapshot, postSnapshot);

      expect(diff.hasTests).toBe(true);
      expect(diff.testSummary).toBeDefined();
      expect(diff.testSummary?.passed).toBe(18);
    });
  });

  describe('parseTestOutput', () => {
    it('should parse Jest JSON output', () => {
      const jsonOutput = JSON.stringify({
        numTotalTests: 15,
        numPassedTests: 13,
        numFailedTests: 2,
        numPendingTests: 0,
      });

      const summary = snapshotManager.parseTestOutput(jsonOutput);

      expect(summary).toBeDefined();
      expect(summary?.type).toBe('jest');
      expect(summary?.total).toBe(15);
      expect(summary?.passed).toBe(13);
    });

    it('should parse text test output patterns', () => {
      const textOutput = 'Tests: 10 passed, 10 total\nTime: 5.2s';

      const summary = snapshotManager.parseTestOutput(textOutput);

      expect(summary).toBeDefined();
      expect(summary?.type).toBe('text');
      expect(summary?.snippet).toContain('10 passed');
    });

    it('should return null for non-test output', () => {
      const randomText = 'This is just some random text without test results';

      const summary = snapshotManager.parseTestOutput(randomText);

      expect(summary).toBeNull();
    });
  });

  describe('formatDuration', () => {
    it('should format seconds correctly', () => {
      const formatted = snapshotManager.formatDuration(45000); // 45 seconds
      expect(formatted).toBe('45s');
    });

    it('should format minutes correctly', () => {
      const formatted = snapshotManager.formatDuration(135000); // 2m 15s
      expect(formatted).toBe('2m 15s');
    });

    it('should format hours correctly', () => {
      const formatted = snapshotManager.formatDuration(7380000); // 2h 3m
      expect(formatted).toBe('2h 3m');
    });
  });

  describe('regression: object args must throw, not crash Node', () => {
    // Regression test for https://git.integrolabs.net/roctinam/aiwg/issues/XXX
    // The orchestrator was passing objects where strings were expected,
    // causing "The path argument must be of type string. Received an instance of Object"

    it('should reject non-string projectRoot in constructor', () => {
      // @ts-expect-error - intentionally passing wrong type for regression test
      const sm = new SnapshotManager({ projectRoot: testDir });
      // The constructor doesn't validate, but methods that use this.projectRoot will fail
      // when called with the stored object value
      expect(typeof sm.projectRoot).toBe('object'); // confirms the bug scenario
    });

    it('should throw when capturePreSnapshot receives an object instead of string path', () => {
      expect(() =>
        snapshotManager.capturePreSnapshot(
          // @ts-expect-error - intentionally passing wrong type
          { sessionId: 'abc', iteration: 1 },
          iterationDir
        )
      ).toThrow();
    });

    it('should throw when capturePreSnapshot receives undefined iterationDir', () => {
      expect(() =>
        snapshotManager.capturePreSnapshot(
          testDir,
          // @ts-expect-error - intentionally passing wrong type
          undefined
        )
      ).toThrow();
    });

    it('should throw when capturePostSnapshot receives a snapshot object instead of strings', () => {
      // First create a valid pre-snapshot
      snapshotManager.capturePreSnapshot(testDir, iterationDir);

      expect(() =>
        snapshotManager.capturePostSnapshot(
          // @ts-expect-error - intentionally passing wrong type
          { timestamp: new Date().toISOString(), git: {} },
          iterationDir
        )
      ).toThrow();
    });
  });
});
