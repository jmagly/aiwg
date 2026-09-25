import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import {
  BoundedDecisionMetrics, FileCompileCache, JevDecisionAdapter, LlmSubagentDecisionAdapter, MemoryCompileCache,
  cacheBenchmarkReport, changedPrefixDimensions, compileCacheKey, compileCacheTelemetry, evaluateCacheBenchmarkTarget,
  evaluateDecisionRuleset, evaluateProviderPrefixReuse, mapCacheTelemetry, prepareAdapterRequest, providerPrefixKey,
  recordDecisionSpanMetrics, sanitizeAttributes,
  type CacheTelemetry, type CompileCacheIdentity, type CompileCacheReadContext, type DecisionAdapterRequest,
  type DecisionBinding, type DecisionCompileCachePolicy, type DecisionDefinition, type DecisionRuleset,
  type ProviderPrefixCompatibilityRecord, type ProviderPrefixIdentity, type RulesetResult,
} from '../../../src/decision/index.js';
import {
  DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, type DecisionLifecyclePolicy,
} from '../../../src/decision/lifecycle.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const definitions = (): Record<string, DecisionDefinition> => ({
  category: fixture('decision-category.json'), severity: fixture('decision-severity.json'), core: fixture('decision-core_unavailable.json'),
});
const lifecyclePolicy = (): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, { classification: 'internal',
    accessScopes: ['decision-runtime'], retentionMs: 100_000, export: 'denied', deletion: 'tombstone',
    backup: 'expire-with-primary' }])) as DecisionLifecyclePolicy['surfaces'] });
const context = (nowEpochMs = 100, overrides: Partial<CompileCacheReadContext> = {}): CompileCacheReadContext =>
  ({ tenantId: 'tenant', projectId: 'project', nowEpochMs, authorize: () => true, ...overrides });
function identity(overrides: Partial<CompileCacheIdentity> = {}): CompileCacheIdentity {
  return { identityVersion: 'decision-compile-cache-identity/v1', layer: 'adapter-compilation',
    sourceArtifactDigests: [digest('a')], compiler: { id: 'decision', version: '1' }, runtimeVersion: 'node-22',
    schemaVersion: 'decision-v1alpha2', canonicalizer: { id: 'rfc8785', version: '1' },
    adapter: { id: 'jev', version: '1.0.0', promptVersion: 'jev-question/v1' }, backendCapabilityMode: 'json-schema',
    modelPolicy: { requested: 'jev-latest', compatibleActualModels: ['jev-1.13.0'] }, featureFlags: { strict: true },
    tenantId: 'tenant', projectId: 'project', dataClass: 'internal', ...overrides };
}
function prefix(overrides: Partial<ProviderPrefixIdentity> = {}): ProviderPrefixIdentity {
  return { schemaVersion: 'decision-provider-prefix-identity/v1', orderedPrefixDigest: digest('c'), provider: 'jev', backend: 'structured',
    requestedModel: 'jev-latest', actualModel: 'jev-1.13.0', apiRevision: 'v1', policy: { id: 'documented', version: '1', ttlMs: 1_000 },
    tenantId: 'tenant', workspaceId: 'project', dataClass: 'internal', region: 'us', egressPolicyDigest: digest('d'), ...overrides };
}
const schema = (name: string) => JSON.parse(readFileSync(`schemas/decision/${name}.schema.json`, 'utf8'));
function ajv() {
  const validator = new Ajv2020({ strict: false });
  for (const name of ['DecisionCompileCacheIdentity.v1', 'DecisionCompileCacheEntry.v1', 'DecisionCompileCacheTombstone.v1',
    'DecisionProviderPrefixIdentity.v1', 'DecisionProviderPrefixCompatibility.v1', 'DecisionCacheTelemetry.v1',
    'DecisionProviderPrefixEvidence.v1', 'DecisionResultCacheEntry.v1']) validator.addSchema(schema(name));
  return (name: string, value: unknown) => validator.validate(`https://aiwg.io/schemas/decision/${name}.schema.json`, value);
}

/** Fake Jev service: answers every requested question deterministically and records request bodies. */
function fakeJev() {
  const bodies: string[] = [];
  const fetch = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const questions = (JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria: unknown }> }).questions;
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria as Record<string, string>);
        return [id, { type: 'choice', choice: keys[0], confidence: 0.9,
          probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 0.9 : 0.1 / (keys.length - 1)])) }];
      }
      if (question.type === 'score') {
        const levels = question.criteria as string[];
        return [id, { type: 'score', score: 0, confidence: 0.8, legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
          probabilities: Object.fromEntries(levels.map((_level, index) => [String(index), index === 0 ? 1 : 0])) }];
      }
      return [id, { type: 'noul', noul: 0.1 }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}

/** Drop wall-clock fields; everything else, including decision semantics, must match exactly. */
function semantics(result: RulesetResult): unknown {
  return JSON.parse(JSON.stringify(result, (key, value) =>
    /(At|EpochMs|durationMs|DurationMs)$/.test(key) || key === 'generatedAt' ? undefined : value));
}

describe('D30 compile/prefix cache offline closure', () => {
  it('CCP-SCHEMA versioned schemas cover every cache record and all five layers', async () => {
    const validate = ajv();
    const store = new MemoryCompileCache<{ value: string }>({ lifecyclePolicy: lifecyclePolicy() });
    const filled = await store.getOrCompile(identity(), context(), 1_000, async () => ({ value: 'compiled' }));
    expect(validate('DecisionCompileCacheIdentity.v1', identity())).toBe(true);
    expect(validate('DecisionCompileCacheEntry.v1', filled.entry)).toBe(true);
    store.setLegalHold(identity(), context(101), { subject: 'case', reason: 'hold', scope: ['cache'], expiresAt: 500, authorizedBy: 'officer' });
    expect(validate('DecisionCompileCacheEntry.v1', store.read(identity(), context(102)))).toBe(true);
    expect(validate('DecisionCompileCacheEntry.v1', { ...filled.entry, tombstonedAtEpochMs: null })).toBe(false);

    const directory = await mkdtemp(join(tmpdir(), 'decision-ccp-schema-'));
    const file = new FileCompileCache<string>(directory, { lifecyclePolicy: lifecyclePolicy() });
    const entry = await file.getOrCompile(identity(), context(), 1_000, async () => 'compiled');
    await file.delete(identity(), context(101));
    const tombstone = JSON.parse(await readFile(join(directory, `${entry.key.slice(7)}.json`), 'utf8'));
    expect(validate('DecisionCompileCacheTombstone.v1', tombstone)).toBe(true);
    expect(validate('DecisionCompileCacheTombstone.v1', { ...tombstone, value: 'compiled' })).toBe(false);

    expect(validate('DecisionProviderPrefixIdentity.v1', prefix())).toBe(true);
    expect(validate('DecisionProviderPrefixIdentity.v1', { ...prefix(), rawPrompt: 'x' })).toBe(false);
    const record: ProviderPrefixCompatibilityRecord = { schemaVersion: 'decision-provider-prefix-compatibility/v1',
      fromIdentityDigest: providerPrefixKey(prefix()), toIdentityDigest: providerPrefixKey(prefix({ apiRevision: 'v2' })),
      permits: ['apiRevision'], aliasSnapshot: null, approvedBy: 'owner', expiresAtEpochMs: 5_000 };
    expect(validate('DecisionProviderPrefixCompatibility.v1', record)).toBe(true);
    expect(validate('DecisionProviderPrefixCompatibility.v1', { ...record, permits: ['requestedModel'] })).toBe(false);
    expect(validate('DecisionProviderPrefixCompatibility.v1', { ...record, permits: ['tenantId'] })).toBe(false);

    const layers = schema('DecisionCacheTelemetry.v1').properties.layer.enum;
    expect(layers).toEqual(['definition-compilation', 'adapter-compilation', 'provider-prefix', 'invocation-replay', 'semantic-result']);
    for (const layer of layers) {
      expect(validate('DecisionCacheTelemetry.v1', { ...compileCacheTelemetry(identity(), 'hit', 1, 10), layer })).toBe(true);
    }
    expect(validate('DecisionCacheTelemetry.v1', { ...compileCacheTelemetry(identity(), 'hit', 1, 10), key: filled.key })).toBe(false);
    expect(validate('DecisionCacheTelemetry.v1', { ...compileCacheTelemetry(identity(), 'hit', 1, 10), reason: 'alias-category' })).toBe(false);
  });

  it('CCP-002 each identity dimension mutated independently misses and creates a new immutable entry', async () => {
    const mutations: Array<[string, Partial<CompileCacheIdentity>]> = [
      ['identityVersion', { identityVersion: 'decision-compile-cache-identity/v2' as never }],
      ['layer', { layer: 'definition-compilation' }],
      ['sourceArtifactDigests', { sourceArtifactDigests: [digest('b')] }],
      ['compiler.id', { compiler: { id: 'other', version: '1' } }],
      ['compiler.version', { compiler: { id: 'decision', version: '2' } }],
      ['runtimeVersion', { runtimeVersion: 'node-24' }],
      ['schemaVersion', { schemaVersion: 'decision-v1alpha1' }],
      ['canonicalizer.id', { canonicalizer: { id: 'jcs-alt', version: '1' } }],
      ['canonicalizer.version', { canonicalizer: { id: 'rfc8785', version: '2' } }],
      ['adapter.id', { adapter: { id: 'llm-subagent', version: '1.0.0', promptVersion: 'jev-question/v1' } }],
      ['adapter.version', { adapter: { id: 'jev', version: '1.1.0', promptVersion: 'jev-question/v1' } }],
      ['adapter.promptVersion', { adapter: { id: 'jev', version: '1.0.0', promptVersion: 'jev-question/v2' } }],
      ['backendCapabilityMode', { backendCapabilityMode: 'grammar' }],
      ['modelPolicy.requested', { modelPolicy: { requested: 'jev-next', compatibleActualModels: ['jev-1.13.0'] } }],
      ['modelPolicy.compatibleActualModels', { modelPolicy: { requested: 'jev-latest', compatibleActualModels: ['jev-1.14.0'] } }],
      ['featureFlags', { featureFlags: { strict: false } }],
      ['tenantId', { tenantId: 'other-tenant' }],
      ['projectId', { projectId: 'other-project' }],
      ['dataClass', { dataClass: 'restricted' }],
    ];
    const cache = new MemoryCompileCache<string>({ lifecyclePolicy: lifecyclePolicy() });
    const base = await cache.getOrCompile(identity(), context(), 1_000, async () => 'base');
    const keys = new Set([base.key]);
    for (const [name, overrides] of mutations) {
      const pins = identity(overrides);
      const scope = context(100, { tenantId: pins.tenantId, projectId: pins.projectId });
      const result = await cache.getOrCompile(pins, scope, 1_000, async () => `artifact-${name}`);
      expect(result.outcome, name).toBe('miss');
      expect(result.entry.value, name).toBe(`artifact-${name}`);
      keys.add(result.key);
    }
    expect(keys.size).toBe(mutations.length + 1);
    expect((await cache.getOrCompile(identity(), context(101), 1_000, async () => 'wrong')).entry.value).toBe('base');
  });

  it('CCP-003 property suite: canonical equivalence only for key order; distinct values never collide', () => {
    let seed = 0x2603;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const pick = <T>(values: readonly T[]) => values[next() % values.length]!;
    const shuffle = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffle);
      if (!value || typeof value !== 'object') return value;
      const entries = Object.entries(value).map(([key, item]) => [key, shuffle(item)] as const);
      for (let index = entries.length - 1; index > 0; index--) {
        const other = next() % (index + 1); [entries[index], entries[other]] = [entries[other]!, entries[index]!];
      }
      return Object.fromEntries(entries);
    };
    const strings = ['a', 'b', 'é', 'é', 'ｅ', '0', '00', ' a', 'a ', 'Ω', 'Ω'];
    const byCanonical = new Map<string, string>();
    for (let index = 0; index < 512; index++) {
      const pins = identity({
        sourceArtifactDigests: [digest(pick(['a', 'b', 'c'])), digest(pick(['d', 'e']))],
        compiler: { id: pick(strings), version: String(next() % 7) },
        adapter: { id: pick(['jev', 'llm-subagent']), version: pick(strings), promptVersion: pick(strings) },
        modelPolicy: { requested: pick(strings), compatibleActualModels: [pick(strings), pick(strings)] },
        featureFlags: { alpha: Boolean(next() & 1), beta: pick(strings), numeric: next() % 5, [`flag-${next() % 3}`]: pick([1, '1', true]) },
        dataClass: pick(strings),
      });
      const key = compileCacheKey(pins);
      // Reordering object keys at every depth is the only promised equivalence.
      expect(compileCacheKey(shuffle(pins) as CompileCacheIdentity)).toBe(key);
      byCanonical.set(canonicalJson(pins), key);
    }
    // Distinct canonical identities (array order, Unicode form, value type, whitespace) never share a key.
    expect(byCanonical.size).toBeGreaterThan(400);
    expect(new Set(byCanonical.values()).size).toBe(byCanonical.size);
    const pairs: Array<[Partial<CompileCacheIdentity>, Partial<CompileCacheIdentity>]> = [
      [{ dataClass: 'é' }, { dataClass: 'é' }],
      [{ featureFlags: { value: 1 } }, { featureFlags: { value: '1' } }],
      [{ featureFlags: { value: true } }, { featureFlags: { value: 'true' } }],
      [{ compiler: { id: 'a ', version: '1' } }, { compiler: { id: 'a', version: '1' } }],
      [{ modelPolicy: { requested: 'm', compatibleActualModels: ['x', 'y'] } }, { modelPolicy: { requested: 'm', compatibleActualModels: ['y', 'x'] } }],
      [{ sourceArtifactDigests: [digest('a'), digest('b')] }, { sourceArtifactDigests: [digest('b'), digest('a')] }],
    ];
    for (const [left, right] of pairs) expect(compileCacheKey(identity(left))).not.toBe(compileCacheKey(identity(right)));
  });

  it('CCP-009 every prefix identity dimension changes the protected key', () => {
    const base = providerPrefixKey(prefix());
    const mutations: Partial<ProviderPrefixIdentity>[] = [
      { orderedPrefixDigest: digest('e') }, { provider: 'other' }, { backend: 'grammar' }, { requestedModel: 'jev-next' },
      { actualModel: 'jev-1.14.0' }, { actualModel: null }, { apiRevision: 'v2' },
      { policy: { id: 'other', version: '1', ttlMs: 1_000 } }, { policy: { id: 'documented', version: '2', ttlMs: 1_000 } },
      { policy: { id: 'documented', version: '1', ttlMs: 2_000 } }, { tenantId: 'other' }, { workspaceId: 'other' },
      { dataClass: 'restricted' }, { region: 'eu' }, { egressPolicyDigest: digest('f') },
    ];
    const keys = mutations.map(value => providerPrefixKey(prefix(value)));
    expect(keys.every(key => key !== base)).toBe(true);
    expect(new Set(keys).size).toBe(mutations.length);
  });

  it('CCP-012 prefix reuse is invalidated by drift and TTL unless a pinned compatibility record permits it', async () => {
    const cached = prefix();
    const record = (next: ProviderPrefixIdentity, overrides: Partial<ProviderPrefixCompatibilityRecord> = {}): ProviderPrefixCompatibilityRecord => ({
      schemaVersion: 'decision-provider-prefix-compatibility/v1', fromIdentityDigest: providerPrefixKey(cached),
      toIdentityDigest: providerPrefixKey(next), permits: changedPrefixDimensions(cached, next) as never, aliasSnapshot: null,
      approvedBy: 'owner', expiresAtEpochMs: 10_000, ...overrides });
    const reuse = (next: ProviderPrefixIdentity, records: ProviderPrefixCompatibilityRecord[] = [], nowEpochMs = 500,
      verifyAliasSnapshot?: () => boolean) =>
      evaluateProviderPrefixReuse({ cached, cachedAtEpochMs: 100, next, nowEpochMs, records, verifyAliasSnapshot });

    expect(await reuse(prefix())).toMatchObject({ reusable: true, reason: 'identical' });
    expect(await reuse(prefix(), [], 1_100)).toMatchObject({ reusable: false, reason: 'ttl-expired' });
    // Transferable drift without a record invalidates; a pinned record permits exactly that change.
    for (const next of [prefix({ apiRevision: 'v2' }), prefix({ backend: 'grammar' }),
      prefix({ policy: { id: 'documented', version: '2', ttlMs: 1_000 } }), prefix({ policy: { id: 'documented', version: '1', ttlMs: 5_000 } })]) {
      expect(await reuse(next), JSON.stringify(next)).toMatchObject({ reusable: false, reason: 'identity-changed' });
      expect(await reuse(next, [record(next)]), JSON.stringify(next)).toMatchObject({ reusable: true, reason: 'pinned-compatibility' });
      expect(await reuse(next, [record(next, { expiresAtEpochMs: 400 })])).toMatchObject({ reusable: false, reason: 'record-expired' });
    }
    // A shorter TTL takes effect immediately even under a record.
    const shorter = prefix({ policy: { id: 'documented', version: '1', ttlMs: 300 } });
    expect(await reuse(shorter, [record(shorter)])).toMatchObject({ reusable: false, reason: 'ttl-expired' });
    // Scope, data class, region, egress, provider and prefix bytes can never transfer.
    for (const next of [prefix({ tenantId: 'other' }), prefix({ workspaceId: 'other' }), prefix({ dataClass: 'restricted' }),
      prefix({ region: 'eu' }), prefix({ egressPolicyDigest: digest('f') }), prefix({ provider: 'other' }),
      prefix({ orderedPrefixDigest: digest('e') })]) {
      expect(await reuse(next, [record(next, { permits: ['requestedModel', 'actualModel', 'apiRevision', 'backend', 'policy'] })]))
        .toMatchObject({ reusable: false, reason: 'non-transferable-dimension' });
    }
    // A record for another pair, or one that does not permit the changed dimension, does not apply.
    const revision = prefix({ apiRevision: 'v2' });
    expect(await reuse(revision, [record(prefix({ apiRevision: 'v3' }))])).toMatchObject({ reusable: false, reason: 'identity-changed' });
    expect(await reuse(revision, [record(revision, { permits: ['backend'] })])).toMatchObject({ reusable: false, reason: 'record-mismatch' });
    // An alias move needs an approved, unexpired D09 snapshot confirmed by the host registry.
    const moved = prefix({ actualModel: 'jev-1.14.0' });
    const snapshot = { alias: 'jev-latest', snapshotId: 'snapshot-7', approvedActualModels: ['jev-1.14.0'], validUntilEpochMs: 5_000 };
    expect(await reuse(moved, [record(moved)])).toMatchObject({ reusable: false, reason: 'alias-snapshot-unverified' });
    expect(await reuse(moved, [record(moved, { aliasSnapshot: snapshot })])).toMatchObject({ reusable: false, reason: 'alias-snapshot-unverified' });
    expect(await reuse(moved, [record(moved, { aliasSnapshot: snapshot })], 500, () => false)).toMatchObject({ reusable: false });
    expect(await reuse(moved, [record(moved, { aliasSnapshot: { ...snapshot, approvedActualModels: ['jev-1.15.0'] } })], 500, () => true))
      .toMatchObject({ reusable: false, reason: 'alias-snapshot-unverified' });
    expect(await reuse(moved, [record(moved, { aliasSnapshot: { ...snapshot, validUntilEpochMs: 400 } })], 500, () => true))
      .toMatchObject({ reusable: false, reason: 'alias-snapshot-unverified' });
    expect(await reuse(moved, [record(moved, { aliasSnapshot: snapshot })], 500, () => true))
      .toMatchObject({ reusable: true, reason: 'pinned-compatibility', changedDimensions: ['actualModel'] });
    const realiased = prefix({ requestedModel: 'jev-next', actualModel: 'jev-1.14.0' });
    expect(await reuse(realiased, [record(realiased, { aliasSnapshot: snapshot })], 500, () => true))
      .toMatchObject({ reusable: false, reason: 'alias-snapshot-unverified' });
    expect(await reuse(realiased, [record(realiased, { aliasSnapshot: { ...snapshot, alias: 'jev-next' } })], 500, () => true))
      .toMatchObject({ reusable: true });
  });

  it('CCP-013 no-cache, miss and hit emit byte-identical Jev requests and identical DecisionResults through evaluateDecisionRuleset', async () => {
    const run = async (compileCache: DecisionCompileCachePolicy | undefined) => {
      const jev = fakeJev();
      const result = await evaluateDecisionRuleset({
        ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
        definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId: 'ccp-parity',
        adapters: { jev: new JevDecisionAdapter({ fetch: jev.fetch }) },
        resolveCredential: async () => new TextEncoder().encode('synthetic-token'),
        ...(compileCache ? { compileCache } : {}),
      });
      return { result, bodies: jev.bodies };
    };
    const store = new FileCompileCache<import('../../../src/decision/types.js').JsonValue>(
      await mkdtemp(join(tmpdir(), 'decision-ccp-parity-')), { lifecyclePolicy: lifecyclePolicy() });
    const outcomes: string[] = [];
    const policy = (enabled: boolean): DecisionCompileCachePolicy => ({ enabled, ttlMs: 10_000, store, context: () => context(Date.now()),
      identityFor: ({ definition }) => identity({ sourceArtifactDigests: [compileCacheKey(identity({ featureFlags: { definition: JSON.stringify(definition) } }))] }),
      onResult: ({ outcome }) => { outcomes.push(outcome); } });
    const baseline = await run(undefined);
    const disabled = await run(policy(false));
    const miss = await run(policy(true));
    const hit = await run(policy(true));
    expect(baseline.result.spec.status).toBe('completed');
    expect(baseline.bodies).toHaveLength(3);
    for (const other of [disabled, miss, hit]) {
      expect(other.bodies).toEqual(baseline.bodies);
      expect(semantics(other.result)).toEqual(semantics(baseline.result));
    }
    expect(outcomes).toEqual(['miss', 'miss', 'miss', 'hit', 'hit', 'hit']);
  });

  it('CCP-013 cached and uncached LLM subagent prompts are byte-identical', async () => {
    const worker = fixture<Record<string, unknown>>('worker-fixture.json');
    const { artifactPin } = await import('../../../src/decision/index.js');
    const pin = artifactPin(worker as { metadata: { id: string; version: string } });
    const prompts: string[] = [];
    const adapter = new LlmSubagentDecisionAdapter({ resolveWorker: async () => worker as never,
      runWorker: async request => { prompts.push(JSON.stringify([request.prompt, request.outputSchema]));
        return { started: true, terminal: true, output: { status: 'success', value: 'documentation', confidence: 0.5, distribution: null } }; } });
    const target = { ...fixture<DecisionBinding>('binding-llm-subagent.json').spec.evaluations.category!.targets[0]!, subagent: pin };
    const request: DecisionAdapterRequest = { alias: 'category', definition: definitions().category, input: fixture('input.json'), target,
      invocationId: 'llm', deadlineEpochMs: Date.now() + 1_000, signal: new AbortController().signal, resolveCredential: async () => new Uint8Array() };
    const store = new FileCompileCache<import('../../../src/decision/types.js').JsonValue>(
      await mkdtemp(join(tmpdir(), 'decision-ccp-llm-')), { lifecyclePolicy: lifecyclePolicy() });
    const policy: DecisionCompileCachePolicy = { enabled: true, ttlMs: 10_000, store, context: context(),
      identityFor: () => identity({ adapter: { id: 'llm-subagent', version: '1.0.0', promptVersion: 'llm-subagent-decision-prompt/v1' } }) };
    await adapter.evaluate(request);
    await adapter.evaluate(await prepareAdapterRequest(request, adapter, policy));
    await adapter.evaluate(await prepareAdapterRequest(request, adapter, policy));
    expect(new Set(prompts).size).toBe(1);
    expect(JSON.parse(JSON.parse(prompts[0]!)[0]).input).toEqual(fixture('input.json'));
    expect(await adapter.evaluate({ ...request, compiledArtifact: { format: 'llm-subagent-decision-prompt/v1', frame: '[]', outputSchema: '{}' } }))
      .toMatchObject({ status: 'error', reason: 'invalid-definition' });
  });

  it('CCP-014 adapters compile locally without credentials or dispatch and reject malformed artifacts before sending', async () => {
    const jev = fakeJev(); let credentials = 0;
    const adapter = new JevDecisionAdapter({ fetch: jev.fetch });
    const target = fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!;
    const compiled = await adapter.compile({ definition: definitions().category, target });
    expect(compiled).toMatchObject({ format: 'jev-question/v1', question: expect.any(String) });
    expect(jev.bodies).toHaveLength(0);
    const request: DecisionAdapterRequest = { alias: 'category', definition: definitions().category, input: fixture('input.json'), target,
      invocationId: 'jev', deadlineEpochMs: Date.now() + 1_000, signal: new AbortController().signal,
      resolveCredential: async () => { credentials++; return new TextEncoder().encode('synthetic-token'); } };
    expect(await adapter.evaluate({ ...request, compiledArtifact: { format: 'jev-question/v1', question: '[1]' } }))
      .toMatchObject({ reason: 'invalid-request', dispatchCertainty: 'not-sent' });
    expect(await adapter.evaluate({ ...request, compiledArtifact: { format: 'other', question: '{}' } }))
      .toMatchObject({ reason: 'invalid-request', dispatchCertainty: 'not-sent' });
    expect(jev.bodies).toHaveLength(0);
    expect(credentials).toBe(2);
    expect(await adapter.evaluate({ ...request, compiledArtifact: compiled })).toMatchObject({ status: 'success' });
    expect(JSON.parse(jev.bodies[0]!).questions.category).toEqual(JSON.parse((compiled as { question: string }).question));
  });

  it('CCP-015 compile-layer telemetry is metadata-only, maps through telemetry and keeps metric cardinality bounded', async () => {
    const telemetry: CacheTelemetry[] = [];
    const alias = 'alias-canary-2603';
    const adapter = { id: 'jev', version: '1', capabilities: async () => ({ answerKinds: [], features: [], maxOptions: null, maxLevels: null,
      confidenceProfiles: [], executable: true }), compile: async () => ({ compiled: 'artifact-canary-2603' }),
      evaluate: async () => { throw new Error('unused'); } };
    const request = { alias, definition: definitions().category, target: fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!,
      input: {}, invocationId: 'i', deadlineEpochMs: 1, signal: new AbortController().signal, resolveCredential: async () => new Uint8Array() };
    const store = new MemoryCompileCache<import('../../../src/decision/types.js').JsonValue>({ lifecyclePolicy: lifecyclePolicy() });
    const policy = (enabled: boolean, overrides: Partial<CompileCacheReadContext> = {}): DecisionCompileCachePolicy => ({ enabled, ttlMs: 1_000, store,
      context: context(100, overrides), identityFor: () => identity(), onTelemetry: value => { telemetry.push(value); } });
    await prepareAdapterRequest(request, adapter, policy(false));
    await prepareAdapterRequest(request, adapter, policy(true));
    await prepareAdapterRequest(request, adapter, policy(true));
    await prepareAdapterRequest(request, adapter, policy(true, { authorize: () => false }));
    expect(telemetry.map(value => [value.layer, value.outcome, value.reason, value.invalidationReason])).toEqual([
      ['definition-compilation', 'bypass', 'cache-disabled', null], ['adapter-compilation', 'miss', 'cold-fill', null],
      ['adapter-compilation', 'hit', 'verified-hit', null], ['adapter-compilation', 'rejected', 'store-rejected', 'revalidation-failed']]);
    const validate = ajv();
    const allowedKeys = ['aiwg.cache.layer', 'aiwg.cache.result', 'aiwg.cache.reason', 'aiwg.cache.version', 'aiwg.cache.saved_tokens',
      'aiwg.cache.preparation_ms', 'aiwg.cache.expires_at_ms', 'aiwg.cache.invalidation_reason'];
    for (const value of telemetry) {
      expect(validate('DecisionCacheTelemetry.v1', value)).toBe(true);
      const mapped = mapCacheTelemetry(value);
      expect(Object.keys(mapped.attributes).sort()).toEqual([...allowedKeys].sort());
      expect(sanitizeAttributes(mapped.attributes, { publicExport: true, canaries: [alias] })).toEqual(mapped.attributes);
      const serialized = JSON.stringify(mapped);
      for (const forbidden of [alias, 'artifact-canary-2603', 'sha256:', 'tenant', 'project']) expect(serialized).not.toContain(forbidden);
    }
    const metrics = new BoundedDecisionMetrics(10_000, 1_000);
    for (let index = 0; index < 500; index++) {
      const value = compileCacheTelemetry(identity({ compiler: { id: 'decision', version: `attacker-${index}` } }),
        (['hit', 'miss', 'bypass', 'rejected'] as const)[index % 4]!, index, 1_000 + index);
      recordDecisionSpanMetrics({ name: 'decision.cache', attributes: mapCacheTelemetry(value).attributes } as never, metrics);
    }
    const series = new Set(metrics.snapshot().map(point => JSON.stringify(point.dimensions)));
    expect(series.size).toBeLessThanOrEqual(4);
    for (const point of metrics.snapshot()) {
      expect(Object.keys(point.dimensions).every(key => ['aiwg.cache.layer', 'aiwg.cache.result', 'aiwg.cache.reason'].includes(key))).toBe(true);
      expect(JSON.stringify(point.dimensions)).not.toContain('attacker');
    }
  });

  it('CCP-011 enforces the preregistered minimum benefit target as pass, fail or unknown', () => {
    const sample = (mode: 'cache-disabled' | 'cache-enabled', preparationLatencyMs: number) => ({ mode, preparationLatencyMs,
      inputTokens: null, cachedInputTokens: null, costUsd: null, memoryBytes: 0, storageBytes: 0,
      outcome: mode === 'cache-enabled' ? 'hit' as const : 'bypass' as const, invalidated: false });
    const report = (target: number, disabled: number, enabled: number) => cacheBenchmarkReport(digest('e'), 0, target, '95% CI',
      [sample('cache-disabled', disabled), sample('cache-enabled', enabled)]);
    expect(evaluateCacheBenchmarkTarget(report(500, 10, 5))).toEqual({ metric: 'preparation-latency', targetBps: 500, observedBenefitBps: 5_000, outcome: 'pass' });
    expect(evaluateCacheBenchmarkTarget(report(500, 10, 9.8))).toMatchObject({ observedBenefitBps: 200, outcome: 'fail' });
    expect(evaluateCacheBenchmarkTarget(report(500, 10, 12))).toMatchObject({ outcome: 'fail' });
    expect(evaluateCacheBenchmarkTarget(report(500, 0, 0))).toMatchObject({ observedBenefitBps: null, outcome: 'unknown' });
  });
});
