/**
 * Multi-Loop Gitea Reporter for External Ralph
 *
 * Coordinated Gitea issue tracking for multiple concurrent Ralph loops.
 * Posts per-loop progress updates and aggregate summaries.
 *
 * @implements @.aiwg/requirements/use-cases/UC-273-multi-loop-supervisor.md
 */

import { GiteaTracker } from './gitea-tracker.mjs';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * @typedef {Object} LoopProgress
 * @property {string} loopId - Loop identifier
 * @property {number} iteration - Current iteration
 * @property {number} maxIterations - Maximum iterations
 * @property {string} status - Loop status
 * @property {number} progress - Progress percentage
 * @property {Object} [analysis] - Latest analysis
 */

export class MultiLoopGiteaReporter {
  /**
   * @param {Object} config
   * @param {string} config.projectRoot - Project root directory
   * @param {string} config.owner - Repository owner
   * @param {string} config.repo - Repository name
   * @param {string} [config.tokenPath] - Path to token file
   */
  constructor(config) {
    this.projectRoot = config.projectRoot;
    this.tracker = new GiteaTracker({
      owner: config.owner,
      repo: config.repo,
      tokenPath: config.tokenPath,
    });
    this.loopsDir = join(this.projectRoot, '.aiwg', 'ralph', 'loops');
    this.issueNumbers = new Map(); // loopId -> issueNumber
  }

  /**
   * Check if Gitea is available
   * @returns {boolean}
   */
  isAvailable() {
    return this.tracker.isAvailable();
  }

  /**
   * Post per-loop progress comment
   * @param {string} loopId - Loop ID
   * @param {Object} progress - Progress data
   * @param {number} [issueNumber] - Existing issue number
   * @returns {number} - Issue number
   */
  postLoopProgress(loopId, progress, issueNumber = null) {
    if (!issueNumber) {
      issueNumber = this.issueNumbers.get(loopId);
    }

    if (!issueNumber) {
      throw new Error(`No issue number for loop ${loopId}. Call createLoopIssue first.`);
    }

    const body = this.formatLoopComment(loopId, {
      type: 'progress',
      iteration: progress.iteration,
      maxIterations: progress.maxIterations,
      status: progress.status,
      analysis: progress.analysis,
    });

    this.tracker.apiCall(
      'POST',
      `/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${issueNumber}/comments`,
      { body }
    );

    return issueNumber;
  }

  /**
   * Post loop completion comment
   * @param {string} loopId - Loop ID
   * @param {Object} result - Completion result
   * @param {number} [issueNumber] - Existing issue number
   */
  postLoopCompletion(loopId, result, issueNumber = null) {
    if (!issueNumber) {
      issueNumber = this.issueNumbers.get(loopId);
    }

    if (!issueNumber) {
      return;
    }

    const body = this.formatLoopComment(loopId, {
      type: 'completion',
      success: result.success,
      iterations: result.iterations,
      reason: result.reason,
    });

    this.tracker.closeIssue(issueNumber, result.success, body);
    this.issueNumbers.delete(loopId);
  }

  /**
   * Post loop crash notification
   * @param {string} loopId - Loop ID
   * @param {Error} error - Error that caused crash
   * @param {number} [issueNumber] - Existing issue number
   */
  postLoopCrash(loopId, error, issueNumber = null) {
    if (!issueNumber) {
      issueNumber = this.issueNumbers.get(loopId);
    }

    if (!issueNumber) {
      return;
    }

    const body = this.formatLoopComment(loopId, {
      type: 'crash',
      error: error.message,
      stack: error.stack,
    });

    this.tracker.apiCall(
      'POST',
      `/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${issueNumber}/comments`,
      { body }
    );
  }

  /**
   * Post aggregate summary of all loops
   * @param {number} issueNumber - Issue number for summary
   * @returns {Object} - Summary data
   */
  postAllLoopsSummary(issueNumber = null) {
    const summary = this.generateAllLoopsSummary();

    if (!issueNumber) {
      // Create new summary issue
      const response = this.tracker.apiCall(
        'POST',
        `/repos/${this.tracker.owner}/${this.tracker.repo}/issues`,
        {
          title: `[Ralph Multi-Loop] Summary - ${new Date().toISOString().split('T')[0]}`,
          body: summary.markdown,
        }
      );
      return { issueNumber: response.number, summary };
    }

    // Update existing issue
    this.tracker.apiCall(
      'POST',
      `/repos/${this.tracker.owner}/${this.tracker.repo}/issues/${issueNumber}/comments`,
      { body: summary.markdown }
    );

    return { issueNumber, summary };
  }

  /**
   * Generate aggregate summary of all loops
   * @returns {Object} - Summary data with markdown
   */
  generateAllLoopsSummary() {
    const loops = this.getAllLoopsStatus();

    const totalActive = loops.filter(l => l.status === 'running').length;
    const totalPaused = loops.filter(l => l.status === 'paused').length;
    const totalCompleted = loops.filter(l => l.status === 'completed').length;
    const totalFailed = loops.filter(l => l.status === 'failed').length;

    const totalIterations = loops.reduce((sum, l) => sum + l.iteration, 0);
    const avgProgress = loops.length > 0
      ? (loops.reduce((sum, l) => sum + (l.progress || 0), 0) / loops.length).toFixed(1)
      : 0;

    const markdown = `## External Ralph Multi-Loop Summary

**Generated**: ${new Date().toISOString()}

### Overview

| Metric | Count |
|--------|-------|
| Active Loops | ${totalActive} |
| Paused Loops | ${totalPaused} |
| Completed | ${totalCompleted} |
| Failed | ${totalFailed} |
| Total Iterations | ${totalIterations} |
| Avg Progress | ${avgProgress}% |

### Active Loops

${loops.filter(l => l.status === 'running' || l.status === 'paused').map(l => `
#### ${l.loopId}

- **Status**: ${l.status}
- **Progress**: ${l.iteration}/${l.maxIterations} (${l.progress}%)
- **Objective**: ${l.objective || 'Not specified'}
- **Started**: ${l.startTime || 'Unknown'}
`).join('\n') || '*No active loops*'}

### Recent Activity

${this.formatRecentActivity(loops)}

---

*This summary is automatically generated by the External Ralph Multi-Loop Supervisor*
`;

    return {
      markdown,
      totalActive,
      totalPaused,
      totalCompleted,
      totalFailed,
      totalIterations,
      avgProgress,
      loops,
    };
  }

  /**
   * Format recent activity for summary
   * @param {Array} loops - All loops
   * @returns {string} - Formatted activity markdown
   */
  formatRecentActivity(loops) {
    // Get latest iteration from each loop
    const activities = loops
      .map(loop => {
        if (!loop.iterations || loop.iterations.length === 0) {
          return null;
        }
        const latest = loop.iterations[loop.iterations.length - 1];
        return {
          loopId: loop.loopId,
          iteration: latest.number,
          status: latest.status,
          timestamp: latest.timestamp,
        };
      })
      .filter(a => a !== null)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 5); // Most recent 5

    if (activities.length === 0) {
      return '*No recent activity*';
    }

    return activities.map(a =>
      `- **${a.loopId}** - Iteration ${a.iteration} (${a.status}) at ${a.timestamp}`
    ).join('\n');
  }

  /**
   * Get status of all loops
   * @returns {Array<LoopProgress>}
   */
  getAllLoopsStatus() {
    const loops = [];

    if (!existsSync(this.loopsDir)) {
      return loops;
    }

    const loopDirs = readdirSync(this.loopsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const loopId of loopDirs) {
      const stateFile = join(this.loopsDir, loopId, 'state.json');

      if (!existsSync(stateFile)) {
        continue;
      }

      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        const progress = state.currentIteration / state.maxIterations * 100;

        loops.push({
          loopId,
          iteration: state.currentIteration,
          maxIterations: state.maxIterations,
          status: state.status,
          progress: Math.round(progress),
          objective: state.objective,
          startTime: state.startTime,
          iterations: state.iterations,
        });
      } catch {
        // Skip corrupted state files
      }
    }

    return loops;
  }

  /**
   * Format loop-specific comment
   * @param {string} loopId - Loop ID
   * @param {Object} content - Comment content
   * @returns {string} - Formatted markdown
   */
  formatLoopComment(loopId, content) {
    const header = `### Loop: \`${loopId}\`\n\n`;

    switch (content.type) {
      case 'progress':
        return header + `**Iteration ${content.iteration}/${content.maxIterations}**

**Status**: ${content.status}

${content.analysis?.learnings ? `**Learnings**:\n${content.analysis.learnings}\n` : ''}

${content.analysis?.artifactsModified?.length > 0
  ? `**Modified Files**:\n${content.analysis.artifactsModified.map(f => `- \`${f}\``).join('\n')}\n`
  : ''}

${content.analysis?.nextApproach ? `**Next Approach**:\n${content.analysis.nextApproach}\n` : ''}
`;

      case 'completion':
        return header + `**Loop Completed**

**Status**: ${content.success ? 'SUCCESS' : 'FAILED'}
**Iterations**: ${content.iterations}
**Reason**: ${content.reason}

---
Completed at ${new Date().toISOString()}
`;

      case 'crash':
        return header + `**Loop Crashed**

**Error**: ${content.error}

<details>
<summary>Stack Trace</summary>

\`\`\`
${content.stack}
\`\`\`

</details>

---
Crashed at ${new Date().toISOString()}
`;

      default:
        return header + content.message || '';
    }
  }

  /**
   * Create Gitea issue for a loop
   * @param {string} loopId - Loop ID
   * @param {Object} loopState - Loop state
   * @returns {number} - Issue number
   */
  createLoopIssue(loopId, loopState) {
    const issueNumber = this.tracker.createIssue(loopState);
    this.issueNumbers.set(loopId, issueNumber);
    return issueNumber;
  }

  /**
   * Get issue number for a loop
   * @param {string} loopId - Loop ID
   * @returns {number|null}
   */
  getIssueNumber(loopId) {
    return this.issueNumbers.get(loopId) || null;
  }

  /**
   * Set issue number for a loop
   * @param {string} loopId - Loop ID
   * @param {number} issueNumber - Issue number
   */
  setIssueNumber(loopId, issueNumber) {
    this.issueNumbers.set(loopId, issueNumber);
  }
}

export default MultiLoopGiteaReporter;
