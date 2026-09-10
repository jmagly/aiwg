/**
 * Tests for Watch Service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';
import { WatchService, WatchEvent } from '../../../src/cli/watch-service.ts';
import { WatchConfig } from '../../../src/cli/config-loader.ts';

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  pollIntervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

describe('WatchService', () => {
  let service: WatchService;
  let testDir: string;
  let config: WatchConfig;

  beforeEach(async () => {
    service = new WatchService();
    // Use unique temp directory per test to avoid race conditions
    testDir = resolve(process.cwd(), `test-temp-watch-${randomUUID().slice(0, 8)}`);
    await mkdir(testDir, { recursive: true });

    config = {
      enabled: true,
      // Use directory path for watching - chokidar will watch all files in it
      patterns: [testDir],
      debounce: 100,
      ignorePatterns: ['**/node_modules/**']
    };
  });

  afterEach(async () => {
    if (service.running()) {
      await service.stop();
    }
    // Give watcher time to close before cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('start/stop', () => {
    it('should start watching', async () => {
      await service.start(config.patterns, config);

      expect(service.running()).toBe(true);
    }, 5000);

    it('should stop watching', async () => {
      await service.start(config.patterns, config);
      await service.stop();

      expect(service.running()).toBe(false);
    }, 5000);

    it('should throw if starting when already running', async () => {
      await service.start(config.patterns, config);

      await expect(service.start(config.patterns, config)).rejects.toThrow(
        'already running'
      );
    }, 5000);

    it('should not throw when stopping if not running', async () => {
      await expect(service.stop()).resolves.not.toThrow();
    });
  });

  describe('file change detection', () => {
    it('should detect file additions', async () => {
      const events: WatchEvent[] = [];

      // Register callback BEFORE starting
      service.onFileChange(async (event) => {
        events.push(event);
      });

      await service.start(config.patterns, config);

      // Create file
      const filePath = resolve(testDir, 'new.md');
      await writeFile(filePath, 'Content', 'utf-8');

      await waitFor(() => events.some(event => event.type === 'add'));

      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'add')).toBe(true);
    }, 10000);

    it('should detect file changes', async () => {
      // Create file before watching
      const filePath = resolve(testDir, 'existing.md');
      await writeFile(filePath, 'Original', 'utf-8');

      const events: WatchEvent[] = [];
      // Register callback BEFORE starting
      service.onFileChange(async (event) => {
        events.push(event);
      });

      await service.start(config.patterns, config);

      // Modify file
      await writeFile(filePath, 'Modified', 'utf-8');
      await waitFor(() => events.some(event => event.type === 'change'));

      expect(events.some(e => e.type === 'change')).toBe(true);
    }, 10000);

    it('should detect file deletions', async () => {
      const filePath = resolve(testDir, 'delete.md');
      await writeFile(filePath, 'Content', 'utf-8');

      const events: WatchEvent[] = [];
      // Register callback BEFORE starting
      service.onFileChange(async (event) => {
        events.push(event);
      });

      await service.start(config.patterns, config);

      // Delete file (use force option to avoid errors if file doesn't exist)
      await rm(filePath, { force: true });
      await waitFor(() => events.some(event => event.type === 'unlink'));

      expect(events.some(e => e.type === 'unlink')).toBe(true);
    }, 10000);
  });

  describe('debouncing', () => {
    it('should debounce rapid changes', async () => {
      const filePath = resolve(testDir, 'debounce.md');
      await writeFile(filePath, 'Initial', 'utf-8');

      let eventCount = 0;
      // Register callback BEFORE starting
      service.onFileChange(async () => {
        eventCount++;
      });

      await service.start(config.patterns, config);

      // Make rapid changes
      for (let i = 0; i < 5; i++) {
        await writeFile(filePath, `Content ${i}`, 'utf-8');
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      await waitFor(() => eventCount > 0);

      // Should have processed only once (debounced)
      expect(eventCount).toBe(1);
    }, 10000);

    it('should respect custom debounce time', async () => {
      const filePath = resolve(testDir, 'custom-debounce.md');
      await writeFile(filePath, 'Initial', 'utf-8');

      let processed = false;
      // Register callback BEFORE starting
      service.onFileChange(async () => {
        processed = true;
      });

      // Use 500ms debounce
      config.debounce = 500;
      await service.start(config.patterns, config);

      await writeFile(filePath, 'Modified', 'utf-8');

      // With awaitWriteFinish (200ms stability) + 500ms debounce,
      // wait 400ms - should not be processed yet
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(processed).toBe(false);

      // Chokidar event delivery can be delayed under full-suite CI load. Wait for
      // the debounced callback instead of assuming it arrives in a fixed window.
      await waitFor(() => processed);
      expect(processed).toBe(true);
    }, 10000);

    it('should throw on negative debounce', () => {
      expect(() => service.debounce(-100)).toThrow('must be >= 0');
    });
  });

  // Callback/statistics contracts use a controlled transport boundary. Real
  // filesystem add/change/unlink and debounce qualification remain above.
  async function withControlledWatcher(
    check: (watcher: EventEmitter, emit: (type: WatchEvent['type'], name: string) => Promise<WatchEvent>) => Promise<void>
  ): Promise<void> {
    const watcher = Object.assign(new EventEmitter(), {
      getWatched: () => ({ [testDir]: ['existing.md'] }),
      close: async () => {},
    });
    const watch = vi.spyOn(chokidar, 'watch').mockReturnValue(
      watcher as unknown as ReturnType<typeof chokidar.watch>
    );
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const started = service.start(config.patterns, config);
      watcher.emit('ready');
      await started;
      await check(watcher, async (type, name) => {
        const path = resolve(testDir, name);
        const timestamp = new Date(Date.now() + config.debounce);
        watcher.emit(type, path);
        await vi.advanceTimersByTimeAsync(config.debounce);
        return { type, path, timestamp };
      });
    } finally {
      try {
        await service.stop();
      } finally {
        watch.mockRestore();
        vi.useRealTimers();
      }
    }
  }

  describe('callbacks', () => {
    it('should call registered callbacks', async () => {
      const callback1 = vi.fn(async (_event: WatchEvent) => {});
      const callback2 = vi.fn(async (_event: WatchEvent) => {});
      service.onFileChange(callback1);
      service.onFileChange(callback2);
      await withControlledWatcher(async (watcher) => {
        const path = resolve(testDir, 'callback.md');
        const timestamp = new Date(Date.now() + config.debounce);
        watcher.emit('add', path);
        await vi.advanceTimersByTimeAsync(config.debounce - 1);
        expect(callback1).not.toHaveBeenCalled();
        expect(callback2).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const expected = { type: 'add', path, timestamp };
        expect(callback1).toHaveBeenCalledExactlyOnceWith(expected);
        expect(callback2).toHaveBeenCalledExactlyOnceWith(expected);
        expect(callback2.mock.calls[0][0]).toBe(callback1.mock.calls[0][0]);
        expect(service.getStats().eventsProcessed).toBe(1);
      });
    }, 10000);

    it('should remove callbacks', async () => {
      const removed = vi.fn(async (_event: WatchEvent) => {});
      const retained = vi.fn(async (_event: WatchEvent) => {});
      service.onFileChange(removed);
      service.onFileChange(retained);
      service.removeCallback(removed);
      await withControlledWatcher(async (_watcher, emit) => {
        const expected = await emit('add', 'removed.md');
        expect(removed).not.toHaveBeenCalled();
        expect(retained).toHaveBeenCalledExactlyOnceWith(expected);
        expect(service.getStats().eventsProcessed).toBe(1);
      });
    }, 10000);

    it('should handle callback errors gracefully', async () => {
      const failure = new Error('Callback error');
      const failing = vi.fn(async (_event: WatchEvent) => { throw failure; });
      const following = vi.fn(async (_event: WatchEvent) => {});
      service.onFileChange(failing);
      service.onFileChange(following);
      await withControlledWatcher(async (_watcher, emit) => {
        const expected = await emit('add', 'error.md');
        expect(failing).toHaveBeenCalledExactlyOnceWith(expected);
        expect(following).toHaveBeenCalledExactlyOnceWith(expected);
        expect(following.mock.calls[0][0]).toBe(failing.mock.calls[0][0]);
        expect(service.running()).toBe(true);
        expect(service.getStats()).toMatchObject({ eventsProcessed: 1, errors: 1 });
      });
    }, 10000);
  });

  describe('statistics', () => {
    it('should track events processed', async () => {
      const callback = vi.fn(async (_event: WatchEvent) => {});
      service.onFileChange(callback);
      await withControlledWatcher(async (_watcher, emit) => {
        expect(service.getStats()).toMatchObject({ eventsProcessed: 0, errors: 0 });
        const first = await emit('add', 'stats.md');
        expect(service.getStats()).toMatchObject({ eventsProcessed: 1, errors: 0, lastEvent: first.timestamp });
        const second = await emit('change', 'stats.md');
        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenNthCalledWith(1, first);
        expect(callback).toHaveBeenNthCalledWith(2, second);
        expect(service.getStats()).toMatchObject({ eventsProcessed: 2, errors: 0, lastEvent: second.timestamp });
      });
    }, 10000);

    it('should track errors', async () => {
      const failing = vi.fn(async (_event: WatchEvent) => { throw new Error('Test error'); });
      service.onFileChange(failing);
      await withControlledWatcher(async (_watcher, emit) => {
        expect(service.getStats().errors).toBe(0);
        await emit('add', 'error-stats.md');
        expect(service.getStats()).toMatchObject({ eventsProcessed: 1, errors: 1 });
        await emit('change', 'error-stats.md');
        expect(failing).toHaveBeenCalledTimes(2);
        expect(service.getStats()).toMatchObject({ eventsProcessed: 2, errors: 2 });
      });
    }, 10000);

    it('should reset statistics', async () => {
      service.onFileChange(async () => { throw new Error('Reset precondition'); });
      await withControlledWatcher(async (_watcher, emit) => {
        const event = await emit('add', 'reset.md');
        expect(service.getStats()).toMatchObject({
          filesWatched: 1, eventsProcessed: 1, errors: 1, lastEvent: event.timestamp,
        });
        await vi.advanceTimersByTimeAsync(1);
        const resetAt = new Date();
        service.resetStats();
        expect(service.getStats()).toEqual({
          filesWatched: 1, eventsProcessed: 0, errors: 0,
          startTime: resetAt, lastEvent: undefined,
        });
      });
    }, 10000);
  });

  describe('pattern management', () => {
    it('should add pattern', async () => {
      await service.start([testDir], config);

      service.addPattern(resolve(testDir, 'subdir'));

      // Pattern should be watched
      expect(service.running()).toBe(true);
    }, 5000);

    it('should remove pattern', async () => {
      await service.start([testDir], config);

      service.removePattern(testDir);

      expect(service.running()).toBe(true);
    }, 5000);

    it('should throw when adding pattern if not running', () => {
      expect(() => service.addPattern('*.md')).toThrow('not running');
    });

    it('should throw when removing pattern if not running', () => {
      expect(() => service.removePattern('*.md')).toThrow('not running');
    });
  });

  describe('getWatchedFiles', () => {
    it('should return empty array when not running', () => {
      const files = service.getWatchedFiles();

      expect(files).toEqual([]);
    });

    it('should return watched files', async () => {
      await writeFile(resolve(testDir, 'watched.md'), 'Content', 'utf-8');

      await service.start(config.patterns, config);

      const files = service.getWatchedFiles();

      expect(files).toContain(resolve(testDir, 'watched.md'));
    }, 5000);
  });

  describe('running', () => {
    it('should return false when not started', () => {
      expect(service.running()).toBe(false);
    });

    it('should return true when running', async () => {
      await service.start(config.patterns, config);

      expect(service.running()).toBe(true);
    }, 5000);

    it('should return false after stop', async () => {
      await service.start(config.patterns, config);
      await service.stop();

      expect(service.running()).toBe(false);
    }, 5000);
  });
});
