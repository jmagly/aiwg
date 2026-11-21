/**
 * Tests for Agentic Smiths - Agentic Definition
 *
 * Validates agentic-definition.yaml format and catalog schemas
 */

import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { LEGACY_MODELS } from '../../fixtures/models.js';

// Types for agentic definition
interface AgentConfig {
  models: string[];
  default_model?: string;
  tools: {
    available: string[];
    orchestration_default?: string[];
  };
}

interface SkillConfig {
  supported: boolean;
  structure?: string;
  filename?: string;
}

interface CommandConfig {
  supported: boolean;
  categories?: string[];
}

interface DeploymentPaths {
  agents: string;
  skills: string;
  commands: string;
}

interface AgenticDefinition {
  platform: {
    provider: string;
    version?: string;
    detected_at?: string;
  };
  agent_config: AgentConfig;
  skill_config: SkillConfig;
  command_config: CommandConfig;
  deployment_paths: DeploymentPaths;
  capabilities?: {
    can_create_agents?: boolean;
    can_create_skills?: boolean;
    can_create_commands?: boolean;
  };
}

// Types for catalogs
interface CatalogArtifact {
  name: string;
  version: string;
  description: string;
  spec_path?: string;
  deployed_path: string;
  created?: string;
  tags?: string[];
  capabilities?: string[];
}

interface AgenticCatalog {
  version: string;
  last_updated: string;
  artifacts: CatalogArtifact[];
  capability_index: Record<string, string>;
}

// Validator functions
function validateAgenticDefinition(def: AgenticDefinition): string[] {
  const errors: string[] = [];

  // Platform validation
  if (!def.platform) {
    errors.push('Missing platform section');
  } else {
    if (!def.platform.provider) errors.push('Missing platform.provider');
    const validProviders = ['claude', 'factory', 'copilot', 'cursor', 'codex', 'warp', 'devin'];
    if (def.platform.provider && !validProviders.includes(def.platform.provider)) {
      errors.push(`Invalid platform.provider: ${def.platform.provider}`);
    }
  }

  // Agent config validation
  if (!def.agent_config) {
    errors.push('Missing agent_config section');
  } else {
    if (!Array.isArray(def.agent_config.models) || def.agent_config.models.length === 0) {
      errors.push('agent_config.models must be a non-empty array');
    } else {
      const validModels = ['haiku', 'sonnet', 'opus'];
      for (const model of def.agent_config.models) {
        if (!validModels.includes(model)) {
          errors.push(`Invalid model: ${model}`);
        }
      }
    }
    if (!def.agent_config.tools?.available || !Array.isArray(def.agent_config.tools.available)) {
      errors.push('agent_config.tools.available must be an array');
    }
  }

  // Skill config validation
  if (!def.skill_config) {
    errors.push('Missing skill_config section');
  } else {
    if (typeof def.skill_config.supported !== 'boolean') {
      errors.push('skill_config.supported must be a boolean');
    }
  }

  // Command config validation
  if (!def.command_config) {
    errors.push('Missing command_config section');
  } else {
    if (typeof def.command_config.supported !== 'boolean') {
      errors.push('command_config.supported must be a boolean');
    }
  }

  // Deployment paths validation
  if (!def.deployment_paths) {
    errors.push('Missing deployment_paths section');
  } else {
    if (!def.deployment_paths.agents) errors.push('Missing deployment_paths.agents');
    if (!def.deployment_paths.skills) errors.push('Missing deployment_paths.skills');
    if (!def.deployment_paths.commands) errors.push('Missing deployment_paths.commands');
  }

  return errors;
}

function validateAgenticCatalog(catalog: AgenticCatalog): string[] {
  const errors: string[] = [];

  if (!catalog.version) errors.push('Missing catalog version');
  if (!catalog.last_updated) errors.push('Missing last_updated timestamp');
  if (!Array.isArray(catalog.artifacts)) errors.push('artifacts must be an array');

  for (const artifact of catalog.artifacts || []) {
    if (!artifact.name) errors.push('Artifact missing name');
    if (!artifact.version) errors.push(`Artifact ${artifact.name} missing version`);
    if (!artifact.description) errors.push(`Artifact ${artifact.name} missing description`);
    if (!artifact.deployed_path) errors.push(`Artifact ${artifact.name} missing deployed_path`);
  }

  if (typeof catalog.capability_index !== 'object') {
    errors.push('capability_index must be an object');
  }

  return errors;
}

describe('AgenticDefinition', () => {
  describe('Schema Validation', () => {
    it('should validate a complete agentic definition', () => {
      const validDef: AgenticDefinition = {
        platform: {
          provider: 'claude',
          version: '2025.12',
          detected_at: '2025-12-13',
        },
        agent_config: {
          models: ['haiku', 'sonnet', 'opus'],
          default_model: 'sonnet',
          tools: {
            available: ['Read', 'Write', 'Bash', 'Glob', 'Grep'],
            orchestration_default: ['Task', 'Read', 'Write', 'TodoWrite'],
          },
        },
        skill_config: {
          supported: true,
          structure: 'directory',
          filename: 'SKILL.md',
        },
        command_config: {
          supported: true,
          categories: ['development', 'utilities'],
        },
        deployment_paths: {
          agents: '.claude/agents/',
          skills: '.claude/skills/',
          commands: '.claude/commands/',
        },
        capabilities: {
          can_create_agents: true,
          can_create_skills: true,
          can_create_commands: true,
        },
      };

      const errors = validateAgenticDefinition(validDef);
      expect(errors).toHaveLength(0);
    });

    it('should reject missing platform section', () => {
      const invalidDef = {
        agent_config: {
          models: ['sonnet'],
          tools: { available: ['Read'] },
        },
        skill_config: { supported: true },
        command_config: { supported: true },
        deployment_paths: {
          agents: '.claude/agents/',
          skills: '.claude/skills/',
          commands: '.claude/commands/',
        },
      } as AgenticDefinition;

      const errors = validateAgenticDefinition(invalidDef);
      expect(errors).toContain('Missing platform section');
    });

    it('should reject invalid platform provider', () => {
      const invalidDef: AgenticDefinition = {
        platform: { provider: 'unknown' },
        agent_config: {
          models: ['sonnet'],
          tools: { available: ['Read'] },
        },
        skill_config: { supported: true },
        command_config: { supported: true },
        deployment_paths: {
          agents: '.claude/agents/',
          skills: '.claude/skills/',
          commands: '.claude/commands/',
        },
      };

      const errors = validateAgenticDefinition(invalidDef);
      expect(errors.some((e) => e.includes('Invalid platform.provider'))).toBe(true);
    });

    it('should reject invalid model names', () => {
      const invalidDef: AgenticDefinition = {
        platform: { provider: 'claude' },
        agent_config: {
          models: [LEGACY_MODELS.gpt4, 'claude-3'],
          tools: { available: ['Read'] },
        },
        skill_config: { supported: true },
        command_config: { supported: true },
        deployment_paths: {
          agents: '.claude/agents/',
          skills: '.claude/skills/',
          commands: '.claude/commands/',
        },
      };

      const errors = validateAgenticDefinition(invalidDef);
      expect(errors.some((e) => e.includes('Invalid model'))).toBe(true);
    });

    it('should require deployment paths', () => {
      const invalidDef: AgenticDefinition = {
        platform: { provider: 'claude' },
        agent_config: {
          models: ['sonnet'],
          tools: { available: ['Read'] },
        },
        skill_config: { supported: true },
        command_config: { supported: true },
        deployment_paths: {
          agents: '',
          skills: '',
          commands: '',
        },
      };

      const errors = validateAgenticDefinition(invalidDef);
      expect(errors.some((e) => e.includes('deployment_paths'))).toBe(true);
    });
  });

  describe('Real Agentic Definition', () => {
    const defPath = path.join(
      process.cwd(),
      '.aiwg/smiths/agentic-definition.yaml'
    );

    it('should load the actual agentic definition if it exists', () => {
      if (!fs.existsSync(defPath)) {
        console.log('Skipping: agentic-definition.yaml not found');
        return;
      }

      const content = fs.readFileSync(defPath, 'utf8');
      const def = yaml.load(content) as AgenticDefinition;

      const errors = validateAgenticDefinition(def);
      expect(errors).toHaveLength(0);
    });
  });
});

describe('AgenticCatalog', () => {
  describe('Schema Validation', () => {
    it('should validate an empty catalog', () => {
      const emptyCatalog: AgenticCatalog = {
        version: '1.0.0',
        last_updated: '2025-12-13',
        artifacts: [],
        capability_index: {},
      };

      const errors = validateAgenticCatalog(emptyCatalog);
      expect(errors).toHaveLength(0);
    });

    it('should validate a catalog with artifacts', () => {
      const catalog: AgenticCatalog = {
        version: '1.0.0',
        last_updated: '2025-12-13',
        artifacts: [
          {
            name: 'security-reviewer',
            version: '1.0.0',
            description: 'Reviews code for security vulnerabilities',
            spec_path: 'specs/security-reviewer.yaml',
            deployed_path: '.claude/agents/security-reviewer.md',
            created: '2025-12-13',
            tags: ['security', 'code-review'],
            capabilities: ['OWASP review', 'Injection detection'],
          },
        ],
        capability_index: {
          'security review': 'security-reviewer',
          'check vulnerabilities': 'security-reviewer',
        },
      };

      const errors = validateAgenticCatalog(catalog);
      expect(errors).toHaveLength(0);
    });

    it('should reject artifacts with missing required fields', () => {
      const invalidCatalog: AgenticCatalog = {
        version: '1.0.0',
        last_updated: '2025-12-13',
        artifacts: [
          {
            name: 'incomplete',
            version: '',
            description: '',
            deployed_path: '',
          },
        ],
        capability_index: {},
      };

      const errors = validateAgenticCatalog(invalidCatalog);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Real Catalogs', () => {
    const catalogPaths = [
      '.aiwg/smiths/agentsmith/catalog.yaml',
      '.aiwg/smiths/skillsmith/catalog.yaml',
      '.aiwg/smiths/commandsmith/catalog.yaml',
    ];

    for (const catalogPath of catalogPaths) {
      const fullPath = path.join(process.cwd(), catalogPath);
      const smithName = catalogPath.split('/')[2];

      it(`should load ${smithName} catalog if it exists`, () => {
        if (!fs.existsSync(fullPath)) {
          console.log(`Skipping: ${catalogPath} not found`);
          return;
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        const catalog = yaml.load(content) as AgenticCatalog;

        const errors = validateAgenticCatalog(catalog);
        expect(errors).toHaveLength(0);
      });
    }
  });
});

describe('Agent Specification', () => {
  interface AgentSpec {
    name: string;
    version: string;
    description: string;
    created?: string;
    agent: {
      model: string;
      tools: string[];
      category?: string;
      orchestration?: boolean;
    };
    capabilities?: string[];
    operating_rhythm?: string[];
    tags?: string[];
  }

  function validateAgentSpec(spec: AgentSpec): string[] {
    const errors: string[] = [];

    if (!spec.name) errors.push('Missing spec name');
    if (!spec.version) errors.push('Missing spec version');
    if (!spec.description) errors.push('Missing spec description');

    if (!spec.agent) {
      errors.push('Missing agent section');
    } else {
      if (!spec.agent.model) errors.push('Missing agent.model');
      const validModels = ['haiku', 'sonnet', 'opus'];
      if (spec.agent.model && !validModels.includes(spec.agent.model)) {
        errors.push(`Invalid agent.model: ${spec.agent.model}`);
      }
      if (!Array.isArray(spec.agent.tools)) {
        errors.push('agent.tools must be an array');
      }
    }

    if (!spec.tags?.length) {
      errors.push('Spec must have at least one tag');
    }

    return errors;
  }

  describe('Schema Validation', () => {
    it('should validate a complete agent specification', () => {
      const validSpec: AgentSpec = {
        name: 'security-reviewer',
        version: '1.0.0',
        description: 'Reviews code for security vulnerabilities',
        created: '2025-12-13',
        agent: {
          model: 'sonnet',
          tools: ['Read', 'Grep', 'Glob'],
          category: 'security',
          orchestration: false,
        },
        capabilities: ['OWASP review', 'Injection detection'],
        operating_rhythm: ['Analyze files', 'Check patterns', 'Report issues'],
        tags: ['security', 'code-review'],
      };

      const errors = validateAgentSpec(validSpec);
      expect(errors).toHaveLength(0);
    });

    it('should reject invalid model', () => {
      const invalidSpec: AgentSpec = {
        name: 'test-agent',
        version: '1.0.0',
        description: 'Test',
        agent: {
          model: LEGACY_MODELS.gpt4,
          tools: ['Read'],
        },
        tags: ['test'],
      };

      const errors = validateAgentSpec(invalidSpec);
      expect(errors.some((e) => e.includes('Invalid agent.model'))).toBe(true);
    });

    it('should require at least one tag', () => {
      const specNoTags: AgentSpec = {
        name: 'test-agent',
        version: '1.0.0',
        description: 'Test',
        agent: {
          model: 'sonnet',
          tools: ['Read'],
        },
        tags: [],
      };

      const errors = validateAgentSpec(specNoTags);
      expect(errors.some((e) => e.includes('at least one tag'))).toBe(true);
    });
  });
});

describe('Skill Specification', () => {
  interface SkillSpec {
    name: string;
    version: string;
    description: string;
    created?: string;
    skill: {
      tools?: string[];
      auto_trigger?: boolean;
    };
    triggers: string[];
    process?: string[];
    tags?: string[];
  }

  function validateSkillSpec(spec: SkillSpec): string[] {
    const errors: string[] = [];

    if (!spec.name) errors.push('Missing spec name');
    if (!spec.version) errors.push('Missing spec version');
    if (!spec.description) errors.push('Missing spec description');

    if (!spec.triggers?.length) {
      errors.push('Skill must have at least one trigger phrase');
    }

    if (!spec.tags?.length) {
      errors.push('Spec must have at least one tag');
    }

    return errors;
  }

  describe('Schema Validation', () => {
    it('should validate a complete skill specification', () => {
      const validSpec: SkillSpec = {
        name: 'json-yaml-converter',
        version: '1.0.0',
        description: 'Converts JSON to YAML format',
        created: '2025-12-13',
        skill: {
          tools: ['Read', 'Write'],
          auto_trigger: false,
        },
        triggers: ['convert JSON to YAML', 'JSON to YAML', 'make this YAML'],
        process: ['Parse JSON', 'Convert to YAML', 'Output result'],
        tags: ['transformation', 'json', 'yaml'],
      };

      const errors = validateSkillSpec(validSpec);
      expect(errors).toHaveLength(0);
    });

    it('should require at least one trigger', () => {
      const specNoTriggers: SkillSpec = {
        name: 'test-skill',
        version: '1.0.0',
        description: 'Test',
        skill: {},
        triggers: [],
        tags: ['test'],
      };

      const errors = validateSkillSpec(specNoTriggers);
      expect(errors.some((e) => e.includes('at least one trigger'))).toBe(true);
    });
  });
});

describe('Command Specification', () => {
  interface CommandSpec {
    name: string;
    version: string;
    description: string;
    created?: string;
    command: {
      category: string;
      model: string;
      allowed_tools: string[];
      orchestration?: boolean;
    };
    arguments?: Array<{
      name: string;
      type: string;
      required?: boolean;
      description: string;
    }>;
    workflow?: string[];
    tags?: string[];
  }

  function validateCommandSpec(spec: CommandSpec): string[] {
    const errors: string[] = [];

    if (!spec.name) errors.push('Missing spec name');
    if (!spec.version) errors.push('Missing spec version');
    if (!spec.description) errors.push('Missing spec description');

    if (!spec.command) {
      errors.push('Missing command section');
    } else {
      if (!spec.command.category) errors.push('Missing command.category');
      if (!spec.command.model) errors.push('Missing command.model');
      const validModels = ['haiku', 'sonnet', 'opus'];
      if (spec.command.model && !validModels.includes(spec.command.model)) {
        errors.push(`Invalid command.model: ${spec.command.model}`);
      }
      if (!Array.isArray(spec.command.allowed_tools)) {
        errors.push('command.allowed_tools must be an array');
      }
    }

    if (!spec.tags?.length) {
      errors.push('Spec must have at least one tag');
    }

    return errors;
  }

  describe('Schema Validation', () => {
    it('should validate a complete command specification', () => {
      const validSpec: CommandSpec = {
        name: 'lint-fix',
        version: '1.0.0',
        description: 'Run linter and auto-fix issues',
        created: '2025-12-13',
        command: {
          category: 'development',
          model: 'haiku',
          allowed_tools: ['Bash', 'Read', 'Write'],
          orchestration: false,
        },
        arguments: [
          {
            name: 'target',
            type: 'path',
            required: false,
            description: 'Target directory',
          },
        ],
        workflow: ['Detect linter', 'Run linter', 'Report results'],
        tags: ['lint', 'code-quality'],
      };

      const errors = validateCommandSpec(validSpec);
      expect(errors).toHaveLength(0);
    });

    it('should reject invalid model', () => {
      const invalidSpec: CommandSpec = {
        name: 'test-command',
        version: '1.0.0',
        description: 'Test',
        command: {
          category: 'utilities',
          model: LEGACY_MODELS.gpt4,
          allowed_tools: ['Read'],
        },
        tags: ['test'],
      };

      const errors = validateCommandSpec(invalidSpec);
      expect(errors.some((e) => e.includes('Invalid command.model'))).toBe(true);
    });

    it('should require category', () => {
      const specNoCategory: CommandSpec = {
        name: 'test-command',
        version: '1.0.0',
        description: 'Test',
        command: {
          category: '',
          model: 'haiku',
          allowed_tools: ['Read'],
        },
        tags: ['test'],
      };

      const errors = validateCommandSpec(specNoCategory);
      expect(errors.some((e) => e.includes('command.category'))).toBe(true);
    });
  });
});
