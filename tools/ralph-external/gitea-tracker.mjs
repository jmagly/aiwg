/**
 * Gitea Tracker for External Ralph Loop
 *
 * Optional integration with Gitea for issue tracking and progress updates.
 * Uses secure token handling from ~/.config/gitea/token.
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GITEA_TOKEN_PATH = join(homedir(), '.config', 'gitea', 'token');
const GITEA_API_BASE = 'https://git.integrolabs.net/api/v1';

/**
 * @typedef {Object} GiteaConfig
 * @property {string} owner - Repository owner
 * @property {string} repo - Repository name
 * @property {string} [tokenPath] - Path to token file
 */

export class GiteaTracker {
  /**
   * @param {GiteaConfig} config
   */
  constructor(config) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.tokenPath = config.tokenPath || GITEA_TOKEN_PATH;
    this.issueNumber = null;
  }

  /**
   * Check if Gitea token is available
   * @returns {boolean}
   */
  isAvailable() {
    return existsSync(this.tokenPath);
  }

  /**
   * Make API call using heredoc pattern for token security
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {Object} [data] - Request body
   * @returns {Object}
   */
  apiCall(method, endpoint, data = null) {
    if (!this.isAvailable()) {
      throw new Error(`Gitea token not found at ${this.tokenPath}`);
    }

    const url = `${GITEA_API_BASE}${endpoint}`;
    const dataArg = data ? `-d '${JSON.stringify(data)}'` : '';

    // Use heredoc pattern for secure token handling
    const script = `bash <<'EOF'
TOKEN=$(cat ${this.tokenPath})
curl -s -X ${method} \\
  -H "Authorization: token \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  "${url}" ${dataArg}
EOF`;

    try {
      const result = execSync(script, { encoding: 'utf8' });
      return JSON.parse(result);
    } catch (error) {
      throw new Error(`Gitea API call failed: ${error.message}`);
    }
  }

  /**
   * Create issue for loop tracking
   * @param {Object} loopState - Loop state
   * @returns {number} - Issue number
   */
  createIssue(loopState) {
    const body = `## External Ralph Loop

**Loop ID**: \`${loopState.loopId}\`

### Objective
${loopState.objective}

### Completion Criteria
${loopState.completionCriteria}

### Configuration
- Max Iterations: ${loopState.maxIterations}
- Model: ${loopState.config?.model || 'claude-sonnet-5'}
- Budget/Iteration: $${loopState.config?.budgetPerIteration || 5.0}

---

**Status**: In Progress

Progress updates will be posted as comments.
`;

    const response = this.apiCall('POST', `/repos/${this.owner}/${this.repo}/issues`, {
      title: `[Ralph] ${loopState.objective.slice(0, 50)}...`,
      body,
    });

    this.issueNumber = response.number;
    return this.issueNumber;
  }

  /**
   * Post progress comment
   * @param {number} issueNumber - Issue number
   * @param {number} iteration - Iteration number
   * @param {Object} analysis - Analysis result
   */
  postProgressComment(issueNumber, iteration, analysis) {
    const body = `## Iteration ${iteration} Update

**Status**: ${analysis.completed ? (analysis.success ? 'Completed' : 'Failed') : 'In Progress'}
**Progress**: ${analysis.completionPercentage || 0}%

### Analysis
${analysis.learnings || 'No learnings recorded'}

### Modified Files
${analysis.artifactsModified?.map(f => `- \`${f}\``).join('\n') || 'None'}

${analysis.blockers?.length > 0 ? `### Blockers\n${analysis.blockers.map(b => `- ${b}`).join('\n')}` : ''}

${analysis.nextApproach ? `### Next Approach\n${analysis.nextApproach}` : ''}
`;

    this.apiCall('POST', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      body,
    });
  }

  /**
   * Close issue with final status
   * @param {number} issueNumber - Issue number
   * @param {boolean} success - Whether loop succeeded
   * @param {string} summary - Final summary
   */
  closeIssue(issueNumber, success, summary) {
    // Post final comment
    const body = `## Loop Completed

**Final Status**: ${success ? 'SUCCESS' : 'FAILED'}

### Summary
${summary}

---
Loop completed at ${new Date().toISOString()}
`;

    this.apiCall('POST', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      body,
    });

    // Close the issue
    this.apiCall('PATCH', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`, {
      state: 'closed',
    });
  }

  /**
   * Update issue title with status
   * @param {number} issueNumber - Issue number
   * @param {string} status - Status to append
   */
  updateTitle(issueNumber, status) {
    this.apiCall('PATCH', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`, {
      title: `[Ralph] [${status}] ${this.objective?.slice(0, 40) || 'Task'}...`,
    });
  }
}

/**
 * Try to detect repository info from git remote
 * @param {string} cwd - Working directory
 * @returns {{owner: string, repo: string}|null}
 */
export function detectGiteaRepo(cwd) {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
    }).trim();

    // Parse git@git.integrolabs.net:owner/repo.git
    const sshMatch = remote.match(/git@git\.integrolabs\.net:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // Parse https://git.integrolabs.net/owner/repo.git
    const httpsMatch = remote.match(/https:\/\/git\.integrolabs\.net\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    return null;
  } catch {
    return null;
  }
}

export default GiteaTracker;
