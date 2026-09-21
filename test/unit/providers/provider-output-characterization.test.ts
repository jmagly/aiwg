import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';
import { getProviderDefinition } from '../../../src/providers/provider-definitions.js';
import { resolveHermesHomePath } from '../../../src/providers/hermes-home.js';

vi.mock('../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  dim: vi.fn(),
  dimText: vi.fn((s: string) => s),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
}));

function makeTmpDir(label: string): string {
  const dir = join(tmpdir(), `aiwg-provider-characterization-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(tmpDir: string, args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['regenerate', ...args],
    cwd: tmpDir,
    frameworkRoot: tmpDir,
  };
}

function writeConfig(tmpDir: string, provider: string): void {
  mkdirSync(join(tmpDir, '.aiwg'), { recursive: true });
  writeFileSync(join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
    version: '1',
    providers: [provider],
    installed: {
      sdlc: {
        version: '2026.5.7',
        source: 'bundled',
        installedAt: '2026-05-15T00:00:00.000Z',
        deployedTo: {
          [provider]: { agents: 1, commands: 1, skills: 1, rules: 1 },
        },
      },
    },
    scripts: {},
  }, null, 2));
}

const USE_PATH_GOLDENS = {
  claude: {
    deployTarget: 'project',
    artifacts: {
      agents: '.claude/agents',
      commands: '.claude/commands',
      skills: '.claude/.aiwg/skills',
      rules: '.claude/rules',
      behaviors: '.claude/hooks',
    },
    kernelSkills: '.claude/skills',
  },
  codex: {
    deployTarget: 'mixed',
    artifacts: {
      agents: '.codex/agents',
      commands: '.codex/commands',
      skills: '.codex/.aiwg/skills',
      rules: '.codex/rules',
      behaviors: '.codex/rules',
    },
    kernelSkills: '.agents/skills',
  },
  copilot: {
    deployTarget: 'project',
    artifacts: {
      agents: '.github/agents',
      commands: '.github/commands',
      skills: '.github/.aiwg/skills',
      rules: '.github/copilot-rules',
      behaviors: '.github/copilot-rules',
    },
    kernelSkills: '.github/skills',
  },
  cursor: {
    deployTarget: 'project',
    artifacts: {
      agents: '.cursor/agents',
      commands: '.cursor/commands',
      skills: '.cursor/.aiwg/skills',
      rules: '.cursor/rules',
      behaviors: '.cursor/rules',
    },
    kernelSkills: '.cursor/skills',
  },
  factory: {
    deployTarget: 'project',
    artifacts: {
      agents: '.factory/droids',
      commands: '.factory/commands',
      skills: '.factory/.aiwg/skills',
      rules: '.factory/rules',
      behaviors: '.factory/rules',
    },
    kernelSkills: '.factory/skills',
  },
  grokbot: {
    deployTarget: 'mixed',
    artifacts: {
      agents: null,
      commands: null,
      skills: null,
      rules: null,
      behaviors: null,
    },
    kernelSkills: null,
  },
  hermes: {
    deployTarget: 'mixed',
    artifacts: {
      agents: null,
      commands: null,
      skills: resolveHermesHomePath('skills', '.aiwg'),
      rules: null,
      behaviors: null,
    },
    kernelSkills: resolveHermesHomePath('skills'),
  },
  opencode: {
    deployTarget: 'project',
    artifacts: {
      agents: '.opencode/agent',
      commands: '.opencode/command',
      skills: '.opencode/.aiwg/skill',
      rules: '.opencode/rule',
      behaviors: '.opencode/rule',
    },
    kernelSkills: '.opencode/skill',
  },
  openclaw: {
    deployTarget: 'home',
    artifacts: {
      agents: '~/.openclaw/agents',
      commands: '~/.openclaw/commands',
      skills: '~/.openclaw/.aiwg/skills',
      rules: '~/.openclaw/rules',
      behaviors: '~/.openclaw/behaviors',
    },
    kernelSkills: '~/.openclaw/skills/aiwg',
  },
  openhuman: {
    deployTarget: 'mixed',
    artifacts: {
      agents: null,
      commands: null,
      skills: '~/.openhuman/.aiwg/skills',
      rules: '~/.openhuman/.aiwg/rules',
      behaviors: null,
    },
    kernelSkills: '~/.openhuman/skills',
  },
  warp: {
    deployTarget: 'project',
    artifacts: {
      agents: '.warp/agents',
      commands: '.warp/commands',
      skills: '.warp/.aiwg/skills',
      rules: '.warp/rules',
      behaviors: null,
    },
    kernelSkills: '.warp/skills',
  },
  windsurf: {
    deployTarget: 'project',
    artifacts: {
      agents: '.windsurf/agents',
      commands: '.windsurf/workflows',
      skills: '.windsurf/.aiwg/skills',
      rules: '.windsurf/rules',
      behaviors: '.windsurf/rules',
    },
    kernelSkills: '.windsurf/skills',
  },
  generic: {
    deployTarget: 'project',
    artifacts: {
      agents: 'agents',
      commands: 'commands',
      skills: 'skills',
      rules: 'rules',
      behaviors: null,
    },
    kernelSkills: null,
  },
} as const;

const REGENERATE_FILE_GOLDENS: Record<string, string[]> = {
  claude: ['AIWG.md', '.aiwg/AIWG.md', 'CLAUDE.md'],
  codex: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md'],
  copilot: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md', '.github/copilot-instructions.md'],
  cursor: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md'],
  factory: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md'],
  grokbot: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md'],
  hermes: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md', '.hermes.md'],
  opencode: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md'],
  warp: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md', 'WARP.md'],
  windsurf: ['AIWG.md', '.aiwg/AIWG.md', 'AGENTS.md'],
};

describe('provider output characterization for registry migration', () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('captures current aiwg use deployment target paths for every provider', () => {
    for (const [provider, golden] of Object.entries(USE_PATH_GOLDENS)) {
      const definition = getProviderDefinition(provider);
      expect(definition, provider).toBeDefined();
      expect(definition?.paths.deployTarget, provider).toBe(golden.deployTarget);
      expect(definition?.paths.artifacts, provider).toEqual(golden.artifacts);
      expect(definition?.paths.kernelSkills, provider).toBe(golden.kernelSkills);
    }
  });

  it('captures regenerate context files without touching the real home directory', async () => {
    const { regenerateHandler } = await import('../../../src/cli/handlers/regenerate.js');

    for (const [provider, expectedFiles] of Object.entries(REGENERATE_FILE_GOLDENS)) {
      const tmpDir = makeTmpDir(provider);
      const homeDir = makeTmpDir(`${provider}-home`);
      tmpDirs.push(tmpDir, homeDir);
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('USERPROFILE', homeDir);
      writeConfig(tmpDir, provider);

      const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', provider]));
      expect(result.exitCode, provider).toBe(0);

      for (const rel of expectedFiles) {
        const filePath = join(tmpDir, rel);
        expect(existsSync(filePath), `${provider} should emit ${rel}`).toBe(true);
        const content = readFileSync(filePath, 'utf8');
        if (rel === 'CLAUDE.md') {
          expect(content, `${provider} ${rel}`).toContain('@AIWG.md');
        } else {
          expect(content, `${provider} ${rel}`).toContain('aiwg discover');
        }
      }

      expect(existsSync(join(homeDir, '.openclaw')), `${provider} should not touch temp home OpenClaw root`).toBe(false);
      expect(existsSync(join(homeDir, '.openhuman')), `${provider} should not touch temp home OpenHuman root`).toBe(false);
    }
  });

  it('captures runtime .mjs MCP provider config paths under temp HOME', async () => {
    const homeDir = makeTmpDir('mcp-home');
    const projectDir = makeTmpDir('mcp-project');
    tmpDirs.push(homeDir, projectDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);

    const { getProviderConfigPath, SUPPORTED_PROVIDERS } = await import('../../../src/mcp/registry.mjs');
    const {
      getMcpInjectionDefinition,
      listMcpInjectProviderIds,
      normalizeRuntimeProviderId,
    } = await import('../../../src/providers/provider-definitions.mjs');

    expect(SUPPORTED_PROVIDERS).toEqual([
      'antigravity',
      'omp',
      'claude-code',
      'cursor',
      'factory',
      'codex',
      'grok-build',
      'opencode',
      'windsurf',
      'warp',
    ]);
    expect(listMcpInjectProviderIds()).toEqual(SUPPORTED_PROVIDERS);
    expect(normalizeRuntimeProviderId('claude')).toBe('claude-code');
    expect(normalizeRuntimeProviderId('openai')).toBe('codex');
    expect(normalizeRuntimeProviderId('agy')).toBe('antigravity');
    expect(getMcpInjectionDefinition('openai')?.configFormat).toBe('toml');
    expect(getMcpInjectionDefinition('opencode')?.serversKey).toBe('mcp');
    expect(getProviderConfigPath('agy', projectDir)).toBe(resolve(projectDir, '.agents/mcp_config.json'));
    expect(getProviderConfigPath('antigravity', projectDir, { scope: 'user' })).toBe(resolve(homeDir, '.gemini/config/mcp_config.json'));
    expect(getProviderConfigPath('claude-code', projectDir)).toBe(resolve(projectDir, '.claude/settings.local.json'));
    expect(getProviderConfigPath('claude', projectDir)).toBe(resolve(projectDir, '.claude/settings.local.json'));
    expect(getProviderConfigPath('cursor', projectDir)).toBe(resolve(projectDir, '.cursor/mcp.json'));
    expect(getProviderConfigPath('factory', projectDir)).toBe(resolve(homeDir, '.factory/mcp.json'));
    expect(getProviderConfigPath('codex', projectDir)).toBe(resolve(homeDir, '.codex/config.toml'));
    expect(getProviderConfigPath('openai', projectDir)).toBe(resolve(homeDir, '.codex/config.toml'));
    expect(getProviderConfigPath('grok-build', projectDir)).toBe(resolve(projectDir, '.grok/config.toml'));
    expect(getProviderConfigPath('grok-build', projectDir, { scope: 'user' })).toBe(resolve(homeDir, '.grok/config.toml'));
    expect(getProviderConfigPath('opencode', projectDir)).toBe(resolve(projectDir, 'opencode.json'));
    expect(getProviderConfigPath('windsurf', projectDir)).toBe(resolve(homeDir, '.codeium/windsurf/mcp_config.json'));
    expect(getProviderConfigPath('warp', projectDir)).toBe(resolve(homeDir, '.warp/mcp.json'));
  });
});
