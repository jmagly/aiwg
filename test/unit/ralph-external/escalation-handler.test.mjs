/**
 * Tests for Escalation Handler
 *
 * @implements Issue #25 - Autonomous Overseer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EscalationHandler, ESCALATION_LEVELS } from '../../../tools/ralph-external/lib/escalation-handler.mjs';
import { spawnSync } from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

describe('EscalationHandler', () => {
  let handler;

  beforeEach(() => {
    handler = new EscalationHandler({
      enableNotifications: false, // Disable for testing
      giteaTokenPath: '/tmp/fake-token',
      giteaUrl: 'https://git.example.com/api/v1',
      repo: 'owner/repo',
    });

    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultHandler = new EscalationHandler();

      expect(defaultHandler.giteaUrl).toContain('git.integrolabs.net');
      expect(defaultHandler.repo).toBe('roctinam/ai-writing-guide');
      expect(defaultHandler.enableNotifications).toBe(true);
    });

    it('should accept custom options', () => {
      expect(handler.giteaUrl).toBe('https://git.example.com/api/v1');
      expect(handler.repo).toBe('owner/repo');
      expect(handler.enableNotifications).toBe(false);
    });
  });

  describe('escalate', () => {
    it('should log escalation', async () => {
      const context = {
        loopId: 'loop-001',
        taskDescription: 'Test task',
        iterationNumber: 5,
        level: ESCALATION_LEVELS.WARNING,
        reason: 'Test warning',
        detection: { type: 'stuck', severity: 'high', message: 'Stuck loop' },
      };

      const result = await handler.escalate(ESCALATION_LEVELS.WARNING, context);

      expect(result.level).toBe(ESCALATION_LEVELS.WARNING);
      expect(result.context).toBe(context);
      expect(result.timestamp).toBeDefined();
      expect(handler.escalationLog.length).toBe(1);
    });

    it('should not create Gitea issue for INFO level', async () => {
      const context = {
        loopId: 'loop-001',
        taskDescription: 'Test',
        iterationNumber: 1,
        reason: 'Info message',
      };

      const result = await handler.escalate(ESCALATION_LEVELS.INFO, context);

      expect(result.channels).not.toContain('gitea_issue');
    });

    it('should not create Gitea issue for WARNING level', async () => {
      const context = {
        loopId: 'loop-001',
        taskDescription: 'Test',
        iterationNumber: 1,
        reason: 'Warning message',
      };

      const result = await handler.escalate(ESCALATION_LEVELS.WARNING, context);

      expect(result.channels).not.toContain('gitea_issue');
    });

    it('should attempt Gitea issue for CRITICAL level', async () => {
      // Mock successful token read
      vi.spyOn(handler, 'getGiteaToken').mockReturnValue('fake-token');

      // Mock successful curl call
      spawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          number: 123,
          html_url: 'https://git.example.com/owner/repo/issues/123',
          id: 456,
        }),
      });

      const context = {
        loopId: 'loop-001',
        taskDescription: 'Critical task',
        iterationNumber: 10,
        reason: 'Critical issue',
        detection: { type: 'resource_burn', severity: 'critical' },
      };

      const result = await handler.escalate(ESCALATION_LEVELS.CRITICAL, context);

      expect(result.channels).toContain('gitea_issue');
      expect(result.issueNumber).toBe(123);
      expect(result.issueUrl).toBeDefined();
    });

    it('should attempt Gitea issue for EMERGENCY level', async () => {
      vi.spyOn(handler, 'getGiteaToken').mockReturnValue('fake-token');

      spawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          number: 124,
          html_url: 'https://git.example.com/owner/repo/issues/124',
          id: 457,
        }),
      });

      const context = {
        loopId: 'loop-002',
        taskDescription: 'Emergency task',
        iterationNumber: 15,
        reason: 'Emergency issue',
      };

      const result = await handler.escalate(ESCALATION_LEVELS.EMERGENCY, context);

      expect(result.channels).toContain('gitea_issue');
    });

    it('should handle Gitea API errors gracefully', async () => {
      vi.spyOn(handler, 'getGiteaToken').mockReturnValue('fake-token');

      spawnSync.mockReturnValue({
        status: 1,
        stderr: 'API error',
      });

      const context = {
        loopId: 'loop-001',
        taskDescription: 'Test',
        iterationNumber: 1,
        reason: 'Test',
      };

      const result = await handler.escalate(ESCALATION_LEVELS.CRITICAL, context);

      expect(result.channels).not.toContain('gitea_issue');
      expect(result.errors).toBeDefined();
      expect(result.errors[0].channel).toBe('gitea');
    });

    it('should handle missing token gracefully', async () => {
      vi.spyOn(handler, 'getGiteaToken').mockReturnValue(null);

      const context = {
        loopId: 'loop-001',
        taskDescription: 'Test',
        iterationNumber: 1,
        reason: 'Test',
      };

      const result = await handler.escalate(ESCALATION_LEVELS.CRITICAL, context);

      expect(result.channels).not.toContain('gitea_issue');
      expect(result.errors).toBeDefined();
    });
  });

  describe('buildIssueBody', () => {
    it('should build complete issue body', () => {
      const context = {
        loopId: 'loop-001',
        taskDescription: 'Fix authentication',
        iterationNumber: 8,
        reason: 'Loop stuck',
        detection: {
          type: 'stuck',
          severity: 'critical',
          message: 'Same error 5 times',
          evidence: { repeatedError: 'NullPointerException', occurrences: 5 },
          recommendations: ['Change approach', 'Request help'],
        },
        intervention: {
          level: 'pause',
          reason: 'Critical stuck loop',
        },
      };

      const body = handler.buildIssueBody(context);

      expect(body).toContain('## Ralph Loop Overseer Alert');
      expect(body).toContain('loop-001');
      expect(body).toContain('Fix authentication');
      expect(body).toContain('**Iteration:** 8');
      expect(body).toContain('Loop stuck');
      expect(body).toContain('stuck');
      expect(body).toContain('critical');
      expect(body).toContain('Change approach');
      expect(body).toContain('Request help');
      expect(body).toContain('pause');
    });

    it('should handle minimal context', () => {
      const context = {
        loopId: 'loop-002',
        taskDescription: 'Test',
        iterationNumber: 1,
        reason: 'Test reason',
      };

      const body = handler.buildIssueBody(context);

      expect(body).toContain('loop-002');
      expect(body).toContain('Test reason');
    });
  });

  describe('sendDesktopNotification', () => {
    it('should send notification via notify-send', () => {
      spawnSync.mockReturnValue({ status: 0 });

      const context = {
        reason: 'Test warning',
        loopId: 'loop-001',
        iterationNumber: 5,
      };

      // Enable notifications temporarily
      handler.enableNotifications = true;

      handler.sendDesktopNotification(ESCALATION_LEVELS.WARNING, context);

      expect(spawnSync).toHaveBeenCalledWith(
        'notify-send',
        expect.arrayContaining([
          '--urgency', 'normal',
          '--app-name', 'Ralph Overseer',
          expect.stringContaining('WARNING'),
          expect.stringContaining('Test warning'),
        ]),
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' }
      );
    });

    it('should use critical urgency for CRITICAL level', () => {
      spawnSync.mockReturnValue({ status: 0 });

      const context = {
        reason: 'Critical issue',
        loopId: 'loop-001',
        iterationNumber: 10,
      };

      handler.enableNotifications = true;
      handler.sendDesktopNotification(ESCALATION_LEVELS.CRITICAL, context);

      expect(spawnSync).toHaveBeenCalledWith(
        'notify-send',
        expect.arrayContaining(['--urgency', 'critical']),
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' }
      );
    });

    it('should fail gracefully if notify-send unavailable', () => {
      spawnSync.mockImplementation(() => {
        throw new Error('Command not found');
      });

      const context = { reason: 'Test', loopId: 'loop-001', iterationNumber: 1 };

      handler.enableNotifications = true;

      // Should not throw
      expect(() => {
        handler.sendDesktopNotification(ESCALATION_LEVELS.INFO, context);
      }).not.toThrow();
    });
  });

  describe('getGiteaToken', () => {
    it('should return null if file does not exist', () => {
      const token = handler.getGiteaToken();
      expect(token).toBeNull();
    });

    // Note: Testing actual file read would require mocking fs
    // which is complex for ESM. In production, this is tested
    // via integration tests.
  });

  describe('getLog', () => {
    it('should return full log', () => {
      handler.escalationLog = [
        { level: ESCALATION_LEVELS.INFO },
        { level: ESCALATION_LEVELS.WARNING },
      ];

      const log = handler.getLog();

      expect(log.length).toBe(2);
    });

    it('should return limited log', () => {
      handler.escalationLog = [
        { level: ESCALATION_LEVELS.INFO },
        { level: ESCALATION_LEVELS.WARNING },
        { level: ESCALATION_LEVELS.CRITICAL },
      ];

      const log = handler.getLog(2);

      expect(log.length).toBe(2);
      expect(log[0].level).toBe(ESCALATION_LEVELS.WARNING);
      expect(log[1].level).toBe(ESCALATION_LEVELS.CRITICAL);
    });
  });

  describe('getSummary', () => {
    it('should summarize escalations', () => {
      handler.escalationLog = [
        { level: ESCALATION_LEVELS.INFO, channels: ['desktop_notification'] },
        { level: ESCALATION_LEVELS.CRITICAL, channels: ['gitea_issue', 'desktop_notification'] },
        { level: ESCALATION_LEVELS.CRITICAL, channels: ['gitea_issue'] },
      ];

      const summary = handler.getSummary();

      expect(summary.total).toBe(3);
      expect(summary.byLevel[ESCALATION_LEVELS.INFO]).toBe(1);
      expect(summary.byLevel[ESCALATION_LEVELS.CRITICAL]).toBe(2);
      expect(summary.byChannel.desktop_notification).toBe(2);
      expect(summary.byChannel.gitea_issue).toBe(2);
    });
  });

  describe('state persistence', () => {
    it('should export state', () => {
      handler.escalationLog = [{ level: ESCALATION_LEVELS.INFO }];

      const state = handler.exportState();

      expect(state.escalationLog).toEqual([{ level: ESCALATION_LEVELS.INFO }]);
    });

    it('should import state', () => {
      const state = {
        escalationLog: [{ level: ESCALATION_LEVELS.WARNING }],
      };

      handler.importState(state);

      expect(handler.escalationLog).toEqual([{ level: ESCALATION_LEVELS.WARNING }]);
    });
  });

  describe('clearLog', () => {
    it('should clear escalation log', () => {
      handler.escalationLog = [{ level: ESCALATION_LEVELS.INFO }];

      handler.clearLog();

      expect(handler.escalationLog).toEqual([]);
    });
  });
});
