/**
 * Agent Deployer
 *
 * Core deployment engine for multi-platform agent deployment.
 *
 * @implements @.aiwg/requirements/use-cases/UC-002-deploy-sdlc-framework.md
 * @architecture @docs/architecture/cli/index.md
 * @nfr @.aiwg/requirements/nfr-modules/performance.md - NFR-PERF-002 (<10s deployment)
 * @tests @test/unit/agents/agent-deployer.test.ts
 * @depends @src/agents/agent-validator.ts
 * @depends @src/agents/agent-packager.ts
 * @agent-catalog @agentic/code/frameworks/sdlc-complete/agents/
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import YAML from 'yaml';
import type {
  AgentInfo,
  DeploymentTarget,
  DeploymentOptions,
  DeploymentResult,
  AgentDeploymentResult,
  AgentMetadata,
} from './types.js';
import { AgentValidator } from './agent-validator.js';
import { AgentPackager } from './agent-packager.js';
import { getProviderDefinition } from '../providers/provider-definitions.js';

export class AgentDeployer {
  private validator: AgentValidator;
  private packager: AgentPackager;

  constructor() {
    this.validator = new AgentValidator();
    this.packager = new AgentPackager();
  }

  /**
   * Deploy agents to target platform
   */
  async deploy(
    target: DeploymentTarget,
    options: DeploymentOptions = {}
  ): Promise<DeploymentResult> {
    const result: DeploymentResult = {
      platform: target.platform,
      projectPath: target.projectPath,
      deployed: [],
      skipped: [],
      failed: [],
      totalAgents: 0,
      deployedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };

    try {
      // Load agents from default locations
      const agents = await this.loadAgents();
      result.totalAgents = agents.length;

      if (options.verbose) {
        console.log(`Loaded ${agents.length} agents`);
      }

      // Filter agents by options
      const filteredAgents = this.filterAgents(agents, options);

      if (options.verbose) {
        console.log(`Deploying ${filteredAgents.length} agents after filtering`);
      }

      // Validate agents
      const validationResults = await this.validator.validateBatch(filteredAgents);
      const validAgents = validationResults
        .filter((r) => r.valid)
        .map((r) => r.agent);

      // Report validation failures
      const invalidAgents = validationResults.filter((r) => !r.valid);
      for (const invalid of invalidAgents) {
        result.failed.push({
          agent: invalid.agent,
          error: `Validation failed: ${invalid.issues
            .filter((i) => i.type === 'error')
            .map((i) => i.message)
            .join(', ')}`,
        });
        result.failedCount++;
      }

      // Create backup if requested
      if (options.backup && !options.dryRun) {
        result.backupPath = await this.createBackup(target);
        if (options.verbose) {
          console.log(`Backup created: ${result.backupPath}`);
        }
      }

      // Deploy each valid agent
      for (const agent of validAgents) {
        try {
          const deployResult = await this.deployAgent(agent, target, options);

          if (deployResult.success) {
            result.deployed.push(deployResult);
            result.deployedCount++;
          } else {
            result.skipped.push(agent);
            result.skippedCount++;
          }
        } catch (error) {
          result.failed.push({
            agent,
            error: error instanceof Error ? error.message : String(error),
          });
          result.failedCount++;
        }
      }
    } catch (error) {
      throw new Error(
        `Deployment failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return result;
  }

  /**
   * Deploy agents to multiple targets
   */
  async deployBatch(
    targets: DeploymentTarget[],
    options: DeploymentOptions = {}
  ): Promise<Map<string, DeploymentResult>> {
    const results = new Map<string, DeploymentResult>();

    for (const target of targets) {
      const key = `${target.platform}:${target.projectPath}`;
      const result = await this.deploy(target, options);
      results.set(key, result);
    }

    return results;
  }

  /**
   * Load agents from source directories
   */
  async loadAgents(sourcePath?: string): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];
    const searchPaths: string[] = [];

    if (sourcePath) {
      searchPaths.push(sourcePath);
    } else {
      // Default search paths
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const aiwgPath = path.join(homeDir, '.local/share/ai-writing-guide/agents');
      const localAgents = path.join(process.cwd(), 'agents');
      const sdlcAgents = path.join(
        homeDir,
        '.local/share/ai-writing-guide/agentic/code/frameworks/sdlc-complete/agents'
      );

      if (existsSync(aiwgPath)) searchPaths.push(aiwgPath);
      if (existsSync(sdlcAgents)) searchPaths.push(sdlcAgents);
      if (existsSync(localAgents)) searchPaths.push(localAgents);
    }

    // Load agents from all search paths
    for (const searchPath of searchPaths) {
      const pathAgents = await this.loadAgentsFromPath(searchPath);
      agents.push(...pathAgents);
    }

    // Remove duplicates by name (prefer earlier paths)
    const uniqueAgents = new Map<string, AgentInfo>();
    for (const agent of agents) {
      if (!uniqueAgents.has(agent.metadata.name)) {
        uniqueAgents.set(agent.metadata.name, agent);
      }
    }

    return Array.from(uniqueAgents.values());
  }

  /**
   * Load agents from a specific path
   */
  private async loadAgentsFromPath(dirPath: string): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    if (!existsSync(dirPath)) {
      return agents;
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        // Skip template and README files
        if (
          entry.name === 'agent-template.md' ||
          entry.name === 'README.md' ||
          entry.name === 'manifest.md'
        ) {
          continue;
        }

        const filePath = path.join(dirPath, entry.name);
        try {
          const agent = await this.parseAgentFile(filePath);
          if (agent) {
            agents.push(agent);
          }
        } catch (error) {
          // Skip files that fail to parse
          console.warn(`Warning: Failed to parse ${filePath}: ${error}`);
        }
      }
    }

    return agents;
  }

  /**
   * Parse agent file
   */
  private async parseAgentFile(filePath: string): Promise<AgentInfo | null> {
    const content = await fs.readFile(filePath, 'utf-8');
    const metadata = this.parseFrontmatter(content);

    if (!metadata.name) {
      // Use filename as fallback
      metadata.name = path.basename(filePath, '.md');
    }

    // Load agent even if description is missing - validation will catch it

    // Extract content (remove frontmatter)
    const contentWithoutFrontmatter = this.removeFrontmatter(content);

    return {
      metadata,
      content: contentWithoutFrontmatter,
      filePath,
      fileName: path.basename(filePath),
    };
  }

  /**
   * Parse YAML frontmatter
   */
  private parseFrontmatter(content: string): AgentMetadata {
    const metadata: Partial<AgentMetadata> = {};

    // Match frontmatter between --- delimiters
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return metadata as AgentMetadata;
    }

    const frontmatter = frontmatterMatch[1];
    const lines = frontmatter.split('\n');

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();

        switch (key) {
          case 'name':
            metadata.name = value;
            break;
          case 'description':
            metadata.description = value;
            break;
          case 'category':
            metadata.category = value as any;
            break;
          case 'model':
            metadata.model = value;
            break;
          case 'version':
            metadata.version = value;
            break;
          case 'tools':
            metadata.tools = value.split(',').map((t) => t.trim());
            break;
          case 'dependencies':
            metadata.dependencies = value.split(',').map((d) => d.trim());
            break;
        }
      }
    }

    // Preserve provider-native fields consumed by the OMP packager. The
    // historical line parser cannot represent arrays, booleans or objects.
    const native = YAML.parse(frontmatter) || {};
    for (const key of ['thinkingLevel', 'spawns', 'blocking', 'output', 'autoloadSkills', 'readSummarize', 'prewalk', 'advisor'] as const) {
      if (native[key] !== undefined) Object.assign(metadata, { [key]: native[key] });
    }
    if (Array.isArray(native.model)) { metadata.modelPriority = native.model; delete metadata.model; }
    if (Array.isArray(native.tools)) metadata.tools = native.tools;
    if (typeof native.name === 'string') metadata.name = native.name;
    if (typeof native.description === 'string') metadata.description = native.description;
    return metadata as AgentMetadata;
  }

  /**
   * Remove frontmatter from content
   */
  private removeFrontmatter(content: string): string {
    const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    return match ? match[1].trim() : content;
  }

  /**
   * Filter agents by options
   */
  private filterAgents(
    agents: AgentInfo[],
    options: DeploymentOptions
  ): AgentInfo[] {
    let filtered = agents;

    // Filter by category
    if (options.categories && options.categories.length > 0) {
      filtered = filtered.filter(
        (agent) =>
          agent.metadata.category &&
          options.categories!.includes(agent.metadata.category)
      );
    }

    // Filter by name
    if (options.agentNames && options.agentNames.length > 0) {
      filtered = filtered.filter((agent) =>
        options.agentNames!.includes(agent.metadata.name)
      );
    }

    return filtered;
  }

  /**
   * Deploy a single agent
   */
  private async deployAgent(
    agent: AgentInfo,
    target: DeploymentTarget,
    options: DeploymentOptions
  ): Promise<AgentDeploymentResult> {
    const agentsDir = this.getAgentsDirectory(target);
    const fileName = this.packager.getFileName(agent, target.platform);
    const targetPath = path.join(agentsDir, fileName);

    // Check if file exists and force is not set
    if (existsSync(targetPath) && !options.force) {
      return {
        agent,
        success: false,
        targetPath,
        error: 'File exists (use --force to overwrite)',
      };
    }

    // Dry run: don't write files
    if (options.dryRun) {
      return {
        agent,
        success: true,
        targetPath,
      };
    }

    // Package agent for platform
    const packaged = await this.packager.package(agent, target.platform);

    // Create directory if needed
    await fs.mkdir(agentsDir, { recursive: true });

    // Write file
    await fs.writeFile(targetPath, packaged.content, 'utf-8');

    return {
      agent,
      success: true,
      targetPath,
    };
  }

  /**
   * Get agents directory for platform
   */
  private getAgentsDirectory(target: DeploymentTarget): string {
    if (target.agentsPath) {
      return path.resolve(target.projectPath, target.agentsPath);
    }

    const definition = getProviderDefinition(target.platform);
    const agentsPath = definition?.paths.artifacts.agents ?? '';
    return path.resolve(target.projectPath, agentsPath);
  }

  /**
   * Create backup of existing agents
   */
  async createBackup(target: DeploymentTarget): Promise<string> {
    const agentsDir = this.getAgentsDirectory(target);

    if (!existsSync(agentsDir)) {
      return ''; // Nothing to backup
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(
      target.projectPath,
      `.agents-backup-${timestamp}`
    );

    await fs.cp(agentsDir, backupPath, { recursive: true });

    return backupPath;
  }

  /**
   * Rollback to previous backup
   */
  async rollback(backupPath: string, target: DeploymentTarget): Promise<void> {
    if (!existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    const agentsDir = this.getAgentsDirectory(target);

    // Remove current agents directory
    if (existsSync(agentsDir)) {
      await fs.rm(agentsDir, { recursive: true, force: true });
    }

    // Restore from backup
    await fs.cp(backupPath, agentsDir, { recursive: true });
  }

  /**
   * Get installed version of an agent
   */
  async getInstalledVersion(
    agentName: string,
    target: DeploymentTarget
  ): Promise<string | null> {
    const agentsDir = this.getAgentsDirectory(target);
    const fileName = `${agentName}${this.packager.getFileExtension(target.platform)}`;
    const filePath = path.join(agentsDir, fileName);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const metadata = this.parseFrontmatter(content);
      return metadata.version || null;
    } catch {
      return null;
    }
  }
}
