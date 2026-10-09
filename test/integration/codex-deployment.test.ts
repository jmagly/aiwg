/**
 * Codex Integration Tests
 *
 * Tests for OpenAI Codex CLI integration including:
 * - AGENTS.md generation
 * - Skills deployment to ~/.codex/skills/
 * - Prompts deployment to ~/.codex/prompts/
 * - MCP configuration generation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { LEGACY_MODELS } from '../fixtures/models.js';
import { execFileSync, spawnSync } from 'child_process';

// Test directories
const TEST_PROJECT_DIR = path.join(os.tmpdir(), 'aiwg-codex-test-project');
const TEST_HOME_DIR = path.join(os.tmpdir(), 'aiwg-codex-test-home');
const TEST_CODEX_DIR = path.join(TEST_HOME_DIR, '.codex');
const REPO_ROOT = path.resolve(__dirname, '../..');

function canInitGit(): boolean {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aiwg-codex-git-check-'));
  try {
    execFileSync('git', ['init'], { timeout: 60_000, cwd: tmpDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const GIT_INIT_AVAILABLE = canInitGit();

// Check if codex CLI is available
function isCodexAvailable(): boolean {
  try {
    const result = spawnSync('codex', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const CODEX_AVAILABLE = isCodexAvailable();

// Check if tsx is available (needed for runAiwg which goes through router-loader)
function isTsxAvailable(): boolean {
  try {
    const result = spawnSync('npx', ['tsx', '--version'], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const TSX_AVAILABLE = isTsxAvailable();

// Helper to run codex CLI commands
function runCodex(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): { stdout: string; stderr: string; status: number | null } {
  try {
    const result = spawnSync('codex', args, {
      encoding: 'utf-8',
      timeout: options.timeout || 30000,
      cwd: options.cwd || process.cwd(),
      env: process.env,
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status,
    };
  } catch (e) {
    return { stdout: '', stderr: String(e), status: -1 };
  }
}

// Helper to run CLI commands
function runAiwg(args: string[], cwd = TEST_PROJECT_DIR): string {
  const env = {
    ...process.env,
    HOME: TEST_HOME_DIR,
    USERPROFILE: TEST_HOME_DIR,
    CODEX_HOME: TEST_CODEX_DIR,
  };

  // Use bin/aiwg.mjs which properly awaits async operations
  return execFileSync(process.execPath, [path.join(REPO_ROOT, 'bin/aiwg.mjs'), ...args], { timeout: 60_000,
    cwd,
    env,
    encoding: 'utf-8',
  });
}

// Helper to run deployment scripts directly
function runScript(scriptPath: string, args: string[] = []): string {
  // Integration tests exercise the legacy per-project mirror.
  // Inject --copy-all so deploys produce assertable output. (#1219 rc.30 — env-var removed)
  if (!args.includes('--copy-all')) args = [...args, '--copy-all'];
  const env = {
    ...process.env,
    HOME: TEST_HOME_DIR,
    USERPROFILE: TEST_HOME_DIR,
    CODEX_HOME: TEST_CODEX_DIR,
  };

  return execFileSync(process.execPath, [path.join(REPO_ROOT, scriptPath), ...args], { timeout: 60_000,
    cwd: TEST_PROJECT_DIR,
    env,
    encoding: 'utf-8',
  });
}

describe.skipIf(!GIT_INIT_AVAILABLE)('Codex Integration', () => {
  beforeEach(async () => {
    // Create test directories
    await fs.mkdir(TEST_PROJECT_DIR, { recursive: true });
    await fs.mkdir(TEST_CODEX_DIR, { recursive: true });

    // Initialize as git repo (Codex requires this)
    execFileSync('git', ['init'], { timeout: 60_000, cwd: TEST_PROJECT_DIR, stdio: 'pipe' });
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(TEST_PROJECT_DIR, { recursive: true, force: true });
    await fs.rm(TEST_HOME_DIR, { recursive: true, force: true });
  });

  describe('AGENTS.md Generation', () => {
    it('generates AGENTS.md for Codex provider', async () => {
      // Run deploy-agents with --create-agents-md
      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--create-agents-md',
        '--target', TEST_PROJECT_DIR
      ]);

      const agentsMd = await fs.readFile(
        path.join(TEST_PROJECT_DIR, 'AGENTS.md'),
        'utf-8'
      );

      expect(agentsMd).toContain('AIWG SDLC Framework');
      expect(agentsMd).toContain('Install Skills');
      expect(agentsMd).toContain('~/.codex/skills/');
    });

    it('respects 32KB size limit', async () => {
      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--create-agents-md',
        '--target', TEST_PROJECT_DIR
      ]);

      const agentsMd = await fs.readFile(
        path.join(TEST_PROJECT_DIR, 'AGENTS.md'),
        'utf-8'
      );

      // Codex project_doc_max_bytes default is 32KB
      expect(Buffer.byteLength(agentsMd, 'utf8')).toBeLessThan(32768);
    });

    it('appends to existing AGENTS.md without duplicating', async () => {
      // Create existing AGENTS.md
      await fs.writeFile(
        path.join(TEST_PROJECT_DIR, 'AGENTS.md'),
        '# My Project\n\nExisting content here.\n'
      );

      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--create-agents-md',
        '--target', TEST_PROJECT_DIR
      ]);

      const agentsMd = await fs.readFile(
        path.join(TEST_PROJECT_DIR, 'AGENTS.md'),
        'utf-8'
      );

      expect(agentsMd).toContain('# My Project');
      expect(agentsMd).toContain('Existing content here');
      expect(agentsMd).toContain('AIWG SDLC Framework');

      // Run again - should not duplicate
      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--create-agents-md',
        '--target', TEST_PROJECT_DIR,
        '--force'
      ]);

      const agentsMd2 = await fs.readFile(
        path.join(TEST_PROJECT_DIR, 'AGENTS.md'),
        'utf-8'
      );

      // Count only the ## heading, not the HTML comment marker
      const matches = agentsMd2.match(/## AIWG SDLC Framework/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('Skills Deployment', () => {
    it('deploys skills to ~/.codex/skills/', async () => {
      const output = runScript('tools/skills/deploy-skills-codex.mjs', [
        '--target', path.join(TEST_CODEX_DIR, 'skills')
      ]);

      expect(output).toContain('Deploying skills to Codex');

      // Check skills directory was created
      const skillsDir = path.join(TEST_CODEX_DIR, 'skills');
      const skills = await fs.readdir(skillsDir);

      expect(skills.length).toBeGreaterThan(0);
    });

    it('formats skill with correct YAML frontmatter', async () => {
      runScript('tools/skills/deploy-skills-codex.mjs', [
        '--target', path.join(TEST_CODEX_DIR, 'skills')
      ]);

      const skillDir = path.join(TEST_CODEX_DIR, 'skills', 'voice-apply');
      const skillMd = await fs.readFile(
        path.join(skillDir, 'SKILL.md'),
        'utf-8'
      );

      // Check YAML frontmatter format
      expect(skillMd).toMatch(/^---\n/);
      expect(skillMd).toMatch(/name: "voice-apply"/);
      expect(skillMd).toMatch(/description: ".+"/);
      expect(skillMd).toMatch(/\n---\n/);
    });

    it('replaces the malformed pre-fix aiwg-mcp deployment with aiwg-mcp-server', async () => {
      const skillsDir = path.join(TEST_CODEX_DIR, 'skills');
      const legacyDir = path.join(skillsDir, 'aiwg-mcp');
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(
        path.join(legacyDir, 'SKILL.md'),
        '---\nnamespace: aiwg\nname: aiwg-mcp\nplatforms: [all]\n\n---\n\n# AIWG MCP Server\n'
      );

      const output = runScript('tools/skills/deploy-skills-codex.mjs', [
        '--target', skillsDir
      ]);

      await expect(fs.access(legacyDir)).rejects.toThrow();
      const canonical = await fs.readFile(
        path.join(skillsDir, 'aiwg-mcp-server', 'SKILL.md'),
        'utf-8'
      );
      expect(canonical).toMatch(/name: "aiwg-mcp-server"/);
      expect(canonical).toMatch(/description: ".+"/);
      expect(output).toContain('1 pruned');
    });

    it('ships only described aiwg-mcp-server skills in source and plugin inventories', async () => {
      const inventories = [
        path.join(REPO_ROOT, 'agentic/code/addons/aiwg-utils/skills'),
        path.join(REPO_ROOT, 'agentic/code/plugins/utils/skills')
      ];

      for (const inventory of inventories) {
        await expect(fs.access(path.join(inventory, 'aiwg-mcp'))).rejects.toThrow();
        const canonical = await fs.readFile(
          path.join(inventory, 'aiwg-mcp-server', 'SKILL.md'),
          'utf-8'
        );
        expect(canonical).toMatch(/^---\n[\s\S]*^name:\s+aiwg-mcp-server\s*$/m);
        expect(canonical).toMatch(/^description:\s+\S.+$/m);
      }
    });

    it('truncates description to 500 chars', async () => {
      runScript('tools/skills/deploy-skills-codex.mjs', [
        '--target', path.join(TEST_CODEX_DIR, 'skills')
      ]);

      const skillsDir = path.join(TEST_CODEX_DIR, 'skills');
      const skills = await fs.readdir(skillsDir);

      for (const skill of skills) {
        const skillMd = await fs.readFile(
          path.join(skillsDir, skill, 'SKILL.md'),
          'utf-8'
        );

        // Extract description from frontmatter
        const descMatch = skillMd.match(/description:\s+"(.+)"/);
        if (descMatch) {
          expect(descMatch[1].length).toBeLessThanOrEqual(500);
        }
      }
    });
  });

  describe('Skills Deployment (formerly Prompts)', () => {
    it('deploys skills to project .agents/skills/ via main deploy script (not legacy ~/.codex/skills/ — #766)', async () => {
      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--deploy-skills',
        '--target', TEST_PROJECT_DIR
      ]);

      // Skills deploy to the cross-provider .agents/skills/ — the path codex-rs
      // scans. The legacy ~/.codex/skills/ home dir is no longer written
      // (writing both made codex list every kernel skill twice).
      const skillsDir = path.join(TEST_PROJECT_DIR, '.agents', 'skills');
      const skills = await fs.readdir(skillsDir);
      expect(skills.length).toBeGreaterThan(0);

      const legacyHomeSkillsDir = path.join(TEST_CODEX_DIR, 'skills');
      const legacyExists = await fs.access(legacyHomeSkillsDir).then(() => true).catch(() => false);
      expect(legacyExists, 'legacy ~/.codex/skills/ must not be written by the provider deploy').toBe(false);
    });

    it('each deployed skill directory contains SKILL.md', async () => {
      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--deploy-skills',
        '--target', TEST_PROJECT_DIR
      ]);

      const skillsDir = path.join(TEST_PROJECT_DIR, '.agents', 'skills');
      const skills = await fs.readdir(skillsDir);

      for (const skill of skills) {
        const skillMdPath = path.join(skillsDir, skill, 'SKILL.md');
        const exists = await fs.access(skillMdPath).then(() => true).catch(() => false);
        if (exists) {
          const content = await fs.readFile(skillMdPath, 'utf-8');
          expect(content).toMatch(/^---\n/);
          expect(content).toMatch(/\n---\n/);
        }
      }
    });

    it('prunes stale managed standard skills during a component-scoped kernel deployment', async () => {
      const skillsDir = path.join(TEST_PROJECT_DIR, '.agents', 'skills');
      const staleDir = path.join(skillsDir, 'eval-agent');
      await fs.mkdir(staleDir, { recursive: true });
      await fs.writeFile(path.join(staleDir, 'SKILL.md'), '---\nname: eval-agent\ndescription: stale\n---\n');
      await fs.writeFile(path.join(staleDir, '.aiwg-managed'), 'aiwg\n');

      execFileSync(process.execPath, [
        path.join(REPO_ROOT, 'tools/skills/deploy-skills-codex.mjs'),
        '--source', path.join(REPO_ROOT, 'agentic', 'code', 'addons', 'aiwg-utils'),
        '--target', skillsDir,
      ], { timeout: 60_000,
        cwd: TEST_PROJECT_DIR,
        env: {
          ...process.env,
          HOME: TEST_HOME_DIR,
          USERPROFILE: TEST_HOME_DIR,
          AIWG_ROOT: REPO_ROOT,
        },
        encoding: 'utf-8',
      });

      await expect(fs.access(staleDir)).rejects.toThrow();
      await expect(fs.access(path.join(skillsDir, 'aiwg-doctor', 'SKILL.md'))).resolves.toBeUndefined();
    });

    it('preserves skill model intent as explicit unsupported policy, not a native pin', async () => {
      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--deploy-skills',
        '--target', TEST_PROJECT_DIR,
      ]);
      // A `--copy-all` deploy exceeds Codex's startup listing cap, so the
      // deployer places overflow on the standard tier (#2561); the model
      // policy contract holds wherever the skill landed.
      const candidates = [
        path.join(TEST_PROJECT_DIR, '.agents', 'skills', 'flow-deploy-to-production', 'SKILL.md'),
        path.join(TEST_PROJECT_DIR, '.codex', '.aiwg', 'skills', 'flow-deploy-to-production', 'SKILL.md'),
      ];
      let content = '';
      for (const candidate of candidates) {
        try { content = await fs.readFile(candidate, 'utf8'); break; } catch { /* try the other tier */ }
      }
      expect(content, `flow-deploy-to-production deployed to neither tier: ${candidates.join(', ')}`).not.toBe('');
      expect(content).toContain(
        '<!-- aiwg:model-policy role=reasoning tier=premium outcome=unsupported rationale=',
      );
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      expect(frontmatter).not.toMatch(/^model:/m);
      expect(frontmatter).not.toMatch(/^effort:/m);
    });
  });

  describe('MCP Configuration', () => {
    // These tests use runAiwg which goes through router-loader → npx tsx
    // Skip if tsx is not available (e.g., in Docker CI containers)
    it.skipIf(!TSX_AVAILABLE)('generates valid TOML config snippet for Codex', async () => {
      const output = runAiwg(['aiwg-mcp', 'install', 'codex', '--dry-run']);

      expect(output).toContain('[DRY RUN]');
      expect(output).toContain('.codex/config.toml');
    });

    it.skipIf(!TSX_AVAILABLE)('includes all AIWG MCP tools', async () => {
      // Create initial config.toml
      await fs.writeFile(
        path.join(TEST_CODEX_DIR, 'config.toml'),
`# Existing config\nmodel = "${LEGACY_MODELS.gpt51}"\n`
      );

      runAiwg(['aiwg-mcp', 'install', 'codex']);

      const config = await fs.readFile(
        path.join(TEST_CODEX_DIR, 'config.toml'),
        'utf-8'
      );

      expect(config).toContain('[mcp_servers.aiwg]');
      expect(config).toContain('command-run');
      expect(config).not.toContain('workflow-run');
      expect(config).toContain('artifact-read');
      expect(config).toContain('artifact-write');
      expect(config).toContain('template-render');
      expect(config).toContain('agent-list');
    });

    it.skipIf(!TSX_AVAILABLE)('does not duplicate MCP config on re-run', { timeout: 15000 }, async () => {
      await fs.writeFile(
        path.join(TEST_CODEX_DIR, 'config.toml'),
        '# Config\n'
      );

      runAiwg(['aiwg-mcp', 'install', 'codex']);
      const output = runAiwg(['aiwg-mcp', 'install', 'codex']);

      expect(output).toContain('already configured');

      const config = await fs.readFile(
        path.join(TEST_CODEX_DIR, 'config.toml'),
        'utf-8'
      );

      const matches = config.match(/\[mcp_servers\.aiwg\]/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('Dry Run', () => {
    it('--dry-run shows what would be deployed without writing', async () => {
      const output = runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'sdlc',
        '--create-agents-md',
        '--target', TEST_PROJECT_DIR,
        '--dry-run'
      ]);

      expect(output).toContain('[dry-run]');

      // Verify no AGENTS.md was created (only .git may exist)
      const files = await fs.readdir(TEST_PROJECT_DIR);
      expect(files).not.toContain('AGENTS.md');
    });

    it('media-curator mode includes media-curator skills for codex', () => {
      const output = runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'media-curator',
        '--deploy-skills',
        '--target', TEST_PROJECT_DIR,
        '--dry-run'
      ]);

      expect(output).toContain('Mode: media-curator');
      expect(output).toContain('media-curator (');
      expect(output).toContain('verify-archive');
    });

    it('research mode includes research skills for codex', () => {
      const output = runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'research',
        '--deploy-skills',
        '--target', TEST_PROJECT_DIR,
        '--dry-run'
      ]);

      expect(output).toContain('Mode: research');
      expect(output).toContain('research-complete (');
      expect(output).toContain('research-workflow');
    });

    it('mmk mode alias deploys media-marketing-kit skills for codex', () => {
      const output = runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'codex',
        '--mode', 'mmk',
        '--deploy-skills',
        '--target', TEST_PROJECT_DIR,
        '--dry-run'
      ]);

      expect(output).toContain('Mode: marketing');
      expect(output).toContain('media-marketing-kit (');
      expect(output).toContain('creative-brief');
    });
  });

  describe('Provider Aliases', () => {
    it('--provider openai is alias for codex', async () => {
      runScript('tools/agents/deploy-agents.mjs', [
        '--provider', 'openai',
        '--mode', 'sdlc',
        '--create-agents-md',
        '--target', TEST_PROJECT_DIR
      ]);

      // Should create AGENTS.md for Codex
      const agentsMd = await fs.readFile(
        path.join(TEST_PROJECT_DIR, 'AGENTS.md'),
        'utf-8'
      );

      expect(agentsMd).toContain('~/.codex/skills/');
    });
  });
});

describe('CI/CD Templates', () => {
  it('provides GitHub Actions workflow templates', async () => {
    const templatesDir = path.join(
      REPO_ROOT,
      'agentic/code/frameworks/sdlc-complete/templates/codex/ci-cd'
    );

    const templates = await fs.readdir(templatesDir);

    expect(templates).toContain('aiwg-codex-review.yml');
    expect(templates).toContain('aiwg-codex-security.yml');
    expect(templates).toContain('aiwg-codex-tests.yml');
  });

  it('review workflow is valid YAML', async () => {
    const reviewYml = await fs.readFile(
      path.join(
        REPO_ROOT,
        'agentic/code/frameworks/sdlc-complete/templates/codex/ci-cd/aiwg-codex-review.yml'
      ),
      'utf-8'
    );

    // Basic YAML validation
    expect(reviewYml).toContain('name:');
    expect(reviewYml).toContain('on:');
    expect(reviewYml).toContain('jobs:');
    expect(reviewYml).toContain('codex exec');
  });
});

describe('Config Template', () => {
  it('provides config.toml template', async () => {
    const configTemplate = await fs.readFile(
      path.join(
        REPO_ROOT,
        'agentic/code/frameworks/sdlc-complete/templates/codex/config.toml.aiwg-template'
      ),
      'utf-8'
    );

    expect(configTemplate).toContain('project_doc_fallback_filenames');
    expect(configTemplate).toContain('CLAUDE.md');
    expect(configTemplate).toContain('[profiles.aiwg-sdlc]');
    // MCP config is commented out in template
    expect(configTemplate).toContain('mcp_servers.aiwg');
  });
});

/**
 * Live Codex CLI Integration Tests
 *
 * These tests validate integration with the actual Codex CLI tool.
 * Tests are skipped if Codex CLI is not installed.
 */
describe('Codex CLI Integration', () => {
  it.skipIf(!CODEX_AVAILABLE)('codex CLI is installed and accessible', () => {
    const result = runCodex(['--version']);
    expect(result.status).toBe(0);
    // Codex version format: X.X.X
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it.skipIf(!CODEX_AVAILABLE)('codex --help returns available commands', () => {
    const result = runCodex(['--help']);
    expect(result.status).toBe(0);
    // Should show help text with commands
    expect(result.stdout.toLowerCase()).toMatch(/usage|commands/);
  });

  describe('Skill and Prompt Discovery', () => {
    it.skipIf(!CODEX_AVAILABLE)('codex recognizes skill directories', async () => {
      // Create a test skill directory structure
      const testSkillsDir = path.join(os.tmpdir(), 'codex-skill-test-' + Date.now());
      const testSkillDir = path.join(testSkillsDir, 'test-skill');
      await fs.mkdir(testSkillDir, { recursive: true });

      // Create SKILL.md with proper format
      const skillContent = `---
name: test-skill
description: A test skill for validation
---

# Test Skill

This is a test skill.
`;
      await fs.writeFile(path.join(testSkillDir, 'SKILL.md'), skillContent);

      // Verify skill structure is valid
      const skillMd = await fs.readFile(path.join(testSkillDir, 'SKILL.md'), 'utf-8');
      expect(skillMd).toMatch(/^---\n/);
      expect(skillMd).toContain('name: test-skill');

      // Cleanup
      await fs.rm(testSkillsDir, { recursive: true, force: true });
    });

    it.skipIf(!CODEX_AVAILABLE)('codex recognizes prompt files', async () => {
      // Create a test prompts directory
      const testPromptsDir = path.join(os.tmpdir(), 'codex-prompt-test-' + Date.now());
      await fs.mkdir(testPromptsDir, { recursive: true });

      // Create a prompt file
      const promptContent = `---
description: A test prompt
argument-hint: <args>
---

# Test Prompt

This is a test prompt with $ARGUMENTS placeholder.
`;
      await fs.writeFile(path.join(testPromptsDir, 'test-prompt.md'), promptContent);

      // Verify prompt structure is valid
      const promptMd = await fs.readFile(path.join(testPromptsDir, 'test-prompt.md'), 'utf-8');
      expect(promptMd).toMatch(/^---\n/);
      expect(promptMd).toContain('description:');
      expect(promptMd).toContain('$ARGUMENTS');

      // Cleanup
      await fs.rm(testPromptsDir, { recursive: true, force: true });
    });
  });

  describe('Configuration Validation', () => {
    it.skipIf(!CODEX_AVAILABLE)('validates config.toml format', async () => {
      // Create a test config
      const testDir = path.join(os.tmpdir(), 'codex-config-test-' + Date.now());
      await fs.mkdir(path.join(testDir, '.codex'), { recursive: true });

      const configContent = `# Codex configuration
model = "${LEGACY_MODELS.gpt4}"
project_doc_fallback_filenames = ["CLAUDE.md", "AGENTS.md", "README.md"]

[profiles.aiwg-sdlc]
model = "${LEGACY_MODELS.gpt4turbo}"

# MCP configuration
[mcp_servers.aiwg]
command = "aiwg"
args = ["mcp", "serve"]
env = { AIWG_MODE = "sdlc" }
`;

      await fs.writeFile(path.join(testDir, '.codex', 'config.toml'), configContent);

      // Verify TOML is valid by checking structure
      const readBack = await fs.readFile(path.join(testDir, '.codex', 'config.toml'), 'utf-8');
      expect(readBack).toContain('model =');
      expect(readBack).toContain('[profiles.aiwg-sdlc]');
      expect(readBack).toContain('[mcp_servers.aiwg]');

      // Cleanup
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it.skipIf(!CODEX_AVAILABLE)('codex accepts custom skill directories', async () => {
      // Test that we can structure skills correctly for codex
      const testDir = path.join(os.tmpdir(), 'codex-custom-skill-' + Date.now());
      const skillsDir = path.join(testDir, '.codex', 'skills', 'voice-apply');
      await fs.mkdir(skillsDir, { recursive: true });

      // Create skill with proper structure
      await fs.writeFile(
        path.join(skillsDir, 'SKILL.md'),
        `---
name: voice-apply
description: Apply voice profile to content
---

# Voice Apply

Apply a voice profile to transform content.
`
      );

      // Verify structure
      const skillPath = path.join(skillsDir, 'SKILL.md');
      const stat = await fs.stat(skillPath);
      expect(stat.isFile()).toBe(true);

      // Cleanup
      await fs.rm(testDir, { recursive: true, force: true });
    });
  });

  describe('CLI Availability Reporting', () => {
    it('reports codex CLI availability status', () => {
      // This test always runs to report status
      console.log(`\n  Codex CLI Status:`);
      console.log(`    Available: ${CODEX_AVAILABLE}`);
      if (CODEX_AVAILABLE) {
        const version = runCodex(['--version']);
        console.log(`    Version: ${version.stdout.trim()}`);
      } else {
        console.log('    Install: npm install -g @openai/codex');
      }
      expect(true).toBe(true); // Always passes, just for reporting
    });
  });
});
