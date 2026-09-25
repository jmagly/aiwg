import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admissionControllerLoadDriver,
  artifactDigest,
  decisionAdmissionRegistry,
  decisionLoadArrivals,
  decisionLoadEvidenceFlags,
  decisionLoadManifestDigest,
  decisionLoadPolicy,
  decisionLoadResultRecord,
  evaluateDecisionRuleset,
  evaluateQualification,
  runDecisionLoadHarness,
  verifyDecisionLoadResultRecord,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionLoadClock,
  type DecisionLoadDriver,
  type DecisionLoadManifestV2,
  type DecisionLoadResultRecord,
  type DecisionRuleset,
  type QualificationRunManifest,
} from '../../../src/decision/index.js';

// CNC-LOAD-001..004: offline D05 load, spike, and soak qualification harness.
const MANIFEST_PATH = resolve(process.cwd(), 'docs/decision/load-manifest.v2.json');
const EVIDENCE_DIR = resolve(process.cwd(), 'docs/decision/evidence/load-offline-v2');
const MANIFEST_DIGEST = 'sha256:416a41466dc58063f45b5e5e9a7ad78b011cf6d3be50b081bab6e47c76a28a0c';
const WRITE_EVIDENCE = process.env.AIWG_DECISION_LOAD_EVIDENCE === 'write';
const manifestBytes = readFileSync(MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes.toString('utf8')) as DecisionLoadManifestV2;
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
const fakeClock = (): DecisionLoadClock => ({ now: () => Date.now(), advance: async ms => { await vi.advanceTimersByTimeAsync(ms); } });

const observed = (alias: string): AdapterObservation => ({
  status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : 0.1,
  uncertainty: { source: 'provider', profile: 'typesafe-distribution-v1', calibration: 'vendor-claimed', confidence: 0.9,
    distribution: null, calibrationRef: null },
  actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, requestId: 'load-request',
});

/** Drives each arrival through `evaluateDecisionRuleset` with a fake adapter on the harness timeline. */
function evaluatorDriver(): { driver: DecisionLoadDriver; sample: () => { active: number; queued: number } } {
  const workspaceId = 'load-harness-evaluator';
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  ruleset.spec.evaluations = ruleset.spec.evaluations.filter(evaluation => evaluation.alias === 'category');
  ruleset.spec.rules = ruleset.spec.rules.filter(rule => rule.id === 'docs');
  const definitions: Record<string, DecisionDefinition> = { category: fixture('decision-category.json') };
  const bindings = Object.fromEntries(['jev', 'llm-subagent'].map(providerId => {
    const binding = fixture<DecisionBinding>(providerId === 'jev' ? 'binding-jev.json' : 'binding-llm-subagent.json');
    binding.spec.evaluations = { category: binding.spec.evaluations.category! };
    binding.spec.ruleset.digest = artifactDigest(ruleset);
    binding.spec.maxAttempts = 1 + manifest.arrivalModel.maxRetries;
    binding.spec.evaluations.category!.targets[0]!.retry = { maxRetries: manifest.arrivalModel.maxRetries,
      initialDelayMs: manifest.arrivalModel.retryBackoffMs, maxDelayMs: manifest.arrivalModel.retryBackoffMs };
    return [providerId, binding];
  }));
  const input = fixture('input.json');
  const driver: DecisionLoadDriver = async (arrival, signal, context) => {
    let calls = 0;
    const adapter: DecisionAdapter = {
      id: arrival.providerId as 'jev' | 'llm-subagent', version: '1.0.0',
      capabilities: async () => ({ answerKinds: ['choice'], features: ['choice'], maxOptions: 255, maxLevels: 10,
        confidenceProfiles: ['typesafe-distribution-v1'], executable: true, egress: { mode: 'none' as const } }),
      evaluate: async request => {
        const first = calls++ === 0;
        await context.dispatch(arrival.serviceMs, request.signal);
        return first && arrival.failsFirstAttempt
          ? { ...observed(request.alias), status: 'error', reason: 'service-error', value: undefined }
          : observed(request.alias);
      },
    };
    const result = await evaluateDecisionRuleset({
      ruleset, binding: bindings[arrival.providerId]!, definitions, input, runId: 'load', invocationId: `load-${arrival.ordinal}`,
      adapters: { [arrival.providerId]: adapter }, signal, random: () => 0.5,
      scheduler: { ...decisionLoadPolicy(manifest, workspaceId, arrival.principalId),
        estimate: () => ({ tokens: arrival.tokens, attempts: 1, batchSize: 1, items: 1, costUsd: 0, retainedWork: 1 }) },
    });
    const attempts = result.spec.evaluations.category?.spec.attempts ?? [];
    const rejected = attempts.find(attempt => attempt.admission?.decision === 'reject');
    const status = result.spec.evaluations.category?.spec.status;
    return {
      attempts: Math.max(1, attempts.length),
      outcome: status === 'success' ? 'completed' : status === 'cancelled' || rejected?.admission?.reason === 'cancelled' ? 'cancelled'
        : rejected ? 'shed' : 'failed',
      ...(rejected ? { admissionReason: rejected.admission!.reason } : {}),
      queueDelaysMs: attempts.filter(attempt => attempt.admission?.decision === 'admit').map(attempt => attempt.admission!.queueDelayMs),
      settledAtMs: Date.now(),
    };
  };
  return { driver, sample: () => decisionAdmissionRegistry.controller(workspaceId)?.snapshot() ?? { active: 0, queued: 0 } };
}

async function qualify(target: DecisionLoadResultRecord['target']): Promise<DecisionLoadResultRecord> {
  vi.useFakeTimers();
  const clock = fakeClock();
  const windowSeconds = target === 'evaluator' ? manifest.duration.evaluatorSampleSeconds
    : manifest.duration.loadSeconds + manifest.duration.spikeSeconds + manifest.duration.soakSeconds;
  const { driver, sample } = target === 'evaluator' ? evaluatorDriver() : admissionControllerLoadDriver(manifest, clock);
  const run = await runDecisionLoadHarness({ manifest, clock, driver, sample, windowSeconds });
  return decisionLoadResultRecord({ manifest, manifestDigest: decisionLoadManifestDigest(manifestBytes), target, windowSeconds, ...run });
}

function committed(target: DecisionLoadResultRecord['target']): DecisionLoadResultRecord {
  return JSON.parse(readFileSync(join(EVIDENCE_DIR, `${target}.json`), 'utf8')) as DecisionLoadResultRecord;
}

describe('offline D05 load harness', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('CNC-LOAD-001 pins the preregistered v2 manifest and its seeded arrivals', () => {
    expect(decisionLoadManifestDigest(manifestBytes)).toBe(MANIFEST_DIGEST);
    expect(manifest.passFail.liveServiceRequired).toBe(false);
    const arrivals = decisionLoadArrivals(manifest);
    expect(arrivals).toEqual(decisionLoadArrivals(manifest));
    expect(arrivals.length).toBeGreaterThan(19_000);
    expect(new Set(arrivals.map(arrival => arrival.principalId))).toEqual(new Set(manifest.principals.map(principal => principal.id)));
    const spike = arrivals.filter(arrival => arrival.atMs >= manifest.duration.loadSeconds * 1000
      && arrival.atMs < (manifest.duration.loadSeconds + manifest.arrivalModel.spikeDurationSeconds) * 1000).length;
    expect(spike / manifest.arrivalModel.spikeDurationSeconds).toBeGreaterThan(2 * manifest.arrivalModel.averageRequestsPerSecond);
  });

  it.each(['admission-controller', 'evaluator'] as const)('CNC-LOAD-002 %s path satisfies every preregistered bound', async target => {
    const record = await qualify(target);
    if (WRITE_EVIDENCE) {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(EVIDENCE_DIR, `${target}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
    expect(record.comparisons.filter(comparison => !comparison.pass)).toEqual([]);
    expect(record.passed).toBe(true);
    expect(record.observations.shed + record.observations.completed + record.observations.failed + record.observations.cancelled)
      .toBe(record.observations.arrivals);
    expect(existsSync(join(EVIDENCE_DIR, `${target}.json`))).toBe(true);
    const retained = committed(target);
    expect(verifyDecisionLoadResultRecord(retained, MANIFEST_DIGEST)).toBe(true);
    expect(retained.passed).toBe(true);
    // Observations are deterministic under fake time; only resource samples depend on the host.
    expect(record.observations).toEqual(retained.observations);
  }, 120_000);

  it('CNC-LOAD-003 keeps G5 on hold for offline evidence and rejects tampered records', () => {
    const records = [committed('admission-controller'), committed('evaluator')];
    const flags = decisionLoadEvidenceFlags(records, MANIFEST_DIGEST);
    expect(flags).toEqual({ 'load-manifest-offline-passed': true, 'load-manifest-qualified': false });
    const run: QualificationRunManifest = { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'load-offline-v2',
      generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: '0123456789abcdef', dirty: false, cases: [], evidence: [], evidenceFlags: flags };
    const report = evaluateQualification(run);
    expect(report.gates.find(gate => gate.id === 'G5')).toMatchObject({ status: 'fail', missing: ['evidence:load-manifest-qualified'] });

    const tampered = structuredClone(records[0]!);
    tampered.observations.maximumActiveCalls = 1;
    expect(verifyDecisionLoadResultRecord(tampered, MANIFEST_DIGEST)).toBe(false);
    expect(decisionLoadEvidenceFlags([tampered, records[1]!], MANIFEST_DIGEST)['load-manifest-offline-passed']).toBe(false);
    expect(decisionLoadEvidenceFlags(records, `sha256:${'0'.repeat(64)}`)['load-manifest-offline-passed']).toBe(false);
  });

  it('CNC-LOAD-004 lets only a passing staged-provider record bound to its manifest qualify G5', () => {
    const staged: DecisionLoadManifestV2 = { ...manifest, mode: 'staged-provider' };
    const digest = decisionLoadManifestDigest(JSON.stringify(staged));
    const retained = committed('admission-controller');
    const record = decisionLoadResultRecord({ manifest: staged, manifestDigest: digest, target: 'admission-controller',
      windowSeconds: retained.window.seconds, observations: retained.observations, resources: retained.resources });
    expect(decisionLoadEvidenceFlags([record], digest)['load-manifest-qualified']).toBe(true);
    const failing = decisionLoadResultRecord({ manifest: staged, manifestDigest: digest, target: 'admission-controller',
      windowSeconds: retained.window.seconds, observations: { ...retained.observations, maximumActiveCalls: 99 }, resources: retained.resources });
    expect(failing.passed).toBe(false);
    expect(decisionLoadEvidenceFlags([record, failing], digest)['load-manifest-qualified']).toBe(false);
  });
});
