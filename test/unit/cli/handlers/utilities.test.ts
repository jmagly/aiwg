/**
 * Utility Command Handlers Tests
 *
 * Tests for utility command handlers that delegate to existing scripts.
 *
 * @source @src/cli/handlers/utilities.ts
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @issue #33, #342
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock script runner
const mockRun = vi.fn().mockResolvedValue({ exitCode: 0 });

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({
    run: mockRun,
  })),
}));

// Mock channel manager
vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn().mockResolvedValue('/mock/framework/root'),
}));

// Mock install-aware update service
vi.mock('../../../../src/update/service.mjs', () => ({
  updateInstallation: vi.fn().mockResolvedValue({
    mode: 'npm',
    status: 'updated',
    changed: true,
    message: 'Updated test installation.',
  }),
}));

// Mock fs for registry reading
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.includes('registry.json')) return true;
        return actual.existsSync(p);
      }),
      readFileSync: vi.fn((p: string, enc?: string) => {
        if (typeof p === 'string' && p.includes('registry.json')) {
          return JSON.stringify({
            version: '1.0.0',
            created: '2026-01-13T00:00:00Z',
            frameworks: [
              { id: 'sdlc-complete', installed: '2026-01-13T00:00:00Z', version: '1.0.0' },
              { id: 'media-marketing-kit', installed: '2026-01-13T00:00:00Z', version: '1.0.0' },
              { id: 'team-tools-addon', installed: '2026-01-13T00:00:00Z', version: '1.0.0' },
            ],
          });
        }
        return actual.readFileSync(p, enc as BufferEncoding);
      }),
    },
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.includes('registry.json')) return true;
      return actual.existsSync(p);
    }),
    readFileSync: vi.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.includes('registry.json')) {
        return JSON.stringify({
          version: '1.0.0',
          created: '2026-01-13T00:00:00Z',
          frameworks: [
            { id: 'sdlc-complete', installed: '2026-01-13T00:00:00Z', version: '1.0.0' },
            { id: 'media-marketing-kit', installed: '2026-01-13T00:00:00Z', version: '1.0.0' },
            { id: 'team-tools-addon', installed: '2026-01-13T00:00:00Z', version: '1.0.0' },
          ],
        });
      }
      return actual.readFileSync(p, enc as BufferEncoding);
    }),
  };
});

// Mock useHandler (the singleton from use.ts)
const { mockUseExecute } = vi.hoisted(() => ({
  mockUseExecute: vi.fn().mockResolvedValue({ exitCode: 0 }),
}));
vi.mock('../../../../src/cli/handlers/use.js', () => ({
  useHandler: {
    execute: mockUseExecute,
  },
  UseHandler: vi.fn(),
}));

// Mock extension registry
vi.mock('../../../../src/extensions/registry.js', () => ({
  getRegistry: vi.fn().mockReturnValue({
    getAll: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    register: vi.fn(),
  }),
}));

vi.mock('../../../../src/extensions/deployment-registration.js', () => ({
  registerDeployedExtensions: vi.fn().mockResolvedValue(undefined),
}));

// Import handlers after mocks are set up
import {
  prefillCardsHandler,
  contributeStartHandler,
  validateMetadataHandler,
  doctorHandler,
  contextFirewallHandler,
  updateHandler,
  utilityHandlers,
} from '../../../../src/cli/handlers/utilities.js';

// Test isolation (#278/#274 fix-round): doctorHandler.execute() calls several
// real (non-mocked) checks beyond the mocked script runner — Grok Build and
// Muse native-extension inspection, Agent Skills conformance, web resource
// cache, workspace context graph, and the skill collision scan — some of
// which can read HOME/XDG-rooted config (e.g. a real ~/.config/muse-code) if
// not stubbed. Every test in this file runs under a fake HOME/USERPROFILE/
// XDG_* and with artifact-path overrides cleared, so nothing here can read
// or write the operator's real home directory.
const ISOLATED_ENV_KEYS = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
] as const;

describe('Utility Command Handlers', () => {
  let mockContext: HandlerContext;
  let savedEnv: Record<string, string | undefined>;
  const isolationRoots: string[] = [];

  beforeEach(() => {
    mockContext = {
      args: [],
      rawArgs: [],
      cwd: '/mock/cwd',
      frameworkRoot: '/mock/framework/root',
    };
    vi.clearAllMocks();
    // Restore default mock return values after clearAllMocks
    mockRun.mockResolvedValue({ exitCode: 0 });
    mockUseExecute.mockResolvedValue({ exitCode: 0 });

    savedEnv = {};
    for (const key of ISOLATED_ENV_KEYS) savedEnv[key] = process.env[key];
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-utilities-test-home-'));
    isolationRoots.push(fakeHome); // registered immediately, before anything that could throw
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.XDG_CONFIG_HOME = path.join(fakeHome, '.config');
    process.env.XDG_DATA_HOME = path.join(fakeHome, '.local', 'share');
    process.env.XDG_CACHE_HOME = path.join(fakeHome, '.cache');
    delete process.env.AIWG_ARTIFACTS_PATH;
    delete process.env.AIWG_PROJECT_ARTIFACTS_PATH;
    delete process.env.AIWG_PROJECT_AIWG_DIR;
  });

  afterEach(() => {
    for (const key of ISOLATED_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    isolationRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  describe('prefillCardsHandler', () => {
    it('should have correct metadata', () => {
      expect(prefillCardsHandler.id).toBe('prefill-cards');
      expect(prefillCardsHandler.category).toBe('utility');
      expect(prefillCardsHandler.aliases).toEqual(['-prefill-cards', '--prefill-cards']);
      expect(prefillCardsHandler.name).toBe('Prefill Cards');
      expect(prefillCardsHandler.description).toMatch(/prefill.*kanban/i);
    });

    it('should delegate to tools/cards/prefill-cards.mjs', async () => {
      await prefillCardsHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/cards/prefill-cards.mjs',
        mockContext.args,
        { cwd: mockContext.cwd }
      );
    });

    it('should pass arguments to script', async () => {
      mockContext.args = ['--board', 'test-board'];

      await prefillCardsHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/cards/prefill-cards.mjs',
        ['--board', 'test-board'],
        { cwd: mockContext.cwd }
      );
    });
  });

  describe('contributeStartHandler', () => {
    it('should have correct metadata', () => {
      expect(contributeStartHandler.id).toBe('contribute-start');
      expect(contributeStartHandler.category).toBe('utility');
      expect(contributeStartHandler.aliases).toEqual(['-contribute-start', '--contribute-start']);
      expect(contributeStartHandler.name).toBe('Start Contribution');
      expect(contributeStartHandler.description).toMatch(/contribution/i);
    });

    it('should delegate to tools/contrib/start-contribution.mjs', async () => {
      await contributeStartHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/contrib/start-contribution.mjs',
        mockContext.args,
        { cwd: mockContext.cwd }
      );
    });
  });

  describe('validateMetadataHandler', () => {
    it('should have correct metadata', () => {
      expect(validateMetadataHandler.id).toBe('validate-metadata');
      expect(validateMetadataHandler.category).toBe('utility');
      expect(validateMetadataHandler.aliases).toEqual(['-validate-metadata', '--validate-metadata']);
      expect(validateMetadataHandler.name).toBe('Validate Metadata');
      expect(validateMetadataHandler.description).toMatch(/metadata/i);
    });

    it('should delegate to tools/cli/validate-metadata.mjs with default recursive scope', async () => {
      // When invoked with no path args, validate-metadata defaults to
      // `--recursive agentic/code` so the CLI shells out without forcing
      // every user to remember the path. Test reflects that default.
      await validateMetadataHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/cli/validate-metadata.mjs',
        ['--recursive', 'agentic/code'],
        { cwd: mockContext.cwd }
      );
    });
  });

  describe('doctorHandler', () => {
    it('should have correct metadata', () => {
      expect(doctorHandler.id).toBe('doctor');
      expect(doctorHandler.category).toBe('maintenance');
      expect(doctorHandler.aliases).toEqual(['-doctor', '--doctor']);
      expect(doctorHandler.name).toBe('Doctor');
      expect(doctorHandler.description).toMatch(/health|diagnostic/i);
    });

    it('should delegate to tools/cli/doctor.mjs', async () => {
      await doctorHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/cli/doctor.mjs',
        mockContext.args,
        { cwd: mockContext.cwd }
      );
    });

    it('shows Muse native extensions when Muse is requested', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-doctor-muse-'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        mockContext.cwd = tmp;
        mockContext.args = ['--provider', 'muse'];
        await doctorHandler.execute(mockContext);
        expect(log.mock.calls.map((call) => String(call[0])).join('\n'))
          .toContain('── Muse Code native extensions ──');
      } finally {
        log.mockRestore();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('hides Muse native extensions when Muse is neither requested nor deployed', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-doctor-no-muse-'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        mockContext.cwd = tmp;
        await doctorHandler.execute(mockContext);
        expect(log.mock.calls.map((call) => String(call[0])).join('\n'))
          .not.toContain('── Muse Code native extensions ──');
      } finally {
        log.mockRestore();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    // #278 — Claude Code's own `.claude/skills/synced/` sync bucket (UUID
    // bucket dirs + manifest.json, no SKILL.md at the top level) must never
    // be reported as a colliding AIWG skill. A real skill nested one level
    // inside a container directory must still be found.
    it('does not report a non-skill container directory (synced/) as a colliding skill (#278)', async () => {
      // Cleanup registered immediately after creation, before any setup
      // that could throw and otherwise leak the temp directory.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-doctor-skill-collision-'));
      try {
        const skillsDir = path.join(tmp, '.claude', 'skills');
        fs.mkdirSync(path.join(skillsDir, 'real-skill'), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, 'real-skill', 'SKILL.md'), '---\nname: real-skill\n---\nBody.\n');
        // Claude Code bucket storage: UUID dirs with manifest.json, no
        // SKILL.md anywhere directly under `synced/` itself.
        fs.mkdirSync(path.join(skillsDir, 'synced', '.bucket-11111111-1111-1111-1111-111111111111'), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, 'synced', '.last-complete-round'), '1\n');
        // A real nested skill one level inside a container directory must
        // still be found and reported — only the container itself is exempt.
        fs.mkdirSync(path.join(skillsDir, 'synced', 'other'), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, 'synced', 'other', 'SKILL.md'), '---\nname: other\n---\nBody.\n');

        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
          mockContext.cwd = tmp;
          await doctorHandler.execute(mockContext);
          const output = log.mock.calls.map((call) => String(call[0])).join('\n');
          expect(output).toContain('── Skill collision scan ──');
          // 'synced' itself is never reported as a colliding skill name.
          expect(output).not.toContain('✗ synced:');
          // The real top-level skill and the real nested skill are still found.
          expect(output).toContain('✗ real-skill:');
          expect(output).toContain('synced/other');
        } finally {
          log.mockRestore();
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('contextFirewallHandler', () => {
    it('maps the default read-only scan to the packaged engine', async () => {
      await contextFirewallHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/security/context-memory-firewall.mjs',
        ['--package-root', mockContext.frameworkRoot],
        { cwd: mockContext.cwd },
      );
    });

    it('maps baseline planning without mutation', async () => {
      mockContext.args = ['baseline', '--plan', '--output', '.aiwg/review.json', '--json'];
      await contextFirewallHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/security/context-memory-firewall.mjs',
        ['--package-root', mockContext.frameworkRoot, '--json', '--plan-baseline=.aiwg/review.json'],
        { cwd: mockContext.cwd },
      );
    });

    it('requires explicit confirmation before a baseline write', async () => {
      mockContext.args = ['baseline', '--write'];
      const result = await contextFirewallHandler.execute(mockContext);

      expect(result.exitCode).toBe(2);
      expect(result.message).toMatch(/requires --confirm-reviewed/);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('maps a confirmed baseline write', async () => {
      mockContext.args = ['baseline', '--write', '--confirm-reviewed'];
      await contextFirewallHandler.execute(mockContext);

      expect(mockRun).toHaveBeenCalledWith(
        'tools/security/context-memory-firewall.mjs',
        ['--package-root', mockContext.frameworkRoot, '--write-baseline', '--confirm-reviewed'],
        { cwd: mockContext.cwd },
      );
    });
  });

  describe('updateHandler', () => {
    it('should have correct metadata', () => {
      expect(updateHandler.id).toBe('update');
      expect(updateHandler.category).toBe('maintenance');
      expect(updateHandler.aliases).toEqual(['-update', '--update', 'upgrade']);
      expect(updateHandler.name).toBe('Update');
      expect(updateHandler.description).toMatch(/update/i);
    });

    it('should check for updates and re-deploy installed frameworks', async () => {
      const { updateInstallation } = await import('../../../../src/update/service.mjs');

      const result = await updateHandler.execute(mockContext);

      expect(updateInstallation).toHaveBeenCalled();
      // Canonical frameworks use aliases; add-ons preserve their registry ID.
      expect(mockUseExecute).toHaveBeenCalledTimes(3);
      expect(mockUseExecute.mock.calls.map(call => call[0].args[0])).toEqual([
        'sdlc',
        'marketing',
        'team-tools-addon',
      ]);
      expect(result.exitCode).toBe(0);
    });

    it('should pass --provider to UseHandler when specified', async () => {
      mockContext.args = ['--provider', 'factory', '--skip-check'];

      await updateHandler.execute(mockContext);

      // Every installed item should include --provider factory
      for (const call of mockUseExecute.mock.calls) {
        const ctx = call[0] as HandlerContext;
        expect(ctx.args).toContain('--provider');
        expect(ctx.args).toContain('factory');
      }
    });

    it('should deploy all when --all flag is passed', async () => {
      mockContext.args = ['--all', '--skip-check'];

      await updateHandler.execute(mockContext);

      // Should call UseHandler once with 'all'
      expect(mockUseExecute).toHaveBeenCalledTimes(1);
      const callCtx = mockUseExecute.mock.calls[0][0] as HandlerContext;
      expect(callCtx.args[0]).toBe('all');
    });

    it('should return dry run info when --dry-run is passed', async () => {
      mockContext.args = ['--dry-run', '--skip-check'];

      const result = await updateHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(mockUseExecute).not.toHaveBeenCalled();
    });

    it('should handle errors from the update service gracefully', async () => {
      const { updateInstallation } = await import('../../../../src/update/service.mjs');
      (updateInstallation as any).mockRejectedValueOnce(new Error('Network error'));

      // Should still proceed with re-deployment
      const result = await updateHandler.execute(mockContext);

      expect(mockUseExecute).toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
    });

    it('should fail safely on canonical installation drift', async () => {
      const { updateInstallation } = await import('../../../../src/update/service.mjs');
      const error = Object.assign(new Error('canonical root mismatch'), { code: 'AIWG_INSTALLATION_DRIFT' });
      (updateInstallation as any).mockRejectedValueOnce(error);

      const result = await updateHandler.execute(mockContext);

      expect(result.exitCode).toBe(78);
      expect(result.message).toContain('canonical root mismatch');
      expect(mockUseExecute).not.toHaveBeenCalled();
    });

    it('should skip update check when --skip-check is passed', async () => {
      const { updateInstallation } = await import('../../../../src/update/service.mjs');
      mockContext.args = ['--skip-check'];

      await updateHandler.execute(mockContext);

      expect(updateInstallation).not.toHaveBeenCalled();
      expect(mockUseExecute).toHaveBeenCalled();
    });

    it('should report failure when a framework fails to re-deploy', async () => {
      mockContext.args = ['--skip-check'];
      mockUseExecute
        .mockResolvedValueOnce({ exitCode: 0 })  // sdlc succeeds
        .mockResolvedValueOnce({ exitCode: 1 })  // marketing fails
        .mockResolvedValueOnce({ exitCode: 0 }); // add-on succeeds

      const result = await updateHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/marketing/);
    });
  });

  describe('utilityHandlers array', () => {
    it('should export all utility handlers', () => {
      expect(utilityHandlers).toHaveLength(6);

      const handlerIds = utilityHandlers.map(h => h.id);
      expect(handlerIds).toContain('prefill-cards');
      expect(handlerIds).toContain('contribute-start');
      expect(handlerIds).toContain('validate-metadata');
      expect(handlerIds).toContain('doctor');
      expect(handlerIds).toContain('context-firewall');
      expect(handlerIds).toContain('update');
    });

    it('all handlers should have required properties', () => {
      utilityHandlers.forEach(handler => {
        expect(handler.id).toBeDefined();
        expect(handler.name).toBeDefined();
        expect(handler.description).toBeDefined();
        expect(handler.category).toBeDefined();
        expect(handler.aliases).toBeDefined();
        expect(Array.isArray(handler.aliases)).toBe(true);
        expect(typeof handler.execute).toBe('function');
      });
    });

    it('utility handlers should have utility category', () => {
      const utilityCategories = utilityHandlers
        .filter(h => ['prefill-cards', 'contribute-start', 'validate-metadata'].includes(h.id))
        .map(h => h.category);

      utilityCategories.forEach(category => {
        expect(category).toBe('utility');
      });
    });

    it('maintenance handlers should have maintenance category', () => {
      const maintenanceCategories = utilityHandlers
        .filter(h => ['doctor', 'context-firewall', 'update'].includes(h.id))
        .map(h => h.category);

      maintenanceCategories.forEach(category => {
        expect(category).toBe('maintenance');
      });
    });
  });

  describe('handler aliases', () => {
    it('should have short and long form aliases', () => {
      utilityHandlers.forEach(handler => {
        expect(handler.aliases.length).toBeGreaterThan(0);

        // Should have at least one short form (-) and one long form (--)
        const hasShortForm = handler.aliases.some(a => a.startsWith('-') && !a.startsWith('--'));
        const hasLongForm = handler.aliases.some(a => a.startsWith('--'));

        expect(hasShortForm || hasLongForm).toBe(true);
      });
    });
  });
});
