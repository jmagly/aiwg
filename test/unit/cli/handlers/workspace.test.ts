/**
 * Unit tests for workspace.ts handler
 * Covers status, migrate-workspace, rollback-workspace commands.
 *
 * @issue #688
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── Mocks ────────────────────────────────────────────────────

const { mockRun, mockBuildDeploymentStatusProbe } = vi.hoisted(() => ({
  mockRun: vi.fn().mockResolvedValue({ exitCode: 0 }),
  mockBuildDeploymentStatusProbe: vi.fn().mockResolvedValue({ status: 'ready' }),
}));

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: mockRun })),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn().mockResolvedValue('/mock/framework/root'),
}));

vi.mock('../../../../src/cli/services/deployment-verification.js', () => ({
  buildDeploymentStatusProbe: mockBuildDeploymentStatusProbe,
}));

import {
  statusHandler,
  wizardHandler,
  migrateWorkspaceHandler,
  rollbackWorkspaceHandler,
  workspaceHandlers,
} from '../../../../src/cli/handlers/workspace.js';

// ── Helpers ───────────────────────────────────────────────────

function makeCtx(args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: args,
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

// ── statusHandler ─────────────────────────────────────────────

describe('statusHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ exitCode: 0 });
    mockBuildDeploymentStatusProbe.mockResolvedValue({ status: 'ready' });
  });

  it('has correct metadata', () => {
    expect(statusHandler.id).toBe('status');
    expect(statusHandler.category).toBe('workspace');
    expect(statusHandler.aliases).toContain('-status');
    expect(statusHandler.aliases).toContain('--status');
    expect(typeof statusHandler.execute).toBe('function');
  });

  it('delegates to workspace-status.mjs', async () => {
    await statusHandler.execute(makeCtx());
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-status.mjs',
      [],
      expect.objectContaining({ cwd: '/mock/cwd' })
    );
  });

  it('passes --json flag through to script', async () => {
    await statusHandler.execute(makeCtx(['--json']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-status.mjs',
      ['--json'],
      expect.any(Object)
    );
  });

  it('passes --verbose flag through to script', async () => {
    await statusHandler.execute(makeCtx(['--verbose']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-status.mjs',
      ['--verbose'],
      expect.any(Object)
    );
  });

  it('does not parse --scope user as the probe project root and forwards the scope filter', async () => {
    const result = await statusHandler.execute(makeCtx(['--probe', '--scope', 'user', '--json']));
    expect(result.exitCode).toBe(0);
    expect(mockBuildDeploymentStatusProbe).toHaveBeenCalledWith(
      '/mock/cwd',
      '/mock/framework/root',
      { scope: 'user', provider: undefined, bundle: undefined },
    );
  });

  it('lets an unqualified probe discover user deployments (#4028)', async () => {
    await statusHandler.execute(makeCtx(['--probe', '--json']));
    expect(mockBuildDeploymentStatusProbe).toHaveBeenCalledWith(
      '/mock/cwd', '/mock/framework/root', { scope: undefined, provider: undefined, bundle: undefined },
    );
  });

  it('forwards an explicit probe root and deployment filters', async () => {
    await statusHandler.execute(makeCtx([
      '--probe', '/workspace', '--provider', 'codex', '--bundle', 'sdlc', '--scope', 'project', '--json',
    ]));
    expect(mockBuildDeploymentStatusProbe).toHaveBeenCalledWith(
      '/workspace',
      '/mock/framework/root',
      { scope: 'project', provider: 'codex', bundle: 'sdlc' },
    );
  });

  it('passes fleet export flags through to script', async () => {
    const args = ['--export', 'json', '--fleet-id', 'eride'];
    await statusHandler.execute(makeCtx(args));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-status.mjs',
      args,
      expect.any(Object)
    );
  });

  it('passes fleet serve flags through to script', async () => {
    const args = ['--serve', '--port', '7387'];
    await statusHandler.execute(makeCtx(args));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-status.mjs',
      args,
      expect.any(Object)
    );
  });

  it('forwards exit code from script', async () => {
    mockRun.mockResolvedValue({ exitCode: 1 });
    const result = await statusHandler.execute(makeCtx());
    expect(result.exitCode).toBe(1);
  });

  it('exits 0 on success', async () => {
    const result = await statusHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
  });
});

// ── wizardHandler ─────────────────────────────────────────────

describe('wizardHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('has correct metadata', () => {
    expect(wizardHandler.id).toBe('wizard');
    expect(wizardHandler.category).toBe('workspace');
    expect(typeof wizardHandler.execute).toBe('function');
  });

  it('delegates to wizard.mjs', async () => {
    const args = ['--dry-run', '--provider', 'codex', '--framework', 'sdlc'];
    await wizardHandler.execute(makeCtx(args));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/wizard.mjs',
      args,
      expect.objectContaining({ cwd: '/mock/cwd' })
    );
  });
});

// ── migrateWorkspaceHandler ───────────────────────────────────

describe('migrateWorkspaceHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('has correct metadata', () => {
    expect(migrateWorkspaceHandler.id).toBe('migrate-workspace');
    expect(migrateWorkspaceHandler.category).toBe('workspace');
    expect(migrateWorkspaceHandler.aliases).toContain('-migrate-workspace');
    expect(migrateWorkspaceHandler.aliases).toContain('--migrate-workspace');
  });

  it('delegates to workspace-migrate.mjs', async () => {
    await migrateWorkspaceHandler.execute(makeCtx());
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-migrate.mjs',
      [],
      expect.objectContaining({ cwd: '/mock/cwd' })
    );
  });

  it('passes --dry-run flag (no file operations)', async () => {
    await migrateWorkspaceHandler.execute(makeCtx(['--dry-run']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-migrate.mjs',
      ['--dry-run'],
      expect.any(Object)
    );
  });

  it('passes --no-backup flag', async () => {
    await migrateWorkspaceHandler.execute(makeCtx(['--no-backup']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-migrate.mjs',
      ['--no-backup'],
      expect.any(Object)
    );
  });

  it('passes --force and --yes flags', async () => {
    await migrateWorkspaceHandler.execute(makeCtx(['--force', '--yes']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-migrate.mjs',
      ['--force', '--yes'],
      expect.any(Object)
    );
  });

  it('forwards non-zero exit code (migration failed)', async () => {
    mockRun.mockResolvedValue({ exitCode: 1 });
    const result = await migrateWorkspaceHandler.execute(makeCtx());
    expect(result.exitCode).toBe(1);
  });
});

// ── rollbackWorkspaceHandler ──────────────────────────────────

describe('rollbackWorkspaceHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('has correct metadata', () => {
    expect(rollbackWorkspaceHandler.id).toBe('rollback-workspace');
    expect(rollbackWorkspaceHandler.category).toBe('workspace');
    expect(rollbackWorkspaceHandler.aliases).toContain('-rollback-workspace');
    expect(rollbackWorkspaceHandler.aliases).toContain('--rollback-workspace');
  });

  it('delegates to workspace-rollback.mjs', async () => {
    await rollbackWorkspaceHandler.execute(makeCtx());
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-rollback.mjs',
      [],
      expect.objectContaining({ cwd: '/mock/cwd' })
    );
  });

  it('passes --dry-run flag (shows what would be restored)', async () => {
    await rollbackWorkspaceHandler.execute(makeCtx(['--dry-run']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-rollback.mjs',
      ['--dry-run'],
      expect.any(Object)
    );
  });

  it('passes --list flag', async () => {
    await rollbackWorkspaceHandler.execute(makeCtx(['--list']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-rollback.mjs',
      ['--list'],
      expect.any(Object)
    );
  });

  it('passes --backup flag with value', async () => {
    await rollbackWorkspaceHandler.execute(makeCtx(['--backup', '/tmp/backup-2026']));
    expect(mockRun).toHaveBeenCalledWith(
      'tools/cli/workspace-rollback.mjs',
      ['--backup', '/tmp/backup-2026'],
      expect.any(Object)
    );
  });

  it('returns exit 1 when no backup exists (from script)', async () => {
    mockRun.mockResolvedValue({ exitCode: 1, message: 'No backup found' });
    const result = await rollbackWorkspaceHandler.execute(makeCtx());
    expect(result.exitCode).toBe(1);
  });
});

// ── workspaceHandlers array ───────────────────────────────────

describe('workspaceHandlers', () => {
  it('exports all 4 handlers', () => {
    expect(workspaceHandlers).toHaveLength(4);
    const ids = workspaceHandlers.map(h => h.id);
    expect(ids).toContain('status');
    expect(ids).toContain('wizard');
    expect(ids).toContain('migrate-workspace');
    expect(ids).toContain('rollback-workspace');
  });

  it('all handlers have required properties', () => {
    for (const handler of workspaceHandlers) {
      expect(handler.id).toBeDefined();
      expect(handler.name).toBeDefined();
      expect(handler.description).toBeDefined();
      expect(handler.category).toBe('workspace');
      expect(Array.isArray(handler.aliases)).toBe(true);
      expect(typeof handler.execute).toBe('function');
    }
  });
});
