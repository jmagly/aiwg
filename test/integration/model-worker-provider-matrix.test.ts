import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deployOpenHumanHarnessAgents,
} from '../../src/cli/handlers/use.js';

const REPO_ROOT = resolve(__dirname, '../..');
const roots: string[] = [];
const roles = ['reasoning', 'coding', 'efficiency'] as const;

function deploy(provider: string, target: string, home: string, dryRun = false): string {
  return execFileSync(process.execPath, [
    join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'),
    '--provider', provider,
    '--mode', 'all',
    '--filter', 'aiwg-model-*',
    '--target', target,
    '--skip-commands-migration',
    '--verbose',
    ...(dryRun ? ['--dry-run'] : []),
  ], { timeout: 60_000,
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('model worker provider matrix', () => {
  it.each([
    {
      provider: 'claude',
      path: (root: string, role: string) => join(root, `.claude/agents/aiwg-model-${role}-worker.md`),
      models: ['opus', 'sonnet', 'haiku'],
    },
    {
      provider: 'codex',
      path: (root: string, role: string) => join(root, `.codex/agents/aiwg-model-${role}-worker.toml`),
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    },
    {
      provider: 'copilot',
      path: (root: string, role: string) => join(root, `.github/agents/aiwg-model-${role}-worker.agent.md`),
      models: ['claude-opus-4.6', 'claude-sonnet-4.6', 'gpt-5.1-codex-mini'],
    },
    {
      provider: 'cursor',
      path: (root: string, role: string) => join(root, `.cursor/agents/aiwg-model-${role}-worker.md`),
      models: ['claude-4.6-opus-high-thinking', 'claude-4.6-sonnet', 'auto'],
    },
    {
      provider: 'factory',
      path: (root: string, role: string) => join(root, `.factory/droids/aiwg-model-${role}-worker.md`),
      models: ['heavy', 'medium', 'light'],
    },
    {
      provider: 'opencode',
      path: (root: string, role: string) => join(root, `.opencode/agent/aiwg-model-${role}-worker.md`),
      models: [
        'anthropic/claude-opus-5',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-haiku-4-5',
      ],
    },
  ])('emits exact native model workers for $provider', async ({ provider, path, models }) => {
    const root = mkdtempSync(join(tmpdir(), `aiwg-${provider}-workers-`));
    roots.push(root);
    const target = join(root, 'project');
    const home = join(root, 'home');
    deploy(provider, target, home);
    const dryRun = deploy(provider, join(root, 'dry-run'), home, true);

    for (let index = 0; index < roles.length; index++) {
      const file = path(target, roles[index]);
      const content = await readFile(file, 'utf8');
      expect(content).toContain(models[index]);
      expect(content).toContain('aiwg discover');
      expect(content).toContain('aiwg show');
      expect(dryRun).toContain(file.replace(target, join(root, 'dry-run')));
    }
  });

  it('emits OpenHuman semantic model hints for all three workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-openhuman-workers-'));
    roots.push(root);
    const home = join(root, 'home');
    process.env.OPENHUMAN_HOME = join(home, '.openhuman');
    try {
      const result = await deployOpenHumanHarnessAgents({
        frameworkRoot: REPO_ROOT,
        target: join(root, 'project'),
        selectors: roles.map(role => `aiwg-model-${role}-worker`),
        scope: 'user',
      });
      expect(result.emitted).toBe(3);
      for (const role of roles) {
        const content = await readFile(
          join(home, `.openhuman/agents/aiwg_aiwg_model_${role}_worker.toml`),
          'utf8',
        );
        expect(content).toContain(`hint = "${role}"`);
        expect(content).toContain('aiwg discover');
        expect(content).toContain('aiwg show');
      }
    } finally {
      delete process.env.OPENHUMAN_HOME;
    }
  });

  it('declares inherited/global or unsupported degradation without false exact pins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-degraded-workers-'));
    roots.push(root);
    const home = join(root, 'home');

    const openclawTarget = join(root, 'openclaw');
    deploy('openclaw', openclawTarget, home);
    for (const role of roles) {
      const content = await readFile(
        join(home, `.openclaw/agents/aiwg-model-${role}-worker.md`),
        'utf8',
      );
      expect(content).not.toMatch(/^model:/m);
      expect(content).toContain('exactly pinned, semantically hinted, or inherited');
    }

    const warpTarget = join(root, 'warp');
    deploy('warp', warpTarget, home);
    const warp = await readFile(join(warpTarget, 'WARP.md'), 'utf8');
    for (const role of roles) expect(warp).toContain(`# AIWG ${role[0].toUpperCase()}${role.slice(1)} Model Worker`);

    const windsurfTarget = join(root, 'windsurf');
    deploy('windsurf', windsurfTarget, home);
    const windsurf = await readFile(join(windsurfTarget, 'AGENTS.md'), 'utf8');
    for (const role of roles) expect(windsurf).toContain(`aiwg-model-${role}-worker`);

    const hermesTarget = join(root, 'hermes');
    deploy('hermes', hermesTarget, home);
    for (const role of roles) {
      await expect(access(join(hermesTarget, `.hermes/agents/aiwg-model-${role}-worker.md`)))
        .rejects.toThrow();
    }
  });
});
