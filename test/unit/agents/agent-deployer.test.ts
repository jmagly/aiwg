/**
 * Tests for AgentDeployer
 *
 * @source @src/agents/agent-deployer.ts
 * @requirement @.aiwg/requirements/use-cases/UC-002-deploy-sdlc-framework.md
 * @nfr @.aiwg/requirements/nfr-modules/performance.md - NFR-PERF-002 (<10s deployment)
 * @nfr @.aiwg/requirements/nfr-modules/reliability.md - NFR-REL-001 (100% success rate)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDeployer } from '../../../src/agents/agent-deployer.ts';
import type { DeploymentTarget, DeploymentOptions } from '../../../src/agents/types.ts';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';

describe('AgentDeployer', () => {
  let deployer: AgentDeployer;
  let testDir: string;
  let agentsSourceDir: string;

  beforeEach(async () => {
    deployer = new AgentDeployer();

    // Create temporary test directories
    testDir = path.join(tmpdir(), `agent-deploy-test-${Date.now()}`);
    agentsSourceDir = path.join(testDir, 'source-agents');

    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(agentsSourceDir, { recursive: true });

    // Create sample agent files
    await createSampleAgents(agentsSourceDir);
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  async function createSampleAgents(dir: string) {
    const agents = [
      {
        name: 'writing-validator',
        category: 'writing-quality',
        content: `---
name: writing-validator
description: Validates writing quality against AI patterns and ensures authenticity
category: writing-quality
model: sonnet
tools: Read, Write, Bash
version: 1.0.0
---

# Writing Validator

You are a writing quality validator.`,
      },
      {
        name: 'prompt-optimizer',
        category: 'writing-quality',
        content: `---
name: prompt-optimizer
description: Optimizes prompts for better AI output quality
category: writing-quality
model: opus
tools: Read, Write
version: 1.0.0
---

# Prompt Optimizer

You are a prompt optimization expert.`,
      },
      {
        name: 'architecture-designer',
        category: 'sdlc',
        content: `---
name: architecture-designer
description: Designs scalable system architectures and makes technical decisions
category: sdlc
model: opus
tools: Read, Write, Bash, Grep
version: 1.0.0
---

# Architecture Designer

You design system architectures.`,
      },
    ];

    for (const agent of agents) {
      await fs.writeFile(path.join(dir, `${agent.name}.md`), agent.content, 'utf-8');
    }
  }

  describe('loadAgents', () => {
    it('should load agents from specified path', async () => {
      const agents = await deployer.loadAgents(agentsSourceDir);

      expect(agents.length).toBeGreaterThan(0);
      expect(agents.some((a) => a.metadata.name === 'writing-validator')).toBe(true);
    });

    it('should skip template and README files', async () => {
      await fs.writeFile(
        path.join(agentsSourceDir, 'agent-template.md'),
        'Template content',
        'utf-8'
      );
      await fs.writeFile(
        path.join(agentsSourceDir, 'README.md'),
        'Readme content',
        'utf-8'
      );

      const agents = await deployer.loadAgents(agentsSourceDir);

      expect(agents.some((a) => a.fileName === 'agent-template.md')).toBe(false);
      expect(agents.some((a) => a.fileName === 'README.md')).toBe(false);
    });

    it('should handle non-existent directory', async () => {
      const agents = await deployer.loadAgents('/non/existent/path');
      expect(agents).toEqual([]);
    });

    it('should parse frontmatter correctly', async () => {
      const agents = await deployer.loadAgents(agentsSourceDir);
      const validator = agents.find((a) => a.metadata.name === 'writing-validator');

      expect(validator).toBeDefined();
      expect(validator?.metadata.description).toContain('Validates writing quality');
      expect(validator?.metadata.category).toBe('writing-quality');
      expect(validator?.metadata.model).toBe('sonnet');
      expect(validator?.metadata.tools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('should extract content without frontmatter', async () => {
      const agents = await deployer.loadAgents(agentsSourceDir);
      const validator = agents.find((a) => a.metadata.name === 'writing-validator');

      expect(validator?.content).not.toContain('---');
      expect(validator?.content).toContain('# Writing Validator');
      expect(validator?.content).toContain('You are a writing quality validator.');
    });

    it('should remove duplicate agents by name', async () => {
      // Create duplicate agent
      await fs.writeFile(
        path.join(agentsSourceDir, 'writing-validator-copy.md'),
        `---
name: writing-validator
description: Duplicate agent
---
Content`,
        'utf-8'
      );

      const agents = await deployer.loadAgents(agentsSourceDir);
      const validators = agents.filter((a) => a.metadata.name === 'writing-validator');

      expect(validators).toHaveLength(1);
    });
  });

  describe('deploy', () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = path.join(testDir, 'test-project');
      await fs.mkdir(projectDir, { recursive: true });
    });

    it('should deploy agents to Claude Code format', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      // Mock loadAgents to use our test agents
      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      const result = await deployer.deploy(target);

      expect(result.deployedCount).toBeGreaterThan(0);
      expect(result.failedCount).toBe(0);

      // Check files were created
      const agentsDir = path.join(projectDir, '.claude/agents');
      expect(existsSync(agentsDir)).toBe(true);

      const files = await fs.readdir(agentsDir);
      expect(files.some((f) => f === 'writing-validator.md')).toBe(true);
    });

    it('should deploy agents to Cursor format', async () => {
      const target: DeploymentTarget = {
        platform: 'cursor',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      const result = await deployer.deploy(target);

      expect(result.deployedCount).toBeGreaterThan(0);

      const agentsDir = path.join(projectDir, '.cursor/agents');
      const files = await fs.readdir(agentsDir);
      expect(files.some((f) => f.endsWith('.json'))).toBe(true);

      // Verify JSON content
      const jsonFile = files.find((f) => f.endsWith('.json'));
      if (jsonFile) {
        const content = await fs.readFile(path.join(agentsDir, jsonFile), 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.name).toBeDefined();
        expect(parsed.description).toBeDefined();
      }
    });

    it('should filter agents by category', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const options: DeploymentOptions = {
        categories: ['writing-quality'],
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      const result = await deployer.deploy(target, options);

      expect(result.deployedCount).toBe(2); // writing-validator, prompt-optimizer
      expect(result.deployed.every((d) => d.agent.metadata.category === 'writing-quality')).toBe(
        true
      );
    });

    it('should filter agents by name', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const options: DeploymentOptions = {
        agentNames: ['writing-validator'],
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      const result = await deployer.deploy(target, options);

      expect(result.deployedCount).toBe(1);
      expect(result.deployed[0].agent.metadata.name).toBe('writing-validator');
    });

    it('should skip existing files unless force is true', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      // First deployment
      await deployer.deploy(target);

      // Second deployment without force
      const result = await deployer.deploy(target, { force: false });

      expect(result.deployedCount).toBe(0);
      expect(result.skippedCount).toBeGreaterThan(0);
    });

    it('should overwrite existing files when force is true', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      // First deployment
      await deployer.deploy(target);

      // Second deployment with force
      const result = await deployer.deploy(target, { force: true });

      expect(result.deployedCount).toBeGreaterThan(0);
      expect(result.skippedCount).toBe(0);
    });

    it('should create backup when requested', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      // First deployment to create files
      await deployer.deploy(target);

      // Second deployment with backup
      const result = await deployer.deploy(target, { backup: true, force: true });

      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
    });

    it('should not deploy in dry-run mode', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      const result = await deployer.deploy(target, { dryRun: true });

      expect(result.deployedCount).toBeGreaterThan(0);

      const agentsDir = path.join(projectDir, '.claude/agents');
      expect(existsSync(agentsDir)).toBe(false);
    });

    it('should report validation failures', async () => {
      // Create invalid agent
      await fs.writeFile(
        path.join(agentsSourceDir, 'invalid-agent.md'),
        `---
name: Invalid Name With Spaces
description: x
---
Content`,
        'utf-8'
      );

      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      const result = await deployer.deploy(target);

      expect(result.failedCount).toBeGreaterThan(0);
      expect(result.failed.some((f) => f.error.includes('Validation failed'))).toBe(true);
    });

    it('should use custom agents path', async () => {
      const customPath = 'custom/agents/dir';
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
        agentsPath: customPath,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      await deployer.deploy(target);

      const agentsDir = path.join(projectDir, customPath);
      expect(existsSync(agentsDir)).toBe(true);
    });

    it('should deploy Devin Desktop agents to the ProviderDefinition artifact path', async () => {
      const target: DeploymentTarget = {
        platform: 'devin',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      await deployer.deploy(target);

      const agentsDir = path.join(projectDir, '.windsurf/agents');
      expect(existsSync(agentsDir)).toBe(true);
      const files = await fs.readdir(agentsDir);
      expect(files.some((f) => f === 'writing-validator.md')).toBe(true);
    });
  });

  describe('deployBatch', () => {
    let project1: string;
    let project2: string;

    beforeEach(async () => {
      project1 = path.join(testDir, 'project-1');
      project2 = path.join(testDir, 'project-2');

      await fs.mkdir(project1, { recursive: true });
      await fs.mkdir(project2, { recursive: true });
    });

    it('should deploy to multiple targets', async () => {
      const targets: DeploymentTarget[] = [
        { platform: 'claude', projectPath: project1 },
        { platform: 'cursor', projectPath: project2 },
      ];

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      const results = await deployer.deployBatch(targets);

      expect(results.size).toBe(2);
      expect(results.get('claude:' + project1)).toBeDefined();
      expect(results.get('cursor:' + project2)).toBeDefined();
    });
  });

  describe('getInstalledVersion', () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = path.join(testDir, 'version-test');
      await fs.mkdir(projectDir, { recursive: true });
    });

    it('should return version of installed agent', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const originalLoad = deployer.loadAgents.bind(deployer);
      deployer.loadAgents = async () => originalLoad(agentsSourceDir);

      // Deploy agents
      await deployer.deploy(target);

      // Check version
      const version = await deployer.getInstalledVersion('writing-validator', target);
      expect(version).toBe('1.0.0');
    });

    it('should return null for non-existent agent', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const version = await deployer.getInstalledVersion('non-existent-agent', target);
      expect(version).toBeNull();
    });
  });

  describe('createBackup', () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = path.join(testDir, 'backup-test');
      await fs.mkdir(projectDir, { recursive: true });
    });

    it('should create backup of agents directory', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      // Create some agents first
      const agentsDir = path.join(projectDir, '.claude/agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, 'test.md'), 'content', 'utf-8');

      const backupPath = await deployer.createBackup(target);

      expect(existsSync(backupPath)).toBe(true);

      const files = await fs.readdir(backupPath);
      expect(files).toContain('test.md');
    });

    it('should return empty string when no agents directory exists', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      const backupPath = await deployer.createBackup(target);
      expect(backupPath).toBe('');
    });
  });

  describe('rollback', () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = path.join(testDir, 'rollback-test');
      await fs.mkdir(projectDir, { recursive: true });
    });

    it('should rollback to previous backup', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      // Create original agents
      const agentsDir = path.join(projectDir, '.claude/agents');
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, 'original.md'), 'original content', 'utf-8');

      // Create backup
      const backupPath = await deployer.createBackup(target);

      // Modify agents
      await fs.writeFile(path.join(agentsDir, 'modified.md'), 'modified content', 'utf-8');
      await fs.unlink(path.join(agentsDir, 'original.md'));

      // Rollback
      await deployer.rollback(backupPath, target);

      // Verify restoration
      const files = await fs.readdir(agentsDir);
      expect(files).toContain('original.md');
      expect(files).not.toContain('modified.md');
    });

    it('should throw error when backup does not exist', async () => {
      const target: DeploymentTarget = {
        platform: 'claude',
        projectPath: projectDir,
      };

      await expect(deployer.rollback('/non/existent/backup', target)).rejects.toThrow(
        'Backup not found'
      );
    });
  });
});
