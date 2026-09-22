/**
 * Tests for ModelResolver
 *
 * @source @src/models/resolver.ts
 * @source @src/models/config-loader.ts
 * @architecture @.aiwg/architecture/ADR-015-enhanced-model-selection.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { resolve } from 'path';
import { ModelResolver } from '../../../src/models/resolver.js';
import { routeModelTier } from '../../../src/models/router.js';
import type { UserProjectConfig } from '../../../src/models/types.js';
import {
  CLAUDE_MODELS,
  FLAGSHIP_MODELS,
  OPENAI_MODELS,
  LEGACY_MODELS,
  PROVIDERS,
} from '../../fixtures/models.js';

describe('ModelResolver', () => {
  let testDir: string;
  let resolver: ModelResolver;

  beforeEach(async () => {
    testDir = resolve(process.cwd(), 'test-temp-models');
    await mkdir(testDir, { recursive: true });
    // Point AIWG_HOME to project root so ConfigLoader finds models-v2.json
    process.env.AIWG_HOME = process.cwd();
  });

  afterEach(async () => {
    delete process.env.AIWG_HOME;
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('resolve', () => {
    it('should resolve agents with various configurations', async () => {
      const cases = [
        {
          name: 'default tier and role',
          options: {},
          agent: 'software-implementer',
          role: undefined,
          expected: {
            modelId: CLAUDE_MODELS.coding,
            provider: 'claude',
            tier: 'standard',
            role: 'coding',
          },
        },
        {
          name: 'explicit reasoning role',
          options: {},
          agent: 'architecture-designer',
          role: 'reasoning',
          expected: {
            modelId: CLAUDE_MODELS.reasoning,
            role: 'reasoning',
            tier: 'premium',
          },
        },
        {
          name: 'tier from CLI options',
          options: { tier: 'max-quality' },
          agent: 'software-implementer',
          role: 'coding',
          expected: {
            modelId: CLAUDE_MODELS.reasoning,
            tier: 'max-quality',
            source: 'cli',
          },
        },
        {
          name: 'unknown agent defaults to coding',
          options: {},
          agent: 'unknown-agent',
          role: undefined,
          expected: {
            role: 'coding',
            tier: 'standard',
          },
        },
      ];

      for (const tc of cases) {
        resolver = new ModelResolver(tc.options, testDir);
        const result = await resolver.resolve(tc.agent, tc.role);
        expect(result, tc.name).toBeDefined();
        for (const [key, value] of Object.entries(tc.expected)) {
          expect((result as any)[key], `${tc.name} - ${key}`).toBe(value);
        }
      }
    });

    it('should apply tier from agent frontmatter', async () => {
      resolver = new ModelResolver({}, testDir);

      const result = await resolver.resolve('software-implementer', 'coding', 'premium');

      expect(result.modelId).toBe(CLAUDE_MODELS.coding);
      expect(result.tier).toBe('premium');
      expect(result.source).toBe('agent');
    });

    it('should handle minimum tier requirements', async () => {
      // Test with minimums respected (default)
      resolver = new ModelResolver({ tier: 'economy' }, testDir);
      const withMinimums = await resolver.resolve('executive-orchestrator', 'reasoning');
      expect(withMinimums.tier).toBe('premium'); // Upgraded from economy
      expect(withMinimums.modelId).toBe(CLAUDE_MODELS.reasoning);

      // Test with minimums ignored
      resolver = new ModelResolver({ tier: 'economy', respectMinimums: false }, testDir);
      const withoutMinimums = await resolver.resolve('executive-orchestrator', 'reasoning');
      expect(withoutMinimums.tier).toBe('economy'); // Not upgraded
      expect(withoutMinimums.modelId).toBe(CLAUDE_MODELS.efficiency);
    });

    it('should use different provider when specified', async () => {
      resolver = new ModelResolver({ provider: 'openai', tier: 'standard' }, testDir);

      const result = await resolver.resolve('software-implementer', 'coding');

      expect(result.provider).toBe('openai');
      expect(result.modelId).toBe(OPENAI_MODELS.coding);
    });

    it('should handle project config overrides', async () => {
      const cases = [
        {
          name: 'tier override',
          config: {
            agentOverrides: {
              'software-implementer': {
                'model-tier': 'premium',
              },
            },
          },
          expectedTier: 'premium',
          expectedSource: 'agent',
        },
        {
          name: 'direct model override',
          config: {
            agentOverrides: {
              'software-implementer': {
                'model-override': LEGACY_MODELS.claudeOpusOld,
              },
            },
          },
          expectedModelId: LEGACY_MODELS.claudeOpusOld,
          expectedSource: 'agent',
        },
      ];

      for (const tc of cases) {
        await writeFile(
          resolve(testDir, 'models.json'),
          JSON.stringify(tc.config),
          'utf-8'
        );

        resolver = new ModelResolver({}, testDir);
        const result = await resolver.resolve('software-implementer', 'coding');

        if (tc.expectedTier) {
          expect(result.tier, tc.name).toBe(tc.expectedTier);
        }
        if (tc.expectedModelId) {
          expect(result.modelId, tc.name).toBe(tc.expectedModelId);
        }
        if (tc.expectedSource) {
          expect(result.source, tc.name).toBe(tc.expectedSource);
        }
      }
    });

    it('should determine role from agent category', async () => {
      resolver = new ModelResolver({}, testDir);

      const result = await resolver.resolve('architecture-designer');

      expect(result.role).toBe('reasoning');
      expect(result.tier).toBe('premium');
    });
  });

  describe('getModelInfo', () => {
    beforeEach(() => {
      resolver = new ModelResolver({}, testDir);
    });

    it('should get model info by ID or alias', async () => {
      const cases = [
        {
          name: 'exact ID',
          query: CLAUDE_MODELS.reasoning,
          expected: {
            id: CLAUDE_MODELS.reasoning,
            provider: 'claude',
            role: 'reasoning',
            contextWindow: 1000000,
          },
        },
        {
          name: 'alias',
          query: 'opus',
          expected: {
            id: CLAUDE_MODELS.reasoning,
          },
        },
        {
          name: 'with cost info',
          query: CLAUDE_MODELS.coding,
          expected: {
            costPer1kTokens: {
              input: 0.002,
              output: 0.01,
            },
          },
        },
      ];

      for (const tc of cases) {
        const info = await resolver.getModelInfo(tc.query);
        expect(info, tc.name).toBeDefined();
        for (const [key, value] of Object.entries(tc.expected)) {
          expect((info as any)?.[key], `${tc.name} - ${key}`).toEqual(value);
        }
      }
    });

    it('should return null for unknown model', async () => {
      const info = await resolver.getModelInfo('unknown-model');
      expect(info).toBeNull();
    });
  });

  describe('listModels', () => {
    beforeEach(() => {
      resolver = new ModelResolver({}, testDir);
    });

    it('should list models with filtering', async () => {
      // All models for default provider
      const allModels = await resolver.listModels();
      expect(allModels.length).toBeGreaterThan(0);
      expect(allModels.every((m) => m.provider === 'claude')).toBe(true);

      // Models for specific provider
      const openaiModels = await resolver.listModels('openai');
      expect(openaiModels.length).toBeGreaterThan(0);
      expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true);

      // Check all three roles are present
      const claudeModels = await resolver.listModels('claude');
      const roles = claudeModels.map((m) => m.role);
      expect(roles).toContain('reasoning');
      expect(roles).toContain('coding');
      expect(roles).toContain('efficiency');
    });

    it('should handle inherited providers', async () => {
      const models = await resolver.listModels('factory');

      // Factory inherits from claude
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.provider === 'factory')).toBe(true);
    });
  });

  describe('listTiers', () => {
    beforeEach(() => {
      resolver = new ModelResolver({}, testDir);
    });

    it('should list all tiers with metadata', async () => {
      const tiers = await resolver.listTiers();

      expect(tiers.length).toBe(4);
      expect(tiers.map((t) => t.tier)).toEqual([
        'economy',
        'standard',
        'premium',
        'max-quality',
      ]);

      const standardTier = tiers.find((t) => t.tier === 'standard');
      expect(standardTier?.description).toContain('Balanced');
      expect(standardTier?.costMultiplier).toBe(1.0);

      const economyTier = tiers.find((t) => t.tier === 'economy');
      expect(economyTier?.costMultiplier).toBe(0.1);

      const maxQualityTier = tiers.find((t) => t.tier === 'max-quality');
      expect(maxQualityTier?.costMultiplier).toBe(10.0);
    });
  });

  describe('tier role mapping', () => {
    it('should map tiers to correct models for each role', async () => {
      const cases = [
        {
          name: 'economy uses efficiency',
          tier: 'economy',
          assertions: [
            { role: 'reasoning', expected: CLAUDE_MODELS.efficiency },
            { role: 'coding', expected: CLAUDE_MODELS.efficiency },
          ],
        },
        {
          name: 'standard is balanced',
          tier: 'standard',
          assertions: [
            { role: 'reasoning', expected: CLAUDE_MODELS.coding },
            { role: 'coding', expected: CLAUDE_MODELS.coding },
            { role: 'efficiency', expected: CLAUDE_MODELS.efficiency },
          ],
        },
        {
          name: 'premium for high quality',
          tier: 'premium',
          assertions: [
            { role: 'reasoning', expected: CLAUDE_MODELS.reasoning },
            { role: 'coding', expected: CLAUDE_MODELS.coding },
          ],
        },
        {
          name: 'max-quality (explicitly elected flagship) for best',
          tier: 'max-quality',
          assertions: [
            { role: 'reasoning', expected: FLAGSHIP_MODELS.claude },
            { role: 'coding', expected: CLAUDE_MODELS.reasoning },
            { role: 'efficiency', expected: CLAUDE_MODELS.coding },
          ],
        },
      ];

      for (const tc of cases) {
        resolver = new ModelResolver({ tier: tc.tier as any }, testDir);
        for (const assertion of tc.assertions) {
          const result = await resolver.resolve('test-agent', assertion.role as any);
          expect(result.modelId, `${tc.name} - ${assertion.role}`).toBe(assertion.expected);
        }
      }
    });
  });

  describe('provider inheritance', () => {
    beforeEach(() => {
      resolver = new ModelResolver({ provider: 'factory' }, testDir);
    });

    it('should inherit models from parent provider', async () => {
      const result = await resolver.resolve('test-agent', 'coding');
      expect(result.modelId).toBe(CLAUDE_MODELS.coding);

      const models = await resolver.listModels('factory');
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id.startsWith('claude-'))).toBe(true);
    });
  });

  describe('project config precedence', () => {
    it('should use project defaults and custom tiers', async () => {
      // Test project default tier override
      const defaultConfig: UserProjectConfig = {
        defaults: {
          tier: 'premium',
        },
      };

      await writeFile(
        resolve(testDir, 'models.json'),
        JSON.stringify(defaultConfig),
        'utf-8'
      );

      resolver = new ModelResolver({}, testDir);
      const result1 = await resolver.resolve('software-implementer', 'coding');
      expect(result1.tier).toBe('premium');

      // Test custom tier definition
      const customTierConfig: UserProjectConfig = {
        customTiers: {
          'budget-dev': {
            description: 'Budget development tier',
            costMultiplier: 0.05,
            roleMapping: {
              reasoning: 'efficiency',
              coding: 'efficiency',
              efficiency: 'efficiency',
            },
          },
        },
      };

      await writeFile(
        resolve(testDir, 'models.json'),
        JSON.stringify(customTierConfig),
        'utf-8'
      );

      resolver = new ModelResolver({
        tier: 'budget-dev' as any,
        respectMinimums: false,
      }, testDir);

      const result2 = await resolver.resolve('software-implementer', 'reasoning');
      expect(result2.modelId).toBe(CLAUDE_MODELS.efficiency);
    });
  });

  describe('clearCache', () => {
    it('should clear resolver cache', async () => {
      resolver = new ModelResolver({}, testDir);

      await resolver.resolve('test-agent');
      resolver.clearCache();

      const result = await resolver.resolve('test-agent');
      expect(result).toBeDefined();
    });
  });

  describe('semantic config validation', () => {
    it('fails invalid project policy before resolution', async () => {
      await writeFile(
        resolve(testDir, 'models.json'),
        JSON.stringify({ defaults: { provider: 'unknown-provider', tier: 'free' } }),
        'utf-8',
      );
      resolver = new ModelResolver({}, testDir);
      await expect(resolver.resolve('software-implementer')).rejects.toThrow(
        /MODEL_POLICY_INVALID/,
      );
    });
  });
});

describe('routeModelTier', () => {
  it('routes deterministic work to Tier 0', () => {
    expect(routeModelTier({ deterministic: true })).toMatchObject({
      tier: 0,
      modelTier: null,
      requiresConfirmation: false,
      source: 'deterministic',
    });
  });

  it('routes complex work to Tier 2 with an escalation summary requirement', () => {
    expect(routeModelTier({ defaultTier: 1, complex: true })).toMatchObject({
      tier: 2,
      modelTier: 'standard',
      summaryRequired: true,
      requiresConfirmation: false,
      source: 'complexity',
    });
  });

  it('maps numeric tiers to the public deterministic/economy/standard/premium taxonomy', () => {
    expect(routeModelTier({ defaultTier: 1 }).modelTier).toBe('economy');
    expect(routeModelTier({ defaultTier: 2 }).modelTier).toBe('standard');
    expect(routeModelTier({ defaultTier: 3 }).modelTier).toBe('premium');
  });

  it('requires confirmation for high-impact or premium routing', () => {
    const decision = routeModelTier({ defaultTier: 1, highImpact: true });
    expect(decision.tier).toBe(3);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.summaryRequired).toBe(true);
    expect(decision.rationale.join(' ')).toMatch(/explicit human confirmation/i);
  });

  it('keeps unattended bots within max auto tier', () => {
    const decision = routeModelTier({ unattended: true, complex: true });
    expect(decision.tier).toBe(2);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.source).toBe('policy');
  });
});
