import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundedDecisionMetrics, DecisionReviewService, FileDecisionReviewStore,
  evaluateDecisionRuleset, restoreTelemetryTrace,
  type AdapterObservation, type DecisionAdapter, type DecisionBinding,
  type DecisionDefinition, type DecisionRuleset, type DecisionTelemetrySpan,
} from '../../../src/decision/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const golden = JSON.parse(readFileSync('test/fixtures/decision/telemetry-runtime-golden-v1.json', 'utf8')) as {
  scenarios: Record<string, Record<string, unknown>>;
};
const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

const definitions = (): Record<string, DecisionDefinition> => ({
  category: fixture('decision-category.json'), severity: fixture('decision-severity.json'),
  core: fixture('decision-core_unavailable.json'),
});
const success = (alias: string): AdapterObservation => ({
  status: 'success', reason: 'none', value: alias === 'category' ? 'documentation' : alias === 'severity' ? 0.25 : 0.05,
  uncertainty: { source: 'provider', profile: alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
    calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
  actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: 'request-safe',
});

function request(adapter: DecisionAdapter, spans: DecisionTelemetrySpan[], signal?: AbortSignal) {
  return {
    ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'),
    definitions: definitions(), input: fixture('input.json'), runId: 'run', invocationId: 'telemetry-runtime',
    adapters: { jev: adapter }, resolveCredential: async () => new Uint8Array([1]), signal,
    now: () => 100, random: () => 0.5, delay: async () => undefined,
    telemetry: { hook: { emit: (span: DecisionTelemetrySpan) => { spans.push(span); } }, ids: deterministicIds() },
  };
}

function deterministicIds() {
  let span = 1;
  return { traceId: () => '1'.repeat(32), spanId: () => (span++).toString(16).padStart(16, '0') };
}

function adapter(evaluate: DecisionAdapter['evaluate']): DecisionAdapter {
  return { id: 'jev', version: '1.0.0', evaluate,
    capabilities: async () => ({ answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true }) };
}

describe('decision telemetry runtime golden traces', () => {
  it('emits retry lifecycle spans from the actual evaluator', async () => {
    const spans: DecisionTelemetrySpan[] = []; let calls = 0;
    const binding = fixture<DecisionBinding>('binding-jev.json');
    binding.spec.maxAttempts = 4;
    binding.spec.evaluations.category!.targets[0]!.retry.maxRetries = 1;
    binding.spec.evaluations.category!.fallbackOn = ['network-transient'];
    const configured = request(adapter(async input => {
      calls += 1;
      if (input.alias === 'category' && calls === 1) return { ...success(input.alias), status: 'error', reason: 'network-transient', value: null };
      return success(input.alias);
    }), spans);
    configured.binding = binding;
    const result = await evaluateDecisionRuleset(configured);
    expect(result.spec.status).toBe('completed');
    const observed = { spanNames: spans.map(span => span.name),
      retryEvents: spans.flatMap(span => span.events).filter(event => event.name === 'retry.scheduled').length,
      terminalStatus: spans[0]?.status };
    expect(observed).toEqual(golden.scenarios['retry-then-success']);
  });

  it('emits a terminal cancellation trace even when no adapter dispatch begins', async () => {
    const spans: DecisionTelemetrySpan[] = []; const controller = new AbortController(); controller.abort();
    const result = await evaluateDecisionRuleset(request(adapter(async input => success(input.alias)), spans, controller.signal));
    expect(result.spec.status).toBe('cancelled');
    expect({ spanNames: spans.map(span => span.name), terminalStatus: spans[0]?.status })
      .toEqual(golden.scenarios['caller-cancellation']);
  });

  it('keeps malformed telemetry IDs and exporter rejection outside decision semantics', async () => {
    const spans: DecisionTelemetrySpan[] = [];
    const configured = request(adapter(async input => success(input.alias)), spans);
    configured.telemetry = { hook: { emit: () => { throw new Error('sink rejected'); } },
      ids: { traceId: () => 'not-w3c', spanId: () => 'also-invalid' } };
    const result = await evaluateDecisionRuleset(configured);
    expect({ emittedSpans: spans.length, decisionUnaffected: result.spec.status === 'completed' })
      .toEqual(golden.scenarios['malformed-id-source']);
  });

  it('links durable review completion to the approved action span', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiwg-telemetry-review-')); directories.push(directory);
    const spans: DecisionTelemetrySpan[] = []; const now = { value: 1_000 };
    const authorization = { authorize: () => true, eligible: () => true, authorizeAction: () => true };
    const service = new DecisionReviewService(new FileDecisionReviewStore(directory, new Uint8Array(32).fill(3)), authorization, () => now.value,
      { telemetry: { hook: { emit: span => { spans.push(span); } }, ids: deterministicIds() } });
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const requester = { id: 'requester', roles: ['requester'], authorityContext: 'policy/v1' };
    const reviewer = { id: 'reviewer', roles: ['reviewer'], authorityContext: 'policy/v1' };
    const base = { tenantId: 'tenant', projectId: 'project' };
    await service.create({ ...base, actor: requester }, { reviewId: 'review-1', sourceReceipt: { id: 'receipt', digest },
      evidencePins: [], policyPins: [], reasonCodes: ['policy-review'], riskTier: 'medium', presentation: {},
      action: { kind: 'notify' }, rationale: 'review', expiresAtEpochMs: 2_000, continuationId: 'continue', resumeToken: 'resume' });
    await service.decide({ ...base, actor: reviewer }, 'review-1', 'approve', 'approved');
    await service.resume({ ...base, actor: reviewer }, 'review-1', 'resume', async () => ({ delivered: true }));
    const linked = spans.slice(-2);
    expect({ spanNames: linked.map(span => span.name), actionParent: linked[1]?.parentSpanId === linked[0]?.context.spanId ? 'decision.review' : null,
      linkRelationship: linked[1]?.links[0]?.relationship }).toEqual(golden.scenarios['approved-action-link']);
  });

  it('goldens deletion and metric cardinality enforcement', () => {
    const root: DecisionTelemetrySpan = { schemaVersion: 'decision-telemetry/v1', name: 'decision.workflow',
      context: { traceId: '1'.repeat(32), spanId: '1'.repeat(16), traceFlags: '01' }, parentSpanId: null,
      startTimeUnixMs: 1, endTimeUnixMs: 2, status: 'ok', attributes: {}, provenance: {}, links: [], events: [] };
    const restored = restoreTelemetryTrace({ schemaVersion: 'decision-telemetry/v1', traceId: root.context.traceId, spans: [root] },
      { traceTtlMs: 1, debugSidecarTtlMs: 1, exportTtlMs: 1, linkedRecordTtlMs: 1, deletionEnabled: true, tombstonesEnabled: true, legalHold: false }, 10);
    expect({ remainingSpans: restored.spans.length, tombstoneReason: restored.tombstones?.at(-1)?.reason }).toEqual(golden.scenarios.deletion);
    const metrics = new BoundedDecisionMetrics(10, 2);
    const outcomes = [metrics.record('decision.duration', 1, { 'aiwg.adapter.id': 'a', 'aiwg.run.id': 'forbidden' }),
      metrics.record('decision.duration', 2, { 'aiwg.adapter.id': 'b' }), metrics.record('decision.duration', 3, { 'aiwg.adapter.id': 'c' })];
    expect({ acceptedPoints: outcomes.filter(Boolean).length, rejectedPoints: outcomes.filter(value => !value).length,
      forbiddenDimensionPresent: metrics.snapshot().some(point => Object.hasOwn(point.dimensions, 'aiwg.run.id')) })
      .toEqual(golden.scenarios.cardinality);
  });
});
