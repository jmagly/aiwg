/**
 * Multi-Loop Dashboard for External Ralph
 *
 * ASCII dashboard for terminal display of multiple concurrent Ralph loops.
 * Works without TTY (static output).
 *
 * @implements @.aiwg/requirements/use-cases/UC-273-multi-loop-supervisor.md
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * @typedef {Object} LoopSummary
 * @property {string} loopId - Loop identifier
 * @property {string} status - Loop status
 * @property {number} iteration - Current iteration
 * @property {number} maxIterations - Maximum iterations
 * @property {number} progress - Progress percentage
 * @property {number} elapsed - Elapsed time in milliseconds
 * @property {string} objective - Loop objective
 */

/**
 * @typedef {Object} AggregateMetrics
 * @property {number} totalIterations - Total iterations across all loops
 * @property {number} successRate - Success rate percentage
 * @property {number} crashesToday - Crashes in last 24 hours
 * @property {number} avgProgress - Average progress percentage
 * @property {number} totalCost - Total cost in USD
 */

export class Dashboard {
  /**
   * @param {Object} config
   * @param {string} config.projectRoot - Project root directory
   */
  constructor(config) {
    this.projectRoot = config.projectRoot;
    this.loopsDir = join(this.projectRoot, '.aiwg', 'ralph', 'loops');
  }

  /**
   * Render dashboard as ASCII string
   * @returns {string} - Dashboard output
   */
  render() {
    const loops = this.getLoopsSummary();
    const metrics = this.getAggregateMetrics();

    const activeCount = loops.filter(l => l.status === 'running').length;
    const totalCount = loops.length;

    const width = 70;
    const border = '─'.repeat(width - 2);

    const lines = [
      `╭${border}╮`,
      this.centerText('External Ralph Multi-Loop Dashboard', width),
      `├${border}┤`,
      this.centerText(`Active Loops: ${activeCount}/${totalCount}`, width),
      `├${border}┤`,
      this.tableHeader(),
      `├${border}┤`,
    ];

    // Add loop rows
    if (loops.length === 0) {
      lines.push(this.centerText('No active loops', width));
    } else {
      for (const loop of loops.slice(0, 10)) { // Show max 10
        lines.push(this.formatLoopRow(loop));
      }

      if (loops.length > 10) {
        lines.push(this.centerText(`... and ${loops.length - 10} more`, width));
      }
    }

    // Add aggregate metrics
    lines.push(`├${border}┤`);
    lines.push(this.formatMetrics(metrics));
    lines.push(`╰${border}╯`);

    return lines.join('\n');
  }

  /**
   * Center text in a line
   * @param {string} text - Text to center
   * @param {number} width - Line width
   * @returns {string}
   */
  centerText(text, width) {
    if (!Number.isInteger(width) || width < 2) throw new RangeError('Dashboard width must be an integer of at least 2');
    const innerWidth = width - 2;
    const displayText = text.length > innerWidth
      ? (innerWidth >= 2 ? `${text.slice(0, innerWidth - 2)}..` : text.slice(0, innerWidth))
      : text;
    const padding = Math.floor((innerWidth - displayText.length) / 2);
    const leftPad = ' '.repeat(padding);
    const rightPad = ' '.repeat(innerWidth - displayText.length - padding);
    return `│${leftPad}${displayText}${rightPad}│`;
  }

  /**
   * Format table header
   * @returns {string}
   */
  tableHeader() {
    return '│ ID                        │ Status  │ Progress │ Elapsed   │';
  }

  /**
   * Format loop row
   * @param {LoopSummary} loop - Loop summary
   * @returns {string}
   */
  formatLoopRow(loop) {
    const id = this.truncate(loop.loopId, 24);
    const status = this.padRight(loop.status, 7);
    const progress = this.padLeft(`${loop.iteration}/${loop.maxIterations}`, 8);
    const elapsed = this.padLeft(this.formatDuration(loop.elapsed), 9);

    return `│ ${id} │ ${status} │ ${progress} │ ${elapsed} │`;
  }

  /**
   * Format aggregate metrics
   * @param {AggregateMetrics} metrics - Metrics data
   * @returns {string}
   */
  formatMetrics(metrics) {
    const text = `Aggregate: ${metrics.totalIterations} iterations │ ${metrics.successRate}% success │ ${metrics.crashesToday} crashes today`;
    return this.centerText(text, 70);
  }

  /**
   * Get summary of all loops
   * @returns {Array<LoopSummary>}
   */
  getLoopsSummary() {
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
        const startTime = new Date(state.startTime).getTime();
        const elapsed = Date.now() - startTime;
        const progress = Math.round((state.currentIteration / state.maxIterations) * 100);

        loops.push({
          loopId,
          status: state.status,
          iteration: state.currentIteration,
          maxIterations: state.maxIterations,
          progress,
          elapsed,
          objective: state.objective,
        });
      } catch {
        // Skip corrupted state files
      }
    }

    // Sort by status (running first, then paused, then others)
    const statusOrder = { running: 0, paused: 1, recovering: 2, completed: 3, failed: 4 };
    loops.sort((a, b) => {
      const aOrder = statusOrder[a.status] ?? 99;
      const bOrder = statusOrder[b.status] ?? 99;
      return aOrder - bOrder;
    });

    return loops;
  }

  /**
   * Get aggregate metrics across all loops
   * @returns {AggregateMetrics}
   */
  getAggregateMetrics() {
    const loops = this.getLoopsSummary();

    const totalIterations = loops.reduce((sum, l) => sum + l.iteration, 0);

    const completed = loops.filter(l => l.status === 'completed').length;
    const failed = loops.filter(l => l.status === 'failed').length;
    const total = completed + failed;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    const crashesToday = this.countCrashesToday();

    const avgProgress = loops.length > 0
      ? Math.round(loops.reduce((sum, l) => sum + l.progress, 0) / loops.length)
      : 0;

    const totalCost = this.calculateTotalCost(loops);

    return {
      totalIterations,
      successRate,
      crashesToday,
      avgProgress,
      totalCost,
    };
  }

  /**
   * Count crashes in last 24 hours
   * @returns {number}
   */
  countCrashesToday() {
    let count = 0;
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;

    if (!existsSync(this.loopsDir)) {
      return count;
    }

    const loopDirs = readdirSync(this.loopsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const loopId of loopDirs) {
      const crashLog = join(this.loopsDir, loopId, 'crash.log');

      if (!existsSync(crashLog)) {
        continue;
      }

      try {
        const log = readFileSync(crashLog, 'utf8');
        const lines = log.split('\n');

        for (const line of lines) {
          const match = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/);
          if (match) {
            const timestamp = new Date(match[1]).getTime();
            if (timestamp > yesterday) {
              count++;
            }
          }
        }
      } catch {
        // Skip corrupted crash logs
      }
    }

    return count;
  }

  /**
   * Calculate total cost across all loops
   * @param {Array<LoopSummary>} loops - All loops
   * @returns {number} - Total cost in USD
   */
  calculateTotalCost(loops) {
    let total = 0;

    for (const loop of loops) {
      const stateFile = join(this.loopsDir, loop.loopId, 'state.json');

      if (!existsSync(stateFile)) {
        continue;
      }

      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));

        if (state.iterations) {
          for (const iteration of state.iterations) {
            const cost = iteration.analysis?.tokenCost;
            if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
              total += cost;
            }
          }
        }
      } catch {
        // Skip
      }
    }

    return total;
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
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  }

  /**
   * Truncate string to max length
   * @param {string} str - String to truncate
   * @param {number} maxLength - Maximum length
   * @returns {string}
   */
  truncate(str, maxLength) {
    if (str.length <= maxLength) {
      return this.padRight(str, maxLength);
    }
    return str.slice(0, maxLength - 2) + '..';
  }

  /**
   * Pad string to the right
   * @param {string} str - String to pad
   * @param {number} length - Target length
   * @returns {string}
   */
  padRight(str, length) {
    return str + ' '.repeat(Math.max(0, length - str.length));
  }

  /**
   * Pad string to the left
   * @param {string} str - String to pad
   * @param {number} length - Target length
   * @returns {string}
   */
  padLeft(str, length) {
    return ' '.repeat(Math.max(0, length - str.length)) + str;
  }

  /**
   * Render dashboard and log to console
   */
  display() {
    console.log(this.render());
  }
}

export default Dashboard;
