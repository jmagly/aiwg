/**
 * Watch Service
 *
 * Monitors file system for changes and triggers workflow processing.
 * Uses chokidar for efficient file watching with debouncing.
 */

import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { WatchConfig } from './config-loader.js';

export interface WatchEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}

export type WatchCallback = (event: WatchEvent) => Promise<void>;

export interface WatchStats {
  filesWatched: number;
  eventsProcessed: number;
  errors: number;
  startTime: Date;
  lastEvent?: Date;
}

/**
 * File watching service with debouncing
 */
export class WatchService {
  private watcher: FSWatcher | null = null;
  private callbacks: WatchCallback[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs = 500;
  private stats: WatchStats;
  private isRunning = false;

  constructor() {
    this.stats = {
      filesWatched: 0,
      eventsProcessed: 0,
      errors: 0,
      startTime: new Date()
    };
  }

  /**
   * Start watching files
   */
  async start(patterns: string[], config: WatchConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('Watch service is already running');
    }

    this.debounceMs = config.debounce;

    // Configure chokidar
    this.watcher = chokidar.watch(patterns, {
      ignored: config.ignorePatterns || [],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });

    // Set up event handlers
    this.watcher.on('add', (path) => this.handleEvent('add', path));
    this.watcher.on('change', (path) => this.handleEvent('change', path));
    this.watcher.on('unlink', (path) => this.handleEvent('unlink', path));

    this.watcher.on('error', (error) => {
      this.stats.errors++;
      console.error('Watch error:', error);
    });

    this.isRunning = true;

    // Wait for ready
    await new Promise<void>((resolve) => {
      if (this.watcher) {
        this.watcher.on('ready', () => resolve());
      } else {
        resolve();
      }
    });

    // `ready` only means chokidar finished its initial scan. Because the
    // watcher runs with `ignoreInitial: true`, a file created between the scan
    // and the watch actually being armed is reported by neither — the event is
    // absent rather than late, so no caller-side wait can recover it (#2518).
    // Resolving `start()` only once every target appears in `getWatched()`
    // makes readiness mean armed.
    await this.waitUntilArmed(patterns);

    const watched = this.watcher?.getWatched() ?? {};
    this.stats.filesWatched = Object.values(watched).reduce(
      (sum, files) => sum + files.length,
      0
    );
  }

  /**
   * Poll `getWatched()` until every requested target is present, or the budget
   * expires. Bounded on purpose: a target that does not exist on disk can never
   * be armed, and `start()` must not hang waiting for one.
   *
   * The healthy path satisfies the first synchronous check and never awaits, so
   * a test that mocks the watcher under fake timers must report its targets
   * from `getWatched()` — otherwise the poll waits on a clock nothing advances.
   */
  private async waitUntilArmed(
    patterns: string[],
    timeoutMs = 500,
    pollIntervalMs = 25
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!this.allTargetsArmed(patterns)) {
      if (Date.now() >= deadline) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /** True when chokidar reports a watch covering every requested target. */
  private allTargetsArmed(patterns: string[]): boolean {
    if (!this.watcher) {
      return true;
    }

    const watched = this.watcher.getWatched();

    // chokidar keys `getWatched()` with the spelling it was given, so resolve
    // both sides before comparing.
    const armed = new Set<string>();
    for (const [dir, entries] of Object.entries(watched)) {
      const absoluteDir = path.resolve(dir);
      armed.add(absoluteDir);
      for (const entry of entries) {
        armed.add(path.join(absoluteDir, entry));
      }
    }

    // A directory target is keyed directly; a file target is listed under its
    // parent. Either spelling resolves into the same set.
    return patterns.every((pattern) => armed.has(path.resolve(pattern)));
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Clear pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.isRunning = false;
  }

  /**
   * Register callback for file changes
   */
  onFileChange(callback: WatchCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove callback
   */
  removeCallback(callback: WatchCallback): void {
    const index = this.callbacks.indexOf(callback);
    if (index > -1) {
      this.callbacks.splice(index, 1);
    }
  }

  /**
   * Set debounce time
   */
  debounce(ms: number): void {
    if (ms < 0) {
      throw new Error('Debounce time must be >= 0');
    }
    this.debounceMs = ms;
  }

  /**
   * Get watch statistics
   */
  getStats(): WatchStats {
    return { ...this.stats };
  }

  /**
   * Check if service is running
   */
  running(): boolean {
    return this.isRunning;
  }

  /**
   * Get list of watched files
   */
  getWatchedFiles(): string[] {
    if (!this.watcher) {
      return [];
    }

    const watched = this.watcher.getWatched();
    const files: string[] = [];

    for (const [dir, fileList] of Object.entries(watched)) {
      for (const file of fileList) {
        files.push(path.join(dir, file));
      }
    }

    return files;
  }

  // Private methods

  private handleEvent(type: 'add' | 'change' | 'unlink', path: string): void {
    // Clear existing timer for this path
    const existingTimer = this.debounceTimers.get(path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.processEvent(type, path);
      this.debounceTimers.delete(path);
    }, this.debounceMs);

    this.debounceTimers.set(path, timer);
  }

  private async processEvent(type: 'add' | 'change' | 'unlink', path: string): Promise<void> {
    const event: WatchEvent = {
      type,
      path,
      timestamp: new Date()
    };

    this.stats.eventsProcessed++;
    this.stats.lastEvent = event.timestamp;

    // Call all registered callbacks
    for (const callback of this.callbacks) {
      try {
        await callback(event);
      } catch (error) {
        this.stats.errors++;
        console.error(`Error processing ${path}:`, error);
      }
    }
  }

  /**
   * Add pattern to watch
   */
  addPattern(pattern: string): void {
    if (!this.watcher) {
      throw new Error('Watch service is not running');
    }
    this.watcher.add(pattern);
  }

  /**
   * Remove pattern from watch
   */
  removePattern(pattern: string): void {
    if (!this.watcher) {
      throw new Error('Watch service is not running');
    }
    this.watcher.unwatch(pattern);
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      filesWatched: this.stats.filesWatched,
      eventsProcessed: 0,
      errors: 0,
      startTime: new Date(),
      lastEvent: undefined
    };
  }
}
