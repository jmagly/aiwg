import { describe, expect, it } from 'vitest';
import {
  classifyModelRole,
  modelForRole,
} from '../../../tools/agents/providers/model-role.mjs';
import { shouldDeployAgent } from '../../../tools/agents/providers/base.mjs';
import { transformAgent as codexTransform } from '../../../tools/agents/providers/codex.mjs';
import { replaceModelFrontmatter as claudeTransform } from '../../../tools/agents/providers/claude.mjs';
import { replaceModelFrontmatter as warpTransform } from '../../../tools/agents/providers/warp.mjs';

const targetModels = {
  reasoning: 'reasoning-target',
  coding: 'coding-target',
  efficiency: 'efficiency-target',
};

function agent(model: string): string {
  return `---\nname: fixture\ndescription: Fixture agent\nmodel: ${model}\n---\n\nFixture instructions\n`;
}

describe('classifyModelRole', () => {
  it.each([
    ['opus', 'reasoning'],
    ['claude-opus-4-7', 'reasoning'],
    ['anthropic/claude-opus-4-6', 'reasoning'],
    ['sonnet', 'coding'],
    ['claude-sonnet-4-6', 'coding'],
    ['anthropic/claude-sonnet-4-6', 'coding'],
    ['haiku', 'efficiency'],
    ['claude-haiku-4-5-20251001', 'efficiency'],
    ['anthropic/claude-haiku-4-5', 'efficiency'],
    ['claude-opus-5', 'reasoning'],
    ['opus[1m]', 'reasoning'],
    ['claude-sonnet-5', 'coding'],
    ['fable', 'reasoning'],
    ['claude-fable-5-1', 'reasoning'],
    ['gpt-6-astra', 'reasoning'],
    ['gpt-5.6-sol', 'reasoning'],
    ['gpt-5.6-terra', 'coding'],
    ['gpt-5.6-luna', 'efficiency'],
  ])('classifies %s as %s', (model, role) => {
    expect(classifyModelRole(model)).toBe(role);
  });

  it('keeps explicit unknown identifiers unknown', () => {
    expect(classifyModelRole('vendor/new-model')).toBe('unknown');
    expect(classifyModelRole('gpt-5.5')).toBe('unknown');
    for (const nearMiss of ['console', 'solution', 'lunar-model', 'terraform']) {
      expect(classifyModelRole(nearMiss)).toBe('unknown');
    }
    expect(modelForRole('vendor/new-model', targetModels)).toBeNull();
  });

  it('allows omitted legacy metadata to use an explicit default', () => {
    expect(classifyModelRole(undefined, { defaultRole: 'coding' })).toBe('coding');
  });
});

describe('shared deployment role classification', () => {
  it.each([
    ['claude-opus-4-7', 'reasoning'],
    ['claude-sonnet-4-6', 'coding'],
    ['claude-haiku-4-5', 'efficiency'],
  ])('filters pinned %s into the %s population', (model, role) => {
    expect(shouldDeployAgent('/tmp/fixture.md', { model }, { filterRole: role })).toBe(true);
    for (const other of ['reasoning', 'coding', 'efficiency'].filter(value => value !== role)) {
      expect(shouldDeployAgent('/tmp/fixture.md', { model }, { filterRole: other })).toBe(false);
    }
  });

  it('does not select an unknown explicit model as coding', () => {
    expect(shouldDeployAgent(
      '/tmp/fixture.md',
      { model: 'vendor/new-model' },
      { filterRole: 'coding' },
    )).toBe(false);
  });

  it.each([
    ['codex', (content: string) => codexTransform('fixture.md', content, {
      reasoningModel: targetModels.reasoning,
      codingModel: targetModels.coding,
      efficiencyModel: targetModels.efficiency,
    })],
    ['claude', (content: string) => claudeTransform(content, targetModels)],
    ['warp', (content: string) => warpTransform(content, targetModels)],
  ])('%s transforms pinned families distinctly and preserves unknown IDs', (_provider, transform) => {
    const expectedModel = (value: string) => _provider === 'codex'
      ? `model = "${value}"`
      : `model: ${value}`;
    expect(transform(agent('claude-opus-4-7'))).toContain(expectedModel('reasoning-target'));
    expect(transform(agent('claude-sonnet-4-6'))).toContain(expectedModel('coding-target'));
    expect(transform(agent('claude-haiku-4-5'))).toContain(expectedModel('efficiency-target'));
    expect(transform(agent('vendor/new-model'))).toContain(expectedModel('vendor/new-model'));
  });

  it('keeps the Codex fixture distribution split across all three roles', () => {
    const deployedModels = [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ].map(model => {
      const transformed = codexTransform('fixture.md', agent(model), {});
      return transformed.match(/^model\s*[=:]\s*\"?([^\"\n]+)\"?$/m)?.[1];
    });

    expect(new Set(deployedModels)).toEqual(new Set([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]));
  });
});
