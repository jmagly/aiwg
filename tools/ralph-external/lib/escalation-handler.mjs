/**
 * Escalation Handler for External Ralph Loop Overseer
 *
 * Handles human escalation via multiple channels:
 * - Desktop notifications (graceful fallback if unavailable)
 * - Gitea issue creation
 * - Webhook support for external integrations
 *
 * @implements Issue #25 - Autonomous Overseer
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { importImpl } from '../../_resolve-impl.mjs';

const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

/**
 * Escalation levels
 */
export const ESCALATION_LEVELS = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
  EMERGENCY: 'emergency',
};

/**
 * @typedef {Object} EscalationContext
 * @property {string} loopId - Ralph loop ID
 * @property {string} taskDescription - Task description
 * @property {number} iterationNumber - Current iteration
 * @property {string} level - Escalation level
 * @property {string} reason - Why escalating
 * @property {Object} detection - Detection that triggered escalation
 * @property {Object} intervention - Intervention that triggered escalation
 */

export class EscalationHandler {
  /**
   * @param {Object} options
   * @param {string} [options.giteaTokenPath] - Path to Gitea token file
   * @param {string} [options.giteaUrl] - Gitea API base URL
   * @param {string} [options.repo] - Repo in format owner/repo
   * @param {Function} [options.webhookUrl] - Webhook URL for external notifications
   * @param {boolean} [options.enableNotifications=true] - Enable desktop notifications
   */
  constructor(options = {}) {
    this.giteaTokenPath = options.giteaTokenPath || '~/.config/gitea/token';
    this.giteaUrl = options.giteaUrl || 'https://git.integrolabs.net/api/v1';
    this.repo = options.repo || 'roctinam/ai-writing-guide';
    this.webhookUrl = options.webhookUrl || null;
    this.enableNotifications = options.enableNotifications !== false;

    this.escalationLog = [];
  }

  /**
   * Escalate to human via configured channels
   * @param {string} level - Escalation level
   * @param {EscalationContext} context - Escalation context
   * @returns {Object} Escalation result
   */
  async escalate(level, context) {
    const escalation = {
      level,
      context,
      timestamp: new Date().toISOString(),
      channels: [],
    };

    // Desktop notification (non-blocking)
    if (this.enableNotifications) {
      try {
        this.sendDesktopNotification(level, context);
        escalation.channels.push('desktop_notification');
      } catch (error) {
        // Graceful fallback - notification failure doesn't block
        console.warn('Desktop notification failed:', error.message);
      }
    }

    // Gitea issue (for CRITICAL and EMERGENCY)
    if (level === ESCALATION_LEVELS.CRITICAL || level === ESCALATION_LEVELS.EMERGENCY) {
      try {
        const issue = await this.createIssue({
          title: `[Ralph Overseer] ${level.toUpperCase()}: ${context.reason}`,
          body: this.buildIssueBody(context),
          labels: ['ralph-overseer', level, 'automated'],
        });
        escalation.channels.push('gitea_issue');
        escalation.issueNumber = issue.number;
        escalation.issueUrl = issue.url;
      } catch (error) {
        console.error('Gitea issue creation failed:', error.message);
        escalation.errors = escalation.errors || [];
        escalation.errors.push({ channel: 'gitea', error: error.message });
      }
    }

    // Webhook (if configured)
    if (this.webhookUrl) {
      try {
        await this.sendWebhook(level, context);
        escalation.channels.push('webhook');
      } catch (error) {
        console.warn('Webhook notification failed:', error.message);
      }
    }

    // Log escalation
    this.escalationLog.push(escalation);

    return escalation;
  }

  /**
   * Send desktop notification
   * @param {string} level
   * @param {EscalationContext} context
   */
  sendDesktopNotification(level, context) {
    // Try notify-send (Linux)
    const title = `Ralph Overseer: ${level.toUpperCase()}`;
    const message = `${context.reason}\n\nLoop: ${context.loopId}\nIteration: ${context.iterationNumber}`;

    const urgency = {
      [ESCALATION_LEVELS.INFO]: 'low',
      [ESCALATION_LEVELS.WARNING]: 'normal',
      [ESCALATION_LEVELS.CRITICAL]: 'critical',
      [ESCALATION_LEVELS.EMERGENCY]: 'critical',
    }[level] || 'normal';

    try {
      boundedSpawnSync('notify-send', [
        '--urgency', urgency,
        '--app-name', 'Ralph Overseer',
        title,
        message,
      ], 'quick');
    } catch (error) {
      // Silently fail - notifications are optional
    }
  }

  /**
   * Create Gitea issue
   * @param {Object} details
   * @param {string} details.title - Issue title
   * @param {string} details.body - Issue body
   * @param {string[]} [details.labels] - Issue labels
   * @returns {Promise<Object>} Created issue
   */
  async createIssue(details) {
    // Read Gitea token
    const token = this.getGiteaToken();
    if (!token) {
      throw new Error('Gitea token not found');
    }

    // Build API request
    const [owner, repo] = this.repo.split('/');
    const url = `${this.giteaUrl}/repos/${owner}/${repo}/issues`;

    const body = JSON.stringify({
      title: details.title,
      body: details.body,
      labels: (details.labels || []).map(name => ({ name })),
    });

    // Use curl for API call (more reliable than fetch in Node)
    const result = spawnSync('curl', [
      '-s',
      '-X', 'POST',
      '-H', `Authorization: token ${token}`,
      '-H', 'Content-Type: application/json',
      url,
      '-d', body,
    ], {
      encoding: 'utf8',
      timeout: 10000,
      killSignal: 'SIGKILL',
    });

    if (result.status !== 0) {
      throw new Error(`Gitea API call failed: ${result.stderr}`);
    }

    const response = JSON.parse(result.stdout);

    return {
      number: response.number,
      url: response.html_url,
      id: response.id,
    };
  }

  /**
   * Build issue body from context
   * @param {EscalationContext} context
   * @returns {string} Markdown body
   */
  buildIssueBody(context) {
    const { loopId, taskDescription, iterationNumber, reason, detection, intervention } = context;

    let body = `## Ralph Loop Overseer Alert\n\n`;
    body += `**Loop ID:** ${loopId}\n`;
    body += `**Task:** ${taskDescription}\n`;
    body += `**Iteration:** ${iterationNumber}\n`;
    body += `**Timestamp:** ${new Date().toISOString()}\n\n`;

    body += `### Issue\n\n${reason}\n\n`;

    if (detection) {
      body += `### Detection\n\n`;
      body += `- **Type:** ${detection.type}\n`;
      body += `- **Severity:** ${detection.severity}\n`;
      body += `- **Message:** ${detection.message}\n\n`;

      if (detection.evidence) {
        body += `**Evidence:**\n\`\`\`json\n${JSON.stringify(detection.evidence, null, 2)}\n\`\`\`\n\n`;
      }

      if (detection.recommendations && detection.recommendations.length > 0) {
        body += `**Recommendations:**\n`;
        detection.recommendations.forEach((rec, idx) => {
          body += `${idx + 1}. ${rec}\n`;
        });
        body += '\n';
      }
    }

    if (intervention) {
      body += `### Intervention\n\n`;
      body += `- **Level:** ${intervention.level}\n`;
      body += `- **Reason:** ${intervention.reason}\n\n`;
    }

    body += `### Actions Required\n\n`;
    body += `- [ ] Review loop state and iteration history\n`;
    body += `- [ ] Determine if loop should continue or abort\n`;
    body += `- [ ] Provide guidance on how to proceed\n\n`;

    body += `---\n`;
    body += `*Automated escalation from Ralph External Loop Overseer*\n`;

    return body;
  }

  /**
   * Send webhook notification
   * @param {string} level
   * @param {EscalationContext} context
   */
  async sendWebhook(level, context) {
    if (!this.webhookUrl) {
      return;
    }

    const payload = {
      level,
      context,
      timestamp: new Date().toISOString(),
    };

    const result = spawnSync('curl', [
      '-s',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      this.webhookUrl,
      '-d', JSON.stringify(payload),
    ], {
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });

    if (result.status !== 0) {
      throw new Error(`Webhook call failed: ${result.stderr}`);
    }
  }

  /**
   * Get Gitea token from file
   * @returns {string|null}
   */
  getGiteaToken() {
    const expandedPath = this.giteaTokenPath.replace(/^~/, process.env.HOME || '');

    if (!existsSync(expandedPath)) {
      return null;
    }

    try {
      const token = readFileSync(expandedPath, 'utf8').trim();
      return token;
    } catch (error) {
      console.error('Error reading Gitea token:', error.message);
      return null;
    }
  }

  /**
   * Get escalation log
   * @param {number} [limit] - Max entries to return
   * @returns {Array}
   */
  getLog(limit = null) {
    if (limit) {
      return this.escalationLog.slice(-limit);
    }
    return [...this.escalationLog];
  }

  /**
   * Get summary of escalations
   * @returns {Object}
   */
  getSummary() {
    const summary = {
      total: this.escalationLog.length,
      byLevel: {},
      byChannel: {},
    };

    this.escalationLog.forEach(esc => {
      // Count by level
      summary.byLevel[esc.level] = (summary.byLevel[esc.level] || 0) + 1;

      // Count by channel
      esc.channels.forEach(channel => {
        summary.byChannel[channel] = (summary.byChannel[channel] || 0) + 1;
      });
    });

    return summary;
  }

  /**
   * Clear escalation log
   */
  clearLog() {
    this.escalationLog = [];
  }

  /**
   * Export state for persistence
   * @returns {Object}
   */
  exportState() {
    return {
      escalationLog: this.escalationLog,
    };
  }

  /**
   * Import state from persistence
   * @param {Object} state
   */
  importState(state) {
    if (state.escalationLog) {
      this.escalationLog = state.escalationLog;
    }
  }
}

export default EscalationHandler;
