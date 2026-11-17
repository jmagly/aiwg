import { describe, expect, it } from 'vitest';
import { loadProviderModelCatalog } from '../../../src/models/catalog-policy.js';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import {
  isConcreteWrapperModel, resolveWrapperPin, wrapperControls, wrapperEnforcementReport,
} from '../../../src/models/wrapper-enforcement.js';

const [reasoning, coding, efficiency] = MODEL_WRAPPER_DEFINITIONS;

describe('wrapper enforcement', () => {
  it('exposes native controls per provider and none for unknown providers', () => {
    expect(wrapperControls('codex')).toEqual({ model: 'model', effort: 'model_reasoning_effort' });
    expect(wrapperControls('copilot')).toEqual({ model: 'model' });
    expect(wrapperControls('hermes')).toEqual({});
  });

  it.each(['auto', 'inherit', 'inherited', 'default', 'configured/x', 'profile-selected', undefined, ''])(
    'treats %j as a non-concrete model', value => expect(isConcreteWrapperModel(value)).toBe(false));
  it('treats a catalog id as a concrete model', () => expect(isConcreteWrapperModel('gpt-6-luna')).toBe(true));

  it('pins model and native effort for providers with both controls', () => {
    const pin = resolveWrapperPin('codex', reasoning);
    expect(pin).toMatchObject({ tier: 'premium', role: 'reasoning', effort: 'high', enforcement: 'pinned' });
    expect(pin.model).toBeTruthy();
  });

  it('falls back from an auto economy selection to the standard coding pin', () => {
    const catalog = structuredClone(loadProviderModelCatalog());
    catalog.providers.cursor.roles.efficiency.id = 'auto';
    const pin = resolveWrapperPin('cursor', efficiency, { catalog });
    expect(pin).toMatchObject({ tier: 'standard', role: 'coding', enforcement: 'pinned' });
    expect(pin.model).not.toBe('auto');
    expect(pin.effort).toBeUndefined();
  });

  it('pins the observed Cursor efficiency model without a fallback', () => {
    const catalog = loadProviderModelCatalog();
    const cursor = catalog.providers.cursor;
    expect(cursor.verifiedAt).toBe('2026-11-17');
    expect(Object.values(cursor.roles).every(row => row.observed)).toBe(true);
    expect(Object.fromEntries(Object.entries(cursor.roles).map(([role, row]) => [role, row.id]))).toEqual({
      reasoning: 'claude-opus-5-thinking-high', coding: 'gpt-5.3-codex-high', efficiency: 'composer-2.5',
    });
    expect(resolveWrapperPin('cursor', efficiency, { catalog })).toMatchObject({
      tier: 'economy', role: 'efficiency', model: 'composer-2.5', enforcement: 'pinned',
    });
  });

  it('does not apply the standard fallback when an explicit override is given', () => {
    const catalog = loadProviderModelCatalog();
    const pin = resolveWrapperPin('cursor', efficiency, { catalog, override: 'claude-4.6-sonnet' });
    expect(pin).toMatchObject({ tier: 'economy', role: 'efficiency', model: 'claude-4.6-sonnet' });
  });

  it('rejects a non-concrete override', () => {
    expect(() => resolveWrapperPin('codex', coding, { override: 'auto' }))
      .toThrow('codex: wrapper override must be a concrete model pin');
  });

  it('rejects an effort the provider cannot express', () => {
    expect(() => resolveWrapperPin('codex', coding, { effort: 'bogus' as never }))
      .toThrow('codex: unsupported wrapper effort');
  });

  it('reports providers without a native model control as inherited and global-only providers as global-only', () => {
    expect(resolveWrapperPin('windsurf', coding)).toMatchObject({ model: undefined, effort: undefined, enforcement: 'inherited' });
    expect(resolveWrapperPin('hermes', coding)).toMatchObject({ model: undefined, enforcement: 'global-only' });
  });

  it('reports pinned-with-effort providers with their native effort field', () => {
    const text = wrapperEnforcementReport('claude');
    expect(text).toContain('Tier enforcement (generated wrapper defaults): pinned; effort: pinned via effort (high/medium/low by wrapper).');
    expect(text).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1');
    expect(text).toContain('not a live resolved-model audit');
  });

  it('reports pinned providers without effort control as not enforced per wrapper', () => {
    const text = wrapperEnforcementReport('copilot');
    expect(text).toContain('): pinned; effort: not enforced per wrapper.');
    expect(text).toContain('Native custom subagents carry explicit catalog model selectors.');
  });

  it('reports global-only providers with their delegation detail', () => {
    const text = wrapperEnforcementReport('hermes');
    expect(text).toContain('): global-only; effort: not enforced per wrapper.');
    expect(text).toContain('All delegated workers share the provider delegation configuration.');
    expect(wrapperEnforcementReport('muse')).toContain('Session --model or settings.json model controls selection');
  });

  it('reports known providers without model controls as inherited with their specific detail', () => {
    expect(wrapperEnforcementReport('windsurf')).toContain('): inherited; effort: not enforced per wrapper. Portable wrapper model selection is unsupported');
    expect(wrapperEnforcementReport('omp')).toContain('): inherited;');
  });

  it('reports unknown providers as inherited with unverified controls', () => {
    const text = wrapperEnforcementReport('not-a-provider');
    expect(text).toContain('): inherited; effort: not enforced per wrapper. Provider wrapper controls are unverified.');
  });
});
