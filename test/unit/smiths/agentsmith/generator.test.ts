/**
 * Tests for AgentSmith Generator
 *
 * @source @src/smiths/agentsmith/generator.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentGenerator } from '../../../../src/smiths/agentsmith/generator.js';
import type { AgentOptions } from '../../../../src/smiths/agentsmith/types.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('AgentGenerator', () => {
  let generator: AgentGenerator;
  let tempDir: string;

  beforeEach(async () => {
    generator = new AgentGenerator();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentsmith-test-'));
  });

  describe('generateAgent', () => {
    it('should generate a simple agent with default settings', async () => {
      const options: AgentOptions = {
        name: 'test-agent',
        description: 'A test agent for validation',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.name).toBe('test-agent');
      expect(agent.platform).toBe('claude');
      expect(agent.model).toBe('haiku'); // Default for simple template
      expect(agent.tools).toEqual(['Read', 'Write']);
      expect(agent.content).toContain('# Test Agent');
      expect(agent.content).toContain('10 Golden Rules');
    });

    it('should generate a complex agent', async () => {
      const options: AgentOptions = {
        name: 'analyzer-agent',
        description: 'Analyzes code quality',
        template: 'complex',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.model).toBe('sonnet');
      expect(agent.tools).toEqual(['Read', 'Write', 'Grep']);
    });

    it('should generate an orchestrator agent', async () => {
      const options: AgentOptions = {
        name: 'task-coordinator',
        description: 'Coordinates multiple agents',
        template: 'orchestrator',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.model).toBe('opus');
      expect(agent.tools).toEqual(['Task']);
      expect(agent.content).toContain('orchestration');
    });

    it('should generate a validator agent', async () => {
      const options: AgentOptions = {
        name: 'code-validator',
        description: 'Validates code quality',
        template: 'validator',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.model).toBe('sonnet');
      expect(agent.tools).toEqual(['Read', 'Grep']);
      expect(agent.content).toContain('Read-only');
    });

    it('should accept custom model tier override', async () => {
      const options: AgentOptions = {
        name: 'custom-agent',
        description: 'Custom configured agent',
        template: 'simple',
        model: 'opus', // Override default haiku
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.model).toBe('opus');
    });

    it('should accept custom tools within template limits', async () => {
      const options: AgentOptions = {
        name: 'custom-tools-agent',
        description: 'Agent with custom tools',
        template: 'simple',
        tools: ['Read', 'Grep'], // Override default Read, Write
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.tools).toEqual(['Read', 'Grep']);
    });

    it('should reject too many tools for template', async () => {
      const options: AgentOptions = {
        name: 'too-many-tools',
        description: 'Agent with too many tools',
        template: 'simple', // Max 2 tools
        tools: ['Read', 'Write', 'Grep'], // 3 tools
        platform: 'claude',
        projectPath: tempDir,
      };

      await expect(generator.generateAgent(options)).rejects.toThrow(/Golden Rule #2/);
    });

    it('should extract expertise from guidance', async () => {
      const options: AgentOptions = {
        name: 'security-agent',
        description: 'Security scanning agent',
        template: 'validator',
        platform: 'claude',
        projectPath: tempDir,
        guidance: 'Expert in OWASP Top 10. Knowledge of SQL injection patterns.',
      };

      const agent = await generator.generateAgent(options);

      expect(agent.content).toContain('OWASP Top 10');
      expect(agent.content).toContain('SQL injection');
    });

    it('should extract responsibilities from guidance', async () => {
      const options: AgentOptions = {
        name: 'doc-agent',
        description: 'Documentation generator',
        template: 'simple',
        platform: 'claude',
        projectPath: tempDir,
        guidance: 'Must parse JSDoc comments. Should generate markdown files.',
      };

      const agent = await generator.generateAgent(options);

      expect(agent.content).toContain('parse JSDoc comments');
      expect(agent.content).toContain('generate markdown files');
    });

    it('should generate correct deployment path for claude', async () => {
      const options: AgentOptions = {
        name: 'test-agent',
        description: 'Test agent',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.path).toBe(path.join(tempDir, '.claude/agents/test-agent.md'));
    });

    it('should generate correct deployment path for cursor', async () => {
      const options: AgentOptions = {
        name: 'test-agent',
        description: 'Test agent',
        platform: 'cursor',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.path).toBe(path.join(tempDir, '.cursor/agents/test-agent.json'));
    });

    it('should generate deployment path from ProviderDefinition for windsurf', async () => {
      const options: AgentOptions = {
        name: 'test-agent',
        description: 'Test agent',
        platform: 'windsurf',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.path).toBe(path.join(tempDir, '.windsurf/agents/test-agent.md'));
    });

    it('should validate agent name format', async () => {
      const options: AgentOptions = {
        name: 'Invalid_Name',
        description: 'Test agent',
        platform: 'claude',
        projectPath: tempDir,
      };

      await expect(generator.generateAgent(options)).rejects.toThrow(/kebab-case/);
    });

    it('should validate description length', async () => {
      const options: AgentOptions = {
        name: 'test-agent',
        description: 'Short',
        platform: 'claude',
        projectPath: tempDir,
      };

      await expect(generator.generateAgent(options)).rejects.toThrow(/at least 10 characters/);
    });

    it('should include category and version in metadata', async () => {
      const options: AgentOptions = {
        name: 'versioned-agent',
        description: 'Agent with version',
        platform: 'claude',
        projectPath: tempDir,
        category: 'testing',
        version: '1.2.3',
      };

      const agent = await generator.generateAgent(options);

      expect(agent.category).toBe('testing');
      expect(agent.version).toBe('1.2.3');
      expect(agent.content).toContain('category: testing');
      expect(agent.content).toContain('version: 1.2.3');
    });
  });

  describe('deployAgent', () => {
    it('should deploy agent to filesystem', async () => {
      const options: AgentOptions = {
        name: 'deploy-test',
        description: 'Agent for deployment test',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);
      await generator.deployAgent(agent);

      // Verify file exists
      const fileContent = await fs.readFile(agent.path, 'utf-8');
      expect(fileContent).toBe(agent.content);
    });

    it('should create directory if it does not exist', async () => {
      const options: AgentOptions = {
        name: 'new-dir-test',
        description: 'Test creating new directory',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      // Ensure directory doesn't exist
      const dir = path.dirname(agent.path);
      try {
        await fs.access(dir);
        await fs.rm(dir, { recursive: true });
      } catch {
        // Directory doesn't exist, which is what we want
      }

      // Deploy should create it
      await generator.deployAgent(agent);

      const stats = await fs.stat(dir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe('listTemplates', () => {
    it('should list all available templates', () => {
      const templates = generator.listTemplates();

      expect(templates).toHaveLength(4);
      expect(templates.map((t) => t.name)).toEqual([
        'simple',
        'complex',
        'orchestrator',
        'validator',
      ]);
    });

    it('should include configuration for each template', () => {
      const templates = generator.listTemplates();

      for (const { name, config } of templates) {
        expect(config.modelTier).toBeDefined();
        expect(config.tools).toBeDefined();
        expect(config.maxTools).toBeGreaterThan(0);
        expect(config.description).toBeDefined();
      }
    });
  });

  describe('getTemplateConfig', () => {
    it('should return config for simple template', () => {
      const config = generator.getTemplateConfig('simple');

      expect(config.modelTier).toBe('haiku');
      expect(config.tools).toEqual(['Read', 'Write']);
      expect(config.maxTools).toBe(2);
      expect(config.canDelegate).toBe(false);
      expect(config.readOnly).toBe(false);
    });

    it('should return config for orchestrator template', () => {
      const config = generator.getTemplateConfig('orchestrator');

      expect(config.modelTier).toBe('opus');
      expect(config.tools).toEqual(['Task']);
      expect(config.maxTools).toBe(1);
      expect(config.canDelegate).toBe(true);
      expect(config.readOnly).toBe(true);
    });
  });

  describe('platform transformations', () => {
    it('should transform to Claude format with YAML frontmatter', async () => {
      const options: AgentOptions = {
        name: 'claude-agent',
        description: 'Claude format test',
        platform: 'claude',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.content).toMatch(/^---\n/);
      expect(agent.content).toContain('name: claude-agent');
      expect(agent.content).toContain('description: Claude format test');
      expect(agent.content).toContain('tools: Read, Write');
    });

    it('should transform to Cursor format as JSON', async () => {
      const options: AgentOptions = {
        name: 'cursor-agent',
        description: 'Cursor format test',
        platform: 'cursor',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      // Should be valid JSON
      const parsed = JSON.parse(agent.content);
      expect(parsed.name).toBe('cursor-agent');
      expect(parsed.description).toBe('Cursor format test');
      expect(parsed.tools).toEqual(['read', 'write']); // Lowercase
    });

    it('should transform to Codex standalone TOML with compiled model policy', async () => {
      const options: AgentOptions = {
        name: 'codex-agent',
        description: 'Codex format test',
        platform: 'codex',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.path).toBe(path.join(tempDir, '.codex/agents/codex-agent.toml'));
      expect(agent.modelPolicy).toMatchObject({ role: 'efficiency', tier: 'economy' });
      expect(agent.content).toContain('name = "codex-agent"');
      expect(agent.content).toContain('model = "gpt-5.6-luna"');
      expect(agent.content).toContain('model_reasoning_effort = "low"');
      expect(agent.content).toContain('Canonical Model Policy');
    });

    it('should transform to Windsurf format without YAML', async () => {
      const options: AgentOptions = {
        name: 'windsurf-agent',
        description: 'Windsurf format test',
        platform: 'windsurf',
        projectPath: tempDir,
      };

      const agent = await generator.generateAgent(options);

      expect(agent.content).toContain('### windsurf-agent');
      expect(agent.content).toContain('> Windsurf format test');
      expect(agent.content).toContain('<capabilities>');
      expect(agent.content).not.toMatch(/^---\n/); // No YAML frontmatter
    });
  });

  describe('dry run mode', () => {
    it('should generate agent without writing files when dryRun is true', async () => {
      const options: AgentOptions = {
        name: 'dry-run-test',
        description: 'Test dry run mode',
        platform: 'claude',
        projectPath: tempDir,
        dryRun: true,
      };

      const agent = await generator.generateAgent(options);

      // Agent should be generated
      expect(agent.name).toBe('dry-run-test');
      expect(agent.content).toBeDefined();
      expect(agent.path).toBeDefined();

      // File should not exist
      await expect(fs.access(agent.path)).rejects.toThrow();
    });
  });
});
