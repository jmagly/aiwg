// Synthetic offline checks for the existing models.json worker selection contract.
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';
import { DEFAULT_WORKER_SELECTION, mergeWorkerSelection, WorkerSelectionPolicySchema } from '../../../src/models/worker-selection-policy.js';
import { MODEL_TIERS } from '../../../src/models/tiers.js';
import type { ModelTier, WorkerSelectionPolicy } from '../../../src/models/types.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerTemplateProject } from '../../fixtures/worker-template-project.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const pointer = '/defaults/workerSelection/maxAutoTier';
function merge(user: WorkerSelectionPolicy, project: WorkerSelectionPolicy, builtin = DEFAULT_WORKER_SELECTION) {
  return mergeWorkerSelection([
    { source: 'builtin/models.json', authority: 'builtin', digest: workerConfigDigest(builtin), policy: builtin },
    { source: 'user/models.json', authority: 'user', digest: workerConfigDigest(user), policy: user },
    { source: 'project/models.json', authority: 'project', digest: workerConfigDigest(project), policy: project },
  ]);
}
async function project() {
  const f = await workerTemplateProject(); roots.push(f.root);
  vi.stubEnv('AIWG_HOME', f.builtin); vi.stubEnv('AIWG_CONFIG', f.user);
  return f;
}
function rankedFixture() {
  const f = workerResolutionFixture();
  const rows = f.snapshot.catalog.discovery!.instances!.codex.models;
  rows[0].worker!.pricing.costClass = 'standard';
  rows[1].worker!.pricing.costClass = 'economy';
  return { ...f, rows, policy: f.snapshot.models.defaults.workerSelection! };
}

describe('T-OG-01 #2642 schema-first worker selection', () => {
  it('compiles strictly and matches Zod for valid and invalid governed fixtures', async () => {
    const schema = JSON.parse(await readFile(resolve('schemas/models/model-config-compatibility.v1.schema.json'), 'utf8'));
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    for (const [kind, valid] of [['valid', true], ['invalid', false]] as const) {
      const dir = resolve('test/fixtures/models/worker-selection', kind);
      for (const name of await readdir(dir)) {
        const value = JSON.parse(await readFile(join(dir, name), 'utf8'));
        expect(validate(value), name).toBe(valid);
        expect(WorkerSelectionPolicySchema.safeParse(value.defaults.workerSelection).success, name).toBe(valid);
      }
    }
    expect(schema.properties.defaults.properties.workerSelection.properties.strategy).not.toHaveProperty('default');
    expect(schema.properties.defaults.properties.workerSelection.properties.maxAutoTier).not.toHaveProperty('default');
    expect(schema.properties.defaults.properties.workerSelection.properties.maxAutoTier.enum).toEqual([...MODEL_TIERS]);
  });

  it.each(MODEL_TIERS)('accepts existing tier spelling %s in config and runtime validation', async maxAutoTier => {
    const f = await project();
    f.fixture.projectPolicy.maxAutoTier = maxAutoTier; await f.write();
    expect((await new ConfigLoader(f.root).load()).defaults.workerSelection!.maxAutoTier).toBe(maxAutoTier);
    expect(WorkerSelectionPolicySchema.safeParse({ maxAutoTier }).success).toBe(true);
  });

  it('defaults legacy worker config and retains normal strategy precedence', async () => {
    const f = await project(); const loader = new ConfigLoader(f.root);
    const policy = (await loader.load()).defaults.workerSelection!;
    expect(policy).not.toHaveProperty('strategy');
    expect(policy).not.toHaveProperty('maxAutoTier');
    expect(merge({ strategy: 'balanced' }, { strategy: 'quality' }).policy.strategy).toBe('quality');
    expect(merge({ strategy: 'balanced' }, {}).policy.strategy).toBe('balanced');
    expect(merge({}, {}, { strategy: 'quality', maxAutoTier: 'economy' }).policy)
      .toMatchObject({ strategy: 'quality', maxAutoTier: 'economy' });
  });
});

describe('T-OG-01 #2642 ceiling precedence and digest preservation', () => {
  it.each([
    ['premium', 'standard', 'standard', false], ['standard', 'premium', 'standard', true],
    ['economy', 'standard', 'economy', true], ['premium', 'economy', 'economy', false],
    ['flagship', 'max-quality', 'max-quality', false], ['max-quality', 'premium', 'premium', false],
  ] as const)('merges user %s and project %s without widening', (user, project, effective, rejected) => {
    const result = merge({ maxAutoTier: user }, { maxAutoTier: project });
    expect(result.policy.maxAutoTier).toBe(effective);
    expect(result.diagnostics.some(item => item.code === 'OG_POLICY_RELAXATION')).toBe(rejected);
    expect(result.origins[pointer].map(origin => origin.contribution)).toEqual([user, project]);
    expect(result.origins[pointer][0]).toMatchObject({ authority: 'user', source: 'user/models.json', digest: workerConfigDigest({ maxAutoTier: user }) });
    if (rejected) expect(result.diagnostics[0].origins).toEqual(result.origins[pointer]);
  });

  it('allows the first explicit ceiling to replace a builtin default', () => {
    expect(merge({}, { maxAutoTier: 'premium' }, { maxAutoTier: 'standard' }).policy.maxAutoTier).toBe('premium');
    expect(merge({ maxAutoTier: 'premium' }, {}).diagnostics).toEqual([]);
  });

  it('rejects project widening on repeated loads and accepts a repaired candidate', async () => {
    const f = await project();
    await writeFile(join(f.user, 'models.json'), JSON.stringify({ defaults: { workerSelection: { maxAutoTier: 'economy' } } }));
    f.fixture.projectPolicy.maxAutoTier = 'premium'; await f.write();
    const loader = new ConfigLoader(f.root);
    for (let attempt = 0; attempt < 2; attempt++) await expect(loader.load()).rejects.toThrow(/OG_POLICY_RELAXATION.*maxAutoTier.*origins=/);
    f.fixture.projectPolicy.maxAutoTier = 'economy'; await f.write();
    const models = await loader.load();
    expect(models.defaults.workerSelection!.maxAutoTier).toBe('economy');
    expect(models.workerPolicyOrigins![pointer].map(origin => origin.authority)).toEqual(['user', 'project']);
  });

  it('invalidates cache, input digests, and stale resolution when selection changes', async () => {
    const f = await project(); const loader = new ConfigLoader(f.root);
    const first = await loader.load(); const digests = loader.getInputDigests()!;
    expect(await loader.load()).toBe(first);
    f.fixture.projectPolicy.strategy = 'quality'; f.fixture.projectPolicy.maxAutoTier = 'economy'; await f.write();
    const second = await loader.load();
    expect(second).not.toBe(first);
    expect(loader.getInputDigests()!.projectModelsDigest).not.toBe(digests.projectModelsDigest);
    expect(loader.getInputDigests()!.userModelsDigest).toBe(digests.userModelsDigest);
    const ranked = rankedFixture();
    const plan = resolveWorkerPlan(ranked.snapshot, ranked.request);
    ranked.policy.strategy = 'balanced';
    expect(resolveWorkerPlan(ranked.snapshot, { ...ranked.request, expectedDigests: plan.digests }).status).toBe('blocked');
    expect(resolveWorkerPlan(ranked.snapshot, ranked.request).digests.resolvedModelsDigest).not.toBe(plan.digests.resolvedModelsDigest);
  });
});

describe('T-OG-01 #2642 eligible strategy ordering and automatic ceiling', () => {
  it.each([
    [undefined, 'primary'], ['cost-effective', 'alternate'], ['balanced', 'primary'], ['quality', 'primary'],
  ] as const)('ranks %s with stable configured tie order', (strategy, member) => {
    const f = rankedFixture(); f.policy.strategy = strategy;
    const plan = resolveWorkerPlan(f.snapshot, f.request);
    expect(plan.status).toBe('eligible'); expect(plan.selected).toMatchObject({ member, effort: 'medium' });
    expect(plan.eligible.filter(tuple => tuple.member === member).map(tuple => tuple.effort)).toEqual(['medium', 'high']);
    f.rows.forEach(row => { row.worker!.pricing.costClass = 'unknown'; });
    expect(resolveWorkerPlan(f.snapshot, f.request).selected?.member).toBe('primary');
  });

  it('keeps exact request pins and conductor choices while enforcing their ceiling', () => {
    const f = rankedFixture();
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, group: 'workers', member: 'primary' }).selected?.member).toBe('primary');
    const choice = { group: 'workers', member: 'primary', model: f.rows[0].id, effort: 'high', rationale: 'Explicit bounded choice' };
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, choice }).selected?.effort).toBe('high');
    f.policy.maxAutoTier = 'economy';
    const plan = resolveWorkerPlan(f.snapshot, { ...f.request, choice, authority: { maxAutoTier: 4 } });
    expect(plan.selected).toBeNull();
    expect(plan.exclusions.flatMap(entry => entry.diagnostics)).toContainEqual(expect.objectContaining({ pointer }));
  });

  it('narrows by candidate tier across roles and aliases without silently replacing pins', () => {
    const f = rankedFixture(); f.policy.maxAutoTier = 'economy';
    const guidance = f.policy.roleGuidance!.coding;
    guidance.tier = 'economy';
    f.policy.roleGuidance!.maintenance = { ...guidance, baseRole: 'coding' };
    const request = { ...f.request, role: 'maintenance', taskClass: undefined };
    const plan = resolveWorkerPlan(f.snapshot, request);
    expect(plan.selected?.member).toBe('alternate');
    expect(plan.exclusions.every(entry => entry.member === 'primary')).toBe(true);
    expect(resolveWorkerPlan(f.snapshot, { ...request, group: 'workers', member: 'primary' }).selected).toBeNull();
    f.rows[1].worker!.pricing.costClass = 'unknown';
    expect(resolveWorkerPlan(f.snapshot, request).selected?.member).toBe('alternate');
  });

  it.each(['premium', 'flagship', 'max-quality'] as ModelTier[])('keeps %s authority separate from strategy and automatic permission', tier => {
    const f = rankedFixture(); f.policy.strategy = 'quality'; f.policy.maxAutoTier = tier;
    f.policy.roleGuidance!.coding.tier = tier;
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, authority: { maxAutoTier: 4 } }).selected).toBeNull();
    const authority = tier === 'premium' ? { premiumAuthorized: true, maxAutoTier: 3 as const } : { election: 'user' as const };
    // Explicit human authority can exceed an automatic-only ceiling, preserving existing gates.
    f.policy.maxAutoTier = 'economy';
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, authority }).status).toBe('eligible');
  });

  it('blocks recognized flagship identities with cheap observations and preserves election', () => {
    const f = rankedFixture(); f.policy.roleGuidance!.coding.tier = 'economy'; f.policy.maxAutoTier = 'economy';
    f.rows[0].id = f.rows[0].apiModelId = 'gpt-6-astra';
    f.rows[0].worker!.pricing.costClass = 'economy';
    f.snapshot.config.parallelism!.groups!.workers.members[0].model = f.rows[0].id;
    const request = { ...f.request, group: 'workers', member: 'primary' };
    expect(resolveWorkerPlan(f.snapshot, request).selected).toBeNull();
    expect(resolveWorkerPlan(f.snapshot, { ...request, authority: { election: 'user' } }).selected?.member).toBe('primary');
  });
});
