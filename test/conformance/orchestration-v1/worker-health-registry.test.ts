import { readFileSync, existsSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  loadProviderModelCapabilities, parseProviderModelCapabilities, resolveWorkerAdapter,
  qualifyWorkerInvocationProfile,
} from '../../../src/models/provider-policy.js';
import {
  PROVIDER_IDS, getProviderDefinition, normalizeProviderDefinitionId,
} from '../../../src/providers/provider-definitions.js';

// OpenHuman was promoted by the B-OG-47 recheck (#2911, 2026-10-08) on
// source-only evidence; it stays unqualified like every other doc-only row.
const hostedIn = ['claude', 'codex', 'copilot', 'factory', 'cursor', 'opencode', 'warp',
  'grok-build', 'hermes', 'muse', 'openclaw', 'antigravity', 'deepseek-harness', 'pi', 'omp', 'openhuman'];
const hostedOut = ['windsurf', 'grokbot', 'flue'];
// Health descriptions are inert in the bundled registry. Register copies only
// in this synthetic diagnostic fixture to exercise their adapter contracts.
const registry = structuredClone(loadProviderModelCapabilities());
for (const entry of Object.values(registry.providers)) {
  if (entry.workerHealthAdapter) entry.workerAdapter = structuredClone(entry.workerHealthAdapter);
}
registry.workerAdapters = structuredClone(registry.workerHealthAdapters ?? {});
const schema = JSON.parse(readFileSync('schemas/models/provider-model-capabilities.v1.schema.json', 'utf8'));

// Scenario evidence is checked-in metadata and synthetic fixture paths only.
// This suite performs no live CLI/model invocation, credential read or MC access.
describe('T-OG-19 S1 registry health coverage and qualification boundaries', () => {
  it('HR01 reconciles every matrix/definition row without adding inference providers', () => {
    const matrix = loadYaml(readFileSync('agentic/code/providers/capability-matrix.yaml', 'utf8')) as any;
    const canonical = Object.keys(matrix.providers).map(normalizeProviderDefinitionId);
    expect(canonical.every(Boolean)).toBe(true);
    expect([...new Set(canonical)].sort()).toEqual([...hostedIn, ...hostedOut].sort());
    expect([...PROVIDER_IDS].sort()).toEqual([...hostedIn, ...hostedOut, 'generic'].sort());
    for (const [id, row] of Object.entries(matrix.providers) as Array<[string, any]>) {
      const provider = normalizeProviderDefinitionId(id)!;
      expect(row.route_feasibility.scope).toBe(hostedIn.includes(provider) ? 'in' : 'out');
    }
    expect(normalizeProviderDefinitionId('claude-code')).toBe('claude');
    // 'openai' is the established alias of the codex CLI provider, not a
    // separate inference provider row (the PROVIDER_IDS equality above
    // already proves no inference provider was added).
    expect(normalizeProviderDefinitionId('openai')).toBe('codex');
    expect(PROVIDER_IDS).not.toContain('openai');
    expect(getProviderDefinition('generic')?.id).toBe('generic');
    expect(() => resolveWorkerAdapter(registry, 'providers:generic')).toThrow();
  });

  it.each(hostedIn)('HR02 %s remains in S1 with explicit degraded coverage, provenance and owner', provider => {
    const adapter = resolveWorkerAdapter(registry, `providers:${provider}`);
    const profile = adapter.invocationProfiles!['direct-shell'];
    const health = profile.health!;
    expect(adapter.qualification.status).toBe('unqualified');
    expect(health).toMatchObject({ version: 1, coverage: 'degraded', handshake: 'process-only',
      qualifiedAt: null, qualification: { status: 'unqualified', authorizedLive: false, scopeDigest: null } });
    expect(health.qualificationOwner).toMatch(/^B-OG-[0-9]{2}$/);
    expect(health.evidenceGrades?.length).toBeGreaterThan(0);
    expect(health.provenance?.length).toBe(health.evidenceGrades?.length);
    expect(health.signalParser).toBe(`provider-${provider}-health-v1`);
    expect(existsSync(health.fixtureRef)).toBe(true);
    expect(profile.controls.stepCap.support).toBe('unqualified');
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-shell', transport: 'shell', cliVersion: '1.0.0' }))
      .toThrow('Worker transport/profile is unqualified');
  });

  it.each(hostedOut)('HR03 %s retains explicit OUT health without fabricated execution', provider => {
    const entry = registry.providers[provider as keyof typeof registry.providers];
    expect(entry.workerAdapter).toBeUndefined();
    expect(entry.workerHealthCoverage).toMatchObject({ scope: 'out', coverage: 'unobserved',
      handshake: 'unobserved', qualificationOwner: 'B-OG-47' });
    expect(entry.workerHealthCoverage?.provenance.length).toBeGreaterThan(0);
    expect(() => resolveWorkerAdapter(registry, `providers:${provider}`)).toThrow();
  });

  it('HR04 local HTTP is an ordinary unqualified member with request-bound degraded coverage', () => {
    const adapter = resolveWorkerAdapter(registry, 'workerAdapters:local-http');
    const profile = adapter.invocationProfiles!['direct-http'];
    expect(adapter.invocation).toMatchObject({ kind: 'http', protocol: 'ollama', generatePath: '/api/generate' });
    expect(profile.health).toMatchObject({ outputFraming: 'http-stream', handshake: 'unobserved',
      coverage: 'degraded', qualificationOwner: 'B-OG-09', statusOperation: null, cancelOperation: null });
    expect(existsSync(profile.health!.fixtureRef)).toBe(true);
    expect(adapter.capabilities.cancel).toBe('none'); // Shared-server liveness is not stop evidence.
  });

  it('HR05 strictly validates bundled health records and preserves their metadata losslessly', () => {
    const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));
    const validate = ajv.compile(schema);
    const bundled = JSON.parse(readFileSync('agentic/code/providers/model-capabilities.v1.json', 'utf8'));
    expect(validate(bundled), JSON.stringify(validate.errors)).toBe(true);
    expect(parseProviderModelCapabilities(bundled)).toEqual(bundled);
  });

  it('HR06 native/client protocol features cannot qualify a model worker', () => {
    for (const provider of ['codex', 'muse', 'hermes', 'opencode', 'openclaw', 'pi', 'omp', 'openhuman']) {
      const adapter = resolveWorkerAdapter(registry, `providers:${provider}`);
      expect(Object.values(adapter.invocationProfiles!).every(profile => profile.transport === 'shell')).toBe(true);
      expect(Object.values(adapter.invocationProfiles!).every(profile => profile.mcp === undefined)).toBe(true);
      expect(adapter.qualification.status).toBe('unqualified');
    }
  });
});
