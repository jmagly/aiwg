/**
 * Unit tests for refresh.ts handler (formerly sync)
 *
 * @issue #685, #694
 * @parent #684
 * @issue #173, #174
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── Mocks ────────────────────────────────────────────────────

const {
  mockRun, mockUseExecute, mockRefreshAllPackages, mockReadAiwgConfig, mockHashManifest,
  mockWriteAiwgConfig,
} = vi.hoisted(() => ({
  mockRun: vi.fn().mockResolvedValue({ exitCode: 0 }),
  mockUseExecute: vi.fn().mockResolvedValue({ exitCode: 0 }),
  mockRefreshAllPackages: vi.fn().mockResolvedValue([]),
  mockReadAiwgConfig: vi.fn().mockResolvedValue(null),
  mockHashManifest: vi.fn().mockResolvedValue(null),
  mockWriteAiwgConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: mockRun })),
}));

vi.mock('../../../../src/cli/handlers/use.js', () => ({
  createUseHandler: vi.fn(() => ({ execute: mockUseExecute })),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn().mockResolvedValue('/mock/framework/root'),
}));

vi.mock('../../../../src/packages/registry.js', () => ({
  refreshAllPackages: mockRefreshAllPackages,
}));

vi.mock('../../../../src/config/aiwg-config.js', () => ({
  readAiwgConfig: mockReadAiwgConfig,
  hashManifest: mockHashManifest,
  writeAiwgConfig: mockWriteAiwgConfig,
  getProviderParallelismDefaults: vi.fn(() => ({
    max_parallel_subagents: 4,
    max_parallel_ralph_loops: 2,
    max_parallel_mc_missions: 4,
  })),
}));

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  dim: vi.fn(),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
  dimText: vi.fn((s: string) => s),
  header: vi.fn(),
  accent: vi.fn((s: string) => s),
  error: vi.fn(),
  channelLabel: vi.fn((s: string) => `[${s}]`),
}));

import {
  collectModelDeployArgs, refreshHandler, pruneStaleManagedAgentFiles, detectStaleProviderTrees,
} from '../../../../src/cli/handlers/refresh.js';
import * as ui from '../../../../src/cli/ui.js';
// Backward-compat alias for existing test references
const syncHandler = refreshHandler;

const savedProcessProvider = process.env.AIWG_TEST_PROCESS_PROVIDER;

describe('refresh model option parity', () => {
  it('forwards model, filter, tier, and save options unchanged', () => {
    expect(collectModelDeployArgs([
      '--model-tier', 'economy',
      '--filter', '*-reviewer',
      '--filter-role', 'coding',
      '--coding-model', 'provider/model',
      '--save',
      '--quiet',
    ])).toEqual([
      '--model-tier', 'economy',
      '--filter', '*-reviewer',
      '--filter-role', 'coding',
      '--coding-model', 'provider/model',
      '--save',
    ]);
  });
});

// ── Helpers ───────────────────────────────────────────────────

function makeCtx(args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['sync', ...args],
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

// ── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  process.env.AIWG_TEST_PROCESS_PROVIDER = 'codex';
  mockUseExecute.mockResolvedValue({ exitCode: 0 });
  mockReadAiwgConfig.mockResolvedValue({
    providers: ['codex'],
    installed: { sdlc: {}, 'writing-quality': {} },
    parallelism: {},
  });
});

afterEach(() => {
  if (savedProcessProvider === undefined) {
    delete process.env.AIWG_TEST_PROCESS_PROVIDER;
  } else {
    process.env.AIWG_TEST_PROCESS_PROVIDER = savedProcessProvider;
  }
});

describe('refreshHandler metadata', () => {
  it('has correct id, category, and description', () => {
    expect(syncHandler.id).toBe('refresh');
    expect(syncHandler.category).toBe('maintenance');
    expect(syncHandler.description).toMatch(/refresh/i);
    expect(typeof syncHandler.execute).toBe('function');
  });

  it('declares non-executing help with the refresh safety flags', async () => {
    const result = await syncHandler.help!(makeCtx(['--help']));

    expect(result).toMatchObject({ exitCode: 0, rawOutput: true });
    expect(result.message).toContain('Usage: aiwg refresh [options]');
    expect(result.message).toContain('--dry-run');
    expect(result.message).toContain('--skip-update');
    expect(result.message).toContain('--packages-only');
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRefreshAllPackages).not.toHaveBeenCalled();
    expect(mockUseExecute).not.toHaveBeenCalled();
  });

  it('has sync as a deprecated alias', () => {
    expect(syncHandler.aliases).toContain('sync');
    expect(syncHandler.aliases).toContain('--sync');
  });
});

describe('syncHandler.execute — default run (no flags)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ exitCode: 0 });
  });

  it('exits 0 and runs all 5 scripts in order', async () => {
    const result = await syncHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);

    const calls = mockRun.mock.calls.map(([script]: [string]) => script);
    expect(calls).toContain('tools/cli/runtime-info.mjs');
    expect(calls).toContain('tools/cli/version.mjs');
    expect(calls).toContain('tools/cli/update.mjs');
    expect(mockUseExecute).toHaveBeenCalled();
    expect(calls).toContain('tools/cli/doctor.mjs');
  });

  it('calls refreshAllPackages', async () => {
    await syncHandler.execute(makeCtx());
    expect(mockRefreshAllPackages).toHaveBeenCalled();
  });
});

describe('syncHandler.execute — --dry-run', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('does not spawn update, deploy, or doctor scripts', async () => {
    const result = await syncHandler.execute(makeCtx(['--dry-run']));
    expect(result.exitCode).toBe(0);

    const calls = mockRun.mock.calls.map(([script]: [string]) => script);
    // runtime-info and version are still called (read-only)
    expect(calls).toContain('tools/cli/runtime-info.mjs');
    expect(calls).toContain('tools/cli/version.mjs');
    // destructive scripts must not run in dry-run
    expect(calls).not.toContain('tools/cli/update.mjs');
    expect(mockUseExecute).not.toHaveBeenCalled();
    expect(calls).not.toContain('tools/cli/doctor.mjs');
  });

  it('does not call refreshAllPackages in dry-run', async () => {
    await syncHandler.execute(makeCtx(['--dry-run']));
    expect(mockRefreshAllPackages).not.toHaveBeenCalled();
  });
});

describe('syncHandler.execute — --skip-update', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('does not call update.mjs', async () => {
    await syncHandler.execute(makeCtx(['--skip-update']));
    const calls = mockRun.mock.calls.map(([script]: [string]) => script);
    expect(calls).not.toContain('tools/cli/update.mjs');
    // but deploy and doctor still run
    expect(mockUseExecute).toHaveBeenCalled();
    expect(calls).toContain('tools/cli/doctor.mjs');
  });
});

describe('syncHandler.execute — --packages-only', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('only refreshes packages, does not run deploy or doctor', async () => {
    const result = await syncHandler.execute(makeCtx(['--packages-only']));
    expect(result.exitCode).toBe(0);
    expect(mockRefreshAllPackages).toHaveBeenCalled();

    const calls = mockRun.mock.calls.map(([script]: [string]) => script);
    expect(calls).not.toContain('tools/cli/update.mjs');
    expect(mockUseExecute).not.toHaveBeenCalled();
    expect(calls).not.toContain('tools/cli/doctor.mjs');
  });
});

describe('syncHandler.execute — --channel', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('passes --channel next to update.mjs', async () => {
    await syncHandler.execute(makeCtx(['--channel', 'next']));
    const updateCall = mockRun.mock.calls.find(([script]: [string]) => script === 'tools/cli/update.mjs');
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain('--channel');
    expect(updateCall![1]).toContain('next');
  });

  it('passes no channel args when no --channel flag', async () => {
    await syncHandler.execute(makeCtx());
    const updateCall = mockRun.mock.calls.find(([script]: [string]) => script === 'tools/cli/update.mjs');
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual([]);
  });
});

describe('syncHandler.execute — --provider', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('passes --provider copilot to the active use handler', async () => {
    await syncHandler.execute(makeCtx(['--provider', 'copilot']));
    expect(mockUseExecute).toHaveBeenCalled();
    const deployArgs = mockUseExecute.mock.calls[0][0].args;
    expect(deployArgs).toContain('--provider');
    expect(deployArgs).toContain('copilot');
  });
});

describe('syncHandler.execute — --frameworks', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('calls the active use handler once per framework when --frameworks sdlc,research', async () => {
    await syncHandler.execute(makeCtx(['--frameworks', 'sdlc,research']));
    expect(mockUseExecute).toHaveBeenCalledTimes(2);
    const deployTargets = mockUseExecute.mock.calls.map(([useCtx]) => useCtx.args[0]);
    expect(deployTargets).toContain('sdlc');
    expect(deployTargets).toContain('research');
  });

  it('re-deploys each installed item when no --frameworks flag', async () => {
    await syncHandler.execute(makeCtx());
    expect(mockUseExecute.mock.calls.map(([useCtx]) => useCtx.args[0])).toEqual([
      'sdlc',
      'writing-quality',
    ]);
    expect(mockUseExecute.mock.calls.flatMap(([useCtx]) => useCtx.args)).not.toContain('all');
  });

  it('--all preserves installed-only semantics instead of expanding aiwg use all', async () => {
    await syncHandler.execute(makeCtx(['--all']));
    expect(mockUseExecute.mock.calls.map(([useCtx]) => useCtx.args[0])).toEqual([
      'sdlc',
      'writing-quality',
    ]);
    expect(mockUseExecute.mock.calls.flatMap(([useCtx]) => useCtx.args)).not.toContain('all');
  });

  it('--frameworks all also preserves installed-only semantics', async () => {
    await syncHandler.execute(makeCtx(['--frameworks', 'all']));
    expect(mockUseExecute.mock.calls.map(([useCtx]) => useCtx.args[0])).toEqual([
      'sdlc',
      'writing-quality',
    ]);
    expect(mockUseExecute.mock.calls.flatMap(([useCtx]) => useCtx.args)).not.toContain('all');
  });
});

describe('syncHandler.execute — --quiet', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRun.mockResolvedValue({ exitCode: 0 }); });

  it('writes JSON to stdout and exits 0', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await syncHandler.execute(makeCtx(['--quiet']));
      expect(result.exitCode).toBe(0);
      // JSON output: last console.log call should be parseable JSON
      const jsonCalls = consoleSpy.mock.calls.filter(([arg]) => {
        try { JSON.parse(arg); return true; } catch { return false; }
      });
      expect(jsonCalls.length).toBeGreaterThan(0);
      const parsed = JSON.parse(jsonCalls[0][0]);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('provider');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('syncHandler.execute — deployment resilience', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns non-zero when the active use handler detects artifact loss', async () => {
    mockRun.mockResolvedValue({ exitCode: 0 });
    mockUseExecute.mockResolvedValue({ exitCode: 1, message: 'deployment verification failed' });

    const result = await syncHandler.execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('sdlc');
  });

  it('reports an update failure again in the final summary while continuing deployment', async () => {
    mockRun.mockImplementation(async (script: string) => {
      if (script === 'tools/cli/update.mjs') return { exitCode: 1 };
      return { exitCode: 0 };
    });

    const result = await syncHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
    expect(mockUseExecute).toHaveBeenCalled();
    expect(mockRun.mock.calls.map(([script]: [string]) => script)).toContain('tools/cli/doctor.mjs');
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining('Installation update failed'));
    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringContaining('Refresh completed with installation update failure (exit 1)'),
    );
    expect(ui.success).not.toHaveBeenCalledWith('Refresh complete');
  });

  it('reports an update failure in the final quiet JSON status', async () => {
    mockRun.mockImplementation(async (script: string) => {
      if (script === 'tools/cli/update.mjs') return { exitCode: 7 };
      return { exitCode: 0 };
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = await syncHandler.execute(makeCtx(['--quiet']));
      expect(result.exitCode).toBe(0);
      const output = consoleSpy.mock.calls
        .map(([value]) => value)
        .find((value) => typeof value === 'string' && value.startsWith('{'));
      expect(JSON.parse(output as string)).toMatchObject({
        status: 'refreshed-with-update-failure',
        updateFailure: { exitCode: 7 },
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('warns but returns exit 0 when doctor reports issues', async () => {
    mockRun.mockImplementation(async (script: string) => {
      if (script === 'tools/cli/doctor.mjs') return { exitCode: 1 };
      return { exitCode: 0 };
    });

    const result = await syncHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
  });
});

describe('syncHandler.execute — stale deployment detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ exitCode: 0 });
    mockRefreshAllPackages.mockResolvedValue([]);
  });

  it('skips stale check when no aiwg.config present', async () => {
    mockReadAiwgConfig.mockResolvedValue(null);
    const result = await syncHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
    // hashManifest should not be called if config is null
    expect(mockHashManifest).not.toHaveBeenCalled();
  });

  it('detects stale frameworks when manifest hash differs (exits 0, stale is non-fatal)', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      installed: {
        sdlc: { manifestHash: 'old-hash' },
      },
    });
    mockHashManifest.mockResolvedValue('new-hash');

    // Stale detection is non-fatal — sync still exits 0 regardless of stale detection result
    const result = await syncHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
  });

  it('reports all up to date when hashes match', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      installed: {
        sdlc: { manifestHash: 'same-hash' },
      },
    });
    mockHashManifest.mockResolvedValue('same-hash');

    const result = await syncHandler.execute(makeCtx());
    expect(result.exitCode).toBe(0);
  });
});

describe('refreshHandler stale AIWG-managed agent cleanup (#1460)', () => {
  it('preserves desired addon-version agents for the provider just refreshed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-addon-version-'));
    try {
      const frameworkRoot = join(root, 'framework-root');
      const projectRoot = join(root, 'project');
      mkdirSync(join(frameworkRoot, 'agentic/code/addons/rlm/agents'), { recursive: true });
      mkdirSync(join(projectRoot, '.claude/agents'), { recursive: true });
      writeFileSync(join(frameworkRoot, 'package.json'), '{"version":"2026.8.10"}\n');
      writeFileSync(
        join(frameworkRoot, 'agentic/code/addons/rlm/agents/rlm-agent.md'),
        '---\nname: RLM Agent\n---\n',
      );
      writeFileSync(
        join(projectRoot, '.claude/agents/rlm-agent.md'),
        '---\n# aiwg:managed v1.4.0 bundled\nname: RLM Agent\n---\n',
      );

      const { removals: removed } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
      });

      expect(removed).toEqual([]);
      expect(existsSync(join(projectRoot, '.claude/agents/rlm-agent.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes bundled managed agent files that no longer exist in current sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-orphan-'));
    try {
      const frameworkRoot = join(root, 'framework-root');
      const projectRoot = join(root, 'project');
      mkdirSync(join(frameworkRoot, 'agentic/code/frameworks/forensics-complete/agents'), { recursive: true });
      mkdirSync(join(projectRoot, '.claude/agents'), { recursive: true });

      writeFileSync(
        join(frameworkRoot, 'agentic/code/frameworks/forensics-complete/agents/forensic-acquisition-agent.md'),
        '---\nname: Forensic Acquisition Agent\nmodel: claude-sonnet-4-6\n---\n',
      );
      writeFileSync(
        join(projectRoot, '.claude/agents/forensic-acquisition-agent.md'),
        '---\n# aiwg:managed v2026.5.10 bundled\nname: Forensic Acquisition Agent\nmodel: claude-sonnet-4-6\n---\n',
      );
      writeFileSync(
        join(projectRoot, '.claude/agents/acquisition-agent.md'),
        '---\n# aiwg:managed v2026.5.0-rc.7 bundled\nname: Acquisition Agent\nmodel: sonnet\n---\n',
      );
      writeFileSync(
        join(projectRoot, '.claude/agents/operator-agent.md'),
        '---\nname: Operator Agent\nmodel: sonnet\n---\n',
      );

      const { removals: removed } = await pruneStaleManagedAgentFiles({ projectRoot, frameworkRoot, provider: 'claude' });

      expect(removed).toEqual([{
        provider: 'claude',
        paths: ['.claude/agents/acquisition-agent.md'],
      }]);
      expect(existsSync(join(projectRoot, '.claude/agents/acquisition-agent.md'))).toBe(false);
      expect(existsSync(join(projectRoot, '.claude/agents/forensic-acquisition-agent.md'))).toBe(true);
      expect(existsSync(join(projectRoot, '.claude/agents/operator-agent.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports stale bundled agent files in dry-run without deleting them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-orphan-dry-'));
    try {
      const frameworkRoot = join(root, 'framework-root');
      const projectRoot = join(root, 'project');
      mkdirSync(join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/agents'), { recursive: true });
      mkdirSync(join(projectRoot, '.claude/agents'), { recursive: true });
      writeFileSync(join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/agents/current-agent.md'), '---\nname: Current\n---\n');
      writeFileSync(
        join(projectRoot, '.claude/agents/old-agent.md'),
        '---\n# aiwg:managed v2026.5.0-rc.7 bundled\nname: Old\nmodel: sonnet\n---\n',
      );

      const { removals: removed } = await pruneStaleManagedAgentFiles({ projectRoot, frameworkRoot, provider: 'claude', dryRun: true });

      expect(removed).toEqual([{
        provider: 'claude',
        paths: ['.claude/agents/old-agent.md'],
      }]);
      expect(existsSync(join(projectRoot, '.claude/agents/old-agent.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #2506 — a provider-scoped refresh used to delete every older managed agent
  // from provider trees it was not asked to touch, leaving commands and rules
  // behind. The deletions were silent, and in git-tracked provider directories
  // they landed as staged deletions in an unrelated working tree.
  it('leaves non-refreshed provider trees untouched by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-cross-provider-'));
    try {
      const { frameworkRoot, projectRoot, claudeAgents, codexAgents, codexCommands, codexRules } =
        makeCrossProviderFixture(root);

      const { removals: removed } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
      });

      expect(removed).toEqual([]);
      expect(existsSync(join(codexAgents, 'stale-agent-01.md'))).toBe(true);
      expect(existsSync(join(codexAgents, 'stale-agent-47.md'))).toBe(true);
      expect(existsSync(join(codexCommands, 'stale-command.md'))).toBe(true);
      expect(existsSync(join(codexRules, 'stale-rule.md'))).toBe(true);
      expect(existsSync(join(claudeAgents, 'current-claude-agent.md'))).toBe(true);
      expect(existsSync(join(codexAgents, 'operator-agent.md'))).toBe(true);
      expect(existsSync(join(codexAgents, 'newer-channel-agent.md'))).toBe(true);
      expect(existsSync(join(codexAgents, 'project-agent.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports non-refreshed stale provider trees so the operator can decide', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-stale-detect-'));
    try {
      const { frameworkRoot, projectRoot } = makeCrossProviderFixture(root);

      const trees = await detectStaleProviderTrees({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
      });

      expect(trees).toHaveLength(1);
      expect(trees[0].provider).toBe('codex');
      expect(trees[0].version).toBe('2026.7.13');
      expect(trees[0].counts).toEqual({ agents: 47, commands: 1, rules: 1 });
      expect(trees[0].total).toBe(49);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes a non-refreshed provider tree as a unit when explicitly requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-cross-prune-'));
    try {
      const { frameworkRoot, projectRoot, claudeAgents, codexAgents, codexCommands, codexRules } =
        makeCrossProviderFixture(root);

      const { removals: removed } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
        crossProvider: 'prune',
      });

      expect(removed).toHaveLength(1);
      expect(removed[0].provider).toBe('codex');
      // agents + commands + rules removed together — never a half-deployed tree
      expect(removed[0].paths).toHaveLength(49);
      expect(existsSync(join(codexAgents, 'stale-agent-01.md'))).toBe(false);
      expect(existsSync(join(codexAgents, 'stale-agent-47.md'))).toBe(false);
      expect(existsSync(join(codexCommands, 'stale-command.md'))).toBe(false);
      expect(existsSync(join(codexRules, 'stale-rule.md'))).toBe(false);
      // Ownership boundaries still hold.
      expect(existsSync(join(claudeAgents, 'current-claude-agent.md'))).toBe(true);
      expect(existsSync(join(codexAgents, 'operator-agent.md'))).toBe(true);
      expect(existsSync(join(codexAgents, 'newer-channel-agent.md'))).toBe(true);
      expect(existsSync(join(codexAgents, 'project-agent.md'))).toBe(true);
      expect(existsSync(join(codexRules, 'RULES-INDEX.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never leaves a half-deployed tree: no run removes agents while keeping commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-half-deployed-'));
    try {
      const { frameworkRoot, projectRoot, codexAgents, codexCommands } =
        makeCrossProviderFixture(root);

      for (const crossProvider of ['skip', 'prune'] as const) {
        const fixtureRoot = mkdtempSync(join(tmpdir(), `aiwg-refresh-half-${crossProvider}-`));
        try {
          const fixture = makeCrossProviderFixture(fixtureRoot);
          await pruneStaleManagedAgentFiles({
            projectRoot: fixture.projectRoot,
            frameworkRoot: fixture.frameworkRoot,
            provider: 'claude',
            crossProvider,
          });
          const agentsLeft = existsSync(join(fixture.codexAgents, 'stale-agent-01.md'));
          const commandsLeft = existsSync(join(fixture.codexCommands, 'stale-command.md'));
          expect(agentsLeft).toBe(commandsLeft);
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
      expect(existsSync(codexAgents)).toBe(true);
      expect(existsSync(codexCommands)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still removes agents the current package no longer ships from the refreshed provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-target-orphan-'));
    try {
      const { frameworkRoot, projectRoot, claudeAgents } = makeCrossProviderFixture(root);
      writeFileSync(
        join(claudeAgents, 'removed-from-package.md'),
        '---\n# aiwg:managed v2026.7.13 bundled\nname: removed-from-package\n---\n',
      );

      const { removals: removed } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
      });

      expect(removed).toEqual([{
        provider: 'claude',
        paths: ['.claude/agents/removed-from-package.md'],
      }]);
      expect(existsSync(join(claudeAgents, 'current-claude-agent.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Workspace shape from #2506: providers ["claude"] with a stale `.codex/` tree
 * left behind by an older package — agents, commands, and rules together.
 */
function makeCrossProviderFixture(root: string) {
  const frameworkRoot = join(root, 'framework-root');
  const projectRoot = join(root, 'project');
  const packagedAgents = join(frameworkRoot, 'agentic/code/frameworks/sdlc-complete/agents');
  const claudeAgents = join(projectRoot, '.claude/agents');
  const codexAgents = join(projectRoot, '.codex/agents');
  const codexCommands = join(projectRoot, '.codex/commands');
  const codexRules = join(projectRoot, '.codex/rules');
  for (const dir of [packagedAgents, claudeAgents, codexAgents, codexCommands, codexRules]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(frameworkRoot, 'package.json'), '{"version":"2026.7.15"}\n');

  for (let index = 1; index <= 47; index += 1) {
    const name = `stale-agent-${String(index).padStart(2, '0')}`;
    writeFileSync(join(packagedAgents, `${name}.md`), `---\nname: ${name}\n---\nCurrent lean body.\n`);
    writeFileSync(
      join(codexAgents, `${name}.md`),
      `---\n# aiwg:managed v2026.7.13 bundled\nname: ${name}\n---\n${'old oversized example\n'.repeat(900)}`,
    );
  }

  writeFileSync(join(packagedAgents, 'current-claude-agent.md'), '---\nname: current-claude-agent\n---\n');
  writeFileSync(join(packagedAgents, 'newer-channel-agent.md'), '---\nname: newer-channel-agent\n---\n');
  writeFileSync(
    join(claudeAgents, 'current-claude-agent.md'),
    '---\n# aiwg:managed v2026.7.15 bundled\nname: current-claude-agent\n---\n',
  );
  writeFileSync(join(codexAgents, 'operator-agent.md'), '# operator owned\n');
  writeFileSync(
    join(codexAgents, 'newer-channel-agent.md'),
    '---\n# aiwg:managed v2026.8.0-rc.1 bundled\nname: newer-channel-agent\n---\n',
  );
  writeFileSync(
    join(codexAgents, 'project-agent.md'),
    '---\n# aiwg:managed v2026.7.13 project-local\nname: project-agent\n---\n',
  );
  writeFileSync(
    join(codexCommands, 'stale-command.md'),
    '<!-- aiwg:managed v2026.7.13 bundled -->\n# Stale command\n',
  );
  writeFileSync(join(codexCommands, 'operator-command.md'), '# operator owned\n');
  writeFileSync(
    join(codexRules, 'stale-rule.md'),
    '<!-- aiwg:managed v2026.7.13 bundled -->\n# Stale rule\n',
  );
  writeFileSync(
    join(codexRules, 'RULES-INDEX.md'),
    '<!-- aiwg:managed v2026.7.13 bundled -->\n# Rules index\n',
  );

  return { frameworkRoot, projectRoot, packagedAgents, claudeAgents, codexAgents, codexCommands, codexRules };
}

describe('#2509 cross-provider prune defers to VCS state', () => {
  function initGitRepo(root: string): void {
    execFileSync('git', ['init', '-q', '.'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  }

  it('leaves git-tracked artifacts in place and reports them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-tracked-'));
    try {
      const { frameworkRoot, projectRoot, codexAgents, codexRules } = makeCrossProviderFixture(root);
      initGitRepo(projectRoot);

      const { removals, trackedSkipped } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
        crossProvider: 'prune',
      });

      expect(removals).toEqual([]);
      expect(trackedSkipped).toHaveLength(1);
      expect(trackedSkipped[0].provider).toBe('codex');
      expect(trackedSkipped[0].paths).toHaveLength(49);
      expect(existsSync(join(codexAgents, 'stale-agent-01.md'))).toBe(true);
      expect(existsSync(join(codexRules, 'stale-rule.md'))).toBe(true);
      // Nothing was staged for deletion in a tree the run was not asked to touch.
      const status = execFileSync('git', ['status', '--short'], { cwd: projectRoot }).toString();
      expect(status.split('\n').filter((line) => line.startsWith(' D'))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes tracked artifacts when the operator states the intent twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-tracked-force-'));
    try {
      const { frameworkRoot, projectRoot, codexAgents, codexRules } = makeCrossProviderFixture(root);
      initGitRepo(projectRoot);

      const { removals, trackedSkipped } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
        crossProvider: 'prune',
        allowTrackedDeletes: true,
      });

      expect(trackedSkipped).toEqual([]);
      expect(removals).toHaveLength(1);
      expect(removals[0].paths).toHaveLength(49);
      expect(existsSync(join(codexAgents, 'stale-agent-01.md'))).toBe(false);
      expect(existsSync(join(codexRules, 'stale-rule.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes normally in a project that is not a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-untracked-'));
    try {
      const { frameworkRoot, projectRoot, codexAgents } = makeCrossProviderFixture(root);

      const { removals, trackedSkipped } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
        crossProvider: 'prune',
      });

      expect(trackedSkipped).toEqual([]);
      expect(removals[0].paths).toHaveLength(49);
      expect(existsSync(join(codexAgents, 'stale-agent-01.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never defers the refreshed provider\'s own orphan cleanup to VCS state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-refresh-target-tracked-'));
    try {
      const { frameworkRoot, projectRoot, claudeAgents } = makeCrossProviderFixture(root);
      writeFileSync(
        join(claudeAgents, 'removed-from-package.md'),
        '---\n# aiwg:managed v2026.7.13 bundled\nname: removed-from-package\n---\n',
      );
      initGitRepo(projectRoot);

      const { removals, trackedSkipped } = await pruneStaleManagedAgentFiles({
        projectRoot,
        frameworkRoot,
        provider: 'claude',
      });

      expect(trackedSkipped).toEqual([]);
      expect(removals).toEqual([{
        provider: 'claude',
        paths: ['.claude/agents/removed-from-package.md'],
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sync integration: all 5 script paths exist on disk', () => {
  // Derive repo root from this file's location: test/unit/cli/handlers/ → 4 levels up
  const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '../../../../');

  it('runtime-info.mjs exists', () => {
    expect(existsSync(resolve(REPO_ROOT, 'tools/cli/runtime-info.mjs'))).toBe(true);
  });

  it('version.mjs exists', () => {
    expect(existsSync(resolve(REPO_ROOT, 'tools/cli/version.mjs'))).toBe(true);
  });

  it('update.mjs exists', () => {
    expect(existsSync(resolve(REPO_ROOT, 'tools/cli/update.mjs'))).toBe(true);
  });

  it('deploy.mjs exists', () => {
    expect(existsSync(resolve(REPO_ROOT, 'tools/cli/deploy.mjs'))).toBe(true);
  });

  it('doctor.mjs exists', () => {
    expect(existsSync(resolve(REPO_ROOT, 'tools/cli/doctor.mjs'))).toBe(true);
  });
});
