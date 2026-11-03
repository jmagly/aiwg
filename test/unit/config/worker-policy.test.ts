import * as fs from 'fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyConfig, getProviderParallelismDefaults, readAiwgConfig, resolveParallelism,
  resolveWorkerGroupInstallation, validateParallelismConfig, validateWorkerGroupReferences,
  workerConfigDigest, writeAiwgConfig, type ParallelismConfig,
} from '../../../src/config/aiwg-config.js';
import { main } from '../../../src/config/cli.js';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import {
  DEFAULT_WORKER_SELECTION, loadProviderModelCapabilities, mergeWorkerSelection,
  qualifyWorkerInvocationProfile,
} from '../../../src/models/provider-policy.js';
import { fixtureJson } from '../../conformance/mission-v1/worker-contract-fixtures.js';

const faults = vi.hoisted(() => ({ readPath: '', accessPath: '', home: '' }));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => faults.home || actual.homedir() };
});
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof fs.readFile>) => args[0] === faults.readPath
      ? Promise.reject(Object.assign(new Error('synthetic unreadable file'), { code: 'EACCES' }))
      : actual.readFile(...args),
    access: (...args: Parameters<typeof fs.access>) => args[0] === faults.accessPath
      ? Promise.reject(Object.assign(new Error('synthetic canonical access failure'), { code: 'EACCES' }))
      : actual.access(...args),
  };
});

const roots: string[] = [];
const group = () => ({ members: [{ id: 'code', cli: 'codex', model: 'synthetic-exact', roles: ['coding' as const] }] });
const policy = (): ParallelismConfig => ({ worker_dispatch: true, groups: { fixture: group() } });
const coding = { groups: ['fixture'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium', 'high'] };
async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'aiwg-2881-'));
  roots.push(root);
  const builtin = join(root, 'builtin');
  const user = join(root, 'user');
  const builtinFile = join(builtin, 'agentic/code/frameworks/sdlc-complete/config/models-v2.json');
  await fs.mkdir(join(builtin, 'agentic/code/frameworks/sdlc-complete/config'), { recursive: true });
  await fs.mkdir(user);
  vi.stubEnv('AIWG_HOME', builtin);
  vi.stubEnv('AIWG_CONFIG', user);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, '.aiwg'));
  const defaults = { version: '2.0', defaults: { provider: 'codex', tier: 'standard' }, tiers: {}, providers: {} };
  await fs.writeFile(builtinFile, JSON.stringify(defaults));
  const projectFile = join(root, 'models.json');
  const userFile = join(user, 'models.json');
  const project = { defaults: { workerSelection: { roleGuidance: { coding } } } };
  await fs.writeFile(projectFile, JSON.stringify(project));
  return { root, builtinFile, userFile, projectFile, defaults, project, loader: new ConfigLoader(root) };
}
afterEach(async () => {
  faults.readPath = '';
  faults.accessPath = '';
  faults.home = '';
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
    expect(existsSync(root), 'fixture cleanup').toBe(false);
  }
});

describe('worker-model default home resolution (#3170)', () => {
  async function isolatedHome() {
    const root = await fs.mkdtemp(join(tmpdir(), 'aiwg-models-home-'));
    roots.push(root);
    vi.stubEnv('HOME', root);
    // Vitest's thread-local env does not update native os.homedir().
    faults.home = root;
    vi.stubEnv('AIWG_HOME', undefined);
    vi.stubEnv('AIWG_CONFIG', undefined);
    vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, 'artifacts'));
    const project = join(root, 'project');
    await fs.mkdir(project);
    return { root, project };
  }

  it('loads bundled defaults without a home install or AIWG_HOME', async () => {
    const { root, project } = await isolatedHome();
    const loader = new ConfigLoader(project);
    const builtinFile = fileURLToPath(new URL('../../../agentic/code/frameworks/sdlc-complete/config/models-v2.json', import.meta.url));
    expect(loader.getLocations()).toEqual({
      aiwgDefault: builtinFile,
      userConfig: join(root, '.config/aiwg/models.json'),
      projectConfig: join(project, 'models.json'),
    });
    await expect(loader.load({ worker_dispatch: true })).resolves.toMatchObject({
      defaults: { workerSelection: DEFAULT_WORKER_SELECTION },
    });
    expect(existsSync(join(root, '.local/share/ai-writing-guide'))).toBe(false);
    expect(process.env.AIWG_HOME).toBeUndefined();
  });

  it('enables dispatch through the config CLI and reads and writes it without an explicit home', async () => {
    const { project } = await isolatedHome();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['set', '--target', project, '--project', 'parallelism.clis.codex',
      JSON.stringify({ adapter: 'providers:codex', accountScope: 'local-account', quotaScope: 'q' })]);
    await main(['set', '--target', project, '--project', 'parallelism.worker_dispatch', 'true']);
    const config = await readAiwgConfig(project);
    expect(config?.parallelism.worker_dispatch).toBe(true);
    await expect(writeAiwgConfig(project, config!)).resolves.toBeUndefined();
  });

  it('keeps explicit home above AIWG_HOME and does not silently ignore a missing override', async () => {
    const { root, project } = await isolatedHome();
    const envHome = join(root, 'env-install');
    const explicitHome = join(root, 'explicit-install');
    vi.stubEnv('AIWG_HOME', envHome);
    const suffix = 'agentic/code/frameworks/sdlc-complete/config/models-v2.json';
    const envLoader = new ConfigLoader(project);
    expect(envLoader.getLocations().aiwgDefault).toBe(join(envHome, suffix));
    await expect(envLoader.load()).rejects.toThrow(join(envHome, suffix));
    const explicitLoader = new ConfigLoader(project, { aiwgHome: explicitHome });
    expect(explicitLoader.getLocations().aiwgDefault).toBe(join(explicitHome, suffix));
    await expect(explicitLoader.load()).rejects.toThrow(join(explicitHome, suffix));
    expect(process.env.AIWG_HOME).toBe(envHome);
  });
});

describe('T-OG-01 S1 complete candidate and restriction origins', () => {
  it('S1-C01 rejects repeated relaxation reads without publishing or caching the invalid candidate', async () => {
    const fixture = await setup();
    await fs.writeFile(fixture.userFile, JSON.stringify({ defaults: { workerSelection: { dataPolicy: { allowUnknown: false } } } }));
    const initial = await fixture.loader.load(policy());
    const digests = fixture.loader.getInputDigests();
    await fs.writeFile(fixture.projectFile, JSON.stringify({ defaults: { workerSelection: { dataPolicy: { allowUnknown: true } } } }));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(fixture.loader.load(policy())).rejects.toThrow('OG_POLICY_RELAXATION');
      expect(fixture.loader.getInputDigests()).toEqual(digests);
    }
    expect(initial.defaults.workerSelection?.dataPolicy?.allowUnknown).toBe(false);
    await fs.writeFile(fixture.projectFile, JSON.stringify(fixture.project));
    expect(await fixture.loader.load(policy())).toBe(initial);
  });

  it('S1-C02 rejects invalid derived freshness even though each input is shape-valid', async () => {
    const fixture = await setup();
    await fs.writeFile(fixture.userFile, JSON.stringify({ defaults: { workerSelection: { freshness: { warnHours: 48 } } } }));
    await fs.writeFile(fixture.projectFile, JSON.stringify({ defaults: { workerSelection: { freshness: { blockHours: 1 } } } }));
    await expect(fixture.loader.load(policy())).rejects.toThrow('warnHours must not exceed blockHours');
    await expect(fixture.loader.load(policy())).rejects.toThrow('OG_CONFIG_REFERENCE');
    expect(fixture.loader.getInputDigests()).toBeNull();
  });

  it('S1-C03 checks group references on every changed policy, including a warm cache', async () => {
    const fixture = await setup();
    const initial = await fixture.loader.load(policy());
    await expect(fixture.loader.load({ worker_dispatch: true, groups: {} })).rejects.toThrow('Unknown group fixture');
    expect(await fixture.loader.load(policy())).toBe(initial);
    // Unbound/native loading keeps its existing preferences and no group check.
    expect((await fixture.loader.load()).defaults.workerSelection?.roleGuidance?.coding.groups).toEqual(['fixture']);
  });

  it('S1-C04 retains explicit user denials and source contributions in project inspection', async () => {
    const fixture = await setup();
    await fs.writeFile(fixture.userFile, JSON.stringify({ defaults: { workerSelection: { guards: { deniedEfforts: ['ultra', 'max'] } } } }));
    await fs.writeFile(fixture.projectFile, JSON.stringify({ ...fixture.project, defaults: { workerSelection: {
      roleGuidance: { coding }, guards: { deniedEfforts: [] },
    } } }));
    await writeAiwgConfig(fixture.root, { ...emptyConfig(), parallelism: policy() });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['get', '--origins', '--target', fixture.root, '--project', 'defaults.workerSelection.guards.deniedEfforts']);
    const inspected = JSON.parse(log.mock.calls[0][0]);
    expect(inspected.value).toEqual(['ultra', 'max']);
    const pointer = '/defaults/workerSelection/guards/deniedEfforts';
    expect(inspected.origins[pointer].map((origin: any) => origin.authority)).toEqual(['builtin', 'user', 'project']);
    expect(inspected.origins[pointer].slice(1)).toEqual([
      expect.objectContaining({ source: fixture.userFile, pointer, contribution: ['ultra', 'max'], digest: workerConfigDigest(JSON.parse(await fs.readFile(fixture.userFile, 'utf8'))) }),
      expect.objectContaining({ source: fixture.projectFile, pointer, contribution: [] }),
    ]);
    expect(Object.keys(inspected.origins)).toEqual([pointer]);
    expect(inspected.digests).toEqual({
      builtinModelsDigest: workerConfigDigest(fixture.defaults),
      userModelsDigest: workerConfigDigest(JSON.parse(await fs.readFile(fixture.userFile, 'utf8'))),
      projectModelsDigest: workerConfigDigest(JSON.parse(await fs.readFile(fixture.projectFile, 'utf8'))),
    });
  });

  it('S1-C05 preserves an inherited wrapper exact pin through a group-bound tier preference', async () => {
    const fixture = await setup();
    await fs.writeFile(fixture.userFile, JSON.stringify({ agentOverrides: { 'aiwg-model-coding-worker': { 'model-override': 'synthetic-pinned' } } }));
    await fs.writeFile(fixture.projectFile, JSON.stringify({ ...fixture.project, agentOverrides: { 'aiwg-model-coding-worker': { 'model-tier': 'premium' } } }));
    const resolved = await fixture.loader.load(policy());
    expect(resolved.agentOverrides['aiwg-model-coding-worker']).toEqual({
      'model-override': 'synthetic-pinned', 'model-tier': 'premium',
    });
    expect(resolved.workerPolicyOrigins?.['/agentOverrides/aiwg-model-coding-worker/model-override']).toEqual([
      expect.objectContaining({ source: fixture.userFile, authority: 'user', contribution: 'synthetic-pinned' }),
    ]);
    expect((await fixture.loader.load()).agentOverrides['aiwg-model-coding-worker']).toEqual({ 'model-tier': 'premium' });
  });

  it.each([
    { guards: { allowedVisibility: ['listed', 'hidden'] } },
    { guards: { denySelfDelegation: false } },
    { guards: { denyConductorWorkerExecution: false } },
    { guards: { requireExactModel: false } },
    { guards: { minimumIdentityEvidence: 'runtime-configured' } },
    { dataPolicy: { allowedProcessing: ['local', 'remote'] } },
    { dataPolicy: { allowUnknown: true } },
    { dataPolicy: { allowProductImprovement: true } },
    { dataPolicy: { maxRetentionDays: 30 } },
    { freshness: { blockHours: 168 } },
  ])('S1-C06 task contribution cannot expand explicit restrictions: %j', task => {
    const result = mergeWorkerSelection([
      { source: 'fixture:builtin', digest: workerConfigDigest(DEFAULT_WORKER_SELECTION), authority: 'builtin', policy: DEFAULT_WORKER_SELECTION },
      { source: 'fixture:project', digest: workerConfigDigest('strict'), authority: 'project', policy: {
        guards: { allowedVisibility: ['listed'], denySelfDelegation: true, denyConductorWorkerExecution: true, requireExactModel: true, minimumIdentityEvidence: 'backend-attested' },
        dataPolicy: { allowedProcessing: ['local'], allowUnknown: false, allowProductImprovement: false, maxRetentionDays: 0 },
        freshness: { warnHours: 1, blockHours: 4 },
      } },
      { source: 'fixture:task', digest: workerConfigDigest(task), authority: 'task', policy: task as any },
    ]);
    expect(result.diagnostics.map(d => d.code)).toContain('OG_POLICY_RELAXATION');
    expect(result.diagnostics[0].origins?.map(o => o.authority)).toEqual(['project', 'task']);
  });

  it('S1-C07 rejects invalid references and duplicate fallbacks while optional roles stay optional', () => {
    expect(validateWorkerGroupReferences(policy(), {}, {})).toEqual([]);
    const required = policy();
    required.groups!.fixture.requiredRoles = ['coding'];
    expect(validateWorkerGroupReferences(required, {}, {}).join()).toContain('No qualified route covers coding');
    expect(validateWorkerGroupReferences(required, {}, { 'fixture/code': ['coding'] })).toEqual([]);
    required.groups!.fixture.fallback = ['code', 'code'];
    expect(validateParallelismConfig(required).join()).toContain('OG_CONFIG_REFERENCE');
    // Invalid shape must return diagnostics, not dereference invalid members.
    expect(validateWorkerGroupReferences({ groups: { broken: {} } } as any, {}).join()).toContain('OG_CONFIG_REFERENCE');
  });
});

describe('T-OG-01/15 S1 config editing, input digests and read failures', () => {
  it.each(['defaults', 'defaults.provider', 'defaults.workerSelection', 'defaults.workerSelection.guards.deniedEfforts'])('rejects model-owned set %s without changing config bytes', async key => {
    const fixture = await setup();
    await writeAiwgConfig(fixture.root, { ...emptyConfig(), parallelism: policy() });
    const file = join(fixture.root, '.aiwg/aiwg.config');
    const before = await fs.readFile(file, 'utf8');
    const modelsBefore = await fs.readFile(fixture.projectFile, 'utf8');
    await expect(main(['set', '--project', key, '{}', '--target', fixture.root]))
      .rejects.toMatchObject({ code: 'ERR_INVALID_KEY', message: expect.stringContaining('models.json') });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readFile(fixture.projectFile, 'utf8')).toBe(modelsBefore);
  });

  it('validates and resolves a saved legacy config with provider bindings and no worker groups identically', async () => {
    const fixture = await setup();
    const bytes = await fs.readFile(fileURLToPath(new URL('../../fixtures/config/legacy-provider-bindings.json', import.meta.url)), 'utf8');
    const legacy = JSON.parse(bytes);
    await fs.mkdir(join(fixture.root, '.aiwg'));
    const file = join(fixture.root, '.aiwg/aiwg.config');
    await fs.writeFile(file, bytes);
    expect(legacy.parallelism.groups).toBeUndefined();
    expect(validateParallelismConfig(legacy.parallelism)).toEqual([]);
    const loaded = await readAiwgConfig(fixture.root);
    expect(loaded).toEqual(legacy);
    expect(resolveParallelism(loaded!.parallelism, loaded!.providers[0])).toEqual({
      max_parallel_subagents: 7,
      max_parallel_ralph_loops: 2,
      max_parallel_mc_missions: 4,
      rationale: 'Legacy native dispatch caps',
    });
    expect(resolveParallelism(loaded!.parallelism, loaded!.providers[0]))
      .toEqual(resolveParallelism(legacy.parallelism, legacy.providers[0]));
    await main(['validate', '--project', '--target', fixture.root]);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });

  it('S1-C08 validates the entire pair before write/reset and leaves previous bytes intact', async () => {
    const fixture = await setup();
    const config = { ...emptyConfig(), parallelism: policy() };
    await writeAiwgConfig(fixture.root, config);
    const file = join(fixture.root, '.aiwg/aiwg.config');
    const before = await fs.readFile(file, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(main(['reset', '--target', fixture.root, '--project', 'parallelism.groups.fixture'])).rejects.toThrow('Unknown group fixture');
    await expect(main(['set', '--project', 'parallelism.groups.fixture.fallback', '["missing"]', '--target', fixture.root])).rejects.toThrow('OG_CONFIG_REFERENCE');
    await expect(main(['set', '--project', 'parallelism.max_parallel_subagents', '51', '--target', fixture.root])).rejects.toThrow('integer between 1 and 50');
    await expect(main(['reset', '--project', 'parallelism.groups.__proto__.polluted', '--target', fixture.root])).rejects.toThrow('Unsafe configuration path');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((Object.prototype as any).polluted).toBeUndefined();
    await main(['set', '--target', fixture.root, '--project', 'parallelism.worker_mode', 'managed']);
    await main(['reset', '--project', 'parallelism.worker_mode', '--target', fixture.root]);
    await main(['get', '--target', fixture.root, '--project', 'parallelism.groups.fixture.members']);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual(group().members);
    expect(resolveParallelism((await readAiwgConfig(fixture.root))!.parallelism).worker_mode).toBe('direct');
    await main(['reset', '--project', 'parallelism', '--target', fixture.root]);
    expect((await readAiwgConfig(fixture.root))?.parallelism?.worker_dispatch).toBeUndefined();
  });

  it('S1-C09 blocks enabled reads and validation after a model edit; disabled config remains usable', async () => {
    const fixture = await setup();
    await writeAiwgConfig(fixture.root, { ...emptyConfig(), parallelism: policy() });
    await fs.writeFile(fixture.projectFile, '{invalid');
    await expect(readAiwgConfig(fixture.root)).rejects.toThrow('Invalid project model config');
    await expect(main(['validate', '--project', '--target', fixture.root])).rejects.toThrow('Invalid project model config');
    // The config owner can explicitly disable groups without loading a broken
    // model policy. No failed read is translated into a default enabled policy.
    await writeAiwgConfig(fixture.root, { ...emptyConfig(), parallelism: { worker_dispatch: false } });
    expect((await readAiwgConfig(fixture.root))?.parallelism?.worker_dispatch).toBe(false);
  });

  // #3050 fix-first: the decline is a setup/onboarding preference, not
  // worker policy — it lives in `setup`, never in `parallelism` (the
  // frozen B-OG-29 contract fragment asserted in
  // test/conformance/mission-v1/worker-policy.test.ts).
  it('round-trips setup.worker_dispatch_offer (#3050) without touching parallelism at all', async () => {
    const fixture = await setup();
    await writeAiwgConfig(fixture.root, { ...emptyConfig(), setup: { worker_dispatch_offer: 'declined' } });
    const cfg = await readAiwgConfig(fixture.root);
    expect(cfg?.setup?.worker_dispatch_offer).toBe('declined');
    expect(cfg?.parallelism?.worker_dispatch).toBeUndefined();
    expect(validateParallelismConfig(cfg?.parallelism)).toEqual([]);
  });

  it.each(['userFile', 'projectFile'] as const)('S1-C10 treats only ENOENT as optional absence (%s)', async key => {
    const fixture = await setup();
    await fixture.loader.load(policy());
    faults.readPath = fixture[key];
    await expect(fixture.loader.load(policy())).rejects.toThrow('synthetic unreadable file');
    await expect(fixture.loader.load(policy())).rejects.toThrow('synthetic unreadable file');
  });

  it('S1-C11 cannot fall back to a compatibility config on a canonical access failure', async () => {
    const fixture = await setup();
    await writeAiwgConfig(fixture.root, { ...emptyConfig(), parallelism: policy() });
    const file = join(fixture.root, '.aiwg/aiwg.config');
    faults.accessPath = file;
    await expect(readAiwgConfig(fixture.root)).rejects.toThrow('synthetic canonical access failure');
  });

  it('S1-C12 re-reads all input digests without creating activation or service state', async () => {
    const fixture = await setup();
    await writeAiwgConfig(fixture.root, { ...emptyConfig(), parallelism: policy() });
    await fixture.loader.load(policy());
    const initial = fixture.loader.getInputDigests()!;
    expect(initial.userModelsDigest).toBe(workerConfigDigest(null));
    await fs.writeFile(fixture.userFile, JSON.stringify({ defaults: { tier: 'premium' } }));
    await fixture.loader.load(policy());
    const userChanged = fixture.loader.getInputDigests()!;
    expect(userChanged.userModelsDigest).not.toBe(initial.userModelsDigest);
    expect(userChanged.projectModelsDigest).toBe(initial.projectModelsDigest);
    await fs.writeFile(fixture.builtinFile, JSON.stringify({ ...fixture.defaults, shorthand: {} }));
    await fixture.loader.load(policy());
    expect(fixture.loader.getInputDigests()!.builtinModelsDigest).not.toBe(initial.builtinModelsDigest);
    await fs.rm(fixture.userFile);
    await fixture.loader.load(policy());
    expect(fixture.loader.getInputDigests()!.userModelsDigest).toBe(initial.userModelsDigest);
    expect((await readAiwgConfig(fixture.root))?.parallelism?.activation).toBeUndefined();
    expect(await fs.readdir(join(fixture.root, '.aiwg'))).toEqual(['aiwg.config']);
    fixture.loader.clearCache();
    expect(fixture.loader.getInputDigests()).toBeNull();
  });

  it('S1-C13 preserves native defaults with no group policy and validates direct digests read-only', async () => {
    const fixture = await setup();
    await fs.rm(fixture.projectFile);
    const unbound = await fixture.loader.load();
    expect(unbound.defaults).toEqual(fixture.defaults.defaults);
    expect(unbound.workerPolicyOrigins).toBeUndefined();
    for (const provider of Object.keys(loadProviderModelCapabilities().providers)) {
      expect(resolveParallelism(undefined, provider)).toEqual(getProviderParallelismDefaults(provider));
      expect(resolveParallelism({ ...policy(), worker_dispatch: false }, provider)).toEqual(getProviderParallelismDefaults(provider));
    }
    const enabled = await fixture.loader.load(policy());
    expect(enabled.defaults.workerSelection).toEqual(DEFAULT_WORKER_SELECTION);
    expect(enabled.defaults.workerSelection?.guards).not.toHaveProperty('denyConductorWorkerExecution');
    expect(enabled.workerPolicyOrigins).not.toHaveProperty('/defaults/workerSelection/guards/denyConductorWorkerExecution');
    expect(await fixture.loader.load(policy())).toBe(enabled);
    expect(existsSync(join(fixture.root, '.aiwg'))).toBe(false);
  });

  it('S1-C14 rejects a null bundled policy without concealing it behind cached defaults', async () => {
    const fixture = await setup();
    const initial = await fixture.loader.load(policy());
    await fs.writeFile(fixture.builtinFile, JSON.stringify({
      ...fixture.defaults, defaults: { ...fixture.defaults.defaults, workerSelection: null },
    }));
    await expect(fixture.loader.load(policy())).rejects.toThrow('Failed to load AIWG default config');
    await expect(fixture.loader.load(policy())).rejects.toThrow('Failed to load AIWG default config');
    await fs.writeFile(fixture.builtinFile, JSON.stringify(fixture.defaults));
    expect(await fixture.loader.load(policy())).toBe(initial);
  });
});

describe('T-OG-15/17/19 S1 trusted installation mapping; fixture qualification only', () => {
  const rows = fixtureJson('provider-coverage.json').rows.filter((row: any) => row.scope === 'IN' && row.kind === 'deployment-provider');
  it.each(rows)('S1-I01 canonical $provider inherits trusted process metadata without claiming live readiness', row => {
    const registry = structuredClone(loadProviderModelCapabilities());
    const adapter = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
    adapter.id = `fixture-${row.provider}`;
    registry.providers[row.provider as keyof typeof registry.providers].workerAdapter = adapter;
    const input = policy();
    input.groups!.fixture.members[0].cli = row.provider;
    const before = JSON.stringify(input);
    for (const transport of ['shell', 'mcp'] as const) {
      input.groups!.fixture.execution = { transport };
      const resolved = resolveWorkerGroupInstallation(input, row.provider, registry);
      expect(resolved.installation).toEqual({ adapter: `providers:${row.provider}`, enabled: true });
      expect(resolved.executable).toBe(adapter.invocation.executable);
      expect(resolved.adapter.invocationProfiles).toEqual(adapter.invocationProfiles);
      expect(resolved.adapter.qualification.status).toBe('unqualified');
      expect(() => qualifyWorkerInvocationProfile(resolved.adapter, { profile: 'fixture-shell', transport, cliVersion: '1.2.3' })).toThrow('unqualified');
    }
    delete input.groups!.fixture.execution;
    expect(JSON.stringify(input)).toBe(before);
  });

  it('S1-I02 explicit canonical installation overrides the default without changing trusted profiles', () => {
    const registry = structuredClone(loadProviderModelCapabilities());
    const adapter = structuredClone(fixtureJson('shared-vectors.json').find((v: any) => v.id === 'adapter-process-shape').value);
    registry.workerAdapters = { fixture: adapter };
    const input = policy();
    input.clis = { codex: { adapter: 'workerAdapters:fixture', accountScope: 'synthetic-account', quotaScope: 'synthetic-quota', executable: '/approved/path with spaces/worker', invocationProfile: 'fixture-shell' } };
    const before = JSON.stringify(input);
    const resolved = resolveWorkerGroupInstallation(input, 'codex', registry);
    expect(resolved.executable).toBe('/approved/path with spaces/worker');
    expect(resolved.installation).toMatchObject(input.clis.codex);
    expect(JSON.stringify(input)).toBe(before);
    input.clis.codex.enabled = false;
    expect(() => resolveWorkerGroupInstallation(input, 'codex', registry)).toThrow('Installation is disabled');
    expect(() => resolveWorkerGroupInstallation({ ...input, worker_dispatch: false }, 'codex', registry)).toThrow('Worker dispatch is disabled');
  });

  it.each(['generic', 'openai', 'claude-code', 'missing'])('S1-I03 %s is not an implicit canonical worker installation', id => {
    expect(() => resolveWorkerGroupInstallation(policy(), id)).toThrow('Unknown canonical installation');
  });

  it('S1-I04 registry presence alone cannot manufacture a bundled invocation profile', () => {
    expect(() => resolveWorkerGroupInstallation(policy(), 'codex')).toThrow('OG_ADAPTER_UNQUALIFIED');
    const invalid = policy();
    invalid.groups!.fixture.members[0].cli = 'openai';
    expect(validateParallelismConfig(invalid).join()).toContain('Unknown installation');
  });
});

describe('worker launch mode config schema', () => {
  it('accepts native-sandbox with non-interactive denied-network codex installations', () => {
    const config = policy();
    config.clis = { local: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'synthetic' } };
    config.groups!.fixture.members.push({ ...group().members[0], id: 'local', cli: 'local' });
    config.groups!.fixture.execution = { launchMode: 'native-sandbox', sandbox: 'workspace-write', approval: 'never', network: 'deny' };
    expect(validateParallelismConfig(config)).toEqual([]);
  });

  it.each([
    { field: 'approval', value: 'on-request', message: 'native-sandbox requires approval="never"' },
    { field: 'network', value: 'allowlisted', message: 'native-sandbox requires network="deny"' },
  ])('refuses native-sandbox with $field=$value', ({ field, value, message }) => {
    const config = policy();
    config.groups!.fixture.execution = { launchMode: 'native-sandbox', sandbox: 'workspace-write', [field]: value };
    expect(validateParallelismConfig(config)).toEqual([
      `OG_CONFIG_REFERENCE /parallelism/groups/fixture/execution/${field}: ${message}`,
    ]);
  });

  it.each([
    { cli: 'claude', adapter: undefined },
    { cli: 'codex', adapter: 'providers:claude' },
    { cli: 'local', adapter: 'workerAdapters:fixture' },
  ])('refuses native-sandbox with non-codex adapter $adapter on $cli', ({ cli, adapter }) => {
    const config = policy();
    if (adapter) config.clis = { [cli]: { adapter, accountScope: 'synthetic', quotaScope: 'synthetic' } };
    config.groups!.fixture.members.push({ ...group().members[0], id: 'other', cli, enabled: false });
    config.groups!.fixture.execution = { launchMode: 'native-sandbox', sandbox: 'workspace-write' };
    const errors = validateParallelismConfig(config);
    expect(errors).toContain('OG_CONFIG_REFERENCE /parallelism/groups/fixture/members/other/cli: native-sandbox requires a codex adapter');
  });

  it('accepts explicit systemd-unit and native-sandbox enforcing shell policies', () => {
    for (const launchMode of ['systemd-unit', 'native-sandbox'] as const) {
      const config = policy();
      config.groups!.fixture.execution = { launchMode, sandbox: 'workspace-write', transport: 'shell' };
      expect(validateParallelismConfig(config)).toEqual([]);
    }
  });

  it.each(['external', 'none', 'danger-full-access', undefined])('refuses native-sandbox with sandbox=%s', sandbox => {
    const config = policy();
    config.groups!.fixture.execution = { launchMode: 'native-sandbox', sandbox: sandbox as any };
    expect(validateParallelismConfig(config).length).toBeGreaterThan(0);
  });

  it('refuses unknown modes and native-sandbox MCP transport', () => {
    const config = policy();
    config.groups!.fixture.execution = { launchMode: 'unknown' as any, sandbox: 'workspace-write' };
    expect(validateParallelismConfig(config).length).toBeGreaterThan(0);
    config.groups!.fixture.execution = { launchMode: 'native-sandbox', sandbox: 'workspace-write', transport: 'mcp' };
    expect(validateParallelismConfig(config).length).toBeGreaterThan(0);
  });
});
