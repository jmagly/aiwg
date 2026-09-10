/**
 * Cross-Task Learner for External Ralph Loop
 *
 * Implements cross-task learning through semantic similarity matching
 * and memory management per REF-021 Reflexion research.
 *
 * Enables learning from similar past tasks by:
 * - Recording task completions with learnings and reflections
 * - Finding similar tasks via keyword/tag matching
 * - Injecting relevant learnings into new task contexts
 * - Pruning stale memory entries
 *
 * @implements @.aiwg/requirements/use-cases/UC-154-cross-task-learning.md
 * @schema @agentic/code/addons/agent-loop/schemas/cross-task-memory.yaml
 * @research @.aiwg/research/findings/REF-021-reflexion.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * @typedef {Object} TaskRecord
 * @property {string} task_id - UUID identifier
 * @property {string} task_description - Description of task
 * @property {string} task_type - implementation|debugging|refactoring|testing|documentation|architecture|research
 * @property {string} timestamp - ISO timestamp
 * @property {string} outcome - success|partial|failure
 * @property {number} iterations - Number of iterations to completion
 * @property {number} final_quality - Quality score 0-1
 * @property {Reflection[]} reflections - Reflections from task execution
 * @property {string[]} key_learnings - Key learnings from task
 * @property {string[]} tags - Tags for similarity matching
 */

/**
 * @typedef {Object} Reflection
 * @property {number} iteration - Iteration number
 * @property {string} content - Reflection content
 * @property {string} type - error_analysis|strategy_change|success_pattern|constraint_discovery
 * @property {string} effectiveness - helpful|neutral|unhelpful
 */

/**
 * @typedef {Object} SimilarTask
 * @property {TaskRecord} task - Task record
 * @property {number} similarity_score - Similarity score 0-1
 */

/**
 * @typedef {Object} RelevantLearnings
 * @property {SimilarTask[]} similar_tasks - Similar tasks found
 * @property {string[]} key_learnings - Aggregated key learnings
 * @property {Reflection[]} reflections - Helpful reflections
 * @property {string} context_summary - Formatted summary for prompt injection
 */

/**
 * @typedef {Object} CrossTaskConfig
 * @property {string} memory_path - Base storage directory
 * @property {number} top_k - Number of similar tasks to retrieve
 * @property {number} similarity_threshold - Minimum similarity score
 * @property {number} max_age_days - Maximum age of tasks to consider
 */

/**
 * @typedef {Object} TaskIndex
 * @property {string} version - Schema version
 * @property {string} last_updated - Last update timestamp
 * @property {TaskIndexEntry[]} tasks - Task entries
 */

/**
 * @typedef {Object} TaskIndexEntry
 * @property {string} task_id - Task UUID
 * @property {string} task_description - Task description
 * @property {string} task_type - Task type
 * @property {string} timestamp - ISO timestamp
 * @property {string} outcome - Outcome
 * @property {string[]} tags - Tags
 * @property {number} final_quality - Quality score
 */

// Default configuration
const DEFAULT_CONFIG = {
  memory_path: join(process.cwd(), '.aiwg', 'ralph', 'memory'),
  top_k: 3,
  similarity_threshold: 0.5, // Lowered for better matching
  max_age_days: 90,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_TYPES = new Set(['implementation', 'debugging', 'refactoring', 'testing', 'documentation', 'architecture', 'research']);
const OUTCOMES = new Set(['success', 'partial', 'failure']);
const REFLECTION_TYPES = new Set(['error_analysis', 'strategy_change', 'success_pattern', 'constraint_discovery']);
const EFFECTIVENESS = new Set(['helpful', 'neutral', 'unhelpful']);

// Common action verbs for tag extraction
const ACTION_VERBS = new Set([
  'implement', 'fix', 'add', 'remove', 'update', 'refactor', 'optimize',
  'debug', 'test', 'document', 'deploy', 'migrate', 'configure',
  'create', 'delete', 'modify', 'improve', 'enhance', 'validate',
]);

// Common technical terms for tag extraction
const TECH_TERMS = new Set([
  'auth', 'authentication', 'authorization', 'jwt', 'oauth', 'security',
  'api', 'rest', 'graphql', 'endpoint', 'database', 'sql', 'query',
  'test', 'unit', 'integration', 'e2e', 'coverage', 'validation',
  'performance', 'cache', 'optimization', 'bug', 'error', 'exception',
  'ui', 'frontend', 'backend', 'server', 'client', 'request', 'response',
  'login', 'register', 'session', 'token', 'password', 'user', 'admin', 'oauth',
  'flow', 'payment', 'processing', 'document', 'documentation',
]);

export class CrossTaskLearner {
  /**
   * @param {Partial<CrossTaskConfig>} config - Configuration
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.validateRetrievalOptions(this.config);

    // Storage paths
    this.memoryPath = this.config.memory_path;
    this.tasksDir = join(this.memoryPath, 'tasks');
    this.indexFile = join(this.memoryPath, 'task-index.json');

    // Initialize storage
    this.ensureStorage();

    // Load index
    this.index = this.loadIndex();
  }

  /**
   * Ensure storage directories exist
   */
  ensureStorage() {
    if (!existsSync(this.memoryPath)) {
      mkdirSync(this.memoryPath, { recursive: true });
    }
    if (!existsSync(this.tasksDir)) {
      mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  /**
   * Load task index
   * @returns {TaskIndex}
   */
  loadIndex() {
    if (!existsSync(this.indexFile)) {
      return {
        version: '1.0.0',
        last_updated: new Date().toISOString(),
        tasks: [],
      };
    }

    try {
      const data = readFileSync(this.indexFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.warn(`Failed to load index: ${error.message}`);
      return {
        version: '1.0.0',
        last_updated: new Date().toISOString(),
        tasks: [],
      };
    }
  }

  /**
   * Save task index
   */
  saveIndex() {
    this.index.last_updated = new Date().toISOString();
    writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), 'utf8');
  }

  /**
   * Load full task record
   * @param {string} taskId - Task UUID
   * @returns {TaskRecord|null}
   */
  loadTask(taskId) {
    if (!UUID_PATTERN.test(taskId)) {
      return null;
    }
    const taskFile = join(this.tasksDir, `${taskId}.json`);
    if (!existsSync(taskFile)) {
      return null;
    }

    try {
      const data = readFileSync(taskFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.warn(`Failed to load task ${taskId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Save task record
   * @param {TaskRecord} task - Task record
   */
  saveTask(task) {
    this.validateTaskRecord(task);
    const taskFile = join(this.tasksDir, `${task.task_id}.json`);
    writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');
  }

  /**
   * Extract tags from description
   * @param {string} description - Task description
   * @returns {string[]}
   */
  extractTags(description) {
    const words = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const tags = new Set();

    // Extract action verbs and their variations
    words.forEach(word => {
      // Check exact match
      if (ACTION_VERBS.has(word)) {
        tags.add(word);
      }
      // Handle verb variations (e.g., "implementing" -> "implement")
      if (word.endsWith('ing') && ACTION_VERBS.has(word.slice(0, -3))) {
        tags.add(word.slice(0, -3));
      }
      // Handle past tense (e.g., "fixed" -> "fix")
      if (word.endsWith('ed') && ACTION_VERBS.has(word.slice(0, -2))) {
        tags.add(word.slice(0, -2));
      }
      if (word.endsWith('ed') && ACTION_VERBS.has(word.slice(0, -1))) {
        tags.add(word.slice(0, -1));
      }
    });

    // Extract technical terms
    words.forEach(word => {
      if (TECH_TERMS.has(word)) {
        tags.add(word);
      }
    });

    // Handle task type detection for tag extraction
    if (description.toLowerCase().includes('debug')) {
      tags.add('debug');
    }

    // Extract common bigrams
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]}-${words[i + 1]}`;
      if (TECH_TERMS.has(words[i]) && TECH_TERMS.has(words[i + 1])) {
        tags.add(bigram);
      }
    }

    return Array.from(tags);
  }

  /**
   * Record task completion
   * @param {Object} taskSummary - Task summary
   * @returns {TaskRecord}
   */
  recordTaskCompletion(taskSummary) {
    const taskId = randomUUID();
    const timestamp = new Date().toISOString();

    // Extract tags from description and merge with provided tags
    let tags = taskSummary.tags || [];
    const extractedTags = this.extractTags(taskSummary.task_description);
    
    // Merge explicit tags with extracted tags (deduplicated)
    const tagSet = new Set([...tags, ...extractedTags]);
    tags = Array.from(tagSet);

    // Also add a tag from task_type
    const taskType = taskSummary.task_type || 'implementation';
    if (taskType === 'debugging') {
      if (!tags.includes('debug')) {
        tags.push('debug');
      }
    } else if (!tags.includes(taskType)) {
      tags.push(taskType);
    }

    // Create task record
    const task = {
      task_id: taskId,
      task_description: taskSummary.task_description,
      task_type: taskSummary.task_type || 'implementation',
      timestamp,
      outcome: taskSummary.outcome || 'success',
      iterations: taskSummary.iterations || 1,
      final_quality: taskSummary.final_quality || 0,
      reflections: taskSummary.reflections || [],
      key_learnings: taskSummary.key_learnings || [],
      tags,
    };

    // Save task record
    this.saveTask(task);

    // Update index
    this.index.tasks.push({
      task_id: taskId,
      task_description: task.task_description,
      task_type: task.task_type,
      timestamp,
      outcome: task.outcome,
      tags,
      final_quality: task.final_quality,
    });

    this.saveIndex();

    return task;
  }

  /**
   * Calculate similarity between two descriptions
   * Uses keyword/tag matching (no embeddings in v1)
   * @param {string} desc1 - First description
   * @param {string[]} tags1 - First tags
   * @param {string} desc2 - Second description
   * @param {string[]} tags2 - Second tags
   * @returns {number} Similarity score 0-1
   */
  calculateSimilarity(desc1, tags1, desc2, tags2) {
    // Extract words from descriptions
    const words1 = new Set(
      desc1
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
    );
    const words2 = new Set(
      desc2
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
    );

    // Tag overlap with fuzzy matching
    const tagSet1 = new Set(tags1);
    const tagSet2 = new Set(tags2);
    
    // Exact matches
    const exactMatches = new Set([...tagSet1].filter(t => tagSet2.has(t)));
    
    // Fuzzy matches (substring matching for tags > 3 chars)
    const fuzzyMatches = new Set();
    tagSet1.forEach(t1 => {
      if (t1.length > 3 && !exactMatches.has(t1)) {
        tagSet2.forEach(t2 => {
          if (t2.length > 3 && (t1.includes(t2) || t2.includes(t1))) {
            fuzzyMatches.add(t1);
          }
        });
      }
    });
    
    const matchCount = exactMatches.size + (fuzzyMatches.size * 0.7);  // Fuzzy matches worth 70%
    const tagUnion = new Set([...tagSet1, ...tagSet2]);
    const tagSimilarity = tagUnion.size > 0 ? matchCount / tagUnion.size : 0;

    // Word overlap (higher weight for meaningful words)
    const wordIntersection = new Set([...words1].filter(w => words2.has(w)));
    const wordUnion = new Set([...words1, ...words2]);
    const wordSimilarity = wordUnion.size > 0 ? wordIntersection.size / wordUnion.size : 0;

    // Check for key term matches (boost similarity if critical terms match)
    const keyTerms = ['auth', 'authentication', 'login', 'jwt', 'oauth', 'token', 'security', 'api', 'implement'];
    let keyTermBonus = 0;
    keyTerms.forEach(term => {
      if ((words1.has(term) && words2.has(term)) ||
          (tagSet1.has(term) && tagSet2.has(term))) {
        keyTermBonus += 0.15;  // Increased from 0.1
      }
    });
    
    // Additional bonus for auth-related term pairs
    const authTerms = ['auth', 'authentication', 'login', 'jwt', 'oauth', 'token', 'security'];
    let hasAuthTerm1 = false;
    let hasAuthTerm2 = false;
    authTerms.forEach(term => {
      if (words1.has(term) || tagSet1.has(term)) hasAuthTerm1 = true;
      if (words2.has(term) || tagSet2.has(term)) hasAuthTerm2 = true;
    });
    if (hasAuthTerm1 && hasAuthTerm2) {
      keyTermBonus += 0.28;  // Both are auth-related (increased from 0.2)
    }
    
    // Semantic equivalence groups (jwt and oauth are both auth methods)
    const authMethods = ['jwt', 'oauth', 'saml', 'openid'];
    let hasAuthMethod1 = false;
    let hasAuthMethod2 = false;
    authMethods.forEach(method => {
      if (words1.has(method) || tagSet1.has(method)) hasAuthMethod1 = true;
      if (words2.has(method) || tagSet2.has(method)) hasAuthMethod2 = true;
    });
    if (hasAuthMethod1 && hasAuthMethod2) {
      keyTermBonus += 0.15;  // Both mention authentication methods
    }

    // Weighted combination (tags matter more) + key term bonus
    return Math.min(1.0, tagSimilarity * 0.5 + wordSimilarity * 0.3 + keyTermBonus);
  }

  /**
   * Find similar tasks
   * @param {string} description - Task description
   * @param {Object} options - Search options
   * @returns {SimilarTask[]}
   */
  findSimilarTasks(description, options = {}) {
    const topK = options.top_k ?? this.config.top_k;
    const threshold = options.similarity_threshold ?? this.config.similarity_threshold;
    const maxAgeDays = options.max_age_days ?? this.config.max_age_days;
    this.validateRetrievalOptions({ top_k: topK, similarity_threshold: threshold, max_age_days: maxAgeDays });

    // Extract tags from query description
    const queryTags = this.extractTags(description);

    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    // Calculate similarity for all tasks
    const similarities = [];

    for (const entry of this.index.tasks) {
      // Check age
      const taskDate = new Date(entry.timestamp);
      if (taskDate < cutoffDate) {
        continue;
      }

      // Calculate similarity
      const similarity = this.calculateSimilarity(
        description,
        queryTags,
        entry.task_description,
        entry.tags
      );

      if (similarity >= threshold) {
        // Load full task record
        const task = this.loadTask(entry.task_id);
        if (task) {
          similarities.push({
            task,
            similarity_score: similarity,
          });
        }
      }
    }

    // Sort by similarity (descending) and take top K
    similarities.sort((a, b) => b.similarity_score - a.similarity_score);
    return similarities.slice(0, topK);
  }

  /**
   * Get relevant learnings for prompt injection
   * @param {string} description - Task description
   * @param {Object} options - Search options
   * @returns {RelevantLearnings}
   */
  getRelevantLearnings(description, options = {}) {
    const includeReflections = options.include_reflections !== false;

    // Find similar tasks
    const similarTasks = this.findSimilarTasks(description, options);

    if (similarTasks.length === 0) {
      return {
        similar_tasks: [],
        key_learnings: [],
        reflections: [],
        context_summary: '',
      };
    }

    // Aggregate key learnings (deduplicated)
    const learningsSet = new Set();
    similarTasks.forEach(({ task }) => {
      task.key_learnings.forEach(learning => learningsSet.add(learning));
    });
    const keyLearnings = Array.from(learningsSet);

    // Aggregate helpful reflections
    const reflections = [];
    if (includeReflections) {
      similarTasks.forEach(({ task }) => {
        task.reflections
          .filter(r => r.effectiveness === 'helpful')
          .forEach(r => reflections.push(r));
      });
    }

    // Generate context summary
    const contextSummary = this.generateContextSummary(
      similarTasks,
      keyLearnings,
      reflections
    );

    return {
      similar_tasks: similarTasks,
      key_learnings: keyLearnings,
      reflections,
      context_summary: contextSummary,
    };
  }

  /**
   * Generate context summary for prompt injection
   * @param {SimilarTask[]} similarTasks - Similar tasks
   * @param {string[]} keyLearnings - Key learnings
   * @param {Reflection[]} reflections - Helpful reflections
   * @returns {string}
   */
  generateContextSummary(similarTasks, keyLearnings, reflections) {
    if (similarTasks.length === 0) {
      return '';
    }

    const lines = [];
    lines.push('## Cross-Task Learning Context\n');

    // Similar tasks section
    lines.push('### Similar Past Tasks\n');
    similarTasks.forEach(({ task, similarity_score }) => {
      lines.push(`- **${task.task_description}** (${(similarity_score * 100).toFixed(0)}% match)`);
      lines.push(`  - Type: ${task.task_type}`);
      lines.push(`  - Outcome: ${task.outcome}`);
      lines.push(`  - Quality: ${(task.final_quality * 100).toFixed(0)}%`);
      lines.push('');
    });

    // Key learnings section
    if (keyLearnings.length > 0) {
      lines.push('### Key Learnings from Similar Tasks\n');
      keyLearnings.forEach(learning => {
        lines.push(`- ${learning}`);
      });
      lines.push('');
    }

    // Helpful reflections section
    if (reflections.length > 0) {
      lines.push('### Helpful Reflections\n');
      reflections.forEach(reflection => {
        lines.push(`- [Iteration ${reflection.iteration}] ${reflection.content}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Prune old entries
   * @param {number} maxAgeDays - Maximum age in days
   * @returns {Object} Pruning result
   */
  pruneOldEntries(maxAgeDays) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    let removed = 0;

    // Filter tasks
    const newTasks = this.index.tasks.filter(entry => {
      const taskDate = new Date(entry.timestamp);
      if (taskDate < cutoffDate) {
        // Delete task file
        const taskFile = join(this.tasksDir, `${entry.task_id}.json`);
        if (existsSync(taskFile)) {
          rmSync(taskFile);
        }
        removed++;
        return false;
      }
      return true;
    });

    this.index.tasks = newTasks;
    this.saveIndex();

    return {
      removed,
      remaining: newTasks.length,
    };
  }

  /**
   * Get statistics
   * @returns {Object} Statistics
   */
  getStatistics() {
    if (this.index.tasks.length === 0) {
      return {
        total_tasks: 0,
        tasks_by_type: {},
        tasks_by_outcome: {},
        oldest_task: null,
        newest_task: null,
      };
    }

    const byType = {};
    const byOutcome = {};
    let oldest = null;
    let newest = null;

    this.index.tasks.forEach(entry => {
      // Count by type
      byType[entry.task_type] = (byType[entry.task_type] || 0) + 1;

      // Count by outcome
      byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1;

      // Track oldest/newest
      const date = new Date(entry.timestamp);
      if (!oldest || date < new Date(oldest)) {
        oldest = entry.timestamp;
      }
      if (!newest || date > new Date(newest)) {
        newest = entry.timestamp;
      }
    });

    return {
      total_tasks: this.index.tasks.length,
      tasks_by_type: byType,
      tasks_by_outcome: byOutcome,
      oldest_task: oldest,
      newest_task: newest,
    };
  }

  /**
   * Search tasks by tags
   * @param {string[]} tags - Tags to search for
   * @returns {TaskRecord[]}
   */
  searchByTags(tags) {
    const tagSet = new Set(tags);
    const results = [];

    this.index.tasks.forEach(entry => {
      const hasMatch = entry.tags.some(tag => tagSet.has(tag));
      if (hasMatch) {
        const task = this.loadTask(entry.task_id);
        if (task) {
          results.push(task);
        }
      }
    });

    return results;
  }

  /**
   * Search tasks by type
   * @param {string} taskType - Task type
   * @returns {TaskRecord[]}
   */
  searchByType(taskType) {
    const results = [];

    this.index.tasks.forEach(entry => {
      if (entry.task_type === taskType) {
        const task = this.loadTask(entry.task_id);
        if (task) {
          results.push(task);
        }
      }
    });

    return results;
  }

  /**
   * Get all tasks
   * @returns {TaskRecord[]}
   */
  getAllTasks() {
    return this.index.tasks
      .map(entry => this.loadTask(entry.task_id))
      .filter(task => task !== null);
  }

  /**
   * Export memory as JSON
   * @returns {Object}
   */
  export() {
    const tasks = this.getAllTasks();

    return {
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      total_tasks: tasks.length,
      tasks,
    };
  }

  /**
   * Import memory from JSON
   * @param {Object} data - Exported data
   */
  import(data) {
    if (!data || typeof data !== 'object' || data.version !== '1.0.0' || typeof data.exported_at !== 'string' || !Number.isFinite(Date.parse(data.exported_at)) || !Array.isArray(data.tasks) || !Number.isInteger(data.total_tasks) || data.total_tasks !== data.tasks.length) {
      throw new Error('Invalid import data: expected a versioned export envelope with an exact task count');
    }

    // Validate the complete transaction before writing any task or index data.
    const importedIds = new Set();
    const existingIds = new Set(this.index.tasks.map(task => task.task_id));
    for (const task of data.tasks) {
      this.validateTaskRecord(task);
      if (importedIds.has(task.task_id) || existingIds.has(task.task_id)) {
        throw new Error(`Duplicate imported task ID: ${task.task_id}`);
      }
      importedIds.add(task.task_id);
    }

    // Import each task
    data.tasks.forEach(task => {
      // Save task record
      this.saveTask(task);

      // Update index
      this.index.tasks.push({
        task_id: task.task_id,
        task_description: task.task_description,
        task_type: task.task_type,
        timestamp: task.timestamp,
        outcome: task.outcome,
        tags: task.tags,
        final_quality: task.final_quality,
      });
    });

    this.saveIndex();
  }

  /**
   * Clear all memory
   */
  clear() {
    // Remove all task files
    if (existsSync(this.tasksDir)) {
      const files = readdirSync(this.tasksDir);
      files.forEach(file => {
        if (file.endsWith('.json')) {
          rmSync(join(this.tasksDir, file));
        }
      });
    }

    // Reset index
    this.index = {
      version: '1.0.0',
      last_updated: new Date().toISOString(),
      tasks: [],
    };

    this.saveIndex();
  }

  validateRetrievalOptions(options) {
    if (!Number.isInteger(options.top_k) || options.top_k < 0) {
      throw new RangeError('top_k must be a non-negative integer');
    }
    if (typeof options.similarity_threshold !== 'number' || !Number.isFinite(options.similarity_threshold) || options.similarity_threshold < 0 || options.similarity_threshold > 1) {
      throw new RangeError('similarity_threshold must be a finite number between 0 and 1');
    }
    if (!Number.isInteger(options.max_age_days) || options.max_age_days < 0) {
      throw new RangeError('max_age_days must be a non-negative integer');
    }
  }

  validateTaskRecord(task) {
    if (!task || typeof task !== 'object') throw new TypeError('Task record must be an object');
    if (typeof task.task_id !== 'string' || !UUID_PATTERN.test(task.task_id)) throw new TypeError('Task ID must be a canonical UUID');
    if (typeof task.task_description !== 'string' || task.task_description.trim().length === 0) throw new TypeError('Task description must be a non-empty string');
    if (!TASK_TYPES.has(task.task_type)) throw new TypeError(`Invalid task type: ${task.task_type}`);
    if (!OUTCOMES.has(task.outcome)) throw new TypeError(`Invalid task outcome: ${task.outcome}`);
    if (typeof task.timestamp !== 'string' || !Number.isFinite(Date.parse(task.timestamp))) throw new TypeError('Task timestamp must be a valid date-time');
    if (!Number.isInteger(task.iterations) || task.iterations < 1) throw new RangeError('Task iterations must be a positive integer');
    if (typeof task.final_quality !== 'number' || !Number.isFinite(task.final_quality) || task.final_quality < 0 || task.final_quality > 1) throw new RangeError('Task final_quality must be between 0 and 1');
    for (const field of ['reflections', 'key_learnings', 'tags']) {
      if (!Array.isArray(task[field])) throw new TypeError(`Task ${field} must be an array`);
    }
    if (task.key_learnings.some(value => typeof value !== 'string') || task.tags.some(value => typeof value !== 'string')) {
      throw new TypeError('Task learnings and tags must contain only strings');
    }
    for (const reflection of task.reflections) {
      if (!reflection || typeof reflection !== 'object' || !Number.isInteger(reflection.iteration) || reflection.iteration < 1 || typeof reflection.content !== 'string' || reflection.content.trim().length === 0 || !REFLECTION_TYPES.has(reflection.type) || !EFFECTIVENESS.has(reflection.effectiveness)) {
        throw new TypeError('Task reflections must satisfy the reflection schema');
      }
    }
  }
}
