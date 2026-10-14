import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process');

import { execFileSync, spawn } from 'node:child_process';
import { TmuxManager, formatStatusDashboard } from '../../../tools/daemon/tmux-manager.mjs';

describe('TmuxManager', () => {
  let tmux;

  beforeEach(() => {
    vi.clearAllMocks();
    execFileSync.mockImplementation(() => '');
    tmux = new TmuxManager();
  });

  afterEach(() => {
    if (tmux.statusTimer) {
      clearInterval(tmux.statusTimer);
    }
  });

  describe('constructor', () => {
    it('should use default values when no options provided', () => {
      const manager = new TmuxManager();

      expect(manager.sessionName).toBe('aiwg-daemon');
      expect(manager.chatPaneRatio).toBe(70);
      expect(manager.statusRefreshMs).toBe(5000);
      expect(manager.statusTimer).toBe(null);
      expect(manager.daemonScript).toBe(null);
    });

    it('should use custom options when provided', () => {
      const manager = new TmuxManager({
        sessionName: 'custom-session',
        chatPaneRatio: 80,
        statusRefreshMs: 3000,
        daemonScript: '/custom/path/script.mjs',
      });

      expect(manager.sessionName).toBe('custom-session');
      expect(manager.chatPaneRatio).toBe(80);
      expect(manager.statusRefreshMs).toBe(3000);
      expect(manager.daemonScript).toBe('/custom/path/script.mjs');
    });

    it('should extend EventEmitter', () => {
      expect(tmux).toBeInstanceOf(EventEmitter);
    });
  });

  describe('isTmuxAvailable', () => {
    it('should return true when tmux is available', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd[0] === '-V') return 'tmux 3.3a';
        return '';
      });

      expect(tmux.isTmuxAvailable()).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith('tmux', ['-V'], { stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' });
    });

    it('should return false when tmux is not available', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd[0] === '-V') throw new Error('not found');
        return '';
      });

      expect(tmux.isTmuxAvailable()).toBe(false);
    });
  });

  describe('sessionExists', () => {
    it('should return true when session exists', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      expect(tmux.sessionExists()).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith(
        'tmux', ['has-session', '-t', 'aiwg-daemon'],
        { stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' }
      );
    });

    it('should return false when session does not exist', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      expect(tmux.sessionExists()).toBe(false);
    });

    it('should use custom session name in check', () => {
      const customTmux = new TmuxManager({ sessionName: 'custom' });
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      customTmux.sessionExists();

      expect(execFileSync).toHaveBeenCalledWith(
        'tmux', ['has-session', '-t', 'custom'],
        { stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' }
      );
    });
  });

  describe('createSession', () => {
    beforeEach(() => {
      // Mock: tmux available, session does NOT exist
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd[0] === '-V') return 'tmux 3.3a';
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });
    });

    it('should create session with chat and status panes', () => {
      tmux.createSession();

      // isTmuxAvailable (tmux -V) + sessionExists (has-session) + new-session + split-window + select-pane = 5 calls
      expect(execFileSync).toHaveBeenCalledTimes(5);

      const calls = execFileSync.mock.calls;
      // Call 0: tmux -V (isTmuxAvailable)
      expect(calls[0][1]).toEqual(['-V']);
      // Call 1: has-session (sessionExists)
      expect(calls[1][1]).toEqual(['has-session', '-t', 'aiwg-daemon']);
      // Call 2: new-session
      expect(calls[2][1]).toEqual(['new-session', '-d', '-s', 'aiwg-daemon', '-x', '200', '-y', '50', 'echo "Chat pane ready"']);
      expect(calls[2][2]).toEqual({ stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' });
      // Call 3: split-window with 30% status pane
      expect(calls[3][1]).toEqual(['split-window', '-t', 'aiwg-daemon', '-v', '-p', '30', 'echo "Status pane ready"']);
      expect(calls[3][2]).toEqual({ stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' });
      // Call 4: select-pane
      expect(calls[4][1]).toEqual(['select-pane', '-t', 'aiwg-daemon:0.0']);
    });

    it('should select chat pane as active after creation', () => {
      tmux.createSession();

      const selectCall = execFileSync.mock.calls.find(call =>
        call[1].includes('select-pane')
      );

      expect(selectCall).toBeDefined();
      expect(selectCall[1]).toEqual(['select-pane', '-t', 'aiwg-daemon:0.0']);
    });

    it('should emit session:created event and return true', () => {
      const eventSpy = vi.fn();
      tmux.on('session:created', eventSpy);

      const result = tmux.createSession();

      expect(eventSpy).toHaveBeenCalledWith({ sessionName: 'aiwg-daemon' });
      expect(result).toBe(true);
    });

    it('should throw when session already exists', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd[0] === '-V') return 'tmux 3.3a';
        if (cmd.includes('has-session')) return ''; // Session exists
        return '';
      });

      expect(() => tmux.createSession()).toThrow(
        'Session "aiwg-daemon" already exists. Use attach() instead.'
      );
    });

    it('should throw when tmux is not available', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd[0] === '-V') throw new Error('not found');
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      expect(() => tmux.createSession()).toThrow(
        'tmux is not installed. Install with: apt install tmux'
      );
    });

    it('should use custom chatCommand when provided', () => {
      tmux.createSession({ chatCommand: 'custom-command --arg' });

      const newSessionCall = execFileSync.mock.calls.find(call =>
        call[1].includes('new-session')
      );

      expect(newSessionCall[1]).toEqual(['new-session', '-d', '-s', 'aiwg-daemon', '-x', '200', '-y', '50', 'custom-command --arg']);
    });

    it('should use custom statusCommand when provided', () => {
      tmux.createSession({ statusCommand: 'custom-status --watch' });

      const splitCall = execFileSync.mock.calls.find(call =>
        call[1].includes('split-window')
      );

      expect(splitCall[1]).toEqual(['split-window', '-t', 'aiwg-daemon', '-v', '-p', '30', 'custom-status --watch']);
    });

    it('should respect custom chatPaneRatio', () => {
      const customTmux = new TmuxManager({ chatPaneRatio: 80 });
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd[0] === '-V') return 'tmux 3.3a';
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      customTmux.createSession();

      const splitCall = execFileSync.mock.calls.find(call =>
        call[1].includes('split-window')
      );

      expect(splitCall[1]).toEqual(['split-window', '-t', 'aiwg-daemon', '-v', '-p', '20', 'echo "Status pane ready"']); // 100 - 80 = 20
    });

    it('should throw wrapped error when execFileSync fails during creation', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd[0] === '-V') return 'tmux 3.3a';
        if (cmd.includes('has-session')) throw new Error('no session');
        if (cmd.includes('new-session')) throw new Error('creation failed');
        return '';
      });

      expect(() => tmux.createSession()).toThrow('Failed to create tmux session: creation failed');
    });
  });

  describe('attach', () => {
    it('should spawn tmux attach-session command and return promise', async () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const mockProc = new EventEmitter();
      spawn.mockReturnValue(mockProc);

      const promise = tmux.attach();

      expect(spawn).toHaveBeenCalledWith(
        'tmux',
        ['attach-session', '-t', 'aiwg-daemon'],
        { stdio: 'inherit' }
      );

      // Resolve the promise
      mockProc.emit('exit', 0);
      await promise;
    });

    it('should pass readonly flag when requested', async () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const mockProc = new EventEmitter();
      spawn.mockReturnValue(mockProc);

      const promise = tmux.attach(true);

      expect(spawn).toHaveBeenCalledWith(
        'tmux',
        ['attach-session', '-t', 'aiwg-daemon', '-r'],
        { stdio: 'inherit' }
      );

      mockProc.emit('exit', 0);
      await promise;
    });

    it('should not pass readonly flag when false', async () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const mockProc = new EventEmitter();
      spawn.mockReturnValue(mockProc);

      const promise = tmux.attach(false);

      const args = spawn.mock.calls[0][1];
      expect(args).not.toContain('-r');

      mockProc.emit('exit', 0);
      await promise;
    });

    it('should throw when session does not exist', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      expect(() => tmux.attach()).toThrow(
        'Session "aiwg-daemon" does not exist. Use createSession() first.'
      );
    });

    it('should resolve on exit code 0', async () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const mockProc = new EventEmitter();
      spawn.mockReturnValue(mockProc);

      const promise = tmux.attach();
      mockProc.emit('exit', 0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should reject on non-zero exit code', async () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const mockProc = new EventEmitter();
      spawn.mockReturnValue(mockProc);

      const promise = tmux.attach();
      mockProc.emit('exit', 1);

      await expect(promise).rejects.toThrow('tmux attach exited with code 1');
    });

    it('should reject on spawn error', async () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const mockProc = new EventEmitter();
      spawn.mockReturnValue(mockProc);

      const promise = tmux.attach();
      mockProc.emit('error', new Error('spawn failed'));

      await expect(promise).rejects.toThrow('Failed to attach to tmux: spawn failed');
    });
  });

  describe('sendToPane', () => {
    beforeEach(() => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });
    });

    it('should send text to specified pane with Enter', () => {
      tmux.sendToPane(0, 'test command');

      const sendCall = execFileSync.mock.calls.find(c => c[1].includes('send-keys'));
      expect(execFileSync.mock.calls.filter(c => c[1][0] === 'send-keys').map(c => c[1])).toEqual([
        ['send-keys', '-t', 'aiwg-daemon:0.0', '-l', '--', 'test command'],
        ['send-keys', '-t', 'aiwg-daemon:0.0', 'Enter'],
      ]);
      expect(sendCall[2]).toEqual({ stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' });
    });

    it('should send text without Enter when specified', () => {
      tmux.sendToPane(1, 'partial text', false);

      const sendCall = execFileSync.mock.calls.find(c => c[1].includes('send-keys'));
      expect(execFileSync.mock.calls.filter(c => c[1][0] === 'send-keys').map(c => c[1])).toEqual([
        ['send-keys', '-t', 'aiwg-daemon:0.1', '-l', '--', 'partial text'],
      ]);
      expect(sendCall[2]).toEqual({ stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' });
    });

    it('should preserve double quotes in text', () => {
      tmux.sendToPane(0, 'text with "quotes"');

      const sendCall = execFileSync.mock.calls.find(c =>
        c[1].includes('send-keys') && c[1].includes('text with "quotes"')
      );
      expect(sendCall[1]).toContain('text with "quotes"');
    });

    it('should throw when session does not exist', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      expect(() => tmux.sendToPane(0, 'test')).toThrow(
        'Session "aiwg-daemon" does not exist'
      );
    });

    it('should throw wrapped error when send-keys fails', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('send-keys')) throw new Error('send failed');
        return '';
      });

      expect(() => tmux.sendToPane(0, 'test')).toThrow('Failed to send to pane 0: send failed');
    });

    it('should support different pane indices', () => {
      const paneIndices = [0, 1, 2];

      for (const pane of paneIndices) {
        vi.clearAllMocks();
        execFileSync.mockImplementation((_file, cmd) => {
          if (cmd.includes('has-session')) return '';
          return '';
        });

        tmux.sendToPane(pane, 'test');

        const sendCall = execFileSync.mock.calls.find(c => c[1].includes('send-keys'));
        expect(sendCall[1]).toEqual(['send-keys', '-t', `aiwg-daemon:0.${pane}`, '-l', '--', 'test']);
      }
    });
  });

  describe('updateStatusPane', () => {
    beforeEach(() => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });
    });

    it('should send C-c and C-l then content lines to status pane', () => {
      tmux.updateStatusPane('Line 1\nLine 2');

      const calls = execFileSync.mock.calls.filter(c =>
        c[1].includes('send-keys') && c[1].includes('aiwg-daemon:0.1')
      );

      // Literal lines and Enter are separate commands.
      expect(calls).toHaveLength(6);
      expect(calls[0][1]).toEqual(['send-keys', '-t', 'aiwg-daemon:0.1', 'C-c']);
      expect(calls[1][1]).toEqual(['send-keys', '-t', 'aiwg-daemon:0.1', 'C-l']);
      expect(calls[2][1]).toEqual(['send-keys', '-t', 'aiwg-daemon:0.1', '-l', '--', 'Line 1']);
      expect(calls[3][1]).toEqual(['send-keys', '-t', 'aiwg-daemon:0.1', 'Enter']);
      expect(calls[4][1]).toEqual(['send-keys', '-t', 'aiwg-daemon:0.1', '-l', '--', 'Line 2']);
      expect(calls[5][1]).toEqual(['send-keys', '-t', 'aiwg-daemon:0.1', 'Enter']);
    });

    it('should send single line content', () => {
      tmux.updateStatusPane('Status: Running');

      const contentCall = execFileSync.mock.calls.find(c =>
        c[1].includes('send-keys') && c[1].includes('Status: Running')
      );
      expect(contentCall).toBeDefined();
      expect(contentCall[1]).toEqual(['send-keys', '-t', 'aiwg-daemon:0.1', '-l', '--', 'Status: Running']);
    });

    it('should return silently when session does not exist', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      // Should NOT throw
      expect(() => tmux.updateStatusPane('test')).not.toThrow();

      // Should not have called send-keys
      const sendCalls = execFileSync.mock.calls.filter(c => c[1].includes('send-keys'));
      expect(sendCalls).toHaveLength(0);
    });

    it('should silently catch errors during update', () => {
      let callCount = 0;
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        callCount++;
        if (callCount > 1) throw new Error('send failed');
        return '';
      });

      expect(() => tmux.updateStatusPane('test')).not.toThrow();
    });
  });

  describe('startStatusRefresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should create interval with correct delay', () => {
      const statusFn = vi.fn(() => 'Status');

      tmux.startStatusRefresh(statusFn);

      expect(tmux.statusTimer).not.toBe(null);
    });

    it('should call statusFn on each interval at 5000ms default', () => {
      const statusFn = vi.fn(() => 'Status');

      tmux.startStatusRefresh(statusFn);

      expect(statusFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      expect(statusFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      expect(statusFn).toHaveBeenCalledTimes(2);
    });

    it('should call updateStatusPane with statusFn result', () => {
      const statusFn = vi.fn(() => 'Current Status');

      tmux.startStatusRefresh(statusFn);
      vi.advanceTimersByTime(5000);

      const contentCall = execFileSync.mock.calls.find(c =>
        c[1].includes('send-keys') && c[1].includes('Current Status')
      );
      expect(contentCall).toBeDefined();
    });

    it('should use custom statusRefreshMs', () => {
      const customTmux = new TmuxManager({ statusRefreshMs: 2000 });
      const statusFn = vi.fn(() => 'Status');

      customTmux.startStatusRefresh(statusFn);

      vi.advanceTimersByTime(2000);
      expect(statusFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      expect(statusFn).toHaveBeenCalledTimes(2);

      customTmux.stopStatusRefresh();
    });

    it('should clear old timer when starting new refresh', () => {
      const statusFn1 = vi.fn(() => 'Status 1');
      const statusFn2 = vi.fn(() => 'Status 2');

      tmux.startStatusRefresh(statusFn1);
      const firstTimer = tmux.statusTimer;

      tmux.startStatusRefresh(statusFn2);

      expect(tmux.statusTimer).not.toBe(firstTimer);

      vi.advanceTimersByTime(5000);
      expect(statusFn1).not.toHaveBeenCalled();
      expect(statusFn2).toHaveBeenCalledTimes(1);
    });

    it('should ignore errors from statusFn', () => {
      const statusFn = vi.fn(() => {
        throw new Error('Status error');
      });

      tmux.startStatusRefresh(statusFn);

      expect(() => {
        vi.advanceTimersByTime(5000);
      }).not.toThrow();
    });

    it('should ignore errors from updateStatusPane', () => {
      const statusFn = vi.fn(() => 'Status');
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('send-keys')) throw new Error('Update error');
        return '';
      });

      tmux.startStatusRefresh(statusFn);

      expect(() => {
        vi.advanceTimersByTime(5000);
      }).not.toThrow();
    });

    it('should not update when session does not exist', () => {
      const statusFn = vi.fn(() => 'Status');
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      tmux.startStatusRefresh(statusFn);
      vi.advanceTimersByTime(5000);

      // statusFn gets called, but updateStatusPane returns early
      expect(statusFn).toHaveBeenCalledTimes(1);
      const sendCalls = execFileSync.mock.calls.filter(c => c[1].includes('send-keys'));
      expect(sendCalls).toHaveLength(0);
    });
  });

  describe('stopStatusRefresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should clear interval when timer exists', () => {
      const statusFn = vi.fn(() => 'Status');

      tmux.startStatusRefresh(statusFn);
      expect(tmux.statusTimer).not.toBe(null);

      tmux.stopStatusRefresh();

      expect(tmux.statusTimer).toBe(null);

      vi.advanceTimersByTime(10000);
      expect(statusFn).not.toHaveBeenCalled();
    });

    it('should be no-op when no timer exists', () => {
      expect(tmux.statusTimer).toBe(null);

      expect(() => {
        tmux.stopStatusRefresh();
      }).not.toThrow();

      expect(tmux.statusTimer).toBe(null);
    });
  });

  describe('killSession', () => {
    it('should kill existing session', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      tmux.killSession();

      expect(execFileSync).toHaveBeenCalledWith(
        'tmux', ['kill-session', '-t', 'aiwg-daemon'],
        { stdio: 'pipe', timeout: 30000, killSignal: 'SIGKILL' }
      );
    });

    it('should emit session:killed event', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const eventSpy = vi.fn();
      tmux.on('session:killed', eventSpy);

      tmux.killSession();

      expect(eventSpy).toHaveBeenCalledWith({ sessionName: 'aiwg-daemon' });
    });

    it('should stop status refresh before killing', () => {
      vi.useFakeTimers();
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        return '';
      });

      const statusFn = vi.fn(() => 'Status');
      tmux.startStatusRefresh(statusFn);
      expect(tmux.statusTimer).not.toBe(null);

      tmux.killSession();

      expect(tmux.statusTimer).toBe(null);

      vi.useRealTimers();
    });

    it('should return silently when session does not exist', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      // Should not throw, just return
      expect(() => tmux.killSession()).not.toThrow();
    });

    it('should throw when kill command fails', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('kill-session')) throw new Error('kill failed');
        return '';
      });

      expect(() => tmux.killSession()).toThrow('Failed to kill session: kill failed');
    });
  });

  describe('listSessions', () => {
    it('should return array of session objects', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('list-sessions')) {
          return 'session1:2:0\nsession2:1:1\naiwg-daemon:3:0\n';
        }
        return '';
      });

      const sessions = tmux.listSessions();

      expect(sessions).toEqual([
        { name: 'session1', windows: 2, attached: false },
        { name: 'session2', windows: 1, attached: true },
        { name: 'aiwg-daemon', windows: 3, attached: false },
      ]);

      expect(execFileSync).toHaveBeenCalledWith(
        'tmux', ['list-sessions', '-F', '#{session_name}:#{session_windows}:#{session_attached}'],
        { stdio: 'pipe', encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' }
      );
    });

    it('should filter out empty lines', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('list-sessions')) {
          return 'session1:1:0\n\nsession2:2:1\n\n';
        }
        return '';
      });

      const sessions = tmux.listSessions();

      expect(sessions).toEqual([
        { name: 'session1', windows: 1, attached: false },
        { name: 'session2', windows: 2, attached: true },
      ]);
    });

    it('should return empty array when no sessions exist', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('list-sessions')) {
          throw new Error('no server running');
        }
        return '';
      });

      const sessions = tmux.listSessions();

      expect(sessions).toEqual([]);
    });

    it('should return empty array on any error', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('list-sessions')) {
          throw new Error('tmux error');
        }
        return '';
      });

      const sessions = tmux.listSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe('getPaneInfo', () => {
    it('should return array of pane info objects', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('list-panes')) {
          return '0:120x40:1\n1:120x10:0\n';
        }
        return '';
      });

      const panes = tmux.getPaneInfo();

      expect(panes).toEqual([
        { index: 0, width: 120, height: 40, active: true },
        { index: 1, width: 120, height: 10, active: false },
      ]);
    });

    it('should parse dimensions correctly', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('list-panes')) {
          return '0:200x50:1\n';
        }
        return '';
      });

      const panes = tmux.getPaneInfo();

      expect(panes[0].width).toBe(200);
      expect(panes[0].height).toBe(50);
    });

    it('should parse active status correctly', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('list-panes')) {
          return '0:100x30:0\n1:100x20:1\n';
        }
        return '';
      });

      const panes = tmux.getPaneInfo();

      expect(panes[0].active).toBe(false);
      expect(panes[1].active).toBe(true);
    });

    it('should return null when session does not exist', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });

      const panes = tmux.getPaneInfo();

      expect(panes).toBe(null);
    });

    it('should return null on error', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('list-panes')) throw new Error('pane error');
        return '';
      });

      const panes = tmux.getPaneInfo();

      expect(panes).toBe(null);
    });

    it('should call execFileSync with correct session name', () => {
      execFileSync.mockImplementation((_file, cmd) => {
        if (cmd.includes('has-session')) return '';
        if (cmd.includes('list-panes')) return '0:100x30:1\n';
        return '';
      });

      tmux.getPaneInfo();

      const listPanesCall = execFileSync.mock.calls.find(c =>
        c[1].includes('list-panes')
      );
      expect(listPanesCall[1]).toEqual(['list-panes', '-t', 'aiwg-daemon', '-F', '#{pane_index}:#{pane_width}x#{pane_height}:#{pane_active}']);
    });
  });

  describe('formatStatusDashboard', () => {
    it('should format dashboard with supervisor only', () => {
      const supervisor = {
        getStatus: () => ({
          running: 2,
          queued: 1,
          maxConcurrency: 5,
          tasks: { running: [], queued: [] },
        }),
      };

      const result = formatStatusDashboard(supervisor, null);

      expect(result).toContain('AIWG Daemon Status');
      expect(result).toContain('Agents: 2 running / 1 queued');
      expect(result).toContain('Max concurrent: 5');
      expect(result).not.toContain('Chat:');
    });

    it('should format dashboard with replChat only', () => {
      const replChat = {
        isProcessing: true,
        queueSize: 3,
        getHistory: () => [{ role: 'user' }, { role: 'assistant' }],
      };

      const result = formatStatusDashboard(null, replChat);

      expect(result).toContain('AIWG Daemon Status');
      expect(result).toContain('Chat: Processing...');
      expect(result).toContain('Queue: 3');
      expect(result).toContain('History: 2 messages');
      expect(result).not.toContain('Agents:');
    });

    it('should format dashboard with both supervisor and replChat', () => {
      const supervisor = {
        getStatus: () => ({
          running: 1,
          queued: 0,
          maxConcurrency: 3,
          tasks: { running: [], queued: [] },
        }),
      };
      const replChat = {
        isProcessing: false,
        queueSize: 0,
        getHistory: () => [],
      };

      const result = formatStatusDashboard(supervisor, replChat);

      expect(result).toContain('Agents: 1 running / 0 queued');
      expect(result).toContain('Chat: Ready');
      expect(result).toContain('Queue: 0');
    });

    it('should show running tasks', () => {
      const supervisor = {
        getStatus: () => ({
          running: 2,
          queued: 0,
          maxConcurrency: 5,
          tasks: {
            running: [
              { id: 'task-001', prompt: 'Write a comprehensive test suite' },
              { id: 'task-002', prompt: 'Refactor authentication module' },
            ],
            queued: [],
          },
        }),
      };

      const result = formatStatusDashboard(supervisor, null);

      expect(result).toContain('Running Tasks:');
      expect(result).toContain('task-001');
      expect(result).toContain('task-002');
    });

    it('should show queued tasks', () => {
      const supervisor = {
        getStatus: () => ({
          running: 0,
          queued: 2,
          maxConcurrency: 5,
          tasks: {
            running: [],
            queued: [
              { id: 'task-003', prompt: 'Queue item 1' },
              { id: 'task-004', prompt: 'Queue item 2' },
            ],
          },
        }),
      };

      const result = formatStatusDashboard(supervisor, null);

      expect(result).toContain('Queued Tasks:');
      expect(result).toContain('task-003');
      expect(result).toContain('task-004');
    });

    it('should not show task sections when none exist', () => {
      const supervisor = {
        getStatus: () => ({
          running: 0,
          queued: 0,
          maxConcurrency: 5,
          tasks: { running: [], queued: [] },
        }),
      };

      const result = formatStatusDashboard(supervisor, null);

      expect(result).not.toContain('Running Tasks:');
      expect(result).not.toContain('Queued Tasks:');
    });

    it('should show Chat as Ready when not processing', () => {
      const replChat = {
        isProcessing: false,
        queueSize: 0,
        getHistory: () => [],
      };

      const result = formatStatusDashboard(null, replChat);

      expect(result).toContain('Chat: Ready');
    });

    it('should show Chat as Processing when active', () => {
      const replChat = {
        isProcessing: true,
        queueSize: 1,
        getHistory: () => [],
      };

      const result = formatStatusDashboard(null, replChat);

      expect(result).toContain('Chat: Processing...');
    });

    it('should create properly bordered output', () => {
      const result = formatStatusDashboard(null, null);

      expect(result).toContain('╔');
      expect(result).toContain('╚');
      // All lines should start with box drawing chars
      const lines = result.split('\n');
      for (const line of lines) {
        expect(line[0]).toMatch(/[╔╠╚║]/);
      }
    });

    it('should truncate long task prompts to 35 characters', () => {
      const supervisor = {
        getStatus: () => ({
          running: 1,
          queued: 0,
          maxConcurrency: 5,
          tasks: {
            running: [
              { id: 'task-123', prompt: 'This is a very long prompt that should be truncated at thirty five characters' },
            ],
            queued: [],
          },
        }),
      };

      const result = formatStatusDashboard(supervisor, null);

      expect(result).toContain('task-123');
      // Prompt is sliced to 35 chars
      expect(result).toContain('This is a very long prompt that sho');
    });

    it('should include timestamp in header', () => {
      const result = formatStatusDashboard(null, null);

      // Timestamp format is HH:MM:SS
      expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });
});
