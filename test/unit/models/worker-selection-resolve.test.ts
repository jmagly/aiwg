// Exercises file-loaded selection through source and built resolvers and the recovery mirror.
import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelResolver } from '../../../src/models/resolver.js';
import { WorkerSelectionPolicySchema } from '../../../src/models/worker-selection-policy.js';
import { validateUserProjectModelConfig } from '../../../src/models/catalog-policy.js';
import { WorkerSelectionPolicySchema as RecoveryPolicySchema } from '../../fixtures/ralph-recovery-baseline/src/models/provider-policy.js';
import { workerTemplateProject } from '../../fixtures/worker-template-project.js';
import { MODEL_TIERS } from '../../../src/models/tiers.js';
import type { ModelTier } from '../../../src/models/types.js';
import type { WorkerPlanRequest, WorkerResolutionPlan } from '../../../src/models/worker-plan.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function project() {
  const f = await workerTemplateProject(); roots.push(f.root);
  vi.stubEnv('AIWG_HOME', f.builtin); vi.stubEnv('AIWG_CONFIG', f.user);
  f.fixture.projectPolicy.strategy = 'quality';
  f.fixture.projectPolicy.maxAutoTier = 'standard';
  // The role floor permits both observations; the ceiling must exclude only standard.
  f.fixture.projectPolicy.roleGuidance!.coding.tier = 'economy';
  const rows = f.fixture.snapshot.catalog.discovery!.instances!.codex.models;
  rows[0].worker!.pricing.costClass = 'standard';
  rows[1].worker!.pricing.costClass = 'economy';
  await f.write();
  return f;
}

async function runResolver(runtime: 'source' | 'built', f: Awaited<ReturnType<typeof project>>,
  request: WorkerPlanRequest = f.fixture.request): Promise<WorkerResolutionPlan> {
  if (runtime === 'source') return new ModelResolver({}, f.root).resolveWorker(request, f.fixture.snapshot);
  // Use a clean Node process so Vitest cannot remap built .js imports to source.
  const module = pathToFileURL(resolve('dist/src/models/resolver.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { ModelResolver } from ${JSON.stringify(module)};
    const { root, request, snapshot } = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(await new ModelResolver({}, root).resolveWorker(request, snapshot)));
  `], { input: JSON.stringify({ root: f.root, request, snapshot: f.fixture.snapshot }),
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: f.root } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('T-OG-01 #2642 worker selection runtime projections', () => {
  it.each(MODEL_TIERS)('accepts %s and every strategy in both strict validators', maxAutoTier => {
    for (const strategy of ['cost-effective', 'balanced', 'quality']) {
      const policy = { strategy, maxAutoTier };
      expect(WorkerSelectionPolicySchema.safeParse(policy).success).toBe(true);
      expect(RecoveryPolicySchema.safeParse(policy).success).toBe(true);
      expect(validateUserProjectModelConfig({ defaults: { workerSelection: policy } }).valid).toBe(true);
    }
  });

  it.each([{ strategy: 'fastest' }, { maxAutoTier: 2 }, { maxAutoTier: 'unlimited' }, { unknown: true }])(
    'preserves strict rejection for %j', policy => {
      expect(WorkerSelectionPolicySchema.safeParse(policy).success).toBe(false);
      expect(RecoveryPolicySchema.safeParse(policy).success).toBe(false);
      expect(validateUserProjectModelConfig({ defaults: { workerSelection: policy } }).valid).toBe(false);
    });
});

describe('T-OG-01 #2642 file-loaded worker resolve', () => {
  it.each(['source', 'built'] as const)('%s preserves legacy members, exclusions and diagnostics without selection fields', async runtime => {
    const f = await workerTemplateProject(); roots.push(f.root);
    vi.stubEnv('AIWG_HOME', f.builtin); vi.stubEnv('AIWG_CONFIG', f.user);
    const rows = f.fixture.snapshot.catalog.discovery!.instances!.codex.models;
    rows[0].worker!.pricing.costClass = 'standard';
    rows[1].worker!.pricing.costClass = 'economy';
    const reviewer = structuredClone(rows[0]);
    reviewer.id = reviewer.apiModelId = 'synthetic-reviewer';
    reviewer.worker!.pricing.costClass = 'premium';
    rows.push(reviewer);
    f.parallelism.groupTemplates!.bounded.members!.push({ id: 'reviewer', cli: 'codex', model: reviewer.id, roles: ['coding'] });
    await f.write();
    const written = JSON.parse(await readFile(f.modelsFile, 'utf8')).defaults.workerSelection;
    expect(written).not.toHaveProperty('strategy');
    expect(written).not.toHaveProperty('maxAutoTier');
    const request = { ...f.fixture.request, effort: 'medium' };
    const legacy = await runResolver(runtime, f, request);
    // Main's configured member order and complete premium exclusion diagnostic.
    expect(legacy.status).toBe('eligible');
    expect(legacy.selected?.member).toBe('primary');
    expect(legacy.eligible.map(({ member, model, effort, diagnostics }) => ({ member, model, effort, diagnostics }))).toEqual([
      { member: 'primary', model: rows[0].id, effort: 'medium', diagnostics: [] },
      { member: 'alternate', model: rows[1].id, effort: 'medium', diagnostics: [] },
    ]);
    expect(legacy.exclusions).toEqual([{ group: 'workers', member: 'reviewer', model: reviewer.id, effort: 'medium', diagnostics: [{
      code: 'OG_MODEL_UNAPPROVED', pointer: '/request/authority',
      message: 'premium tier was explicitly requested; Tier 3 requires explicit human confirmation; agents may pass --authorize-premium only after the human explicitly confirmed the premium escalation (escalation-discipline rule)',
    }] }]);
    expect(legacy.diagnostics).toEqual([]);
    expect(legacy.choice?.rationale).toBe('Role group order, member priority/declaration order, then qualified effort ladder');

    // Explicit order preservation and a nonrestricting ceiling must resolve identically.
    f.fixture.projectPolicy.strategy = 'balanced';
    f.fixture.projectPolicy.maxAutoTier = 'flagship';
    await f.write();
    const explicit = await runResolver(runtime, f, request);
    expect(explicit.eligible).toEqual(legacy.eligible);
    expect(explicit.selected).toEqual(legacy.selected);
    expect(explicit.exclusions).toEqual(legacy.exclusions);
    expect(explicit.diagnostics).toEqual(legacy.diagnostics);

    delete f.fixture.projectPolicy.strategy;
    delete f.fixture.projectPolicy.maxAutoTier;
    await f.write();
    const authorized = await runResolver(runtime, f, { ...request,
      choice: { group: 'workers', member: 'reviewer', model: reviewer.id, effort: 'medium', rationale: 'Authorized review' },
      authority: { premiumAuthorized: true, maxAutoTier: 3 } });
    expect(authorized.selected?.member).toBe('reviewer');
    expect(authorized.exclusions).toEqual([]);
    expect(authorized.diagnostics).toEqual([]);
  });

  it.each(['source', 'built'] as const)('%s accepts selection fields and narrows eligible choices after reload', async runtime => {
    const f = await project();
    const resolver = new ModelResolver({}, f.root);
    const run = () => runtime === 'source' ? resolver.resolveWorker(f.fixture.request, f.fixture.snapshot) : runResolver(runtime, f);
    const initial = await run();
    expect(initial.status, JSON.stringify(initial.diagnostics)).toBe('eligible');
    expect(initial.policy).toMatchObject({ strategy: 'quality', maxAutoTier: 'standard' });
    expect(initial.selected?.member).toBe('primary');
    expect(new Set(initial.eligible.map((tuple: { member: string }) => tuple.member)))
      .toEqual(new Set(['primary', 'alternate']));

    f.fixture.projectPolicy.maxAutoTier = 'economy' satisfies ModelTier;
    await f.write();
    const narrowed = await run();
    expect(narrowed.status, JSON.stringify(narrowed.diagnostics)).toBe('eligible');
    expect(narrowed.selected?.member).toBe('alternate');
    expect(narrowed.eligible.every((tuple: { member: string }) => tuple.member === 'alternate')).toBe(true);
    expect(narrowed.exclusions.flatMap((entry: { diagnostics: unknown[] }) => entry.diagnostics))
      .toContainEqual(expect.objectContaining({ code: 'OG_MODEL_UNAPPROVED', pointer: '/defaults/workerSelection/maxAutoTier' }));
    expect(narrowed.digests.projectModelsDigest).not.toBe(initial.digests.projectModelsDigest);
    const written = JSON.parse(await readFile(join(f.root, 'models.json'), 'utf8'));
    expect(written.defaults.workerSelection.maxAutoTier).toBe('economy');
  });
});
