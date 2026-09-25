import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  artifactPin, convertDecisionDefinitionV1Alpha1, DECISION_API_VERSION_STRUCTURED, evaluateDecisionRuleset,
  readDecisionDocumentForRollback, validateDecisionDocument, type AdapterObservation, type DecisionAdapter,
  type DecisionBinding, type DecisionDefinition, type DecisionRuleset,
} from '../../../../src/decision/index.js';

/**
 * CON-* contract-conformance checks. They run inside the C36 executor (the
 * contract-validation baseline case) so the aggregate run binds their outcome
 * to G0 through named evidence IDs.
 */
export const CONTRACT_EVIDENCE_IDS = ['CON-SCHEMA-01', 'CON-REJECT-01', 'CON-PIN-01', 'CON-VERSION-01',
  'CON-CONVERT-01', 'CON-RESULT-01'] as const;

const EXAMPLES = 'agentic/code/addons/decision-engine/examples';
const read = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const rejects = (value: unknown): boolean => { try { validateDecisionDocument(value); return false; } catch { return true; } };

export const contractChecks: Readonly<Record<(typeof CONTRACT_EVIDENCE_IDS)[number], () => Promise<void>>> = {
  // Every checked-in decision document validates against its versioned schema.
  'CON-SCHEMA-01': async () => {
    let documents = 0;
    for (const name of (await readdir(EXAMPLES)).filter(file => file.endsWith('.json')).sort()) {
      const value = await read<{ apiVersion?: string; kind?: string }>(`${EXAMPLES}/${name}`);
      if (!value.apiVersion || !value.kind) continue;
      validateDecisionDocument(value);
      documents += 1;
    }
    assert.ok(documents >= 14, `only ${documents} decision documents validated`);
  },
  // Unknown kind or version, a missing required field and an undeclared property fail closed.
  'CON-REJECT-01': async () => {
    const definition = await read<DecisionDefinition>(`${EXAMPLES}/decision-category.json`);
    assert.equal(rejects({ ...definition, kind: 'DecisionPolicy' }), true);
    assert.equal(rejects({ ...definition, apiVersion: 'decision.aiwg.io/v9' }), true);
    const missing = structuredClone(definition) as unknown as { spec: Record<string, unknown> };
    delete missing.spec.question;
    assert.equal(rejects(missing), true);
    assert.equal(rejects({ ...definition, spec: { ...definition.spec, backendPayload: { model: 'x' } } }), true);
    assert.equal(rejects(definition), false);
  },
  // A pin covers content: any authored change moves the digest, and a stale pin stops evaluation before dispatch.
  'CON-PIN-01': async () => {
    const definition = await read<DecisionDefinition>(`${EXAMPLES}/decision-category.json`);
    const changed = structuredClone(definition);
    changed.spec.question = `${changed.spec.question} `;
    assert.notEqual(artifactPin(changed).digest, artifactPin(definition).digest);
    assert.equal(artifactPin(structuredClone(definition)).digest, artifactPin(definition).digest);
    const ruleset = await read<DecisionRuleset>(`${EXAMPLES}/ruleset.json`);
    const binding = await read<DecisionBinding>(`${EXAMPLES}/binding-jev.json`);
    let calls = 0;
    const adapter: DecisionAdapter = { id: 'jev', version: '1.0.0', capabilities: async () => ({
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'],
      maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true,
    }), evaluate: async () => { calls += 1; throw new Error('must not dispatch'); } };
    const result = await evaluateDecisionRuleset({ ruleset, binding,
      definitions: { category: changed, severity: await read(`${EXAMPLES}/decision-severity.json`),
        core: await read(`${EXAMPLES}/decision-core_unavailable.json`) },
      input: await read(`${EXAMPLES}/input.json`), runId: 'con-pin', invocationId: 'con-pin', adapters: { jev: adapter } });
    assert.equal(result.spec.reason, 'digest-mismatch');
    assert.equal(calls, 0);
  },
  // The v1alpha1 executor may read a v1alpha2 document for rollback but never execute it.
  'CON-VERSION-01': async () => {
    const definition = await read<DecisionDefinition>(`${EXAMPLES}/decision-category.json`);
    const upgraded = convertDecisionDefinitionV1Alpha1(definition).definition;
    const readOnly = readDecisionDocumentForRollback(upgraded, 'read-only');
    assert.equal(readOnly.writable, false);
    assert.equal(Object.isFrozen(readOnly.document), true);
    assert.throws(() => readDecisionDocumentForRollback(upgraded, 'execute'));
    assert.equal(readDecisionDocumentForRollback(definition, 'execute').writable, true);
  },
  // Conversion keeps authored strings, validates under the new version, and assigns a new digest.
  'CON-CONVERT-01': async () => {
    const definition = await read<DecisionDefinition>(`${EXAMPLES}/decision-category.json`);
    const converted = convertDecisionDefinitionV1Alpha1(definition);
    assert.equal(converted.definition.apiVersion, DECISION_API_VERSION_STRUCTURED);
    validateDecisionDocument(converted.definition);
    assert.deepEqual(converted.definition.spec, definition.spec);
    assert.equal(converted.previousDigest, artifactPin(definition).digest);
    assert.notEqual(converted.digest, converted.previousDigest);
    assert.throws(() => convertDecisionDefinitionV1Alpha1(converted.definition));
  },
  // A runtime-produced result conforms to the published RulesetResult schema.
  'CON-RESULT-01': async () => {
    const observation = (alias: string): AdapterObservation => ({ status: 'success', reason: 'none',
      value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05, actualModel: 'fixture', requestId: null,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
        calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null } });
    const adapter: DecisionAdapter = { id: 'jev', version: '1.0.0', capabilities: async () => ({
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'], features: ['choice', 'ordinal-score', 'truth-probability'],
      maxOptions: 255, maxLevels: 10, confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true,
    }), evaluate: async request => observation(request.alias) };
    const result = await evaluateDecisionRuleset({ ruleset: await read(`${EXAMPLES}/ruleset.json`),
      binding: await read(`${EXAMPLES}/binding-jev.json`), definitions: { category: await read(`${EXAMPLES}/decision-category.json`),
        severity: await read(`${EXAMPLES}/decision-severity.json`), core: await read(`${EXAMPLES}/decision-core_unavailable.json`) },
      input: await read(`${EXAMPLES}/input.json`), runId: 'con-result', invocationId: 'con-result', adapters: { jev: adapter } });
    assert.equal(result.spec.status, 'completed');
    validateDecisionDocument(result);
    for (const evaluation of Object.values(result.spec.evaluations)) validateDecisionDocument(evaluation);
  },
};

export async function runContractChecks(): Promise<void> {
  for (const id of CONTRACT_EVIDENCE_IDS) await contractChecks[id]();
}
