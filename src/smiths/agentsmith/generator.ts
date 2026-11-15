/**
 * Agent Generator
 *
 * Generates agents following the 10 Golden Rules from the Agent Design Bible.
 *
 * @architecture @docs/architecture/cli/index.md
 */

import type {
  AgentOptions,
  GeneratedAgent,
  AgentTemplate,
  ModelTier,
  TemplateConfig,
  AgentStructure,
} from './types.js';
import type { Platform } from '../../agents/types.js';
import { AgentPackager } from '../../agents/agent-packager.js';
import { getProviderDefinition } from '../../providers/provider-definitions.js';
import {
  compileModelPolicy,
  renderCodexAgentToml,
  type ProviderModelCatalog,
} from '../../models/provider-policy.js';
import type { CanonicalModelPolicy, Provider } from '../../models/types.js';
import { collectProviderInventory } from '../../providers/provider-inventory.js';
import { resolveDynamicModelCatalog } from '../../models/model-discovery.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * Template configurations following 10 Golden Rules
 */
const TEMPLATE_CONFIGS: Record<AgentTemplate, TemplateConfig> = {
  simple: {
    modelTier: 'haiku',
    tools: ['Read', 'Write'],
    maxTools: 2,
    canDelegate: false,
    readOnly: false,
    description: 'Simple agents for focused, single-purpose tasks',
  },
  complex: {
    modelTier: 'sonnet',
    tools: ['Read', 'Write', 'Grep'],
    maxTools: 3,
    canDelegate: false,
    readOnly: false,
    description: 'Complex agents requiring analysis and decision-making',
  },
  orchestrator: {
    modelTier: 'opus',
    tools: ['Task'],
    maxTools: 1,
    canDelegate: true,
    readOnly: true,
    description: 'Orchestrators that delegate to other agents (Task tool only)',
  },
  validator: {
    modelTier: 'sonnet',
    tools: ['Read', 'Grep'],
    maxTools: 2,
    canDelegate: false,
    readOnly: true,
    description: 'Validators for quality checks (read-only)',
  },
};

/**
 * Agent Generator
 */
export class AgentGenerator {
  private packager: AgentPackager;

  constructor() {
    this.packager = new AgentPackager();
  }

  /**
   * Generate agent following 10 Golden Rules
   */
  async generateAgent(options: AgentOptions): Promise<GeneratedAgent> {
    // Step 1: Validate inputs
    this.validateOptions(options);

    // Step 2: Get template configuration
    const template = options.template || 'simple';
    const templateConfig = TEMPLATE_CONFIGS[template];

    // Step 3: Select model tier
    const modelTier = options.model || templateConfig.modelTier;
    const modelPolicy = this.modelPolicyForTier(modelTier);

    // Step 4: Select tools
    const tools = this.selectTools(options.tools, templateConfig);

    // Step 5: Build agent structure
    const structure = await this.buildAgentStructure(options, templateConfig);

    // Step 6: Generate agent content
    const content = this.generateContent(structure, modelPolicy, tools);

    // Step 7: Transform for platform
    const compiled = compileModelPolicy({
      provider: this.modelProvider(options.platform),
      artifact: 'agent',
      policy: modelPolicy,
      catalog: await this.loadEffectiveCatalog(options.projectPath),
    });

    const platformContent = await this.transformForPlatform(
      content,
      options.name,
      options.description,
      compiled.fields.model ?? modelTier,
      modelPolicy,
      compiled.effectiveEffort,
      tools,
      options.platform,
      options.category,
      options.version
    );

    // Step 8: Determine deployment path
    const deploymentPath = this.getDeploymentPath(
      options.projectPath,
      options.platform,
      options.name
    );

    return {
      name: options.name,
      path: deploymentPath,
      content: platformContent,
      platform: options.platform,
      model: modelTier,
      modelPolicy,
      tools,
      category: options.category,
      version: options.version,
    };
  }

  /**
   * Deploy generated agent
   */
  async deployAgent(agent: GeneratedAgent): Promise<void> {
    const dir = path.dirname(agent.path);

    // Ensure target directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(agent.path, agent.content, 'utf-8');
  }

  /**
   * Validate agent options
   */
  private validateOptions(options: AgentOptions): void {
    if (!options.name || !/^[a-z0-9-]+$/.test(options.name)) {
      throw new Error('Agent name must be kebab-case (lowercase with hyphens)');
    }

    if (!options.description || options.description.length < 10) {
      throw new Error('Agent description must be at least 10 characters');
    }

    if (!options.platform) {
      throw new Error('Platform is required');
    }

    if (!options.projectPath) {
      throw new Error('Project path is required');
    }

    // Validate custom tools don't exceed template max
    if (options.tools) {
      const template = options.template || 'simple';
      const maxTools = TEMPLATE_CONFIGS[template].maxTools;
      if (options.tools.length > maxTools) {
        throw new Error(
          `Template '${template}' allows maximum ${maxTools} tools (Golden Rule #2: Minimal Tools)`
        );
      }
    }
  }

  /**
   * Select tools based on template and overrides
   */
  private selectTools(customTools: string[] | undefined, config: TemplateConfig): string[] {
    if (customTools && customTools.length > 0) {
      // Validate count
      if (customTools.length > config.maxTools) {
        throw new Error(
          `Maximum ${config.maxTools} tools allowed for this template (Golden Rule #2)`
        );
      }
      return customTools;
    }

    return config.tools;
  }

  /**
   * Build agent structure from options
   */
  private async buildAgentStructure(
    options: AgentOptions,
    config: TemplateConfig
  ): Promise<AgentStructure> {
    const title = this.toTitleCase(options.name);

    // Build structure from guidance or use defaults
    const structure: AgentStructure = {
      title,
      description: options.description,
      expertise: this.extractExpertise(options.guidance, config),
      responsibilities: this.extractResponsibilities(options.guidance, config),
      workflow: this.generateWorkflow(config),
      outputFormat: this.generateOutputFormat(options.guidance, config),
      constraints: this.generateConstraints(config),
      examples: this.generateExamples(options.guidance),
    };

    return structure;
  }

  /**
   * Extract expertise from guidance
   */
  private extractExpertise(guidance: string | undefined, config: TemplateConfig): string[] {
    const expertise: string[] = [];

    // Add template-specific expertise
    if (config.canDelegate) {
      expertise.push('Multi-agent orchestration and workflow coordination');
      expertise.push('Task decomposition and parallel execution patterns');
    } else if (config.readOnly) {
      expertise.push('Code analysis and quality validation');
      expertise.push('Pattern detection and compliance checking');
    } else {
      expertise.push('Domain-specific task execution');
      expertise.push('File manipulation and content generation');
    }

    // Extract from guidance if provided
    if (guidance) {
      const expertisePatterns = [
        /expert in (.+?)(?:\.|,|$)/gi,
        /knowledge of (.+?)(?:\.|,|$)/gi,
        /understands (.+?)(?:\.|,|$)/gi,
      ];

      for (const pattern of expertisePatterns) {
        const matches = guidance.matchAll(pattern);
        for (const match of matches) {
          expertise.push(match[1].trim());
        }
      }
    }

    return expertise;
  }

  /**
   * Extract responsibilities from guidance
   */
  private extractResponsibilities(
    guidance: string | undefined,
    config: TemplateConfig
  ): string[] {
    const responsibilities: string[] = [];

    // Add template-specific responsibilities
    if (config.canDelegate) {
      responsibilities.push('Decompose complex tasks into agent-sized subtasks');
      responsibilities.push('Launch parallel agent execution when appropriate');
      responsibilities.push('Synthesize results from multiple agents');
    } else if (config.readOnly) {
      responsibilities.push('Analyze files and patterns without modification');
      responsibilities.push('Report findings with specific evidence');
      responsibilities.push('Escalate issues requiring human decision');
    } else {
      responsibilities.push('Execute well-defined tasks with clear scope');
      responsibilities.push('Verify preconditions before taking action');
      responsibilities.push('Report results with clear success/failure indication');
    }

    // Extract from guidance
    if (guidance) {
      const responsibilityPatterns = [
        /must (.+?)(?:\.|,|$)/gi,
        /should (.+?)(?:\.|,|$)/gi,
        /responsible for (.+?)(?:\.|,|$)/gi,
      ];

      for (const pattern of responsibilityPatterns) {
        const matches = guidance.matchAll(pattern);
        for (const match of matches) {
          const resp = match[1].trim();
          if (!resp.includes('not') && !resp.includes("don't")) {
            responsibilities.push(resp);
          }
        }
      }
    }

    return responsibilities.slice(0, 5); // Max 5 responsibilities (Golden Rule #1: Single Responsibility)
  }

  /**
   * Generate workflow steps
   */
  private generateWorkflow(config: TemplateConfig): string[] {
    const workflow: string[] = [];

    // Common steps (Golden Rules #3, #4, #5)
    workflow.push('**Verify inputs**: Check all required parameters are provided and valid');

    if (!config.readOnly) {
      workflow.push('**Ground before acting**: Use Read/Grep to verify current state');
    }

    // Template-specific workflow
    if (config.canDelegate) {
      workflow.push('**Decompose task**: Break into parallel-ready subtasks');
      workflow.push('**Launch agents**: Use Task tool to delegate subtasks');
      workflow.push('**Synthesize results**: Combine agent outputs into cohesive result');
    } else if (config.readOnly) {
      workflow.push('**Scan and analyze**: Use Read/Grep to examine files');
      workflow.push('**Identify issues**: Flag violations or areas of concern');
      workflow.push('**Report findings**: Provide actionable recommendations');
    } else {
      workflow.push('**Execute task**: Perform the requested operation');
      workflow.push('**Verify result**: Confirm expected outcome achieved');
    }

    // Always include uncertainty handling (Golden Rule #5)
    workflow.push('**Handle uncertainty**: Escalate to user if ambiguous or out of scope');

    return workflow;
  }

  /**
   * Generate output format
   */
  private generateOutputFormat(guidance: string | undefined, config: TemplateConfig): string {
    // Extract format from guidance if specified
    if (guidance) {
      const formatMatch = guidance.match(/output format[:\s]+(.+?)(?:\.|$)/i);
      if (formatMatch) {
        return formatMatch[1].trim();
      }
    }

    // Default formats by template
    if (config.canDelegate) {
      return 'Structured summary with sections for each delegated task and synthesized conclusion';
    } else if (config.readOnly) {
      return 'Issue report with severity, location, and recommended actions';
    } else {
      return 'Concise confirmation with key details (files modified, lines changed, etc.)';
    }
  }

  /**
   * Generate constraints
   */
  private generateConstraints(config: TemplateConfig): string[] {
    const constraints: string[] = [];

    // Golden Rule #2: Minimal Tools
    constraints.push(`Limited to ${config.maxTools} tool(s): ${config.tools.join(', ')}`);

    // Template-specific constraints
    if (config.readOnly) {
      constraints.push('Read-only: Cannot modify files or execute commands');
    }

    if (config.canDelegate) {
      constraints.push('Delegation-only: Uses Task tool, does not perform direct operations');
    }

    // Golden Rule #1: Single Responsibility
    constraints.push('Single responsibility: Stays within defined scope');

    // Golden Rule #5: Uncertainty
    constraints.push('Escalates ambiguous requests to user rather than guessing');

    return constraints;
  }

  /**
   * Generate examples from guidance
   */
  private generateExamples(guidance: string | undefined): string[] | undefined {
    if (!guidance) return undefined;

    const examples: string[] = [];
    const examplePattern = /example[:\s]+(.+?)(?:\.|$)/gi;
    const matches = guidance.matchAll(examplePattern);

    for (const match of matches) {
      examples.push(match[1].trim());
    }

    return examples.length > 0 ? examples : undefined;
  }

  /**
   * Generate full agent content
   */
  private generateContent(
    structure: AgentStructure,
    model: CanonicalModelPolicy,
    tools: string[]
  ): string {
    const lines: string[] = [];

    // Title and description
    lines.push(`# ${structure.title}`);
    lines.push('');
    lines.push(structure.description);
    lines.push('');

    // Expertise
    lines.push('## Expertise');
    lines.push('');
    for (const item of structure.expertise) {
      lines.push(`- ${item}`);
    }
    lines.push('');

    // Responsibilities
    lines.push('## Responsibilities');
    lines.push('');
    for (const item of structure.responsibilities) {
      lines.push(`- ${item}`);
    }
    lines.push('');

    // Workflow
    lines.push('## Workflow');
    lines.push('');
    for (let i = 0; i < structure.workflow.length; i++) {
      lines.push(`${i + 1}. ${structure.workflow[i]}`);
    }
    lines.push('');

    // Output Format
    lines.push('## Output Format');
    lines.push('');
    lines.push(structure.outputFormat);
    lines.push('');

    // Constraints
    if (structure.constraints && structure.constraints.length > 0) {
      lines.push('## Constraints');
      lines.push('');
      for (const item of structure.constraints) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }

    // Examples
    if (structure.examples && structure.examples.length > 0) {
      lines.push('## Examples');
      lines.push('');
      for (const example of structure.examples) {
        lines.push(`- ${example}`);
      }
      lines.push('');
    }

    // 10 Golden Rules compliance note
    lines.push('---');
    lines.push('');
    lines.push('**Note**: This agent follows the 10 Golden Rules for agent design:');
    lines.push('');
    lines.push('1. **Single Responsibility** - One clear purpose');
    lines.push(`2. **Minimal Tools** - ${tools.length} tool(s) maximum`);
    lines.push('3. **Explicit I/O** - Clear inputs and outputs');
    lines.push('4. **Grounding** - Verifies before acting');
    lines.push('5. **Uncertainty** - Escalates ambiguity');
    lines.push('6. **Context Scope** - Filters distractors');
    lines.push('7. **Recovery** - Handles errors gracefully');
    lines.push(`8. **Model Tier** - ${model.role}/${model.tier} canonical policy for task complexity`);
    lines.push('9. **Parallel Ready** - Safe for concurrent execution');
    lines.push('10. **Observable** - Traceable output');

    return lines.join('\n');
  }

  /**
   * Transform content for platform
   */
  private async transformForPlatform(
    content: string,
    name: string,
    description: string,
    model: string,
    modelPolicy: CanonicalModelPolicy,
    effort: CanonicalModelPolicy['effort'] | undefined,
    tools: string[],
    platform: Platform,
    category?: string,
    version?: string
  ): Promise<string> {
    if (platform === 'codex') {
      return renderCodexAgentToml({
        name,
        description,
        developerInstructions: [
          content,
          '',
          '## Canonical Model Policy',
          '',
          `- model-role: ${modelPolicy.role}`,
          `- model-tier: ${modelPolicy.tier}`,
        ].join('\n'),
        model,
        ...(effort ? { modelReasoningEffort: effort } : {}),
      });
    }

    // Create AgentInfo-like structure for packager
    const agentInfo = {
      metadata: {
        name,
        description,
        model,
        modelRole: modelPolicy.role,
        modelTier: modelPolicy.tier,
        ...(platform === 'omp' && effort ? { thinkingLevel: effort } : {}),
        tools,
        category: category as any,
        version,
      },
      content,
      filePath: '', // Not used
      fileName: '', // Not used
    };

    const packaged = await this.packager.package(agentInfo, platform);
    return packaged.content;
  }

  /**
   * Get deployment path for platform
   */
  private getDeploymentPath(projectPath: string, platform: Platform, name: string): string {
    if (platform === 'codex') return path.join(projectPath, '.codex/agents', `${name}.toml`);
    const platformDir = getProviderDefinition(platform)?.paths.artifacts.agents ?? '';
    const ext = this.packager.getFileExtension(platform);
    return path.join(projectPath, platformDir, `${name}${ext}`);
  }

  private modelProvider(platform: Platform): Exclude<Provider, 'openai'> {
    return (platform === 'generic' ? 'claude' : platform) as Exclude<Provider, 'openai'>;
  }

  private modelPolicyForTier(tier: ModelTier): CanonicalModelPolicy {
    if (tier === 'haiku') return { role: 'efficiency', tier: 'economy', effort: 'low' };
    if (tier === 'opus') return { role: 'reasoning', tier: 'premium', effort: 'high' };
    return { role: 'coding', tier: 'standard', effort: 'medium' };
  }

  private async loadEffectiveCatalog(projectPath: string): Promise<ProviderModelCatalog> {
    const aiwgRoot = this.findAiwgRoot();
    const inventory = await collectProviderInventory(projectPath, { detectProcess: false });
    return resolveDynamicModelCatalog({
      aiwgRoot,
      inventory,
      allowNetwork: false,
    }) as Promise<ProviderModelCatalog>;
  }

  private findAiwgRoot(): string {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      if (existsSync(path.join(cursor, 'agentic/code/providers/model-catalog.v1.json'))) return cursor;
      const next = path.dirname(cursor);
      if (next === cursor) break;
      cursor = next;
    }
    return process.cwd();
  }

  /**
   * Convert kebab-case to Title Case
   */
  private toTitleCase(kebab: string): string {
    return kebab
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Get template configuration
   */
  getTemplateConfig(template: AgentTemplate): TemplateConfig {
    return TEMPLATE_CONFIGS[template];
  }

  /**
   * List all available templates
   */
  listTemplates(): Array<{ name: AgentTemplate; config: TemplateConfig }> {
    return Object.entries(TEMPLATE_CONFIGS).map(([name, config]) => ({
      name: name as AgentTemplate,
      config,
    }));
  }
}
