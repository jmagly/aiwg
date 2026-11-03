import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  emptyConfig, readAiwgConfig, writeAiwgConfig, resolveParallelism, validateParallelismConfig,
  validateWorkerGroupReferences, validateWorkerInstallationBindings, workerConfigDigest,
  workerActivationDigests, workerActivationCopyInventory, validateWorkerBudgetEnforcement,
} from '../../../src/config/aiwg-config.js';
import { main } from '../../../src/config/cli.js';
import { resolveDynamicModelCatalog } from '../../../src/models/model-discovery.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import {
  DEFAULT_WORKER_SELECTION, mergeWorkerSelection, validateUserProjectModelConfig,
  workerModelKey, isCanonicalWorkerModelKey, validateWorkerPolicyRoute, parseProviderModelCatalog,
} from '../../../src/models/provider-policy.js';
import { fixtureJson, readJson, validators } from './worker-contract-fixtures.js';

const { draft07, draft2020, schemas } = validators();
const shapeVectors = fixtureJson('shared-vectors.json');
const semanticVectors = fixtureJson('policy-semantic-vectors.json');
const routeVectors = fixtureJson('policy-route-vectors.json');
const roots: string[] = [];
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-2878-'));
  roots.push(root);
  // Config validation now reads the complete enabled pair. Keep all model
  // inputs within the fixture channel, including tests that only edit groups.
  vi.stubEnv('AIWG_HOME', process.cwd());
  vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
  return root;
}
function patch(base: any, delta: any): any {
  if (delta === null || Array.isArray(delta) || typeof delta !== 'object') return structuredClone(delta);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(delta)) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? patch(result[key] ?? {}, value) : structuredClone(value);
  return result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
});

describe('B-OG-29 production policy semantics (T-OG-01/05)', () => {
  it.each(semanticVectors)('$pack $id', vector => {
    if (vector.kind === 'merge') {
      const result = mergeWorkerSelection([
        { source: 'fixture:builtin', authority: 'builtin', digest: workerConfigDigest(DEFAULT_WORKER_SELECTION), policy: DEFAULT_WORKER_SELECTION },
        { source: 'fixture:user', authority: 'user', digest: workerConfigDigest(vector.user), policy: vector.user },
        { source: 'fixture:project', authority: 'project', digest: workerConfigDigest(vector.project), policy: vector.project },
      ]);
      expect(result.policy).toMatchObject(vector.expected);
      for (const key of vector.absentGuards ?? []) {
        expect(result.policy.guards).not.toHaveProperty(key);
        expect(result.origins).not.toHaveProperty(`/defaults/workerSelection/guards/${key}`);
      }
      expect(result.diagnostics.map(d => d.code)).toEqual(vector.codes);
      for (const diagnostic of result.diagnostics.filter(d => d.code === 'OG_POLICY_RELAXATION')) {
        expect(diagnostic.origins?.map(o => o.authority)).toEqual(['user', 'project']);
        expect(diagnostic.origins?.every(o => o.pointer === diagnostic.pointer && /^sha256:[a-f0-9]{64}$/.test(o.digest))).toBe(true);
      }
      expect(mergeWorkerSelection([
        { source: 'fixture:builtin', authority: 'builtin', digest: workerConfigDigest(DEFAULT_WORKER_SELECTION), policy: DEFAULT_WORKER_SELECTION },
        { source: 'fixture:user', authority: 'user', digest: workerConfigDigest(vector.user), policy: vector.user },
        { source: 'fixture:project', authority: 'project', digest: workerConfigDigest(vector.project), policy: vector.project },
      ])).toEqual(result);
    } else if (vector.kind === 'models') {
      expect(validateUserProjectModelConfig(vector.value).valid).toBe(vector.valid);
      // Shape can accept a null role whose semantic permission is missing.
      const validate = draft2020.getSchema(schemas.models.$id)!;
      if (vector.valid) expect(validate(vector.value), JSON.stringify(validate.errors)).toBe(true);
    } else if (vector.kind === 'identity') {
      expect(workerModelKey(vector.provider, vector.model)).toBe(vector.key);
      expect(isCanonicalWorkerModelKey(vector.key)).toBe(true);
    } else if (vector.kind === 'identity-invalid') {
      expect(isCanonicalWorkerModelKey(vector.key)).toBe(false);
    } else if (vector.kind === 'parallelism') {
      expect(validateParallelismConfig(vector.value).length === 0).toBe(vector.valid);
      if (vector.valid) expect(draft07.getSchema(schemas.config.$id)!({ parallelism: vector.value })).toBe(true);
    } else if (vector.kind === 'binding') {
      expect(validateWorkerInstallationBindings(vector.value, vector.adapters).length === 0).toBe(vector.valid);
    } else if (vector.kind === 'budget') {
      expect(validateWorkerBudgetEnforcement(vector.budgets, vector.enforceable).length === 0).toBe(vector.valid);
    } else throw new Error(`Unexercised vector kind: ${vector.kind}`);
  });

  it('ships the frozen fragments at the existing schema paths with strict-mode declarations', () => {
    const { $schema: _dialect, definitions, ...parallelism } = fixtureJson('parallelism.fragment.json');
    parallelism.properties.budgets.allOf[0].then.properties = { reservationUsd: {} };
    expect(schemas.config.properties.parallelism).toEqual(parallelism);
    // Redundant declarations permit strictRequired without changing the
    // frozen mutual-exclusion constraint or the enclosing property types.
    definitions.cli.not.properties = { executable: {}, endpoint: {} };
    for (const [key, definition] of Object.entries(definitions)) expect(schemas.config.definitions[key]).toEqual(definition);
    const { $schema: _modelsDialect, $defs, ...selection } = fixtureJson('worker-selection.fragment.json');
    expect(schemas.models.properties.defaults.properties.workerSelection).toEqual(selection);
    for (const [key, definition] of Object.entries($defs)) expect(schemas.models.$defs[key]).toEqual(definition);
    const { $schema: _observationDialect, ...observation } = fixtureJson('worker-observation.fragment.json');
    // Match #2880's capability comparison: normalize only redundant strict-mode
    // declarations on a fresh fixture copy; parent constraints remain unchanged.
    observation.properties.qualification.allOf[0].then.properties = { fixtureDigest: {}, verifiedAt: {}, evidenceRef: {} };
    observation.allOf[1].then.properties.efforts.type = 'array';
    observation.allOf[1].else.properties.efforts.type = 'array';
    expect(schemas.catalog.$defs.workerObservation).toEqual(observation);
  });

  it('compiles the shipped catalog schema in strict mode', () => {
    const strict = addFormats(new Ajv2020({ strict: true }));
    expect(() => strict.compile(schemas.catalog)).not.toThrow();
  });

  it('defaults groups while preserving the legacy disabled result and input bytes', () => {
    const input = { worker_dispatch: true, groups: { fixture: { members: [{ id: 'code', cli: 'codex', model: 'fixture-code', roles: ['coding' as const] }] } }, admission: {}, budgets: {}, retry: {} };
    const before = JSON.stringify(input);
    const resolved = resolveParallelism(input, 'claude');
    expect(resolved.worker_mode).toBe('direct');
    expect(resolved.activation).toBeUndefined();
    expect(resolved.groups?.fixture).toMatchObject({ fallback: [], requiredRoles: [], execution: { isolation: 'worktree', sandbox: 'workspace-write', approval: 'never', network: 'deny', transport: 'shell', receipts: 'optional' }, members: [{ enabled: true, priority: 50 }] });
    expect(resolved.admission).toEqual({ maxQueued: 128, queueTimeoutSeconds: 300, leaseSeconds: 60, starvationSeconds: 120, authorityRef: 'project' });
    expect(resolved.retry?.maxAttempts).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
    expect(resolveParallelism({ ...input, worker_dispatch: false }, 'claude')).toEqual(resolveParallelism(undefined, 'claude'));
  });

  it.each([0, -1, 0.5, 86401, '120', null])('rejects invalid starvation threshold %j', starvationSeconds => {
    expect(validateParallelismConfig({ admission: { starvationSeconds } }).length).toBeGreaterThan(0);
  });

  it('preserves a configured diagnostic threshold', () => {
    expect(resolveParallelism({ worker_dispatch: true, admission: { starvationSeconds: 15 } }).admission?.starvationSeconds).toBe(15);
  });

  it('checks cross-file group references and only explicitly required qualified roles', () => {
    const parallelism = semanticVectors.find((v: any) => v.id === 'optional-installation-binding').value;
    expect(validateWorkerGroupReferences(parallelism, { roleGuidance: { reasoning: { groups: ['absent'], tier: 'premium', initialEffort: 'high', effortLadder: ['high'] } } })).toEqual([expect.stringContaining('OG_CONFIG_REFERENCE')]);
    expect(validateWorkerGroupReferences(parallelism, {}, {})).toEqual([]);
    const required = patch(parallelism, { groups: { fixture: { requiredRoles: ['coding'] } } });
    expect(validateWorkerGroupReferences(required, {}, {}).join()).toContain('OG_ADAPTER_UNQUALIFIED');
    expect(validateWorkerGroupReferences(required, {}, { 'fixture/code': ['coding'] })).toEqual([]);
  });
});

describe('direct/shared consumer guards (T-OG-01/15/19)', () => {
  it.each(routeVectors)('$pack $id', vector => {
    const observation = patch(shapeVectors.find((v: any) => v.id === 'observation-no-effort').value, {
      qualification: { status: 'qualified', roles: ['efficiency'], fixtureDigest: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only' },
    });
    const policy = patch(DEFAULT_WORKER_SELECTION, shapeVectors.find((v: any) => v.id === 'direct-model-no-effort').value.defaults.workerSelection);
    const input = patch({ policy, role: 'efficiency', inferenceProvider: 'fixture', apiModelId: 'fixture-text:q4', selectedModel: 'fixture-text:q4', effort: null, identityEvidence: 'runtime-configured', observation }, vector.patch);
    input.now = new Date('2026-10-07T01:00:00Z');
    const result = validateWorkerPolicyRoute(input);
    if (vector.code) expect(result.map(d => d.code)).toContain(vector.code);
    else expect(result).toEqual([]);
  });

  it('reports a malformed inference identity as a diagnostic instead of throwing', () => {
    const observation = patch(shapeVectors.find((v: any) => v.id === 'observation-no-effort').value, {
      qualification: { status: 'qualified', roles: ['efficiency'], fixtureDigest: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-07T00:00:00Z', evidenceRef: 'fixture:synthetic-only' },
    });
    const policy = patch(DEFAULT_WORKER_SELECTION, shapeVectors.find((v: any) => v.id === 'direct-model-no-effort').value.defaults.workerSelection);
    const input = { policy, role: 'efficiency', inferenceProvider: 'Not Canonical', apiModelId: '', selectedModel: '', effort: null, identityEvidence: 'runtime-configured' as const, observation, now: new Date('2026-10-07T01:00:00Z') };
    expect(() => validateWorkerPolicyRoute(input)).not.toThrow();
    expect(validateWorkerPolicyRoute(input).map(d => d.code)).toContain('OG_CONFIG_REFERENCE');
  });

  it('keeps observation evidence per installation and rejects conflicting effort/visibility, dates and URIs', () => {
    const catalog = readJson('agentic/code/providers/model-catalog.v1.json');
    const worker = shapeVectors.find((v: any) => v.id === 'observation-no-effort').value;
    const instance = { provider: 'local-text', source: 'native', observedAt: worker.observedAt, runtimeVersion: '1.0.0', accountScope: 'local-runtime', accountBinding: 'synthetic-account-a', models: [{ id: 'fixture-text:q4', hidden: false, reasoningEfforts: [], worker }] };
    catalog.discovery = { source: 'native', fetchedAt: worker.fetchedAt, providers: {}, instances: { alpha: instance, beta: { ...instance, accountBinding: 'synthetic-account-b', models: [] } } };
    expect(parseProviderModelCatalog(catalog).discovery?.instances?.alpha.accountBinding).toBe('synthetic-account-a');
    expect(parseProviderModelCatalog(catalog).discovery?.instances?.beta.models).toEqual([]);
    for (const delta of [
      { discovery: { instances: { alpha: { models: [{ ...instance.models[0], hidden: true }] } } } },
      { discovery: { instances: { alpha: { models: [{ ...instance.models[0], reasoningEfforts: ['high'] }] } } } },
      { discovery: { fetchedAt: '2026-02-30T00:00:00Z' } },
      { discovery: { remoteUrl: 'invalid uri' } },
    ]) expect(() => parseProviderModelCatalog(patch(catalog, delta))).toThrow();
  });

  it('the existing catalog loader rejects invalid enrichment and preserves distinct installation evidence offline', async () => {
    const root = await temporary();
    const folder = join(root, 'agentic/code/providers');
    await mkdir(folder, { recursive: true });
    const catalog = readJson('agentic/code/providers/model-catalog.v1.json');
    const worker = shapeVectors.find((v: any) => v.id === 'observation-no-effort').value;
    const instance = { provider: 'local-text', source: 'native', observedAt: worker.observedAt, runtimeVersion: '1.0.0', accountScope: 'local-runtime', accountBinding: 'synthetic-account', models: [{ id: 'fixture-text:q4', hidden: false, reasoningEfforts: [], worker }] };
    catalog.discovery = { source: 'native', fetchedAt: worker.fetchedAt, providers: {}, instances: { alpha: instance } };
    const file = join(folder, 'model-catalog.v1.json');
    await writeFile(file, JSON.stringify(catalog));
    const options = { aiwgRoot: root, homeDir: root, inventory: { providers: [] } as any, now: () => new Date('2026-10-07T01:00:00Z') };
    expect((await resolveDynamicModelCatalog(options)).discovery?.instances?.alpha).toEqual(instance);
    catalog.discovery.instances.alpha.models[0].worker = { ...worker, verifiedAt: '2026-02-30T00:00:00Z' };
    await writeFile(file, JSON.stringify(catalog));
    await expect(resolveDynamicModelCatalog(options)).rejects.toThrow('Invalid or missing static model catalog');
  });

  it('loads models and direct config with no managed state, rejects relaxations, and invalidates changed cached inputs', async () => {
    const root = await temporary();
    const aiwgHome = join(root, 'builtin');
    const userRoot = join(root, 'user');
    const builtinPath = join(aiwgHome, 'agentic/code/frameworks/sdlc-complete/config');
    await mkdir(builtinPath, { recursive: true });
    await mkdir(userRoot);
    vi.stubEnv('AIWG_HOME', aiwgHome);
    vi.stubEnv('AIWG_CONFIG', userRoot);
    const builtin = { version: '2.0', defaults: { tier: 'standard', provider: 'codex' }, tiers: {}, providers: {} };
    await writeFile(join(builtinPath, 'models-v2.json'), JSON.stringify(builtin));
    const project = shapeVectors.find((v: any) => v.id === 'direct-model-no-effort').value;
    await writeFile(join(root, 'models.json'), JSON.stringify(project));
    const config = { ...emptyConfig(), ...shapeVectors.find((v: any) => v.id === 'direct-config-no-managed-state').value };
    await writeAiwgConfig(root, config);
    const loader = new ConfigLoader(root);
    const initial = await loader.load();
    expect((await loader.load())).toBe(initial);
    expect(initial.defaults.workerSelection?.roleGuidance?.efficiency.initialEffort).toBeNull();
    const pointer = '/defaults/workerSelection/dataPolicy/allowedProcessing';
    expect(initial.workerPolicyOrigins?.[pointer].map(o => o.authority)).toEqual(['builtin', 'project']);
    const changed = patch(project, { defaults: { workerSelection: { guards: { allowedVisibility: ['listed', 'hidden'] } } } });
    await writeFile(join(root, 'models.json'), JSON.stringify(changed));
    expect((await loader.load())).not.toBe(initial);
    await writeFile(join(userRoot, 'models.json'), JSON.stringify({ defaults: { workerSelection: { guards: { allowedVisibility: ['listed'] } } } }));
    await expect(loader.load()).rejects.toThrow('OG_POLICY_RELAXATION');
    await rm(join(userRoot, 'models.json'));
    await writeFile(join(builtinPath, 'models-v2.json'), JSON.stringify({ ...builtin, defaults: { ...builtin.defaults, workerSelection: { freshness: { warnHours: 1 } } } }));
    await writeFile(join(root, 'models.json'), JSON.stringify(patch(changed, { defaults: { workerSelection: { freshness: { blockHours: 4 } } } })));
    expect((await loader.load()).defaults.workerSelection?.freshness).toMatchObject({ warnHours: 1, blockHours: 4 });
    expect(await readAiwgConfig(root)).toEqual(config);
    expect(await readdir(join(root, '.aiwg'))).toEqual(['aiwg.config']);
    expect(existsSync(join(root, '.aiwg/ralph-external'))).toBe(false);
  });

  it('validates opted-in input through both config readers and writers before mutation', async () => {
    const root = await temporary();
    const good = { ...emptyConfig(), parallelism: { worker_dispatch: true } };
    await writeAiwgConfig(root, good);
    const file = join(root, '.aiwg/aiwg.config');
    const before = await readFile(file, 'utf8');
    const invalid = { ...good, parallelism: { worker_dispatch: 'true' } } as any;
    await expect(writeAiwgConfig(root, invalid)).rejects.toThrow('OG_CONFIG_REFERENCE');
    expect(await readFile(file, 'utf8')).toBe(before);
    await writeFile(file, JSON.stringify(invalid));
    await expect(readAiwgConfig(root)).rejects.toThrow('OG_CONFIG_REFERENCE');
  });

  it('sets nested JSON fields and resets existing worker paths through the production CLI', async () => {
    const root = await temporary();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['set', '--project', 'parallelism.worker_dispatch', 'true', '--target', root]);
    const group = { members: [{ id: 'code', cli: 'codex', model: 'fixture-code', roles: ['coding'] }] };
    await main(['set', '--project', 'parallelism.groups.fixture', JSON.stringify(group), '--target', root]);
    expect((await readAiwgConfig(root))?.parallelism?.groups?.fixture).toEqual(group);
    const file = join(root, '.aiwg/aiwg.config');
    const before = await readFile(file, 'utf8');
    await expect(main(['set', '--project', 'parallelism.groups.__proto__.members', '[]', '--target', root])).rejects.toThrow('Unsafe configuration path');
    await expect(main(['set', '--project', 'parallelism.groups.fixture.fallback', '["missing"]', '--target', root])).rejects.toThrow('OG_CONFIG_REFERENCE');
    expect(await readFile(file, 'utf8')).toBe(before);
    await main(['reset', '--project', 'parallelism.groups.fixture', '--target', root]);
    expect((await readAiwgConfig(root))?.parallelism?.groups).toEqual({});
  });
});

describe('S0 activation digest/copy inventory contracts; runtime deferred S2+', () => {
  it.each(fixtureJson('activation-contract-vectors.json'))('$pack $id', vector => {
    if (vector.kind === 'digest') expect(workerConfigDigest(vector.value)).toBe(vector.digest);
    else if (vector.kind === 'inventory') expect(workerActivationCopyInventory(...vector.args)).toEqual(vector.expected);
    else throw new Error(`Unexercised activation vector kind: ${vector.kind}`);
  });
  it('hashes absent model files as null and excludes only the commit marker', () => {
    const config = emptyConfig();
    config.parallelism = { worker_dispatch: true, worker_mode: 'managed' };
    const before = workerActivationDigests(config);
    expect(before.projectModelsDigest).toBe(workerConfigDigest(null));
    const after = structuredClone(config);
    after.parallelism!.activation = { revision: 1, snapshotRef: 'fixture:immutable', ...before };
    expect(workerActivationDigests(after)).toEqual(before);
    expect(workerActivationDigests(after, {}, { defaults: { tier: 'premium' } }).userModelsDigest).not.toBe(before.userModelsDigest);
    after.parallelism!.worker_dispatch = false;
    expect(workerActivationDigests(after).configDigest).not.toBe(before.configDigest);
    const validate = draft07.getSchema(schemas.config.$id)!;
    expect(validate({ parallelism: { activation: { revision: 1, snapshotRef: 'fixture:immutable', ...before } } })).toBe(true);
    expect(validate({ parallelism: { activation: { revision: 1, snapshotRef: 'fixture:immutable', ...before, configDigest: 'bad' } } })).toBe(false);
  });
});
