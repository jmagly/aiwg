import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOT, applyPatch, readFixture, records } from './ensemble-fixtures.js';

// Adapter and transport modules are replaced by spies. The D17 contract must never load or call them.
const loaded = vi.hoisted(() => ({ modules: [] as string[], calls: [] as string[] }));
vi.mock('../../../src/decision/adapters/jev.js', () => {
  loaded.modules.push('jev');
  return { JevDecisionAdapter: class { constructor() { loaded.calls.push('jev-adapter'); } }, createJevTransport: () => loaded.calls.push('jev-transport') };
});
vi.mock('../../../src/decision/adapters/llm-subagent.js', () => {
  loaded.modules.push('llm-subagent');
  return { LlmSubagentDecisionAdapter: class { constructor() { loaded.calls.push('llm-adapter'); } } };
});
vi.mock('../../../src/decision/evaluate.js', () => {
  loaded.modules.push('evaluate');
  return { evaluateDecisionRuleset: () => loaded.calls.push('evaluate') };
});

const ensemble = await import('../../../src/decision/ensemble/index.js');

describe('ENS D17 contract isolation: no adapter, transport or credential path (#2679)', () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(() => {
    const fail = (name: string) => () => { throw new Error(`${name} must not be called by the D17 contract`); };
    spies.push(vi.spyOn(globalThis, 'fetch').mockImplementation(fail('fetch')));
    for (const [module, name] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [net, 'createConnection'], [tls, 'connect']] as const) {
      spies.push(vi.spyOn(module as any, name).mockImplementation(fail(name) as any));
    }
  });
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

  it('ENS-ISO-01 every validator entry point runs without touching a spy', () => {
    const policies = records<any>('ensemble-policy.v1.valid.json');
    const cc = records<any>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09');
    const drift = records<any>('drift-response.v1.valid.json').get('triage-drift-response');
    const vectors = readFixture<{ cases: any[] }>('aggregation-vectors.v1.json').cases;
    const table = readFixture<{ rows: any[] }>('drift-response-table.v1.json').rows;
    for (const policy of policies.values()) { ensemble.validateEnsemblePolicy(policy); ensemble.planEnsembleBudget(policy); }
    for (const vector of vectors) {
      const aggregate = ensemble.aggregateEnsembleResults(applyPatch(policies.get(vector.policy), vector.patch), vector.results);
      ensemble.validateEnsembleAggregate(aggregate);
    }
    ensemble.validateChampionChallenger(cc);
    ensemble.validateDriftResponsePolicy(drift);
    for (const row of table) { try { ensemble.resolveDriftResponse(drift, row.signal); } catch (error) { expect(error).toBeInstanceOf(ensemble.EnsembleContractError); } }
    const report = ensemble.buildEnsembleIntegrityReport({ record: cc, pairedDeltas: [], eligibility: null, integrity: {
      sample_n: 0, uncertainty: null, paired_baseline: null, integrity_mode: 'standard', fresh_workspace_required: false, fresh_workspace_verified: false,
      integrity_state: 'unverified', trusted_score_source: 'local-unverified', compromise_labels: [], weak_signal_reason: null,
      release_gate: { decision: 'HOLD', reasons: ['fixture'] } } });
    ensemble.validateEnsembleIntegrityReport(report);
    for (const kind of Object.keys(ensemble.ENSEMBLE_SCHEMA_FILES)) expect(() => ensemble.checkEnsembleSchema(kind as any, {})).toThrow();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(loaded.modules).toEqual([]);
    expect(loaded.calls).toEqual([]);
  });

  it('ENS-ISO-02 the ensemble module graph imports no adapter, transport, evaluator or credential module', () => {
    const seen = new Set<string>();
    const forbidden = /\/adapters\/|transport|credential|\/evaluate\.ts$|\/job-http\.ts$|\/job-worker\.ts$|\/job-gateway\.ts$/;
    const visit = (file: string): void => {
      if (seen.has(file)) return; seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^(?:import|export)\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)) {
        const [, typeOnly, specifier] = match;
        if (!specifier!.startsWith('.')) {
          expect(['node:crypto', 'node:fs', 'node:path', 'node:url', 'node:util', 'node:zlib', 'ajv/dist/2020.js', 'ajv-formats', 'yaml'], `${file} imports ${specifier}`).toContain(specifier);
          continue;
        }
        const target = resolve(dirname(file), specifier!.replace(/\.js$/, '.ts'));
        expect(forbidden.test(target), `${file} imports ${target}`).toBe(false);
        if (!typeOnly) visit(target);
      }
    };
    visit(resolve(ROOT, 'src/decision/ensemble/index.ts'));
    expect([...seen].some(file => file.endsWith('ensemble/aggregate.ts'))).toBe(true);
    expect([...seen].filter(file => !file.includes('/src/decision/ensemble/')).map(file => file.slice(ROOT.length + 1)).sort())
      .toEqual(['src/decision/entry.ts', 'src/security/artifact-trust.ts']);
  });
});
