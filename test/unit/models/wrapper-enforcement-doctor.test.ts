// Exercise actual artifact controls independently of generated defaults.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deployedWrapperEnforcement, isConcreteWrapperModel, wrapperEnforcementReport,
  wrapperModelRisks } from '../../../src/models/wrapper-enforcement.js';
import { loadProviderModelCatalog } from '../../../src/models/catalog-policy.js';

describe('doctor wrapper enforcement', () => {
  it('accepts only the configured sole Muse model as an election (#4325)', () => {
    expect(wrapperModelRisks('muse', { inheritedModel: 'muse-spark-1.3' })).toEqual([]);
    expect(wrapperModelRisks('muse', {})).toEqual(['delegation.unresolved-model']);
    expect(wrapperModelRisks('muse', { model: 'muse-spark-1.3' })).toEqual(['delegation.unresolved-model']);
    expect(wrapperModelRisks('muse', { inheritedModel: 'gpt-6-astra' })).toEqual(['delegation.flagship-inheritance']);
    const catalog = structuredClone(loadProviderModelCatalog());
    catalog.providers.muse!.roles.coding.id = 'another-muse-model';
    expect(wrapperModelRisks('muse', { inheritedModel: 'muse-spark-1.3' }, catalog))
      .toEqual(['delegation.flagship-inheritance']);
    catalog.providers.muse!.roles.coding.id = 'muse-spark-1.3';
    catalog.providers.muse!.tiers = structuredClone(catalog.providers.codex!.tiers);
    expect(wrapperModelRisks('muse', { inheritedModel: 'muse-spark-1.3' }, catalog))
      .toEqual(['delegation.flagship-inheritance']);
    delete catalog.providers.muse!.tiers;
    for (const role of Object.values(catalog.providers.muse!.roles)) role.id = 'gpt-6-astra';
    expect(wrapperModelRisks('muse', { inheritedModel: 'gpt-6-astra' }, catalog))
      .toEqual(['delegation.flagship-inheritance']);
  });

  it('distinguishes observed pins from inherited model and effort', () => {
    expect(deployedWrapperEnforcement('codex', { model: 'custom-model', effort: 'medium', inheritedModel: 'gpt-6-astra' }))
      .toEqual({ model: 'pinned', effort: 'pinned', effectiveModel: 'custom-model', effectiveEffort: 'medium' });
    expect(deployedWrapperEnforcement('codex', { inheritedModel: 'gpt-6-luna', inheritedEffort: 'low' }))
      .toEqual({ model: 'inherited', effort: 'inherited', effectiveModel: 'gpt-6-luna', effectiveEffort: 'low' });
    expect(deployedWrapperEnforcement('codex', { model: 'custom-model', effort: 'bogus' }).effort).toBe('inherited');
    expect(deployedWrapperEnforcement('copilot', { model: 'custom-model', effort: 'high' }).effort).toBe('inherited');
    expect(deployedWrapperEnforcement('unknown', {}).model).toBe('inherited');
    expect(deployedWrapperEnforcement('claude', { effort: 'xhigh' }).effort).toBe('inherited');
    expect(deployedWrapperEnforcement('codex', { effort: 'xhigh' }).effort).toBe('pinned');
  });

  it.each(['hermes', 'warp', 'muse', 'grokbot'])('does not mistake mirror fields for native pins on %s', provider => {
    expect(deployedWrapperEnforcement(provider, { model: 'custom-model', effort: 'high', inheritedModel: 'global-model' }))
      .toMatchObject({ model: 'global-only', effort: 'global-only', effectiveModel: 'global-model' });
  });

  it('uses the existing report format for observed artifact model and effort', () => {
    expect(wrapperEnforcementReport('codex', { model: 'custom-model', effort: 'high' }))
      .toContain('Tier enforcement (deployed wrapper): pinned; effort: pinned via model_reasoning_effort.');
    expect(wrapperEnforcementReport('codex', {})).toContain('): inherited; effort: inherited.');
    expect(wrapperEnforcementReport('hermes', {})).toContain('): global-only; effort: global-only.');
  });

  it.each([' ', 'unknown', 'unresolved', 'placeholder', 'TODO', '${MODEL}', '<model>', 'configured/coding', 'Hint(role)'])(
    'flags unresolved value %s', model => {
      expect(isConcreteWrapperModel(model)).toBe(false);
      expect(wrapperModelRisks('codex', { model, inheritedModel: 'gpt-6-luna' }))
        .toContain('delegation.unresolved-model');
    });

  it('flags a missing effective model, including unknown providers', () => {
    expect(wrapperModelRisks('codex', {})).toEqual(['delegation.unresolved-model']);
    expect(wrapperModelRisks('unknown', { inheritedModel: 'gpt-6-astra' }))
      .toEqual(['delegation.flagship-inheritance']);
  });

  it('flags a premium model only when inherited, since pinning it is the normal ladder', () => {
    expect(wrapperModelRisks('codex', { inheritedModel: 'gpt-6.1-sol' })).toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('codex', { model: 'gpt-6.1-sol' })).toEqual([]);
  });

  it('flags a pinned flagship model', () => {
    expect(wrapperModelRisks('codex', { inheritedModel: 'gpt-6-astra' })).toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('codex', { model: 'gpt-6-astra' })).toEqual(['delegation.flagship-inheritance']);
  });

  it.each(['gpt-6-astra', 'gpt-6.1-sol'])('exempts elected or allowlisted model %s', inheritedModel => {
    expect(wrapperModelRisks('codex', { model: inheritedModel, agentName: 'worker', flagshipAllowlist: ['worker'] })).toEqual([]);
    expect(wrapperModelRisks('codex', { model: inheritedModel, election: 'user' })).toEqual([]);
    expect(wrapperModelRisks('codex', { inheritedModel, election: 'user' })).toEqual([]);
    expect(wrapperModelRisks('codex', { inheritedModel, agentName: 'worker', flagshipAllowlist: ['worker'] })).toEqual([]);
    expect(wrapperModelRisks('codex', { inheritedModel, agentName: 'other', flagshipAllowlist: ['worker'] }))
      .toEqual(['delegation.flagship-inheritance']);
  });

  it.each([
    ['hermes', 'delegation.model', 'delegation.effort'],
    ['warp', '--model', 'effort: unavailable'],
    ['muse', '--model', '--reasoning-effort'],
    ['grokbot', 'model: unavailable', 'effort: unavailable'],
  ])('names native global controls in doctor for %s', (provider, model, effort) => {
    // The guide describes the AIWG side and links the provider inventory; doctor names the native settings.
    const docs = readFileSync(new URL('../../../docs/configuration/model-configuration.md', import.meta.url), 'utf8');
    expect(docs).toContain('(../providers/provider-inventory.md)');
    expect(wrapperEnforcementReport(provider)).toContain(model);
    expect(wrapperEnforcementReport(provider)).toContain(effort);
  });

  it('accounts for forced Claude fallback, premium aliases and global-only inheritance', () => {
    expect(wrapperModelRisks('claude', { model: 'sonnet', inheritedModel: 'opus', forceInheritedModel: true }))
      .toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('claude', { model: 'sonnet', inheritedModel: 'opus' })).toEqual([]);
    expect(wrapperModelRisks('hermes', { model: 'cheap', inheritedModel: 'gpt-6-astra' }))
      .toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('hermes', { inheritedModel: 'openai/gpt-6.1-sol' }))
      .toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('hermes', { inheritedModel: 'global-delegation-model' }))
      .toEqual(['delegation.unresolved-model']);
    expect(wrapperModelRisks('codex', { inheritedModel: 'gpt-6-luna' })).toEqual([]);
  });

  it('keeps a wrapper pinned to its premium role default clean, but never a pinned flagship', () => {
    expect(wrapperModelRisks('claude', { model: 'opus' })).toEqual([]);
    expect(wrapperModelRisks('claude', { model: 'claude-opus-5-5' })).toEqual([]);
    expect(wrapperModelRisks('codex', { model: 'gpt-6.1-sol' })).toEqual([]);
    expect(wrapperModelRisks('claude', { model: 'claude-fable-5-1' })).toEqual(['delegation.flagship-inheritance']);
    expect(wrapperModelRisks('codex', { model: 'gpt-6-astra' })).toEqual(['delegation.flagship-inheritance']);
  });
});
