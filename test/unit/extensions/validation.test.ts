/**
 * Unit Tests for Extension Validation Schemas
 *
 * Tests Zod schemas for all extension types with valid and invalid cases.
 *
 * @source @src/extensions/validation.ts
 * @architecture @docs/architecture/cli/extending-cli.md
 * @requirement @.aiwg/requirements/use-cases/UC-003-extension-validation.md
 */

import { describe, it, expect } from 'vitest';
import {
  validateExtension,
  isValidExtension,
  validateExtensionStrict,
  validateExtensionMetadata,
  formatValidationErrors,
  isExtensionType,
  ExtensionSchema,
  AgentMetadataSchema,
  CommandMetadataSchema,
  SkillMetadataSchema,
  PlatformCompatibilitySchema,
  DeploymentConfigSchema,
  validateSkillFrontmatter,
} from '../../../src/extensions/validation.js';
import { CLAUDE_MODELS } from '../../fixtures/models.js';
import type { Extension } from '../../../src/extensions/types.js';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import { ZodError } from 'zod';

// ============================================
// Test Fixtures
// ============================================

const validAgentExtension: Extension = {
  id: 'api-designer',
  type: 'agent',
  name: 'API Designer',
  description: 'Designs RESTful APIs with OpenAPI specifications',
  version: '1.0.0',
  capabilities: ['api-design', 'openapi', 'rest'],
  keywords: ['api', 'design', 'openapi', 'rest'],
  category: 'sdlc/architecture',
  platforms: {
    claude: 'full',
    cursor: 'partial',
  },
  deployment: {
    pathTemplate: '.{platform}/agents/{id}.md',
    core: true,
  },
  metadata: {
    type: 'agent',
    role: 'API Design and Contract Definition',
    model: {
      tier: 'sonnet',
    },
    tools: ['Read', 'Write', 'Grep'],
    template: 'complex',
    maxTools: 10,
    canDelegate: false,
    readOnly: false,
  },
  author: 'AIWG Contributors',
  license: 'MIT',
};

const validCommandExtension: Extension = {
  id: 'mention-wire',
  type: 'command',
  name: 'Mention Wire',
  description: 'Wire @-mention traceability across artifacts',
  version: '2026.1.5',
  capabilities: ['traceability', 'validation'],
  keywords: ['traceability', 'mention', 'validation'],
  platforms: {
    claude: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
  },
  metadata: {
    type: 'command',
    template: 'utility',
    argumentHint: '[pattern]',
    allowedTools: ['Read', 'Write', 'Grep', 'Glob'],
    model: 'sonnet',
  },
};

const validSkillExtension: Extension = {
  id: 'status-check',
  type: 'skill',
  name: 'Status Check',
  description: 'Check current project status and next steps',
  version: '1.0.0',
  capabilities: ['status', 'navigation'],
  keywords: ['status', 'sdlc', 'navigation'],
  platforms: {
    claude: 'full',
    cursor: 'full',
  },
  deployment: {
    pathTemplate: '.{platform}/skills/{id}.md',
  },
  metadata: {
    type: 'skill',
    triggerPhrases: ["what's next?", 'project status', 'where are we?'],
    autoTrigger: false,
    tools: ['Read', 'Grep'],
  },
};

// ============================================
// Platform Compatibility Tests
// ============================================

describe('PlatformCompatibilitySchema', () => {
  it('validates platform compatibility with various configurations', () => {
    const testCases = [
      { input: { claude: 'full' as const, cursor: 'partial' as const, copilot: 'experimental' as const }, expected: true, desc: 'multiple platforms' },
      { input: { claude: 'full' as const }, expected: true, desc: 'single platform' },
      { input: {}, expected: false, desc: 'empty platforms' },
      { input: { claude: 'invalid-level' }, expected: false, desc: 'invalid support level' },
    ];

    testCases.forEach(({ input, expected, desc }) => {
      expect(PlatformCompatibilitySchema.safeParse(input).success).toBe(expected, `failed for ${desc}`);
    });
  });

  it('accepts pi and hermes (#3724)', () => {
    const result = PlatformCompatibilitySchema.safeParse({ claude: 'full', pi: 'full', hermes: 'full' });
    expect(result.success).toBe(true);
  });

  it('accepts every registered provider id (#3724)', () => {
    for (const id of PROVIDER_IDS) {
      const result = PlatformCompatibilitySchema.safeParse({ [id]: 'full' });
      expect(result.success).toBe(true, `provider '${id}' should be an accepted platform key`);
    }
    const all = Object.fromEntries(PROVIDER_IDS.map(id => [id, 'full']));
    expect(PlatformCompatibilitySchema.safeParse(all).success).toBe(true);
  });

  it('rejects an unknown platform key and names it (#3724)', () => {
    const result = PlatformCompatibilitySchema.safeParse({ claude: 'full', bogus: 'full' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(issue => issue.message).join('\n');
      expect(messages).toContain('bogus');
    }
  });
});

// ============================================
// Deployment Config Tests
// ============================================

describe('DeploymentConfigSchema', () => {
  it('validates deployment config and rejects invalid cases', () => {
    const testCases = [
      {
        input: {
          pathTemplate: '.{platform}/agents/{id}.md',
          pathOverrides: { claude: '.claude/agents/custom.md' },
          additionalFiles: ['references/patterns.md'],
          autoInstall: true,
          core: true,
        },
        expected: true,
        desc: 'valid full config'
      },
      { input: {}, expected: false, desc: 'missing pathTemplate' },
      { input: { pathTemplate: '' }, expected: false, desc: 'empty pathTemplate' },
    ];

    testCases.forEach(({ input, expected, desc }) => {
      expect(DeploymentConfigSchema.safeParse(input).success).toBe(expected, `failed for ${desc}`);
    });
  });

  it('sets default values', () => {
    const result = DeploymentConfigSchema.parse({
      pathTemplate: '.{platform}/agents/{id}.md',
    });
    expect(result.autoInstall).toBe(false);
    expect(result.core).toBe(false);
  });
});

// ============================================
// Agent Metadata Tests
// ============================================

describe('AgentMetadataSchema', () => {
  it('validates agent metadata with various model and tool configurations', () => {
    const baseMetadata = {
      type: 'agent' as const,
      role: 'API Designer',
      model: { tier: 'sonnet' as const },
      tools: ['Read', 'Write'],
    };

    const testCases = [
      { input: baseMetadata, expected: true, desc: 'basic valid metadata' },
      { input: { ...baseMetadata, tools: [] }, expected: false, desc: 'empty tools array' },
      { input: { ...baseMetadata, model: { tier: 'sonnet' as const, override: CLAUDE_MODELS.reasoning } }, expected: true, desc: 'model override' },
      { input: { ...baseMetadata, model: { tier: 'invalid' } }, expected: false, desc: 'invalid model tier' },
    ];

    testCases.forEach(({ input, expected, desc }) => {
      expect(AgentMetadataSchema.safeParse(input).success).toBe(expected, `failed for ${desc}`);
    });
  });

  it('accepts optional fields', () => {
    const valid = {
      type: 'agent' as const,
      role: 'API Designer',
      model: { tier: 'sonnet' as const },
      tools: ['Read'],
      maxTools: 10,
      canDelegate: true,
      readOnly: false,
      workflow: ['step1', 'step2'],
      expertise: ['apis', 'openapi'],
      responsibilities: ['design', 'document'],
    };
    expect(AgentMetadataSchema.safeParse(valid).success).toBe(true);
  });
});

// ============================================
// Command Metadata Tests
// ============================================

describe('CommandMetadataSchema', () => {
  it('validates command metadata with arguments and options', () => {
    const baseCommand = {
      type: 'command' as const,
      template: 'utility' as const,
    };

    const withArguments = {
      ...baseCommand,
      arguments: [{
        name: 'file',
        description: 'Input file',
        required: true,
        type: 'string' as const,
        position: 0,
      }],
    };

    const withOptions = {
      ...baseCommand,
      options: [{
        name: 'verbose',
        description: 'Verbose output',
        type: 'boolean' as const,
        short: 'v',
        long: 'verbose',
      }],
    };

    const invalidTemplate = {
      type: 'command' as const,
      template: 'invalid',
    };

    const invalidShort = {
      ...baseCommand,
      options: [{
        name: 'verbose',
        description: 'Verbose output',
        type: 'boolean' as const,
        short: 'vb', // Should be single character
      }],
    };

    expect(CommandMetadataSchema.safeParse(baseCommand).success).toBe(true, 'basic command');
    expect(CommandMetadataSchema.safeParse(withArguments).success).toBe(true, 'with arguments');
    expect(CommandMetadataSchema.safeParse(withOptions).success).toBe(true, 'with options');
    expect(CommandMetadataSchema.safeParse(invalidTemplate).success).toBe(false, 'invalid template');
    expect(CommandMetadataSchema.safeParse(invalidShort).success).toBe(false, 'multi-char short option');
  });
});

// ============================================
// Skill Metadata Tests
// ============================================

describe('SkillMetadataSchema', () => {
  it('validates skill metadata with trigger phrases', () => {
    const testCases = [
      { input: { type: 'skill' as const, triggerPhrases: ["what's next?", 'status'] }, expected: true, desc: 'valid basic' },
      { input: { type: 'skill' as const, triggerPhrases: [] }, expected: false, desc: 'empty trigger phrases' },
    ];

    testCases.forEach(({ input, expected, desc }) => {
      expect(SkillMetadataSchema.safeParse(input).success).toBe(expected, `failed for ${desc}`);
    });
  });

  it('accepts optional fields and sets defaults', () => {
    const result = SkillMetadataSchema.parse({
      type: 'skill' as const,
      triggerPhrases: ['status'],
    });
    expect(result.autoTrigger).toBe(false);

    const withOptionals = {
      type: 'skill' as const,
      triggerPhrases: ['status'],
      autoTrigger: true,
      autoTriggerConditions: ['phase === "implementation"'],
      tools: ['Read', 'Grep'],
      references: [{
        filename: 'status.md',
        description: 'Status guide',
        path: 'docs/status.md',
      }],
      inputRequirements: ['current phase'],
      outputFormat: 'markdown table',
    };
    expect(SkillMetadataSchema.safeParse(withOptionals).success).toBe(true);
  });
});

// ============================================
// Full Extension Tests
// ============================================

describe('ExtensionSchema', () => {
  it('validates all extension types', () => {
    [
      { input: validAgentExtension, type: 'agent' },
      { input: validCommandExtension, type: 'command' },
      { input: validSkillExtension, type: 'skill' },
    ].forEach(({ input, type }) => {
      const result = ExtensionSchema.safeParse(input);
      expect(result.success).toBe(true, `failed for ${type} extension`);
    });
  });

  it('validates ID and version formats', () => {
    const testCases = [
      { input: { ...validAgentExtension, id: 'InvalidID' }, expected: false, desc: 'non-kebab-case ID' },
      { input: { ...validAgentExtension, id: '1-invalid' }, expected: false, desc: 'ID starts with number' },
      { input: { ...validAgentExtension, version: 'v1.0' }, expected: false, desc: 'invalid version format' },
      { input: { ...validCommandExtension, version: '2026.1.5' }, expected: true, desc: 'CalVer format' },
    ];

    testCases.forEach(({ input, expected, desc }) => {
      expect(ExtensionSchema.safeParse(input).success).toBe(expected, `failed for ${desc}`);
    });
  });

  it('validates required arrays and type consistency', () => {
    const testCases = [
      { input: { ...validAgentExtension, capabilities: [] }, expected: false, desc: 'empty capabilities' },
      { input: { ...validAgentExtension, keywords: [] }, expected: false, desc: 'empty keywords' },
      {
        input: {
          ...validAgentExtension,
          type: 'command' as const,
          metadata: {
            type: 'agent' as const,
            role: 'API Designer',
            model: { tier: 'sonnet' as const },
            tools: ['Read'],
          },
        },
        expected: false,
        desc: 'type mismatch'
      },
    ];

    testCases.forEach(({ input, expected, desc }) => {
      expect(ExtensionSchema.safeParse(input).success).toBe(expected, `failed for ${desc}`);
    });
  });

  it('validates URLs', () => {
    const invalid = {
      ...validAgentExtension,
      repository: 'not-a-url',
    };
    expect(ExtensionSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts optional metadata fields and sets defaults', () => {
    const valid: Extension = {
      ...validAgentExtension,
      author: 'John Magly',
      license: 'Apache-2.0',
      repository: 'https://github.com/jmagly/aiwg',
      homepage: 'https://aiwg.io',
      bugs: 'https://github.com/jmagly/aiwg/issues',
      documentation: {
        readme: 'README.md',
        guide: 'docs/guide.md',
      },
      status: 'stable',
      requires: ['aiwg-utils'],
      recommends: ['voice-framework'],
      conflicts: ['legacy-agent'],
      systemDependencies: {
        'gh': '>=2.0.0',
      },
    };
    const result = ExtensionSchema.safeParse(valid);
    expect(result.success).toBe(true);

    const parsed = ExtensionSchema.parse(validAgentExtension);
    expect(parsed.status).toBe('stable', 'default status');
  });

  it('validates deprecation metadata', () => {
    const testCases = [
      {
        input: {
          ...validAgentExtension,
          status: 'deprecated' as const,
          deprecation: {
            date: '2026-01-13T12:00:00Z',
            successor: 'api-designer-v2',
            reason: 'Replaced by improved version',
          },
        },
        expected: true,
        desc: 'valid deprecation'
      },
      {
        input: {
          ...validAgentExtension,
          deprecation: {
            date: '2026-01-13', // Missing time
            reason: 'Deprecated',
          },
        },
        expected: false,
        desc: 'invalid date format'
      },
    ];

    testCases.forEach(({ input, expected, desc }) => {
      expect(ExtensionSchema.safeParse(input).success).toBe(expected, `failed for ${desc}`);
    });
  });

  it('accepts installation state and signature metadata', () => {
    const withInstallation = {
      ...validAgentExtension,
      installation: {
        installedAt: '2026-01-13T12:00:00Z',
        installedFrom: 'registry' as const,
        installedPath: '/home/user/.aiwg/extensions/api-designer',
        enabled: true,
      },
    };
    expect(ExtensionSchema.safeParse(withInstallation).success).toBe(true, 'installation state');

    const withSignature = {
      ...validAgentExtension,
      checksum: 'sha256:abc123...',
      signature: {
        algorithm: 'pgp' as const,
        value: 'signature-data',
        publicKey: 'public-key-data',
      },
    };
    expect(ExtensionSchema.safeParse(withSignature).success).toBe(true, 'signature metadata');
  });
});

// ============================================
// Validation Function Tests
// ============================================

describe('validateExtension', () => {
  it('validates extensions and returns appropriate results', () => {
    const validResult = validateExtension(validAgentExtension);
    expect(validResult.success).toBe(true);
    if (validResult.success) {
      expect(validResult.data.id).toBe('api-designer');
      expect(validResult.data.type).toBe('agent');
    }

    const invalidCases = [
      { input: { ...validAgentExtension, id: 'Invalid-ID', version: 'invalid' }, desc: 'multiple errors' },
      { input: { invalid: 'data' }, desc: 'completely invalid' },
      { input: null, desc: 'null' },
      { input: undefined, desc: 'undefined' },
    ];

    invalidCases.forEach(({ input, desc }) => {
      const result = validateExtension(input);
      expect(result.success).toBe(false, `failed for ${desc}`);
      if (!result.success) {
        expect(result.errors).toBeInstanceOf(ZodError);
      }
    });
  });
});

describe('isValidExtension', () => {
  it('validates and acts as type guard', () => {
    [validAgentExtension, validCommandExtension, validSkillExtension].forEach((ext) => {
      expect(isValidExtension(ext)).toBe(true, `failed for ${ext.type}`);
    });

    const invalid = { ...validAgentExtension, id: 'Invalid-ID' };
    expect(isValidExtension(invalid)).toBe(false);

    // Type guard check
    const data: unknown = validAgentExtension;
    if (isValidExtension(data)) {
      expect(data.id).toBe('api-designer');
      expect(data.name).toBe('API Designer');
    }
  });
});

describe('validateExtensionStrict', () => {
  it('returns validated data or throws', () => {
    const result = validateExtensionStrict(validAgentExtension);
    expect(result.id).toBe('api-designer');
    expect(result.type).toBe('agent');

    const invalid = { ...validAgentExtension, id: 'Invalid-ID' };
    expect(() => validateExtensionStrict(invalid)).toThrow(ZodError);
  });
});

describe('validateExtensionMetadata', () => {
  it('validates metadata for all extension types', () => {
    const testCases = [
      { input: validAgentExtension.metadata, expectedType: 'agent', desc: 'agent metadata' },
      { input: validCommandExtension.metadata, expectedType: 'command', desc: 'command metadata' },
      { input: { type: 'invalid' }, expectedType: null, desc: 'invalid metadata' },
    ];

    testCases.forEach(({ input, expectedType, desc }) => {
      const result = validateExtensionMetadata(input);
      if (expectedType) {
        expect(result.success).toBe(true, `failed for ${desc}`);
        if (result.success && result.data) {
          expect(result.data.type).toBe(expectedType);
        }
      } else {
        expect(result.success).toBe(false, `failed for ${desc}`);
      }
    });
  });
});

describe('formatValidationErrors', () => {
  it('formats errors with field paths', () => {
    const result = validateExtension({
      ...validAgentExtension,
      id: 'Invalid-ID',
      version: 'invalid',
    });

    if (!result.success) {
      const messages = formatValidationErrors(result.errors);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some(msg => msg.includes('id'))).toBe(true);
      expect(messages.some(msg => msg.includes('version'))).toBe(true);
    }
  });

  it('includes error messages', () => {
    const result = validateExtension({
      ...validAgentExtension,
      capabilities: [],
    });

    if (!result.success) {
      const messages = formatValidationErrors(result.errors);
      expect(messages.some(msg => msg.includes('capability'))).toBe(true);
    }
  });
});

describe('isExtensionType', () => {
  it('validates type consistency', () => {
    const agentValidated = validateExtensionStrict(validAgentExtension);
    expect(isExtensionType(agentValidated, 'agent')).toBe(true);
    expect(isExtensionType(agentValidated, 'command')).toBe(false);

    const commandValidated = validateExtensionStrict(validCommandExtension);
    expect(isExtensionType(commandValidated, 'command')).toBe(true);
    expect(isExtensionType(commandValidated, 'agent')).toBe(false);
  });
});

// ============================================
// Edge Cases & Error Conditions
// ============================================

describe('Edge Cases', () => {
  it('rejects empty strings and invalid numeric values', () => {
    const emptyStrings = {
      ...validAgentExtension,
      name: '',
      description: '',
    };
    expect(validateExtension(emptyStrings).success).toBe(false, 'empty strings');

    const negativeNumber = {
      ...validAgentExtension,
      metadata: {
        ...validAgentExtension.metadata,
        maxTools: -1,
      },
    };
    expect(validateExtension(negativeNumber).success).toBe(false, 'negative maxTools');
  });

  it('validates URLs and platform requirements', () => {
    const malformedUrls = {
      ...validAgentExtension,
      repository: 'not a url',
      homepage: 'also not a url',
    };
    expect(validateExtension(malformedUrls).success).toBe(false, 'malformed URLs');

    const emptyPlatforms = {
      ...validAgentExtension,
      platforms: {},
    };
    expect(validateExtension(emptyPlatforms).success).toBe(false, 'empty platforms');
  });

  it('enforces type consistency and deployment requirements', () => {
    const typeMismatch = {
      ...validAgentExtension,
      type: 'agent' as const,
      metadata: {
        type: 'command' as const,
        template: 'utility' as const,
      },
    };
    expect(validateExtension(typeMismatch).success).toBe(false, 'type mismatch');

    const emptyPathTemplate = {
      ...validAgentExtension,
      deployment: {
        pathTemplate: '',
      },
    };
    expect(validateExtension(emptyPathTemplate).success).toBe(false, 'empty pathTemplate');
  });
});

describe('validateSkillFrontmatter — empty-triggers guard (#1623)', () => {
  it('fails on a declared-but-empty triggers array', () => {
    const result = validateSkillFrontmatter({
      name: 'scaffold-extension',
      description: 'Create a new extension package',
      triggers: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.errors.issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/empty-triggers|declared but empty/i);
    }
  });

  it('fails when triggers contains a whitespace-only phrase', () => {
    const result = validateSkillFrontmatter({
      name: 'scaffold-extension',
      description: 'Create a new extension package',
      triggers: ['author an expansion', '   '],
    });
    expect(result.success).toBe(false);
  });

  it('passes with a non-empty triggers array', () => {
    const result = validateSkillFrontmatter({
      name: 'scaffold-extension',
      description: 'Create a new extension package',
      triggers: ['author an expansion', 'build an extension'],
    });
    expect(result.success).toBe(true);
  });

  it('passes when triggers is omitted entirely (guard targets empty, not absent)', () => {
    const result = validateSkillFrontmatter({
      name: 'some-skill',
      description: 'A skill that does not declare triggers',
    });
    expect(result.success).toBe(true);
  });
});
