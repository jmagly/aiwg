/**
 * Tests for CrossTaskLearner
 *
 * @tests @tools/ralph-external/cross-task-learner.mjs
 * @requirement @agentic/code/addons/agent-loop/schemas/cross-task-memory.yaml
 * @issue #154
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { CrossTaskLearner } from './cross-task-learner.mjs';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'aiwg-cross-task-test-'));

describe('CrossTaskLearner', () => {
  let learner;

  beforeEach(() => {
    // Clean test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }

    // Initialize learner
    learner = new CrossTaskLearner({
      memory_path: TEST_DIR,
      top_k: 3,
      similarity_threshold: 0.7,
      max_age_days: 90,
    });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('recordTaskCompletion', () => {
    it('should record a completed task', () => {
      const task = learner.recordTaskCompletion({
        task_description: 'Implement user authentication with JWT tokens',
        task_type: 'implementation',
        outcome: 'success',
        iterations: 3,
        final_quality: 0.85,
        key_learnings: [
          'JWT tokens should have short expiry times',
          'Always validate token signature',
        ],
        tags: ['auth', 'security', 'jwt'],
      });

      assert.ok(task.task_id);
      assert.equal(task.task_description, 'Implement user authentication with JWT tokens');
      assert.equal(task.task_type, 'implementation');
      assert.equal(task.outcome, 'success');
      assert.equal(task.iterations, 3);
      assert.equal(task.final_quality, 0.85);
      assert.equal(task.key_learnings.length, 2);

      // Verify index updated
      const stats = learner.getStatistics();
      assert.equal(stats.total_tasks, 1);
    });

    it('should auto-extract tags from description', () => {
      const task = learner.recordTaskCompletion({
        task_description: 'Fix authentication bug in login flow',
        task_type: 'debugging',
        outcome: 'success',
      });

      assert.ok(task.tags.includes('fix'));
      assert.ok(task.tags.includes('debug'));
    });

    it('should record reflections', () => {
      const task = learner.recordTaskCompletion({
        task_description: 'Refactor database query performance',
        task_type: 'refactoring',
        outcome: 'success',
        reflections: [
          {
            iteration: 2,
            content: 'Adding index on user_id column improved performance by 10x',
            type: 'success_pattern',
            effectiveness: 'helpful',
          },
        ],
      });

      assert.equal(task.reflections.length, 1);
      assert.equal(task.reflections[0].type, 'success_pattern');
    });
  });

  describe('findSimilarTasks', () => {
    beforeEach(() => {
      // Add some tasks to search from
      learner.recordTaskCompletion({
        task_description: 'Implement JWT authentication for API endpoints',
        task_type: 'implementation',
        outcome: 'success',
        iterations: 3,
        final_quality: 0.85,
        key_learnings: ['Use bcrypt for password hashing'],
        tags: ['auth', 'security', 'api'],
      });

      learner.recordTaskCompletion({
        task_description: 'Fix bug in user login validation',
        task_type: 'debugging',
        outcome: 'success',
        iterations: 2,
        final_quality: 0.90,
        key_learnings: ['Validate email format before database query'],
        tags: ['fix', 'auth', 'debug'],
      });

      learner.recordTaskCompletion({
        task_description: 'Add documentation for payment processing',
        task_type: 'documentation',
        outcome: 'success',
        iterations: 1,
        final_quality: 0.95,
        key_learnings: ['Include error codes in API docs'],
        tags: ['document', 'api'],
      });
    });

    it('should find similar tasks based on keywords', () => {
      const similar = learner.findSimilarTasks(
        'Implement OAuth authentication for user login'
      );

      // Should find authentication-related tasks
      assert.ok(similar.length > 0);
      const firstMatch = similar[0];
      assert.ok(firstMatch.similarity_score >= 0.7);
      assert.ok(
        firstMatch.task.task_description.toLowerCase().includes('auth') ||
        firstMatch.task.tags.includes('auth')
      );
    });

    it('should respect similarity threshold', () => {
      // Create learner with high threshold
      const strictLearner = new CrossTaskLearner({
        memory_path: TEST_DIR,
        similarity_threshold: 0.95, // Very high threshold
      });

      // Record a task
      strictLearner.recordTaskCompletion({
        task_description: 'Implement user authentication',
        task_type: 'implementation',
        outcome: 'success',
      });

      // Search with somewhat different description
      const similar = strictLearner.findSimilarTasks(
        'Add payment processing feature'
      );

      // Should find no matches due to high threshold
      assert.equal(similar.length, 0);
    });

    it('should limit results to top_k', () => {
      // Create learner with top_k = 1
      const limitedLearner = new CrossTaskLearner({
        memory_path: TEST_DIR,
        top_k: 1,
        similarity_threshold: 0.5, // Lower threshold
      });

      // Use existing tasks
      const similar = limitedLearner.findSimilarTasks(
        'Fix authentication bug in login'
      );

      assert.equal(similar.length, 1);
    });

    it('should honor explicit zero options and reject invalid retrieval options', () => {
      const none = learner.findSimilarTasks('Implement authentication', {
        top_k: 0,
        similarity_threshold: 0,
        max_age_days: 90,
      });
      assert.deepEqual(none, []);

      for (const options of [
        { top_k: -1 }, { top_k: 1.5 }, { similarity_threshold: Number.NaN },
        { similarity_threshold: 1.1 }, { max_age_days: -1 }, { max_age_days: 1.5 },
      ]) {
        assert.throws(() => learner.findSimilarTasks('auth', options));
      }
    });

    it('should sort by similarity score', () => {
      const similar = learner.findSimilarTasks(
        'Implement authentication for login',
        { similarity_threshold: 0 }
      );

      assert.ok(similar.length > 1);
      for (let i = 0; i < similar.length - 1; i++) {
        assert.ok(similar[i].similarity_score >= similar[i + 1].similarity_score);
      }
    });
  });

  describe('getRelevantLearnings', () => {
    beforeEach(() => {
      learner.recordTaskCompletion({
        task_description: 'Implement JWT authentication',
        task_type: 'implementation',
        outcome: 'success',
        iterations: 3,
        final_quality: 0.85,
        key_learnings: [
          'JWT tokens should expire after 15 minutes',
          'Store refresh tokens securely',
        ],
        reflections: [
          {
            iteration: 2,
            content: 'Using RS256 instead of HS256 for better security',
            type: 'strategy_change',
            effectiveness: 'helpful',
          },
        ],
        tags: ['auth', 'security'],
      });
    });

    it('should return aggregated learnings', () => {
      const learnings = learner.getRelevantLearnings(
        'Add OAuth authentication for user login'
      );

      assert.ok(learnings.similar_tasks.length > 0);
      assert.ok(learnings.key_learnings.length > 0);
      assert.ok(learnings.context_summary.length > 0);
    });

    it('should include reflections when enabled', () => {
      const learnings = learner.getRelevantLearnings(
        'Implement authentication system'
      );

      assert.ok(learnings.reflections.length > 0);
      assert.ok(learnings.context_summary.includes('Helpful Reflections'));
    });

    it('should return empty when no similar tasks', () => {
      const learnings = learner.getRelevantLearnings(
        'Completely unrelated task about graphics rendering'
      );

      assert.equal(learnings.similar_tasks.length, 0);
      assert.equal(learnings.key_learnings.length, 0);
      assert.equal(learnings.context_summary, '');
    });

    it('should deduplicate key learnings', () => {
      // Add another task with same learning
      learner.recordTaskCompletion({
        task_description: 'Fix authentication token expiry bug',
        task_type: 'debugging',
        outcome: 'success',
        key_learnings: [
          'JWT tokens should expire after 15 minutes', // Duplicate
          'Always validate token expiry time',
        ],
        tags: ['auth', 'fix'],
      });

      const learnings = learner.getRelevantLearnings(
        'Implement JWT authentication'
      );

      // Count occurrences of the duplicate learning
      const count = learnings.key_learnings.filter(
        l => l === 'JWT tokens should expire after 15 minutes'
      ).length;

      assert.equal(count, 1); // Should appear only once
    });

    it('should generate context summary with similar tasks', () => {
      const learnings = learner.getRelevantLearnings(
        'Implement authentication'
      );

      assert.ok(learnings.context_summary.includes('Cross-Task Learning Context'));
      assert.ok(learnings.context_summary.includes('Similar Past Tasks'));
    });
  });

  describe('pruneOldEntries', () => {
    it('should remove entries older than max_age_days', () => {
      // Record a task
      const task = learner.recordTaskCompletion({
        task_description: 'Test task',
        task_type: 'testing',
        outcome: 'success',
      });

      // Manually modify timestamp to be 100 days old
      const taskData = learner.loadTask(task.task_id);
      taskData.timestamp = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

      // Update in index
      const entry = learner.index.tasks.find(e => e.task_id === task.task_id);
      if (entry) {
        entry.timestamp = taskData.timestamp;
        learner.saveIndex();
      }

      // Prune with 90 day limit
      const result = learner.pruneOldEntries(90);

      assert.equal(result.removed, 1);
      assert.equal(result.remaining, 0);
    });

    it('should keep recent entries', () => {
      learner.recordTaskCompletion({
        task_description: 'Recent task',
        task_type: 'implementation',
        outcome: 'success',
      });

      const result = learner.pruneOldEntries(90);

      assert.equal(result.removed, 0);
      assert.equal(result.remaining, 1);
    });
  });

  describe('getStatistics', () => {
    it('should return empty stats for no tasks', () => {
      const stats = learner.getStatistics();

      assert.equal(stats.total_tasks, 0);
      assert.deepEqual(stats.tasks_by_type, {});
      assert.deepEqual(stats.tasks_by_outcome, {});
      assert.equal(stats.oldest_task, null);
      assert.equal(stats.newest_task, null);
    });

    it('should aggregate statistics correctly', () => {
      learner.recordTaskCompletion({
        task_description: 'Task 1',
        task_type: 'implementation',
        outcome: 'success',
      });

      learner.recordTaskCompletion({
        task_description: 'Task 2',
        task_type: 'debugging',
        outcome: 'success',
      });

      learner.recordTaskCompletion({
        task_description: 'Task 3',
        task_type: 'implementation',
        outcome: 'partial',
      });

      const stats = learner.getStatistics();

      assert.equal(stats.total_tasks, 3);
      assert.equal(stats.tasks_by_type.implementation, 2);
      assert.equal(stats.tasks_by_type.debugging, 1);
      assert.equal(stats.tasks_by_outcome.success, 2);
      assert.equal(stats.tasks_by_outcome.partial, 1);
      assert.ok(stats.oldest_task);
      assert.ok(stats.newest_task);
    });
  });

  describe('searchByTags', () => {
    beforeEach(() => {
      learner.recordTaskCompletion({
        task_description: 'Task with auth tag',
        task_type: 'implementation',
        outcome: 'success',
        tags: ['auth', 'security'],
      });

      learner.recordTaskCompletion({
        task_description: 'Task with test tag',
        task_type: 'testing',
        outcome: 'success',
        tags: ['test', 'coverage'],
      });
    });

    it('should find tasks by tag', () => {
      const results = learner.searchByTags(['auth']);

      assert.equal(results.length, 1);
      assert.ok(results[0].tags.includes('auth'));
    });

    it('should find tasks matching any tag', () => {
      const results = learner.searchByTags(['auth', 'test']);

      assert.equal(results.length, 2);
    });
  });

  describe('searchByType', () => {
    beforeEach(() => {
      learner.recordTaskCompletion({
        task_description: 'Implementation task',
        task_type: 'implementation',
        outcome: 'success',
      });

      learner.recordTaskCompletion({
        task_description: 'Debug task',
        task_type: 'debugging',
        outcome: 'success',
      });
    });

    it('should find tasks by type', () => {
      const results = learner.searchByType('implementation');

      assert.equal(results.length, 1);
      assert.equal(results[0].task_type, 'implementation');
    });
  });

  describe('export and import', () => {
    beforeEach(() => {
      learner.recordTaskCompletion({
        task_description: 'Task to export',
        task_type: 'implementation',
        outcome: 'success',
        key_learnings: ['Learning 1'],
      });
    });

    it('should export memory as JSON', () => {
      const exported = learner.export();

      assert.ok(exported.version);
      assert.ok(exported.exported_at);
      assert.equal(exported.total_tasks, 1);
      assert.ok(Array.isArray(exported.tasks));
      assert.equal(exported.tasks[0].task_description, 'Task to export');
    });

    it('should import memory from JSON', () => {
      const exported = learner.export();

      // Clear and import
      learner.clear();
      assert.equal(learner.getStatistics().total_tasks, 0);

      learner.import(exported);
      assert.equal(learner.getStatistics().total_tasks, 1);

      const tasks = learner.getAllTasks();
      assert.equal(tasks[0].task_description, 'Task to export');
    });

    it('should reject invalid imports before writing or mutating the index', () => {
      const before = learner.export();
      const escapedPath = join(TEST_DIR, 'escaped-task.json');
      const invalid = {
        ...before.tasks[0],
        task_id: '../escaped-task',
      };

      assert.throws(() => learner.import({ ...before, total_tasks: 1, tasks: [invalid] }), /canonical UUID/);
      assert.equal(existsSync(escapedPath), false);
      assert.equal(learner.getStatistics().total_tasks, 1);

      assert.throws(() => learner.import({ ...before, total_tasks: 1, tasks: [before.tasks[0]] }), /Duplicate imported task ID/);
      assert.equal(learner.getStatistics().total_tasks, 1);

      for (const mutation of [
        { timestamp: 'not-a-date' },
        { task_type: 'unknown' },
        { outcome: 'unknown' },
        { iterations: 0 },
        { final_quality: 2 },
        { tags: [42] },
        { reflections: [{ iteration: 0, content: '', type: 'unknown', effectiveness: 'unknown' }] },
      ]) {
        const task = { ...before.tasks[0], task_id: randomUUID(), ...mutation };
        assert.throws(() => learner.import({ ...before, total_tasks: 1, tasks: [task] }));
      }
      assert.throws(() => learner.import({ tasks: [] }), /versioned export envelope/);
      assert.equal(learner.getStatistics().total_tasks, 1);
    });
  });

  describe('clear', () => {
    it('should clear all memory', () => {
      learner.recordTaskCompletion({
        task_description: 'Task to clear',
        task_type: 'implementation',
        outcome: 'success',
      });

      assert.equal(learner.getStatistics().total_tasks, 1);

      learner.clear();

      assert.equal(learner.getStatistics().total_tasks, 0);
      assert.equal(learner.getAllTasks().length, 0);
    });
  });

  describe('similarity calculation', () => {
    it('should calculate high similarity for similar descriptions', () => {
      learner.recordTaskCompletion({
        task_description: 'Implement user authentication with JWT',
        task_type: 'implementation',
        outcome: 'success',
        tags: ['auth', 'jwt', 'security'],
      });

      const similar = learner.findSimilarTasks(
        'Implement JWT authentication for users'
      );

      // Should find with high similarity
      assert.ok(similar.length > 0);
      assert.ok(similar[0].similarity_score > 0.7);
    });

    it('should calculate low similarity for dissimilar descriptions', () => {
      learner.recordTaskCompletion({
        task_description: 'Implement user authentication',
        task_type: 'implementation',
        outcome: 'success',
        tags: ['auth', 'security'],
      });

      const similar = learner.findSimilarTasks(
        'Refactor database schema for analytics'
      );

      // Should find no matches or very low similarity
      assert.ok(
        similar.length === 0 ||
        similar[0].similarity_score < 0.5
      );
    });
  });
});
