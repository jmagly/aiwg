// Verifies discovery role selection against current tier families and the user-elected flagship policy.
import { describe, expect, it } from 'vitest';
import { selectRoleModels } from '../../../src/models/model-discovery.js';

const efforts = (count: number) => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].slice(0, count);

describe('selectRoleModels tier families (#2642)', () => {
  // Shape of Codex `model/list` observed 2026-09-21 (codex-cli 0.155.1).
  const codexList = [
    { id: 'gpt-5.6-sol', reasoningEfforts: efforts(6), isDefault: true },
    { id: 'gpt-6-astra', reasoningEfforts: efforts(6) },
    { id: 'gpt-reserve', reasoningEfforts: efforts(5), hidden: true },
    { id: 'gpt-5.6-terra', reasoningEfforts: efforts(6) },
    { id: 'gpt-5.6-luna', reasoningEfforts: efforts(5) },
    { id: 'gpt-5.5', reasoningEfforts: efforts(4) },
  ];

  it('maps the Codex ladder to premium/standard/economy without the flagship', () => {
    const selected = selectRoleModels(codexList);
    expect(selected.reasoning?.id).toBe('gpt-5.6-sol');
    expect(selected.coding?.id).toBe('gpt-5.6-terra');
    expect(selected.efficiency?.id).toBe('gpt-5.6-luna');
  });

  it('never assigns a flagship even when the provider marks it default', () => {
    const flagshipDefault = codexList.map(model => ({ ...model, isDefault: model.id === 'gpt-6-astra' }));
    const ids = Object.values(selectRoleModels(flagshipDefault)).map(model => model?.id);
    expect(ids).not.toContain('gpt-6-astra');
  });

  it('maps a Claude-style list and excludes Fable', () => {
    const selected = selectRoleModels([
      { id: 'anthropic/claude-fable-5-1', reasoningEfforts: efforts(6) },
      { id: 'anthropic/claude-opus-5', reasoningEfforts: efforts(5) },
      { id: 'anthropic/claude-sonnet-5', reasoningEfforts: efforts(5), isDefault: true },
      { id: 'anthropic/claude-haiku-4-5', reasoningEfforts: efforts(3) },
    ]);
    expect(selected).toMatchObject({
      reasoning: { id: 'anthropic/claude-opus-5' },
      coding: { id: 'anthropic/claude-sonnet-5' },
      efficiency: { id: 'anthropic/claude-haiku-4-5' },
    });
  });

  it('returns no roles when only flagship models are visible', () => {
    expect(selectRoleModels([{ id: 'gpt-6-astra' }, { id: 'claude-fable-5-1' }])).toEqual({});
  });

  it('does not treat substrings such as "solution" as a premium family', () => {
    const selected = selectRoleModels([
      { id: 'vendor/solution-small', reasoningEfforts: efforts(1) },
      { id: 'vendor/deep-reason', reasoningEfforts: efforts(3) },
    ]);
    expect(selected.reasoning?.id).toBe('vendor/deep-reason');
  });
});
