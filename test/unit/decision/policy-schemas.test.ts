import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, validateDecisionLifecyclePolicy,
  type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import { validateProjectionPolicy, type DecisionProjectionPolicy } from '../../../src/decision/projection.js';

const load = (name: string) => JSON.parse(readFileSync(new URL(`../../../schemas/decision/${name}`, import.meta.url), 'utf8')) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (value: Ajv2020) => void)(ajv);
const projectionSchema = ajv.compile(load('DecisionProjectionPolicy.v1.schema.json'));
const lifecycleSchema = ajv.compile(load('DecisionLifecyclePolicy.v1.schema.json'));

// Fixture shapes mirror test/unit/decision/projection.test.ts and lifecycle.test.ts.
const projection = (): DecisionProjectionPolicy => ({
  version: '1.0.0', provider: 'typesafe', model: 'jev-1', origin: 'https://api.typesafe.ai', region: 'us',
  purpose: 'triage', allowIncompleteContext: false,
  fields: [
    { pointer: '/evidence', output: 'evidence', source: 'case-record', subject: 'case-7', trust: 'verified', sensitivity: 'internal',
      purpose: 'triage', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'], exportPolicy: 'sanitized',
      deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['typesafe'], allowedModels: ['jev-1'],
      allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] },
    { pointer: '/report', output: 'report', source: 'caller', subject: 'case-7', trust: 'untrusted', sensitivity: 'confidential',
      purpose: 'triage', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'], exportPolicy: 'denied',
      deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['typesafe'], allowedModels: ['jev-1'],
      allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] },
  ],
});

const lifecycle = (): DecisionLifecyclePolicy => ({
  version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'confidential', accessScopes: ['case-worker'], retentionMs: 100,
    export: 'denied', deletion: 'erase', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'],
});

const LIFECYCLE_FIELDS = ['source', 'subject', 'trust', 'sensitivity', 'purpose', 'retentionClass', 'accessScopes',
  'exportPolicy', 'deletionPolicy', 'backupPolicy', 'allowedProviders', 'allowedModels', 'allowedOrigins', 'allowedRegions'] as const;

describe('decision projection policy schema', () => {
  it('SCHEMA-PROJ-01 accepts the runtime-valid projection fixture', () => {
    expect(() => validateProjectionPolicy(projection())).not.toThrow();
    expect(projectionSchema(projection())).toBe(true);
  });

  it('SCHEMA-PROJ-02 accepts the optional maxSensitivity ceiling and rejects unknown values', () => {
    for (const maxSensitivity of ['public', 'internal', 'confidential', 'restricted']) {
      expect(projectionSchema({ ...projection(), maxSensitivity })).toBe(true);
    }
    expect(projectionSchema({ ...projection(), maxSensitivity: 'secret' })).toBe(false);
  });

  it.each(LIFECYCLE_FIELDS)('SCHEMA-PROJ-03 rejects a field missing lifecycle/provenance metadata %s', key => {
    const value = projection();
    delete (value.fields[0] as unknown as Record<string, unknown>)[key];
    expect(projectionSchema(value)).toBe(false);
    expect(() => validateProjectionPolicy(value)).toThrow();
  });

  it('SCHEMA-PROJ-04 rejects empty arrays, non-HTTPS or credentialed origins and unknown control fields', () => {
    const cases: Array<(value: DecisionProjectionPolicy) => void> = [
      value => { value.fields = []; },
      value => { value.fields[0]!.accessScopes = []; },
      value => { value.fields[0]!.allowedOrigins = []; },
      value => { value.fields[0]!.allowedRegions = ['']; },
      value => { value.origin = 'http://api.typesafe.ai'; },
      value => { value.origin = 'https://user:pass@api.typesafe.ai'; },
      value => { value.fields[0]!.allowedOrigins = ['http://api.typesafe.ai']; },
      value => { (value as unknown as Record<string, unknown>).credentialRef = 'x'; },
      value => { (value.fields[0] as unknown as Record<string, unknown>).extra = 'x'; },
      value => { value.fields[0]!.pointer = 'evidence'; },
      value => { value.fields[0]!.exportPolicy = 'public' as 'denied'; },
    ];
    for (const mutate of cases) {
      const value = projection(); mutate(value);
      expect(projectionSchema(value)).toBe(false);
      expect(() => validateProjectionPolicy(value)).toThrow();
    }
  });
});

describe('decision lifecycle policy schema', () => {
  it('SCHEMA-LIFE-01 accepts the runtime-valid decision-lifecycle/v1 fixture', () => {
    expect(() => validateDecisionLifecyclePolicy(lifecycle())).not.toThrow();
    expect(lifecycleSchema(lifecycle())).toBe(true);
  });

  it.each(DECISION_LIFECYCLE_SURFACES)('SCHEMA-LIFE-02 rejects missing lifecycle metadata for %s', surface => {
    const missing = lifecycle();
    delete (missing.surfaces as Partial<DecisionLifecyclePolicy['surfaces']>)[surface];
    expect(lifecycleSchema(missing)).toBe(false);
    for (const key of ['classification', 'accessScopes', 'retentionMs', 'export', 'deletion', 'backup'] as const) {
      const value = lifecycle();
      delete (value.surfaces[surface] as unknown as Record<string, unknown>)[key];
      expect(lifecycleSchema(value)).toBe(false);
      expect(() => validateDecisionLifecyclePolicy(value)).toThrow(/incomplete/);
    }
  });

  it('SCHEMA-LIFE-03 rejects version drift, unknown surfaces, empty scopes and non-positive retention', () => {
    const cases: Array<(value: DecisionLifecyclePolicy) => void> = [
      value => { (value as unknown as Record<string, unknown>).version = 'decision-lifecycle/v2'; },
      value => { (value.surfaces as Record<string, unknown>).unknown = value.surfaces.state; },
      value => { value.surfaces.state.accessScopes = []; },
      value => { value.surfaces.state.accessScopes = ['']; },
      value => { value.surfaces.state.retentionMs = 0; },
      value => { value.surfaces.state.retentionMs = 1.5; },
      value => { value.surfaces.state.backup = 'forever' as 'not-persisted'; },
    ];
    for (const mutate of cases) {
      const value = lifecycle(); mutate(value);
      expect(lifecycleSchema(value)).toBe(false);
      expect(() => validateDecisionLifecyclePolicy(value)).toThrow(/incomplete/);
    }
  });
});
