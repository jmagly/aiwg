// Checks routing-record refusals and projection of qualified synthetic worker plans.
import { describe, expect, it } from 'vitest';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';
import { workerRoutingRecord } from '../../../src/models/worker-routing-record.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

function qualifiedFixture() {
  const fixture = workerResolutionFixture();
  const plan = resolveWorkerPlan(fixture.snapshot, fixture.request);
  expect(plan.status).toBe('eligible');
  expect(plan.selected?.model).toBe('synthetic/a%b');
  return { ...fixture, plan };
}

describe('T-OG-01 qualified worker routing record', () => {
  it.each(['selected', 'role'] as const)('refuses a plan without %s', field => {
    const { plan, snapshot } = qualifiedFixture();
    plan[field] = null;
    expect(() => workerRoutingRecord('flow', 'node', plan, snapshot))
      .toThrow('Worker routing requires an eligible selected worker');
  });

  it.each(['policy', 'roleGuidance', 'coding'] as const)('refuses missing %s', field => {
    const { plan, snapshot } = qualifiedFixture();
    if (field === 'policy') plan.policy = undefined;
    else if (field === 'roleGuidance') delete plan.policy!.roleGuidance;
    else delete plan.policy!.roleGuidance!.coding;
    expect(() => workerRoutingRecord('mc', 'node', plan, snapshot))
      .toThrow('Selected worker has no role guidance');
  });

  it.each(['missing', 'invalid-tier'] as const)('refuses resolver output with %s tier policy', input => {
    const { snapshot, request } = workerResolutionFixture();
    if (input === 'missing') delete snapshot.models.defaults.workerSelection;
    else snapshot.models.defaults.workerSelection!.roleGuidance!.coding.tier = 'cheap' as never;
    const plan = resolveWorkerPlan(snapshot, request);
    expect(plan.status).toBe('blocked');
    expect(plan.selected).toBeNull();
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_CONFIG_REFERENCE' }));
    expect(() => workerRoutingRecord('team', 'node', plan, snapshot))
      .toThrow('Worker routing requires an eligible selected worker');
  });

  it.each(['discovery', 'instances', 'cli', 'models', 'match', 'worker'] as const)(
    'refuses missing model observation: %s', field => {
      const { plan, snapshot } = qualifiedFixture();
      const discovery = snapshot.catalog.discovery!;
      const instance = discovery.instances!.codex;
      if (field === 'discovery') delete snapshot.catalog.discovery;
      else if (field === 'instances') delete discovery.instances;
      else if (field === 'cli') delete discovery.instances!.codex;
      else if (field === 'models') instance.models = [];
      else if (field === 'match') instance.models[0].id = instance.models[0].apiModelId = 'another-model';
      else delete instance.models[0].worker;
      expect(() => workerRoutingRecord('ralph', 'node', plan, snapshot))
        .toThrow('Selected worker has no model observation');
    });

  it.each(['id', 'apiModelId'] as const)('finds the selected observation by %s', key => {
    const { plan, snapshot } = qualifiedFixture();
    const row = snapshot.catalog.discovery!.instances!.codex.models[0];
    row[key === 'id' ? 'apiModelId' : 'id'] = 'catalog-alias';
    plan.policy = { roleGuidance: { coding: plan.policy!.roleGuidance!.coding } };
    expect(workerRoutingRecord('flow', 'node', plan, snapshot)).toEqual({
      version: 1, orchestrator: 'flow', workerId: 'node', role: 'coding', requested_tier: null,
      resolved_tier: 'standard', resolved_model: 'synthetic/a%b', wrapper: 'aiwg-model-coding-worker',
      strategy: 'balanced', max_auto_tier: null, election: null, warnings: [],
    });
  });

  it('projects role aliases, policy bounds, and diagnostic messages', () => {
    const { plan, snapshot } = qualifiedFixture();
    plan.role = 'project-coder';
    plan.policy!.roleGuidance!['project-coder'] = { ...plan.policy!.roleGuidance!.coding, baseRole: 'coding' };
    plan.policy!.strategy = 'quality';
    plan.policy!.maxAutoTier = 'standard';
    plan.diagnostics.push({ code: 'OG_SANDBOX_EXTERNAL', blocking: false, pointer: '/fixture', message: 'Synthetic warning' });
    expect(workerRoutingRecord('mission', 'alias-worker', plan, snapshot, 'standard')).toEqual({
      version: 1, orchestrator: 'mission', workerId: 'alias-worker', role: 'project-coder', requested_tier: 'standard',
      resolved_tier: 'standard', resolved_model: 'synthetic/a%b', wrapper: 'aiwg-model-coding-worker',
      strategy: 'quality', max_auto_tier: 'standard', election: null, warnings: ['Synthetic warning'],
    });
  });

  it('preserves an explicit model pin and refuses to relabel observed premium pricing', () => {
    const { snapshot, request } = workerResolutionFixture();
    snapshot.models.defaults.workerSelection!.maxAutoTier = 'premium';
    snapshot.catalog.discovery!.instances!.codex.models[0].worker!.pricing.costClass = 'premium';
    const plan = resolveWorkerPlan(snapshot, { ...request, model: 'synthetic/a%b',
      authority: { premiumAuthorized: true, maxAutoTier: 3 } });
    expect(plan.status).toBe('eligible');
    expect(workerRoutingRecord('team', 'pinned', plan, snapshot, 'premium')).toMatchObject({
      resolved_model: 'synthetic/a%b', resolved_tier: 'premium', requested_tier: 'premium',
    });
    expect(() => workerRoutingRecord('team', 'pinned', plan, snapshot, 'standard'))
      .toThrow('Resolved worker tier premium differs from --worker-tier standard');
  });

  it('refuses an unelected flagship pin and preserves an elected tier alias', () => {
    const { snapshot, request } = workerResolutionFixture();
    snapshot.config.parallelism!.groups!.workers.members[0].model = 'gpt-6-astra';
    const row = snapshot.catalog.discovery!.instances!.codex.models[0];
    row.id = row.apiModelId = 'gpt-6-astra';
    const pinned = { ...request, model: 'gpt-6-astra' };
    const blocked = resolveWorkerPlan(snapshot, pinned);
    expect(blocked.selected).toBeNull();
    expect(blocked.exclusions.flatMap(entry => entry.diagnostics)).toContainEqual(expect.objectContaining({
      message: 'Flagship models are user-elected only',
    }));
    expect(() => workerRoutingRecord('mc', 'flagship', blocked, snapshot, 'flagship'))
      .toThrow('Worker routing requires an eligible selected worker');

    const authority = { election: 'user' as const };
    const elected = resolveWorkerPlan(snapshot, { ...pinned, authority });
    expect(elected.status).toBe('eligible');
    expect(workerRoutingRecord('mc', 'flagship', elected, snapshot, 'max-quality', authority)).toMatchObject({
      resolved_model: 'gpt-6-astra', resolved_tier: 'flagship', requested_tier: 'max-quality', election: 'user',
    });
    expect(workerRoutingRecord('mc', 'flagship', elected, snapshot, 'flagship', authority).requested_tier).toBe('flagship');
    expect(() => workerRoutingRecord('mc', 'flagship', elected, snapshot, 'premium', authority))
      .toThrow('Resolved worker tier flagship differs from --worker-tier premium');
  });
});
