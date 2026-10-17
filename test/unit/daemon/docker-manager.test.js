import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContainerManager } from '../../../tools/docker/container-manager.mjs';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue('abc123'),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    // The implementation resolver reads the real package manifest via named
    // fs exports; ContainerManager's default fs import stays mocked above.
    existsSync: actual.existsSync,
    writeFileSync: vi.fn(),
    readFileSync: actual.readFileSync,
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';

describe('ContainerManager', () => {
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish fs mocks after clearMocks resets them
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('abc123');
    manager = new ContainerManager({
      projectDir: '/home/user/project',
      webPort: 7474,
    });
  });

  describe('isDockerAvailable', () => {
    it('returns true when docker info succeeds', () => {
      execFileSync.mockReturnValue('');
      expect(manager.isDockerAvailable()).toBe(true);
    });

    it('returns false when docker info fails', () => {
      execFileSync.mockImplementation(() => { throw new Error('not found'); });
      expect(manager.isDockerAvailable()).toBe(false);
    });
  });

  describe('ensureImage', () => {
    it('skips build when image exists', () => {
      // First call: docker image inspect succeeds
      execFileSync.mockReturnValue('');
      manager.ensureImage();
      // Only the inspect call, no build
      expect(execFileSync).toHaveBeenCalledTimes(1);
    });

    it('builds image when not present', () => {
      let callCount = 0;
      execFileSync.mockImplementation((file, args) => {
        callCount++;
        if (callCount === 1 && args.join(' ').includes('image inspect')) {
          throw new Error('not found');
        }
        return '';
      });

      manager.ensureImage();
      expect(execFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('status', () => {
    it('returns running status', () => {
      execFileSync.mockReturnValue('true healthy');
      const status = manager.status();
      expect(status.running).toBe(true);
      expect(status.health).toBe('healthy');
    });

    it('returns not running when docker inspect fails', () => {
      execFileSync.mockImplementation(() => { throw new Error('not found'); });
      const status = manager.status();
      expect(status.running).toBe(false);
      expect(status.containerId).toBeNull();
    });
  });

  describe('stop', () => {
    it('stops and removes container', () => {
      manager.stop();
      // Should call docker stop and docker rm
      expect(execFileSync).toHaveBeenCalledTimes(2);
    });

    it('handles non-existent container gracefully', () => {
      execFileSync.mockImplementation(() => { throw new Error('not found'); });
      // Should not throw
      expect(() => manager.stop()).not.toThrow();
    });
  });

  describe('literal Docker arguments', () => {
    const literal = 'project space; $(touch injected)';

    it('passes image and build context without shell interpretation', () => {
      const custom = new ContainerManager({
        projectDir: literal,
        imageName: 'custom image; echo injected',
        imageTag: 'tag with spaces',
        dockerConfig: { buildContext: literal },
      });
      execFileSync.mockImplementation((file, args) => {
        if (args[0] === 'image') throw new Error('not found');
        return '';
      });
      custom.ensureImage();
      expect(execFileSync.mock.calls[0].slice(0, 2)).toEqual([
        'docker', ['image', 'inspect', 'custom image; echo injected:tag with spaces'],
      ]);
      const build = execFileSync.mock.calls[1];
      expect(build[0]).toBe('docker');
      expect(build[1].slice(0, 2)).toEqual(['build', '-f']);
      expect(build[1].slice(3)).toEqual(['-t', 'custom image; echo injected:tag with spaces', literal]);
      expect(build[2].timeout).toBe(600_000);
    });

    it('passes run options and existing-container filter as separate arguments', () => {
      const custom = new ContainerManager({
        projectDir: literal,
        imageName: 'custom',
        dockerConfig: {
          restart_policy: 'policy; echo injected',
          resources: { memory: '1g; echo injected', cpus: '2' },
          env_file: '.env with spaces',
          volumes: [{ source: 'extra volume', target: '/target space', mode: 'ro' }],
        },
      });
      execFileSync.mockImplementation((file, args) => args[0] === 'run' ? '  abc123456789abcdef\n' : '');
      expect(custom.start().containerId).toBe('abc123456789');
      const filter = execFileSync.mock.calls.find(([, args]) => args[0] === 'ps');
      expect(filter[1].slice(0, 3)).toEqual(['ps', '-q', '-f']);
      expect(filter[1][3]).toMatch(/^name=aiwg-daemon-/);
      const run = execFileSync.mock.calls.find(([, args]) => args[0] === 'run');
      expect(run[0]).toBe('docker');
      expect(run[1]).toContain(`${literal}:/workspace`);
      expect(run[1]).toContain('policy; echo injected');
      expect(run[1]).toContain('1g; echo injected');
      expect(run[1]).toContain('custom:latest');
      expect(run[1][run[1].indexOf('--env-file') + 1]).toMatch(/\.env with spaces$/);
      expect(run[1].some(arg => arg.endsWith('extra volume:/target space:ro'))).toBe(true);
      expect(run[2].timeout).toBe(600_000);
    });

    it('keeps inspect formatting literal and stops/removes by container name', () => {
      execFileSync.mockReturnValue('true healthy\n');
      expect(manager.status().health).toBe('healthy');
      expect(execFileSync.mock.calls[0][1].slice(0, 3)).toEqual([
        'inspect', '--format', '{{.State.Running}} {{.State.Health.Status}}',
      ]);
      const name = execFileSync.mock.calls[0][1][3];
      manager.stop();
      expect(execFileSync.mock.calls[1].slice(0, 2)).toEqual(['docker', ['stop', name]]);
      expect(execFileSync.mock.calls[1][2].timeout).toBe(15000);
      expect(execFileSync.mock.calls[2].slice(0, 2)).toEqual(['docker', ['rm', name]]);
    });
  });

  describe('constructor', () => {
    it('generates container name from project dir hash', () => {
      const m1 = new ContainerManager({ projectDir: '/path/a' });
      const m2 = new ContainerManager({ projectDir: '/path/b' });
      // Different projects get different container names
      // (we can't easily test the names without accessing private fields,
      // but we can verify construction doesn't throw)
      expect(m1).toBeDefined();
      expect(m2).toBeDefined();
    });

    it('accepts docker config overrides', () => {
      const m = new ContainerManager({
        projectDir: '/test',
        dockerConfig: {
          image: 'custom:v2',
          env_file: '.env.prod',
        },
      });
      expect(m).toBeDefined();
    });
  });
});
