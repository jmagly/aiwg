/**
 * tmux Manager - Session management for the daemon REPL
 *
 * Creates and manages tmux sessions with a 2-pane layout:
 * - Top pane (70%): Interactive chat REPL
 * - Bottom pane (30%): Status dashboard
 *
 * @implements @.aiwg/requirements/use-cases/UC-TMUX-001.md
 * @tests @test/unit/daemon/tmux-manager.test.js
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { importImpl } from '../_resolve-impl.mjs';

const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

export class TmuxManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionName = options.sessionName || 'aiwg-daemon';
    this.chatPaneRatio = options.chatPaneRatio || 70;
    this.daemonScript = options.daemonScript || null;
    this.statusRefreshMs = options.statusRefreshMs || 5000;
    this.statusTimer = null;
  }

  /**
   * Check if tmux is installed and available
   */
  isTmuxAvailable() {
    try {
      boundedExecFileSync('tmux', ['-V'], 'quick', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if session already exists
   */
  sessionExists() {
    try {
      boundedExecFileSync('tmux', ['has-session', '-t', this.sessionName], 'quick', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new tmux session with 2-pane layout
   * @param {object} options - Creation options
   * tmux executes these trusted, operator-supplied commands through its shell.
   * @param {string} options.chatCommand - Shell command for the chat pane
   * @param {string} options.statusCommand - Shell command for the status pane
   */
  createSession(options = {}) {
    if (!this.isTmuxAvailable()) {
      throw new Error('tmux is not installed. Install with: apt install tmux');
    }

    if (this.sessionExists()) {
      throw new Error(`Session "${this.sessionName}" already exists. Use attach() instead.`);
    }

    const chatCommand = options.chatCommand || 'echo "Chat pane ready"';
    const statusCommand = options.statusCommand || 'echo "Status pane ready"';

    try {
      // Create session in detached mode with the chat command
      boundedExecFileSync(
        'tmux', ['new-session', '-d', '-s', this.sessionName, '-x', '200', '-y', '50', chatCommand],
        'quick',
        { stdio: 'pipe' }
      );

      // Split horizontally for status pane (bottom)
      const statusPercent = 100 - this.chatPaneRatio;
      boundedExecFileSync(
        'tmux', ['split-window', '-t', this.sessionName, '-v', '-p', String(statusPercent), statusCommand],
        'quick',
        { stdio: 'pipe' }
      );

      // Select the top pane (chat) as active
      boundedExecFileSync('tmux', ['select-pane', '-t', `${this.sessionName}:0.0`], 'quick', { stdio: 'pipe' });

      this.emit('session:created', { sessionName: this.sessionName });
      return true;
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${err.message}`);
    }
  }

  /**
   * Attach to the existing session
   * @param {boolean} readonly - Attach in read-only mode
   */
  attach(readonly = false) {
    if (!this.sessionExists()) {
      throw new Error(`Session "${this.sessionName}" does not exist. Use createSession() first.`);
    }

    // Use spawn to attach interactively
    const proc = spawn('tmux', ['attach-session', '-t', this.sessionName, ...(readonly ? ['-r'] : [])], {
      stdio: 'inherit',
    });

    return new Promise((resolve, reject) => {
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`tmux attach exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to attach to tmux: ${err.message}`));
      });
    });
  }

  /**
   * Send text to a specific pane
   * @param {number} pane - Pane index (0 = chat, 1 = status)
   * @param {string} text - Text to send
   * @param {boolean} enter - Whether to send Enter after text
   */
  sendToPane(pane, text, enter = true) {
    if (!this.sessionExists()) {
      throw new Error(`Session "${this.sessionName}" does not exist`);
    }

    const target = `${this.sessionName}:0.${pane}`;

    try {
      boundedExecFileSync(
        'tmux', ['send-keys', '-t', target, '-l', '--', text],
        'quick',
        { stdio: 'pipe' }
      );
      if (enter) boundedExecFileSync('tmux', ['send-keys', '-t', target, 'Enter'], 'quick', { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Failed to send to pane ${pane}: ${err.message}`);
    }
  }

  /**
   * Update the status pane content
   * @param {string} content - Status text to display
   */
  updateStatusPane(content) {
    if (!this.sessionExists()) return;

    const target = `${this.sessionName}:0.1`;
    try {
      // Clear pane and write new content
      boundedExecFileSync('tmux', ['send-keys', '-t', target, 'C-c'], 'quick', { stdio: 'pipe' });
      boundedExecFileSync('tmux', ['send-keys', '-t', target, 'C-l'], 'quick', { stdio: 'pipe' });

      // Write each line
      const lines = content.split('\n');
      for (const line of lines) {
        boundedExecFileSync(
          'tmux', ['send-keys', '-t', target, '-l', '--', line],
          'quick',
          { stdio: 'pipe' }
        );
        boundedExecFileSync('tmux', ['send-keys', '-t', target, 'Enter'], 'quick', { stdio: 'pipe' });
      }
    } catch {
      // Status update failure is non-critical
    }
  }

  /**
   * Start auto-refreshing the status pane
   * @param {function} statusFn - Function that returns status text
   */
  startStatusRefresh(statusFn) {
    this.stopStatusRefresh();

    this.statusTimer = setInterval(() => {
      try {
        const content = statusFn();
        this.updateStatusPane(content);
      } catch {
        // Non-critical
      }
    }, this.statusRefreshMs);
  }

  /**
   * Stop auto-refreshing the status pane
   */
  stopStatusRefresh() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /**
   * Kill the tmux session
   */
  killSession() {
    this.stopStatusRefresh();

    if (!this.sessionExists()) return;

    try {
      boundedExecFileSync('tmux', ['kill-session', '-t', this.sessionName], 'quick', { stdio: 'pipe' });
      this.emit('session:killed', { sessionName: this.sessionName });
    } catch (err) {
      throw new Error(`Failed to kill session: ${err.message}`);
    }
  }

  /**
   * List all tmux sessions
   */
  listSessions() {
    try {
      const output = boundedExecFileSync('tmux', ['list-sessions', '-F', '#{session_name}:#{session_windows}:#{session_attached}'], 'quick', {
        stdio: 'pipe',
        encoding: 'utf8',
      });

      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, windows, attached] = line.split(':');
          return { name, windows: parseInt(windows, 10), attached: attached === '1' };
        });
    } catch {
      return [];
    }
  }

  /**
   * Get pane info for the session
   */
  getPaneInfo() {
    if (!this.sessionExists()) return null;

    try {
      const output = boundedExecFileSync(
        'tmux', ['list-panes', '-t', this.sessionName, '-F', '#{pane_index}:#{pane_width}x#{pane_height}:#{pane_active}'],
        'quick',
        { stdio: 'pipe', encoding: 'utf8' }
      );

      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [index, size, active] = line.split(':');
          const [width, height] = size.split('x');
          return {
            index: parseInt(index, 10),
            width: parseInt(width, 10),
            height: parseInt(height, 10),
            active: active === '1',
          };
        });
    } catch {
      return null;
    }
  }
}

/**
 * Generate a status dashboard string
 * @param {object} supervisor - AgentSupervisor instance
 * @param {object} replChat - REPLChat instance
 */
export function formatStatusDashboard(supervisor, replChat) {
  const lines = [];
  const now = new Date().toISOString().slice(11, 19);

  lines.push(`╔════════════════════════════════════════╗`);
  lines.push(`║  AIWG Daemon Status    ${now}   ║`);
  lines.push(`╠════════════════════════════════════════╣`);

  if (supervisor) {
    const status = supervisor.getStatus();
    lines.push(`║ Agents: ${status.running} running / ${status.queued} queued   `);
    lines.push(`║ Max concurrent: ${status.maxConcurrency}              `);

    if (status.tasks.running.length > 0) {
      lines.push(`╠────────────────────────────────────────╣`);
      lines.push(`║ Running Tasks:                         `);
      for (const t of status.tasks.running) {
        const prompt = t.prompt.slice(0, 35).padEnd(35);
        lines.push(`║  ${t.id}: ${prompt}`);
      }
    }

    if (status.tasks.queued.length > 0) {
      lines.push(`╠────────────────────────────────────────╣`);
      lines.push(`║ Queued Tasks:                          `);
      for (const t of status.tasks.queued) {
        const prompt = t.prompt.slice(0, 35).padEnd(35);
        lines.push(`║  ${t.id}: ${prompt}`);
      }
    }
  }

  if (replChat) {
    lines.push(`╠────────────────────────────────────────╣`);
    lines.push(`║ Chat: ${replChat.isProcessing ? 'Processing...' : 'Ready'}   Queue: ${replChat.queueSize}    `);
    lines.push(`║ History: ${replChat.getHistory().length} messages              `);
  }

  lines.push(`╚════════════════════════════════════════╝`);

  return lines.join('\n');
}
