/**
 * Skill→Command Translator Tests
 *
 * @issue #550
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  parseFrontmatter,
  generateCommandContent,
  translateSkillsToCommands,
  translateSingleSkill,
  providerNeedsCommands,
  providerUsesSkillsNatively,
} from '../../../src/plugin/skill-command-translator.js';

// ============================================
// Provider Classification
// ============================================

describe('Provider classification', () => {
  describe('providerNeedsCommands', () => {
    it('should return true for legacy/native-command providers', () => {
      expect(providerNeedsCommands('factory')).toBe(true);
      // opencode: PUW-006 (#1107) — OpenCode scans .opencode/command/**/*.md
      expect(providerNeedsCommands('opencode')).toBe(true);
      expect(providerNeedsCommands('warp')).toBe(true);
      expect(providerNeedsCommands('windsurf')).toBe(true);
      expect(providerNeedsCommands('copilot')).toBe(true);
      expect(providerNeedsCommands('codex')).toBe(true);
      expect(providerNeedsCommands('openclaw')).toBe(true);
    });

    it('should return false for skills-native providers', () => {
      expect(providerNeedsCommands('claude')).toBe(false);
      expect(providerNeedsCommands('cursor')).toBe(false);
      expect(providerNeedsCommands('hermes')).toBe(false);
    });

    it('should return false for unknown providers', () => {
      expect(providerNeedsCommands('unknown')).toBe(false);
    });
  });

  describe('providerUsesSkillsNatively', () => {
    it('should return true for skills-native providers', () => {
      expect(providerUsesSkillsNatively('claude')).toBe(true);
      expect(providerUsesSkillsNatively('cursor')).toBe(true);
      expect(providerUsesSkillsNatively('hermes')).toBe(true);
    });

    it('should return false for command-needing providers', () => {
      expect(providerUsesSkillsNatively('factory')).toBe(false);
      // opencode is now command-needing per PUW-006 (#1107)
      expect(providerUsesSkillsNatively('opencode')).toBe(false);
    });
  });
});

// ============================================
// Frontmatter Parsing
// ============================================

describe('parseFrontmatter', () => {
  it('should parse description', () => {
    const content = `---
description: Deploy SDLC framework
---

# Body`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.description).toBe('Deploy SDLC framework');
    expect(body).toContain('# Body');
  });

  it('should parse commandHint block', () => {
    const content = `---
description: Test skill
commandHint:
  argumentHint: <file-path>
  allowedTools: Read, Write, Bash
  template: orchestration
  model: sonnet
  modelRole: coding
  modelTier: standard
  modelEffort: medium
---

Body content`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.commandHint).toBeDefined();
    expect(frontmatter.commandHint!.argumentHint).toBe('<file-path>');
    expect(frontmatter.commandHint!.allowedTools).toBe('Read, Write, Bash');
    expect(frontmatter.commandHint!.template).toBe('orchestration');
    expect(frontmatter.commandHint!.model).toBe('sonnet');
    expect(frontmatter.commandHint!.modelRole).toBe('coding');
    expect(frontmatter.commandHint!.modelTier).toBe('standard');
    expect(frontmatter.commandHint!.modelEffort).toBe('medium');
  });

  it('should parse userInvocable: false', () => {
    const content = `---
description: Background skill
userInvocable: false
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.userInvocable).toBe(false);
  });

  it('should parse kebab-case user-invocable', () => {
    const content = `---
description: Background skill
user-invocable: false
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.userInvocable).toBe(false);
  });

  it('should parse effort and context', () => {
    const content = `---
description: Test
effort: 2
context: fork
---

Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.effort).toBe(2);
    expect(frontmatter.context).toBe('fork');
  });

  it('should handle content without frontmatter', () => {
    const content = '# No frontmatter\n\nJust body content.';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  it('should parse real-world SKILL.md frontmatter', () => {
    const content = `---
description: Address open issues using issue-thread-driven ralph loops
commandHint:
  argumentHint: <issue_numbers...> [--filter "status:open label:bug"] [--all-open]
  allowedTools: Task, Read, Write, Edit, Bash, Glob, Grep, mcp__gitea__*
  model: opus
  category: project-management
  orchestration: true
---

# Address Issues

Body content here.`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.description).toBe('Address open issues using issue-thread-driven ralph loops');
    expect(frontmatter.commandHint!.argumentHint).toContain('<issue_numbers...>');
    expect(frontmatter.commandHint!.allowedTools).toContain('Task');
    expect(frontmatter.commandHint!.model).toBe('opus');
    expect(frontmatter.commandHint!.orchestration).toBe(true);
    expect(body).toContain('# Address Issues');
  });
});

// ============================================
// Command Generation
// ============================================

describe('generateCommandContent', () => {
  it('migrates legacy skill model hints to portable command policy', () => {
    const output = generateCommandContent(
      'review',
      { description: 'Review', commandHint: { model: 'opus' } },
      'Review the change.',
      'codex',
    );
    expect(output).toContain('aiwg-model-role: reasoning');
    expect(output).toContain('aiwg-model-tier: premium');
    expect(output).not.toMatch(/^model:/m);
  });

  it('emits Claude native skill model and effort only when requested', () => {
    const output = generateCommandContent(
      'review',
      {
        description: 'Review',
        commandHint: {
          modelRole: 'coding',
          modelTier: 'standard',
          modelEffort: 'high',
        },
      },
      'Review the change.',
      'claude',
    );
    expect(output).toContain('aiwg-model-role: coding');
    expect(output).toContain('model: sonnet');
    expect(output).toContain('effort: 3');
  });
  it('should generate minimal command with description only', () => {
    const content = generateCommandContent('my-skill', { description: 'A simple skill' }, '# My Skill\n\nBody');
    expect(content).toContain('---');
    expect(content).toContain('description: A simple skill');
    expect(content).toContain('# My Skill');
    expect(content).toContain('Body');
  });

  it('should include argument-hint from commandHint', () => {
    const content = generateCommandContent(
      'deploy',
      { description: 'Deploy', commandHint: { argumentHint: '<framework>' } },
      '# Deploy',
    );
    expect(content).toContain('argument-hint: <framework>');
  });

  it('should include allowed-tools from commandHint', () => {
    const content = generateCommandContent(
      'test',
      { description: 'Test', commandHint: { allowedTools: 'Read, Write, Bash' } },
      '# Test',
    );
    expect(content).toContain('allowed-tools: Read, Write, Bash');
  });

  it('should handle array allowedTools', () => {
    const content = generateCommandContent(
      'test',
      { description: 'Test', commandHint: { allowedTools: ['Read', 'Write'] } },
      '# Test',
    );
    expect(content).toContain('allowed-tools: Read, Write');
  });

  it('should fall back to top-level allowedTools when commandHint has none', () => {
    const content = generateCommandContent(
      'test',
      { description: 'Test', allowedTools: 'Bash, Glob' },
      '# Test',
    );
    expect(content).toContain('allowed-tools: Bash, Glob');
  });

  it('should omit skill-only fields (effort, context, disableModelInvocation)', () => {
    const content = generateCommandContent(
      'test',
      { description: 'Test', effort: 2, context: 'fork', disableModelInvocation: true },
      '# Test',
    );
    expect(content).not.toContain('effort');
    expect(content).not.toContain('context');
    expect(content).not.toContain('disable');
  });

  it('should preserve body content unchanged', () => {
    const body = '# Complex Skill\n\n## Section 1\n\nContent with `code` and **bold**.\n\n```yaml\nkey: value\n```\n';
    const content = generateCommandContent('test', { description: 'Test' }, body);
    expect(content).toContain(body.trimStart());
  });
});

// ============================================
// Single Skill Translation
// ============================================

describe('translateSingleSkill', () => {
  it('should translate a skill to command format', () => {
    const skillContent = `---
description: Deploy framework
commandHint:
  argumentHint: <framework>
  allowedTools: Read, Write, Bash
---

# Deploy

Deploy the framework.`;

    const result = translateSingleSkill('deploy', skillContent);
    expect(result).not.toBeNull();
    expect(result).toContain('description: Deploy framework');
    expect(result).toContain('argument-hint: <framework>');
    expect(result).toContain('allowed-tools: Read, Write, Bash');
    expect(result).toContain('# Deploy');
  });

  it('should return null for background-only skills', () => {
    const skillContent = `---
description: Background processor
userInvocable: false
---

# Background

Runs automatically.`;

    const result = translateSingleSkill('background', skillContent);
    expect(result).toBeNull();
  });

  it('should handle skills without commandHint', () => {
    const skillContent = `---
description: Simple skill
---

# Simple

Does things.`;

    const result = translateSingleSkill('simple', skillContent);
    expect(result).not.toBeNull();
    expect(result).toContain('description: Simple skill');
    expect(result).not.toContain('argument-hint');
    expect(result).not.toContain('allowed-tools');
  });
});

// ============================================
// Directory-Level Translation
// ============================================

describe('translateSkillsToCommands', () => {
  let tmpDir: string;
  let skillsDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-translator-test-'));
    skillsDir = path.join(tmpDir, 'skills');
    targetDir = path.join(tmpDir, 'commands');

    // Create test skill directories
    await fs.mkdir(path.join(skillsDir, 'deploy-framework'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'deploy-framework', 'SKILL.md'),
      `---
description: Deploy a framework to the workspace
commandHint:
  argumentHint: <framework>
  allowedTools: Read, Write, Bash
---

# Deploy Framework

Deploy the framework.`,
    );

    await fs.mkdir(path.join(skillsDir, 'background-task'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'background-task', 'SKILL.md'),
      `---
description: Background processor
userInvocable: false
---

# Background

Runs automatically.`,
    );

    await fs.mkdir(path.join(skillsDir, 'simple-util'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'simple-util', 'SKILL.md'),
      `---
description: Simple utility
---

# Simple Utility

Does simple things.`,
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes Copilot dual paths: .github/commands/*.md and .github/prompts/*.prompt.md (PUW-004 #1105)', async () => {
    // Mirror the real use.ts layout: project root with .github/commands/.
    const projectRoot = path.join(tmpDir, 'project');
    const copilotCommandsDir = path.join(projectRoot, '.github', 'commands');
    await fs.mkdir(copilotCommandsDir, { recursive: true });

    const result = await translateSkillsToCommands(skillsDir, {
      provider: 'copilot',
      targetDir: copilotCommandsDir,
      projectPath: projectRoot,
    });
    expect(result.translated.length).toBeGreaterThan(0);

    // Legacy path: .github/commands/<id>.md (kept per always-deploy invariant)
    const legacyPath = path.join(copilotCommandsDir, 'deploy-framework.md');
    await expect(fs.access(legacyPath)).resolves.toBeUndefined();

    // New path: .github/prompts/<id>.prompt.md
    const promptPath = path.join(projectRoot, '.github', 'prompts', 'deploy-framework.prompt.md');
    await expect(fs.access(promptPath)).resolves.toBeUndefined();

    const promptContent = await fs.readFile(promptPath, 'utf-8');
    expect(promptContent).toContain('Deploy a framework to the workspace');
  });

  it('does NOT write .github/prompts/ for non-Copilot providers', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const factoryCommandsDir = path.join(projectRoot, '.factory', 'commands');
    await fs.mkdir(factoryCommandsDir, { recursive: true });

    await translateSkillsToCommands(skillsDir, {
      provider: 'factory',
      targetDir: factoryCommandsDir,
      projectPath: projectRoot,
    });
    await expect(fs.access(path.join(projectRoot, '.github', 'prompts'))).rejects.toThrow();
  });

  it('should skip translation for skills-native providers', async () => {
    const result = await translateSkillsToCommands(skillsDir, {
      provider: 'claude',
      targetDir,
    });
    expect(result.totalProcessed).toBe(0);
    expect(result.translated).toHaveLength(0);
  });

  it('should translate skills for command-needing providers', async () => {
    const result = await translateSkillsToCommands(skillsDir, {
      provider: 'factory',
      targetDir,
    });
    expect(result.totalProcessed).toBe(3);
    expect(result.translated).toHaveLength(2); // deploy-framework + simple-util
    expect(result.skipped).toHaveLength(1); // background-task
    expect(result.skipped[0].skillName).toBe('background-task');
    expect(result.skipped[0].skipReason).toContain('userInvocable: false');
  });

  it('should write command files to target directory', async () => {
    await translateSkillsToCommands(skillsDir, {
      provider: 'factory',
      targetDir,
    });

    const files = await fs.readdir(targetDir);
    expect(files).toContain('deploy-framework.md');
    expect(files).toContain('simple-util.md');
    expect(files).not.toContain('background-task.md');

    const content = await fs.readFile(path.join(targetDir, 'deploy-framework.md'), 'utf-8');
    expect(content).toContain('description: Deploy a framework to the workspace');
    expect(content).toContain('argument-hint: <framework>');
    expect(content).toContain('allowed-tools: Read, Write, Bash');
  });

  it('should not write files in dry-run mode', async () => {
    const result = await translateSkillsToCommands(skillsDir, {
      provider: 'factory',
      targetDir,
      dryRun: true,
    });
    expect(result.translated).toHaveLength(2);

    // Target directory should not exist
    await expect(fs.access(targetDir)).rejects.toThrow();
  });

  it('should handle missing skills directory gracefully', async () => {
    const result = await translateSkillsToCommands('/nonexistent/path', {
      provider: 'factory',
      targetDir,
    });
    expect(result.totalProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should work for all command-needing providers', async () => {
    for (const provider of ['factory', 'opencode', 'warp', 'windsurf', 'copilot', 'codex', 'openclaw']) {
      const providerTarget = provider === 'copilot'
        ? path.join(tmpDir, '.github', 'commands')
        : path.join(tmpDir, `commands-${provider}`);
      const result = await translateSkillsToCommands(skillsDir, {
        provider,
        targetDir: providerTarget,
      });
      expect(result.translated.length).toBeGreaterThan(0, `Provider ${provider} should generate commands`);
    }
  });
});
