/**
 * Tests for Watch Service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
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

  describe('callbacks', () => {
    it('should call registered callbacks', async () => {
      let callback1Called = false;
      let callback2Called = false;

      // Register callbacks BEFORE starting
      service.onFileChange(async () => {
        callback1Called = true;
      });
      service.onFileChange(async () => {
        callback2Called = true;
      });

      await service.start(config.patterns, config);

      const filePath = resolve(testDir, 'callback.md');
      await writeFile(filePath, 'Content', 'utf-8');
      await waitFor(() => callback1Called && callback2Called);

      expect(callback1Called).toBe(true);
      expect(callback2Called).toBe(true);
    }, 10000);

    it('should remove callbacks', async () => {
      let callbackCalled = false;
      const callback = async () => {
        callbackCalled = true;
      };

      service.onFileChange(callback);
      service.removeCallback(callback);

      await service.start(config.patterns, config);

      const filePath = resolve(testDir, 'removed.md');
      await writeFile(filePath, 'Content', 'utf-8');
      await waitFor(() => service.getStats().eventsProcessed > 0);

      expect(callbackCalled).toBe(false);
    }, 10000);

    it('should handle callback errors gracefully', async () => {
      let errorThrown = false;

      // Register callback BEFORE starting
      service.onFileChange(async () => {
        errorThrown = true;
        throw new Error('Callback error');
      });

      await service.start(config.patterns, config);

      const filePath = resolve(testDir, 'error.md');
      await writeFile(filePath, 'Content', 'utf-8');
      await waitFor(() => errorThrown && service.getStats().errors > 0);

      // Should not crash the service
      expect(service.running()).toBe(true);

      // Verify the callback was actually invoked
      expect(errorThrown).toBe(true);

      const stats = service.getStats();
      expect(stats.errors).toBeGreaterThan(0);
    }, 10000);
  });

  describe('statistics', () => {
    it('should track events processed', async () => {
      // Register callback BEFORE starting (even if empty, to track events)
      service.onFileChange(async () => {});

      await service.start(config.patterns, config);

      const filePath = resolve(testDir, 'stats.md');
      await writeFile(filePath, 'Content', 'utf-8');
      await waitFor(() => service.getStats().eventsProcessed > 0);

      const stats = service.getStats();
      expect(stats.eventsProcessed).toBeGreaterThan(0);
    }, 10000);

    it('should track errors', async () => {
      // Register callback BEFORE starting
      service.onFileChange(async () => {
        throw new Error('Test error');
      });

      await service.start(config.patterns, config);

      const filePath = resolve(testDir, 'error-stats.md');
      await writeFile(filePath, 'Content', 'utf-8');
      await waitFor(() => service.getStats().errors > 0);

      const stats = service.getStats();
      expect(stats.errors).toBeGreaterThan(0);
    }, 10000);

    it('should reset statistics', async () => {
      // Register callback BEFORE starting
      service.onFileChange(async () => {});

      await service.start(config.patterns, config);

      const filePath = resolve(testDir, 'reset.md');
      await writeFile(filePath, 'Content', 'utf-8');
      await waitFor(() => service.getStats().eventsProcessed > 0);

      service.resetStats();

      const stats = service.getStats();
      expect(stats.eventsProcessed).toBe(0);
      expect(stats.errors).toBe(0);
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
