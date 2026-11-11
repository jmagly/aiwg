import { assertStartupRuleDelivery } from '../helpers/rule-delivery-context.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deployOpenHumanHarnessAgents,
} from '../../src/cli/handlers/use.js';

const REPO_ROOT = resolve(__dirname, '../..');
const roots: string[] = [];
const roles = ['reasoning', 'coding', 'efficiency'] as const;
// Each deploy is a real child process capped at DEPLOY_CHILD_TIMEOUT_MS; the
// test timeout must cover every deploy it runs plus assertion headroom.
const DEPLOY_CHILD_TIMEOUT_MS = 60_000;
const SINGLE_DEPLOY_TEST_TIMEOUT_MS = DEPLOY_CHILD_TIMEOUT_MS + 15_000;
const DOUBLE_DEPLOY_TEST_TIMEOUT_MS = 2 * DEPLOY_CHILD_TIMEOUT_MS + 15_000;

function deploy(provider: string, target: string, home: string, dryRun = false, source?: string): string {
  return execFileSync(process.execPath, [
    join(REPO_ROOT, 'tools/agents/deploy-agents.mjs'),
    '--provider', provider,
    '--mode', 'all',
    '--filter', 'aiwg-model-*',
    '--target', target,
    '--skip-commands-migration',
    '--verbose',
    ...(source ? ['--source', source] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ], { timeout: DEPLOY_CHILD_TIMEOUT_MS,
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: join(home, '.hermes'),
      GROK_HOME: join(home, '.grok'), XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') },
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
      models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'],
    },
    {
      provider: 'copilot',
      path: (root: string, role: string) => join(root, `.github/agents/aiwg-model-${role}-worker.agent.md`),
      models: ['claude-opus-4.6', 'claude-sonnet-4.6', 'gpt-5.1-codex-mini'],
    },
    {
      provider: 'cursor',
      path: (root: string, role: string) => join(root, `.cursor/agents/aiwg-model-${role}-worker.md`),
      // Efficiency uses the standard catalog pin; Cursor's `auto` is never emitted (#2649).
      models: ['claude-4.6-opus-high-thinking', 'claude-4.6-sonnet', 'claude-4.6-sonnet'],
    },
    {
      provider: 'factory',
      path: (root: string, role: string) => join(root, `.factory/droids/aiwg-model-${role}-worker.md`),
      models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
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
      expect(content).not.toMatch(/^model: auto$/m);
      expect(content).toContain('aiwg discover');
      expect(content).toContain('aiwg show');
      expect(dryRun).toContain(file.replace(target, join(root, 'dry-run')));
    }
  }, DOUBLE_DEPLOY_TEST_TIMEOUT_MS);

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
  }, SINGLE_DEPLOY_TEST_TIMEOUT_MS);

  it.each(['openclaw', 'warp', 'windsurf', 'hermes', 'grok-build'])('%s declares inherited/global or unsupported degradation without false exact pins', async provider => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-degraded-workers-'));
    roots.push(root);
    const home = join(root, 'home');

    if (provider === 'grok-build') {
      const target = join(root, 'grok-build');
      deploy(provider, target, home, false, join(REPO_ROOT, 'agentic/code/addons/aiwg-utils'));
      for (const role of roles) {
        const content = await readFile(join(target, `.grok/agents/aiwg-model-${role}-worker.md`), 'utf8');
        expect(content).not.toMatch(/^model:/m);
        expect(content).toContain(`AIWG model role: ${role}`);
        expect(content).toContain('Tier enforcement: inherited');
        expect(content).not.toMatch(/^tools:/m);
        expect(content).toContain('-m');
      }
    }

    if (provider === 'openclaw') {
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
    }

    if (provider === 'warp') {
      const warpTarget = join(root, 'warp');
      deploy('warp', warpTarget, home);
      const warp = await readFile(join(warpTarget, 'WARP.md'), 'utf8');
      const warpIndex = assertStartupRuleDelivery(warpTarget, 'warp', warp);
      for (const role of roles) {
        const definition = `.warp/agents/aiwg-model-${role}-worker.md`;
        expect(warpIndex).toContain(definition);
        const content = await readFile(join(warpTarget, definition), 'utf8');
        expect(content).toContain(`# AIWG ${role[0].toUpperCase()}${role.slice(1)} Model Worker`);
        expect(content).toContain('exactly pinned, semantically hinted, or inherited');
      }
      expect(warp).not.toContain('<!-- AIWG:bound-rules:start -->');

    }

    if (provider === 'windsurf') {
      const windsurfTarget = join(root, 'windsurf');
      deploy('windsurf', windsurfTarget, home);
      const windsurf = await readFile(join(windsurfTarget, 'AGENTS.md'), 'utf8');
      const index = assertStartupRuleDelivery(windsurfTarget, 'windsurf', windsurf);
      for (const role of roles) {
        expect(index).toContain(`aiwg-model-${role}-worker`);
        const content = await readFile(join(windsurfTarget, `.windsurf/agents/aiwg-model-${role}-worker.md`), 'utf8');
        expect(content).toContain('exactly pinned, semantically hinted, or inherited');
        expect(content).not.toMatch(/^model:/m);
      }
    }

    if (provider === 'hermes') {
      const hermesTarget = join(root, 'hermes');
      deploy('hermes', hermesTarget, home);
      const hermes = await readFile(join(hermesTarget, 'AGENTS.md'), 'utf8');
      const hermesIndex = assertStartupRuleDelivery(hermesTarget, 'hermes', hermes);
      for (const role of roles) {
        const definition = `.hermes/agents/aiwg-model-${role}-worker.md`;
        expect(hermesIndex).toContain(definition);
        const content = await readFile(join(hermesTarget, definition), 'utf8');
        expect(content).toContain('exactly pinned, semantically hinted, or inherited');
      }
      expect(hermes.length).toBeLessThanOrEqual(19000);
      expect(hermes).not.toContain('<!-- AIWG:bound-rules:start -->');
    }
  }, SINGLE_DEPLOY_TEST_TIMEOUT_MS);
});
