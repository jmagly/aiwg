// Native orchestration uses the same merged worker policy as qualified dispatch.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDelegation } from '../../../src/models/delegation.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { workerRoutingRecord } from '../../../src/models/worker-routing-record.js';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'delegation-'));
  await mkdir(join(root, 'user'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const request = () => ({ orchestrator: 'mission' as const, workerId: 'bounded-worker', assignment: 'Implement the bounded change', provider: 'claude', cwd: root });

describe('T-OG-01 native orchestration tier policy', () => {
  it.each(['mission', 'mc', 'flow', 'ralph', 'team'] as const)('routes %s without a session model', async orchestrator => {
    const { record, envelope } = await resolveDelegation({ ...request(), orchestrator });
    expect(record).toMatchObject({ version: 1, orchestrator, role: 'coding', requested_tier: null,
      resolved_tier: 'standard', wrapper: 'aiwg-model-coding-worker', strategy: 'cost-effective', max_auto_tier: 'standard', election: null });
    expect(record.resolved_model).toMatch(/sonnet/);
    expect(envelope.model?.effectiveModel).toBe(record.resolved_model);
    expect(envelope.launch.target).toBe(record.wrapper);
  });

  it('uses role guidance and merged strategy, and refuses a narrowed ceiling', async () => {
    const config = await new ConfigLoader(root).load();
    config.defaults.workerSelection = { strategy: 'quality', maxAutoTier: 'economy', taskClasses: { read: 'efficiency' } };
    const { record } = await resolveDelegation({ ...request(), task: 'read' }, config);
    expect(record).toMatchObject({ role: 'efficiency', resolved_tier: 'economy', strategy: 'quality', max_auto_tier: 'economy' });
    await expect(resolveDelegation(request(), config)).rejects.toThrow(/maxAutoTier/);
  });

  it('loads builtin → user → project, including a narrowed project ceiling', async () => {
    await writeFile(join(root, 'user/models.json'), JSON.stringify({ defaults: { workerSelection: { strategy: 'balanced', maxAutoTier: 'standard' } } }));
    await writeFile(join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: { strategy: 'quality', maxAutoTier: 'economy' } } }));
    expect((await resolveDelegation({ ...request(), requestedTier: 'economy' })).record).toMatchObject({ resolved_tier: 'economy', strategy: 'quality', max_auto_tier: 'economy' });
    await expect(resolveDelegation(request())).rejects.toThrow(/maxAutoTier/);
    await writeFile(join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: { maxAutoTier: 'flagship' } } }));
    await expect(resolveDelegation(request())).rejects.toThrow(/widen|relax|ceiling/i);
  });

  it.each(['mission', 'mc', 'flow', 'ralph', 'team'] as const)('never elects flagship for %s automatically', async orchestrator => {
    await expect(resolveDelegation({ ...request(), orchestrator, requestedTier: 'flagship' })).rejects.toThrow(/Flagship|authorization|ceiling|tier/i);
    await expect(resolveDelegation({ ...request(), orchestrator, model: 'claude-fable-5' })).rejects.toThrow(/Flagship/);
    const elected = await resolveDelegation({ ...request(), orchestrator, requestedTier: 'flagship', election: 'user' });
    expect(elected.record).toMatchObject({ resolved_tier: 'flagship', election: 'user' });
  });

  it('rejects invalid tiers, placeholders, unknown roles, and disguised premium pins', async () => {
    await expect(resolveDelegation({ ...request(), requestedTier: 'cheap' as any })).rejects.toThrow(/Invalid/);
    await expect(resolveDelegation({ ...request(), role: 'unknown-role' })).rejects.toThrow(/Unknown worker role/);
    await expect(resolveDelegation({ ...request(), provider: 'omp' })).rejects.toThrow(/concrete model/);
    await expect(resolveDelegation({ ...request(), provider: 'omp', model: '@task' })).rejects.toThrow(/concrete model/);
    await expect(resolveDelegation({ ...request(), requestedTier: 'economy', model: 'opus' })).rejects.toThrow(/maxAutoTier/);
    await expect(resolveDelegation({ ...request(), provider: 'codex', model: 'gpt-6-astra[1m]' })).rejects.toThrow(/Flagship/);
  });

  it.each([['claude-code', 'claude'], ['openai', 'codex']])('normalizes %s to %s', async (alias, provider) => {
    const config = await new ConfigLoader(root).load();
    const canonical = await resolveDelegation({ ...request(), provider }, config);
    const aliased = await resolveDelegation({ ...request(), provider: alias }, config);
    expect(aliased.envelope.provider).toBe(provider);
    expect(aliased.record).toEqual(canonical.record);
    expect(aliased.record.resolved_model).toBe(canonical.envelope.model!.effectiveModel);
  });

  it('refuses an unknown provider and unknown task classes, even with an explicit role', async () => {
    const config = await new ConfigLoader(root).load();
    await expect(resolveDelegation({ ...request(), provider: 'unknown-provider' }, config))
      .rejects.toThrow('Worker tier selection is unavailable for provider unknown-provider');
    config.defaults.workerSelection = {};
    await expect(resolveDelegation({ ...request(), task: 'unknown-task', role: 'coding' }, config))
      .rejects.toThrow('Unknown worker task class: unknown-task');
    config.defaults.workerSelection.taskClasses = { read: 'efficiency' };
    await expect(resolveDelegation({ ...request(), task: 'unknown-task' }, config))
      .rejects.toThrow('Unknown worker task class: unknown-task');
  });

  it('uses an assigned default role and applies only matching tier floors without lowering the tier', async () => {
    const config = await new ConfigLoader(root).load();
    config.defaults.workerSelection = {};
    config.agentRoleAssignments = {
      unrelated: { agents: ['other-worker'], defaultRole: 'reasoning', minimumTier: 'flagship', rationale: 'Different worker' },
      selected: { agents: [request().workerId], defaultRole: 'efficiency', minimumTier: 'economy', rationale: 'Default role' },
      floor: { agents: [request().workerId], defaultRole: 'coding', minimumTier: 'standard', rationale: 'Minimum tier' },
      lower: { agents: [request().workerId], defaultRole: 'efficiency', minimumTier: 'economy', rationale: 'Must not lower' },
    };
    const { record, envelope } = await resolveDelegation(request(), config);
    expect(record).toMatchObject({ role: 'efficiency', resolved_tier: 'standard', wrapper: 'aiwg-model-efficiency-worker' });
    expect(envelope.tier).toBe('standard');
    expect(record.resolved_model).toBe(config.providers.claude!.models!.efficiency!.default);
    config.defaults.workerSelection.taskClasses = { implement: 'coding' };
    expect((await resolveDelegation({ ...request(), task: 'implement' }, config)).record.role).toBe('coding');
    expect((await resolveDelegation({ ...request(), task: 'implement', role: 'efficiency' }, config)).record.role).toBe('efficiency');
    config.agentRoleAssignments.floor.minimumTier = 'max-quality';
    await expect(resolveDelegation(request(), config)).rejects.toThrow(/Flagship/);
    expect((await resolveDelegation({ ...request(), election: 'user' }, config)).record)
      .toMatchObject({ role: 'efficiency', resolved_tier: 'flagship', election: 'user' });
  });

  it('honors constrained role guidance and refuses a requested tier below its floor', async () => {
    const config = await new ConfigLoader(root).load();
    config.providers.claude!.models!.coding = { default: 'synthetic-review-model' };
    config.defaults.workerSelection = {
      maxAutoTier: 'premium', taskClasses: { review: 'reviewer' },
      roleGuidance: { reviewer: { baseRole: 'coding', tier: 'premium', groups: ['workers'], initialEffort: 'high', effortLadder: ['high'] } },
    };
    await expect(resolveDelegation({ ...request(), task: 'review', requestedTier: 'standard' }, config))
      .rejects.toThrow('Requested worker tier is below role guidance');
    const { record, envelope } = await resolveDelegation({ ...request(), task: 'review', premiumAuthorized: true }, config);
    expect(record).toMatchObject({ role: 'reviewer', resolved_tier: 'premium', resolved_model: 'synthetic-review-model',
      wrapper: 'aiwg-model-coding-worker', max_auto_tier: 'premium' });
    expect(envelope.role).toBe('coding');
    expect(envelope.model!.effectiveModel).toBe(record.resolved_model);
    config.agentOverrides[request().workerId] = { 'model-tier': 'economy' };
    await expect(resolveDelegation({ ...request(), role: 'reviewer', premiumAuthorized: true }, config))
      .rejects.toThrow('Requested worker tier is below role guidance');
  });

  it('ignores inherited role guidance and uses base roles when no own guidance exists', async () => {
    const config = await new ConfigLoader(root).load();
    config.defaults.workerSelection = { roleGuidance: Object.create({
      reviewer: { baseRole: 'coding', tier: 'standard', groups: ['workers'], initialEffort: 'high', effortLadder: ['high'] },
    }) };
    await expect(resolveDelegation({ ...request(), role: 'reviewer' }, config)).rejects.toThrow('Unknown worker role: reviewer');
    const { record } = await resolveDelegation(request(), config);
    expect(record).toMatchObject({ role: 'coding', resolved_tier: 'standard', wrapper: 'aiwg-model-coding-worker' });
  });

  it('falls back to explicit native CLI pins and agent overrides on an unsupported wrapper surface', async () => {
    const config = await new ConfigLoader(root).load();
    const native = { ...request(), provider: 'devin' };
    await expect(resolveDelegation(native, config))
      .rejects.toThrow('Worker requires a concrete model for devin; supply an explicit model pin');
    config.agentOverrides[request().workerId] = { 'model-override': 'synthetic-agent-model' };
    const overridden = await resolveDelegation(native, config);
    expect(overridden.envelope.model!.effectiveModel).toBeUndefined();
    expect(overridden.record.resolved_model).toBe('synthetic-agent-model');
    expect(overridden.record.warnings).toContain('devin cannot enforce agent-scoped model policy (unsupported)');
    const pinned = await resolveDelegation({ ...native, model: 'synthetic-operator-model' }, config);
    expect(pinned.record.resolved_model).toBe('synthetic-operator-model');
    expect(pinned.envelope.model!.effectiveModel).toBeUndefined();
    await expect(resolveDelegation({ ...native, model: 'inherit' }, config)).rejects.toThrow(/concrete model/);
  });

  it.each(['opus', 'anthropic/opus'])('recognizes the premium provider alias %s despite an economy label', async model => {
    const config = await new ConfigLoader(root).load();
    config.defaults.workerSelection = { maxAutoTier: 'premium' };
    const disguised = { ...request(), requestedTier: 'economy' as const, model };
    await expect(resolveDelegation(disguised, config)).rejects.toThrow('Worker tier requires explicit human authorization');
    const { record } = await resolveDelegation({ ...disguised, premiumAuthorized: true }, config);
    expect(record).toMatchObject({ requested_tier: 'economy', resolved_tier: 'premium', resolved_model: model });
  });

  it('requires premium authorization even when the configured automatic ceiling permits premium', async () => {
    const config = await new ConfigLoader(root).load();
    config.defaults.workerSelection = { maxAutoTier: 'premium' };
    const premium = { ...request(), requestedTier: 'premium' as const };
    await expect(resolveDelegation(premium, config)).rejects.toThrow('Worker tier requires explicit human authorization');
    const { record, envelope } = await resolveDelegation({ ...premium, premiumAuthorized: true }, config);
    expect(record).toMatchObject({ requested_tier: 'premium', resolved_tier: 'premium', max_auto_tier: 'premium' });
    expect(envelope.decision.requiresConfirmation).toBe(false);
  });

  it('projects qualified worker pricing into the identical record without relabeling it', () => {
    const f = workerResolutionFixture();
    f.snapshot.models.defaults.workerSelection!.maxAutoTier = 'premium';
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.pricing.costClass = 'premium';
    const plan = resolveWorkerPlan(f.snapshot, { ...f.request, authority: { premiumAuthorized: true, maxAutoTier: 3 } });
    const record = workerRoutingRecord('flow', 'node', plan, f.snapshot);
    expect(record).toMatchObject({ orchestrator: 'flow', role: 'coding', resolved_tier: 'premium', resolved_model: plan.selected!.model });
    expect(() => workerRoutingRecord('mc', 'node', plan, f.snapshot, 'economy')).toThrow(/differs/);
  });
});
