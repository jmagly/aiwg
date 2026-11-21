import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Dynamic import since provider-watcher is ESM .mjs
const loadModule = async () => {
  const mod = await import('../../../tools/daemon/provider-watcher.mjs');
  return mod;
};

describe('ProviderWatcher (#615)', () => {
  let tmpDir: string;
  let ProviderWatcher: any;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pw-test-'));
    const mod = await loadModule();
    ProviderWatcher = mod.ProviderWatcher;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should initialize with defaults', () => {
      const watcher = new ProviderWatcher({ stateDir: join(tmpDir, 'state') });
      expect(watcher.providers).toHaveLength(9);
      expect(watcher.intervalHours).toBe(6);
    });

    it('should accept custom provider list', () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        providers: ['claude-code', 'cursor'],
      });
      expect(watcher.providers).toEqual(['claude-code', 'cursor']);
    });

    it('should accept custom interval', () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        intervalHours: 12,
      });
      expect(watcher.intervalHours).toBe(12);
    });
  });

  describe('state persistence', () => {
    it('should start with empty state when no state file exists', () => {
      const watcher = new ProviderWatcher({ stateDir: join(tmpDir, 'state') });
      expect(watcher.state).toEqual({ providers: {}, lastFullCheck: null });
    });

    it('should save and load state', () => {
      const stateDir = join(tmpDir, 'state');
      const watcher = new ProviderWatcher({ stateDir });

      // Modify state and save
      watcher.state.providers['claude-code'] = {
        lastCheck: '2026-01-01T00:00:00Z',
        lastSeenVersions: { 'npm:@anthropic-ai/claude-code': '1.0.0' },
        lastSeenHashes: {},
      };
      watcher.state.lastFullCheck = '2026-01-01T00:00:00Z';
      watcher.saveState();

      // Create new watcher — should load saved state
      const watcher2 = new ProviderWatcher({ stateDir });
      expect(watcher2.state.lastFullCheck).toBe('2026-01-01T00:00:00Z');
      expect(watcher2.state.providers['claude-code'].lastSeenVersions['npm:@anthropic-ai/claude-code']).toBe('1.0.0');
    });

    it('should handle corrupted state gracefully', () => {
      const stateDir = join(tmpDir, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'state.json'), 'not valid json{{{');

      const watcher = new ProviderWatcher({ stateDir });
      expect(watcher.state).toEqual({ providers: {}, lastFullCheck: null });
    });
  });

  describe('start/stop', () => {
    it('should start and stop without errors', () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        providers: ['claude-code'],
        intervalHours: 1,
      });

      // Mock checkAll to prevent actual network calls
      watcher.checkAll = vi.fn().mockResolvedValue([]);

      watcher.start();
      expect(watcher._intervalHandle).not.toBeNull();

      watcher.stop();
      expect(watcher._intervalHandle).toBeNull();
    });

    it('should be safe to call stop multiple times', () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
      });
      watcher.checkAll = vi.fn().mockResolvedValue([]);
      watcher.start();
      watcher.stop();
      watcher.stop(); // no error
      expect(watcher._intervalHandle).toBeNull();
    });

    it('should not start twice', () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
      });
      watcher.checkAll = vi.fn().mockResolvedValue([]);
      watcher.start();
      const handle = watcher._intervalHandle;
      watcher.start(); // should be no-op
      expect(watcher._intervalHandle).toBe(handle);
      watcher.stop();
    });
  });

  describe('getCronExpression', () => {
    it('should return correct cron for default 6h interval', () => {
      const watcher = new ProviderWatcher({ stateDir: join(tmpDir, 'state') });
      expect(watcher.getCronExpression()).toBe('0 */6 * * *');
    });

    it('should return correct cron for custom interval', () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        intervalHours: 12,
      });
      expect(watcher.getCronExpression()).toBe('0 */12 * * *');
    });
  });

  describe('getStatus', () => {
    it('should return status summary', () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        providers: ['claude-code', 'cursor'],
      });
      const status = watcher.getStatus();
      expect(status.watching).toEqual(['claude-code', 'cursor']);
      expect(status.intervalHours).toBe(6);
      expect(status.lastFullCheck).toBeNull();
      expect(status.providers).toEqual({});
    });

    it('should include per-provider state after check', () => {
      const watcher = new ProviderWatcher({ stateDir: join(tmpDir, 'state') });
      watcher.state.providers['cursor'] = {
        lastCheck: '2026-01-01T00:00:00Z',
        lastSeenVersions: {},
        lastSeenHashes: { 'changelog:https://cursor.com/changelog': 'abc123' },
      };

      const status = watcher.getStatus();
      expect(status.providers.cursor.lastCheck).toBe('2026-01-01T00:00:00Z');
      expect(status.providers.cursor.hashesTracked).toBe(1);
    });
  });

  describe('generatePRBody', () => {
    it('should return empty string for no changes', () => {
      expect(ProviderWatcher.generatePRBody([])).toBe('');
    });

    it('should generate structured markdown for changes', () => {
      const changes = [
        {
          provider: 'claude-code',
          displayName: 'Claude Code',
          source: 'npm',
          sourceUrl: '@anthropic-ai/claude-code',
          type: 'new-version',
          previousVersion: '1.0.0',
          newVersion: '1.1.0',
          impact: 'medium',
          summary: '@anthropic-ai/claude-code updated to 1.1.0 (was 1.0.0)',
          referenceFiles: ['.aiwg/references/platforms/claude-code.md'],
          integrationDocs: [],
          detectedAt: '2026-01-01T00:00:00Z',
        },
      ];

      const body = ProviderWatcher.generatePRBody(changes);
      expect(body).toContain('## Provider Updates Detected');
      expect(body).toContain('**Impact**: Medium');
      expect(body).toContain('### Claude Code');
      expect(body).toContain('new-version');
      expect(body).toContain('.aiwg/references/platforms/claude-code.md');
    });

    it('should flag high-impact changes for human review', () => {
      const changes = [
        {
          provider: 'cursor',
          displayName: 'Cursor',
          source: 'github-release',
          sourceUrl: 'getcursor/cursor',
          type: 'new-release',
          previousVersion: '2.0',
          newVersion: '3.0',
          impact: 'high',
          summary: 'Cursor released 3.0 (breaking changes)',
          referenceFiles: [],
          integrationDocs: [],
          detectedAt: '2026-01-01T00:00:00Z',
        },
      ];

      const body = ProviderWatcher.generatePRBody(changes);
      expect(body).toContain('**Impact**: High');
      expect(body).toContain('### Requires Human Review');
      expect(body).toContain('- [ ]');
      expect(body).toContain('Cursor');
    });
  });

  describe('getProviderSources', () => {
    it('should return all 9 provider definitions', () => {
      const sources = ProviderWatcher.getProviderSources();
      expect(sources).toHaveLength(9);
      const ids = sources.map((s: { id: string }) => s.id);
      expect(ids).toContain('claude-code');
      expect(ids).toContain('cursor');
      expect(ids).toContain('copilot');
      expect(ids).toContain('factory');
      expect(ids).toContain('devin');
      expect(ids).toContain('warp');
      expect(ids).toContain('codex');
      expect(ids).toContain('opencode');
      expect(ids).toContain('openclaw');
    });

    it('each provider should have at least one source', () => {
      const sources = ProviderWatcher.getProviderSources();
      for (const provider of sources) {
        expect(provider.sources.length, `${provider.id} has no sources`).toBeGreaterThan(0);
      }
    });
  });

  describe('getAutomationRule', () => {
    it('should return a valid automation rule definition', () => {
      const rule = ProviderWatcher.getAutomationRule();
      expect(rule.id).toBe('provider-watch-pr');
      expect(rule.trigger.source).toBe('provider-watch');
      expect(rule.trigger.type).toBe('provider.changes');
      expect(rule.action.type).toBe('agent');
      expect(rule.action.agent).toBe('aiwg-steward');
      expect(rule.action.prompt).toContain('Provider platform changes');
      expect(rule.requiresApproval).toBe(false);
      expect(rule.cooldownMs).toBeGreaterThan(0);
    });

    it('should have a 6-hour cooldown matching default interval', () => {
      const rule = ProviderWatcher.getAutomationRule();
      expect(rule.cooldownMs).toBe(6 * 60 * 60 * 1000);
    });
  });

  describe('checkAll (with mocked sources)', () => {
    it('should emit changes-detected when changes found', async () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        providers: ['claude-code'],
      });

      // Mock checkProvider to return a fake change
      watcher.checkProvider = vi.fn().mockResolvedValue([
        {
          provider: 'claude-code',
          displayName: 'Claude Code',
          type: 'new-version',
          summary: 'test change',
          impact: 'low',
        },
      ]);

      const changesPromise = new Promise((resolve) => {
        watcher.on('changes-detected', resolve);
      });

      const changes = await watcher.checkAll();
      expect(changes).toHaveLength(1);

      const event = await changesPromise as { changes: unknown[]; timestamp: string };
      expect(event.changes).toHaveLength(1);
      expect(event.timestamp).toBeDefined();
    });

    it('should not emit when no changes found', async () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        providers: ['claude-code'],
      });

      watcher.checkProvider = vi.fn().mockResolvedValue([]);

      let emitted = false;
      watcher.on('changes-detected', () => { emitted = true; });

      await watcher.checkAll();
      expect(emitted).toBe(false);
    });

    it('should emit error and continue when a provider fails', async () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        providers: ['claude-code', 'cursor'],
      });

      let callCount = 0;
      watcher.checkProvider = vi.fn().mockImplementation(async (provider: { id: string }) => {
        callCount++;
        if (provider.id === 'claude-code') {
          throw new Error('Network timeout');
        }
        return [];
      });

      const errors: Array<{ provider: string; error: string }> = [];
      watcher.on('error', (e: { provider: string; error: string }) => errors.push(e));

      await watcher.checkAll();
      expect(callCount).toBe(2); // both providers attempted
      expect(errors).toHaveLength(1);
      expect(errors[0].provider).toBe('claude-code');
    });

    it('should update lastFullCheck timestamp', async () => {
      const watcher = new ProviderWatcher({
        stateDir: join(tmpDir, 'state'),
        providers: ['claude-code'],
      });
      watcher.checkProvider = vi.fn().mockResolvedValue([]);

      expect(watcher.state.lastFullCheck).toBeNull();
      await watcher.checkAll();
      expect(watcher.state.lastFullCheck).toBeDefined();
    });
  });
});
