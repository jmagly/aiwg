import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonicalJson } from '../../security/artifact-trust.js';
import { JevDecisionAdapter } from '../adapters/jev.js';
import { decisionBatchQuestionId } from '../batch.js';
import { batchAccountingTotals } from '../batch-receipts/accounting.js';
import { MemoryBatchResultStore } from '../batch-receipts/result-store.js';
import { MemoryBatchReceiptStore } from '../batch-receipts/store.js';
import { CanonicalJsonByteEstimator, planDecisionContext } from '../context-plan.js';
import { evaluateDecisionRuleset } from '../evaluate.js';
import { MemoryDecisionReceiptStore } from '../receipts.js';
import { resolveJsonPointer } from '../validate.js';
import type { DecisionAdmissionEvidence, DecisionEvaluationRequest, DecisionSchedulerPolicy, JsonValue, RulesetResult } from '../types.js';
import { getDecisionPatternPack, decisionPatternPacks } from './catalog.js';
import { governedPatternArtifacts, resolveDecisionPatternArtifact, validateGovernedPatternArtifacts } from './artifacts.js';
import { RecordedJevTransport, resolveOfflineRecordedCredential } from './recorded.js';
import { PATTERN_SPECS, type PatternSpec } from './specs.js';
import type {
  DecisionPatternId, DecisionPatternPack, LivePatternLimits, LivePatternPlan, LivePatternReceipt, LivePatternRequest,
  LivePatternTransport, PatternEvaluationEvidence, PatternGateEvidence, PatternReceipt, PatternRoute, PatternUsageEvidence,
} from './types.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pointerValue = (root: unknown, pointer: string): unknown => { const resolved = resolveJsonPointer(root, pointer); return resolved.found ? resolved.value : undefined; };
const RESTRICTIVENESS: Record<PatternRoute, number> = { accept: 0, review: 1, deny: 2 };

export function listDecisionPatterns(): Array<Pick<DecisionPatternPack, 'id' | 'version' | 'status' | 'summary' | 'limitations'>> {
  return decisionPatternPacks.map(({ id, version, status, summary, limitations }) => ({ id, version, status, summary, limitations: [...limitations] }));
}

const validationCache = new Map<string, string[]>();

/** Validate a pack manifest. Results are memoized by the validated content (fixture expectations are not validated). */
export function validateDecisionPattern(pack: DecisionPatternPack): string[] {
  const key = canonicalJson({ ...pack, fixtures: pack.fixtures.map(({ expected: _expected, ...fixture }) => fixture) } as unknown as JsonValue);
  if (!validationCache.has(key)) validationCache.set(key, validateDecisionPatternUncached(pack));
  return [...validationCache.get(key)!];
}

function validateDecisionPatternUncached(pack: DecisionPatternPack): string[] {
  const errors: string[] = [];
  if (pack.schema !== 'decision-pattern-pack/v1') errors.push('unsupported-schema');
  if (!/^\d+\.\d+\.\d+$/.test(pack.version)) errors.push('invalid-version');
  for (const [name, value] of Object.entries(pack.artifacts)) {
    if (Array.isArray(value) ? value.length === 0 || value.some(item => !item) : !value) errors.push(`missing-artifact:${name}`);
    for (const reference of Array.isArray(value) ? value : [value]) {
      try {
        const resolved = resolveDecisionPatternArtifact(reference);
        if (resolved.patternId !== pack.id || resolved.patternVersion !== pack.version) errors.push(`artifact-identity-mismatch:${name}`);
      } catch { errors.push(`unresolvable-artifact:${name}`); }
    }
  }
  if (pack.status !== 'unavailable' && pack.fixtures.length === 0) errors.push('missing-offline-fixture');
  if (!pack.failurePath || !pack.rollback || pack.limitations.length === 0) errors.push('missing-governance-guidance');
  if (pack.live && (pack.live.limits.maxCalls < 1 || pack.live.limits.maxTokens < 1 || pack.live.limits.maxCostUsd <= 0 || pack.live.limits.allowUnknownCost !== false || pack.live.limits.maxAttempts < 1 || pack.live.limits.deadlineMs < 1)) errors.push('invalid-live-limits');
  try {
    validateGovernedPatternArtifacts(pack.id, pack.version);
    const inputSchema = resolveDecisionPatternArtifact(pack.artifacts.inputSchema).content;
    const outputSchema = resolveDecisionPatternArtifact(pack.artifacts.outputSchema).content;
    if (typeof inputSchema === 'string' || typeof outputSchema === 'string') throw new Error('schema artifact must be JSON');
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validateInput = ajv.compile(inputSchema as object);
    const validateOutput = ajv.compile(outputSchema as object);
    for (const candidate of pack.fixtures) {
      if (!validateInput(candidate.input)) errors.push(`fixture-input-schema:${candidate.id}`);
      if (!validateOutput(candidate.recordedEvidence)) errors.push(`fixture-output-schema:${candidate.id}`);
    }
  } catch { errors.push('invalid-artifact-schema'); }
  return errors;
}

export interface OfflinePatternOverrides {
  /** Replacement sanitized recorded answers, replayed through the same runtime. */
  recordedEvidence?: Record<string, JsonValue>;
  /** Replacement synthetic input. It is still validated by the governed ruleset. */
  input?: Record<string, JsonValue>;
}

/**
 * Run one offline fixture through the production decision runtime: the governed
 * definitions, ruleset and offline binding are evaluated by `evaluateDecisionRuleset`
 * with the production Jev adapter over a recorded-replay transport. Deterministic
 * gates declared in the pack's candidate policy may only narrow the outcome.
 */
export async function runOfflineDecisionPattern(id: DecisionPatternId, fixtureId?: string, overrides: OfflinePatternOverrides = {}): Promise<PatternReceipt> {
  const pack = getDecisionPatternPack(id);
  const errors = validateDecisionPattern(pack);
  if (errors.length) throw new Error(`Invalid decision pattern: ${errors.join(', ')}`);
  if (pack.status === 'unavailable') throw new Error(`Decision pattern unavailable: ${id}`);
  const selected = fixtureId ? pack.fixtures.find(candidate => candidate.id === fixtureId) : pack.fixtures[0];
  if (!selected) throw new Error(`Unknown fixture for decision pattern: ${id}`);
  const input = structuredClone(overrides.input ?? selected.input);
  const recordedEvidence = structuredClone(overrides.recordedEvidence ?? selected.recordedEvidence);
  const spec = PATTERN_SPECS[id];
  const aliases = spec.evaluations.map(evaluation => evaluation.alias);
  const gates: PatternGateEvidence[] = [];
  const base = { pack, fixtureId: selected.id, subjectId: selected.subjectId, spec };

  let batchSubject: string | undefined;
  if (spec.gates.batchSubjectsFrom) {
    const subjects = aliases.map(alias => record(pointerValue(input, spec.gates.batchSubjectsFrom!))[alias]);
    if (!subjects.every(subject => typeof subject === 'string' && subject && subject === subjects[0])) {
      // Unrelated subjects never share a request; the anti-example is rejected before any dispatch.
      gates.push({ gate: 'batch-subject', outcome: 'rejected-before-dispatch', reason: 'multi-subject-batch-rejected' });
      return offlineReceipt({ ...base, route: 'deny', reason: 'multi-subject-batch-rejected', gates, result: null, invocations: 0, transportCalls: 0, candidate: null, usage: unavailableUsage() });
    }
    batchSubject = subjects[0] as string;
    gates.push({ gate: 'batch-subject', outcome: 'pass' });
  }

  const transport = new RecordedJevTransport(recordedEvidence, aliases);
  const artifacts = governedPatternArtifacts(id, pack.version);
  const request: DecisionEvaluationRequest = {
    ruleset: artifacts.ruleset, binding: artifacts.offlineBinding, definitions: artifacts.definitions, input,
    runId: `pattern-${id}`, invocationId: `pattern-${id}-${selected.id}`,
    adapters: { jev: new JevDecisionAdapter({ fetch: transport.fetch }) }, resolveCredential: resolveOfflineRecordedCredential,
    // Recorded replay never leaves the process, so the host opts out of projection explicitly (D10).
    projection: { mode: 'unprojected-local' },
  };
  let batchStore: MemoryBatchReceiptStore | undefined;
  if (batchSubject !== undefined) {
    batchStore = new MemoryBatchReceiptStore();
    Object.assign(request, nativeBatchPolicy(id, pack.version, spec, input, batchSubject, batchStore));
  }
  let invocations = 1;
  let result: RulesetResult;
  if (spec.gates.replay) {
    // Idempotent resume through the production receipt store: every resume after the
    // first must return the stored result without another transport request.
    const resumes = Number(pointerValue(input, spec.gates.replay.resumeCountFrom));
    request.receiptStore = new MemoryDecisionReceiptStore();
    request.receiptProjectId = `pattern-${id}`;
    request.invocationId = `pattern-${id}-${String(input.invocationId ?? selected.id)}`;
    result = await evaluateDecisionRuleset(request);
    for (invocations = 1; invocations < resumes; invocations += 1) {
      const replayed = await evaluateDecisionRuleset(request);
      if (canonicalJson(replayed) !== canonicalJson(result)) throw new Error('Durable replay returned a different result');
    }
    gates.push({ gate: 'durable-replay', outcome: transport.calls.length <= aliases.length ? 'pass' : 'narrowed', reason: `${invocations}-invocations` });
  } else {
    result = await evaluateDecisionRuleset(request);
  }

  const gated = applyGates(spec, input, result, gates);
  const usage = batchStore ? await requestUsage(result, batchStore, request) : attemptUsage(result);
  return offlineReceipt({ ...base, route: gated.route, reason: gated.reason, gates, result, invocations, transportCalls: transport.calls.length, candidate: gated.candidate, usage });
}

function nativeBatchPolicy(id: DecisionPatternId, version: string, spec: PatternSpec, input: Record<string, JsonValue>, subject: string, store: MemoryBatchReceiptStore): Pick<DecisionEvaluationRequest, 'batching' | 'batchReceipts'> {
  const estimator = new CanonicalJsonByteEstimator();
  const state = pointerValue(input, spec.evaluations[0]!.inputPointer) as JsonValue;
  const contextPlan = planDecisionContext({
    subject, authorizedState: state, authorizationDigest: `sha256:${createHash('sha256').update(`pattern.${id}@${version}`).digest('hex')}`, incompleteContext: false,
    questions: spec.evaluations.map(evaluation => ({ id: decisionBatchQuestionId(evaluation.alias), subject, entry: { question: evaluation.alias } })),
  }, { id: 'jev', version: '1', estimator: { id: estimator.id, version: estimator.version }, limits: { aggregateTokens: 100_000, stateAndLongestQuestionTokens: 100_000 }, safetyMarginBps: 0, requestEnvelopeTokens: 0 }, estimator);
  return {
    batching: { enabled: true, evaluations: Object.fromEntries(spec.evaluations.map(evaluation => [evaluation.alias,
      { decisionSubject: subject, independent: true, egressPolicy: 'pattern-offline-recorded', hostPolicy: `pattern.${id}@${version}` }])) },
    batchReceipts: { store, resultStore: new MemoryBatchResultStore(), tenantId: 'pattern-playground', projectId: `pattern-${id}`, contextPlan,
      subjectHash: `sha256:${createHash('sha256').update(subject).digest('hex')}` },
  };
}

/** Deterministic gates run after evaluation and can only make the route more restrictive. */
function applyGates(spec: PatternSpec, input: Record<string, JsonValue>, result: RulesetResult, gates: PatternGateEvidence[]): { route: PatternRoute; reason: string; candidate: string | null } {
  const outcome = rulesetOutcome(result);
  let route = outcome.route;
  let reason = outcome.reason;
  const narrow = (next: PatternRoute, nextReason: string): void => {
    if (RESTRICTIVENESS[next] > RESTRICTIVENESS[route]) { route = next; reason = nextReason; }
  };
  if (spec.gates.deterministicPolicyFrom) {
    const denied = pointerValue(input, spec.gates.deterministicPolicyFrom) === 'deny';
    gates.push({ gate: 'deterministic-policy', outcome: denied ? 'narrowed' : 'pass', ...(denied ? { reason: 'deterministic-policy-deny' } : {}) });
    if (denied && !(route === 'deny' && reason === 'deterministic-policy-deny')) { route = 'deny'; reason = 'deterministic-policy-deny'; }
  }
  let candidate: string | null = null;
  const gate = spec.gates.candidateGate;
  if (gate) {
    if (route !== 'accept') gates.push({ gate: 'candidate-membership', outcome: 'not-applicable' });
    else {
      const proposed = gate.candidateFrom.source === 'decision'
        ? result.spec.evaluations[gate.candidateFrom.alias]?.spec.value : pointerValue(input, gate.candidateFrom.pointer);
      const allowed = pointerValue(input, gate.allowedFrom);
      const member = Array.isArray(allowed) && allowed.some(entry => gate.matchKeys
        ? gate.matchKeys.every(key => canonicalJson(record(entry)[key] ?? null) === canonicalJson(record(proposed)[key] ?? null))
          && Object.entries(gate.requireAllowed ?? {}).every(([key, value]) => canonicalJson(record(entry)[key] ?? null) === canonicalJson(value))
        : typeof proposed === 'string' && entry === proposed);
      if (member) {
        const label = gate.labelKey ? record(proposed)[gate.labelKey] : proposed;
        candidate = typeof label === 'string' ? label : null;
        gates.push({ gate: 'candidate-membership', outcome: 'pass' });
      } else {
        gates.push({ gate: 'candidate-membership', outcome: 'narrowed', reason: gate.reason });
        narrow(spec.unauthorizedEvidenceRoute, gate.reason);
      }
    }
  }
  const argumentGate = spec.gates.argumentGate;
  if (argumentGate) {
    if (route !== 'accept') gates.push({ gate: 'typed-arguments', outcome: 'not-applicable' });
    else {
      const selected = result.spec.evaluations[argumentGate.functionAlias]?.spec.value;
      const schemas = record(pointerValue(input, argumentGate.schemasFrom));
      let valid = false;
      try {
        valid = typeof selected === 'string' && Object.prototype.hasOwnProperty.call(schemas, selected)
          && Boolean(new Ajv2020({ strict: true, allErrors: true }).compile(record(schemas[selected]))(pointerValue(input, argumentGate.argumentsFrom)));
      } catch { valid = false; }
      gates.push({ gate: 'typed-arguments', outcome: valid ? 'pass' : 'narrowed', ...(valid ? {} : { reason: argumentGate.reason }) });
      if (!valid) { narrow(spec.unauthorizedEvidenceRoute, argumentGate.reason); candidate = null; }
    }
  }
  return { route, reason, candidate: route === 'accept' ? candidate : null };
}

function rulesetOutcome(result: RulesetResult): { route: PatternRoute; reason: string } {
  const outcome = record(result.spec.outcome);
  const route = outcome.route;
  return (route === 'accept' || route === 'review' || route === 'deny') && typeof outcome.reason === 'string'
    ? { route, reason: outcome.reason } : { route: 'review', reason: `ruleset-${result.spec.reason}` };
}

async function requestUsage(result: RulesetResult, store: MemoryBatchReceiptStore, request: DecisionEvaluationRequest): Promise<PatternUsageEvidence> {
  const reference = Object.values(result.spec.evaluations).find(evaluation => evaluation.spec.batchResult)?.spec.batchResult;
  const receipt = reference ? await store.read(reference.batchId, request.batchReceipts!.tenantId, request.batchReceipts!.projectId) : null;
  if (!receipt) return unavailableUsage();
  const totals = batchAccountingTotals(receipt).usage;
  return totals.inputTokens === null && totals.outputTokens === null ? unavailableUsage()
    : { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: null, availability: 'recorded', scope: 'request' };
}

function attemptUsage(result: RulesetResult): PatternUsageEvidence {
  const attempts = Object.values(result.spec.evaluations).flatMap(evaluation => evaluation.spec.attempts);
  const sum = (key: 'inputTokens' | 'outputTokens'): number | null => attempts.some(attempt => attempt.usage[key] !== null)
    ? attempts.reduce((total, attempt) => total + (attempt.usage[key] ?? 0), 0) : null;
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  return inputTokens === null && outputTokens === null ? unavailableUsage()
    : { inputTokens, outputTokens, costUsd: null, availability: 'recorded', scope: 'attempts' };
}

function unavailableUsage(): PatternUsageEvidence { return { inputTokens: null, outputTokens: null, costUsd: null, availability: 'unavailable', scope: null }; }

function evaluationEvidence(spec: PatternSpec, result: RulesetResult | null): PatternEvaluationEvidence[] {
  if (!result) return [];
  return spec.evaluations.flatMap(evaluation => {
    const value = result.spec.evaluations[evaluation.alias];
    if (!value) return [];
    const attempts = value.spec.attempts;
    return [{
      alias: evaluation.alias, primitive: evaluation.answer.kind, status: value.spec.status, reason: value.spec.reason,
      value: value.spec.value ?? null, distribution: value.spec.uncertainty?.distribution ? { ...value.spec.uncertainty.distribution } : null,
      acceptance: value.spec.acceptance ? { disposition: value.spec.acceptance.disposition, matchedRule: value.spec.acceptance.matchedRule, reason: value.spec.acceptance.reason } : null,
      attempts: attempts.length,
      usage: attempts.at(-1)?.usage ? { ...attempts.at(-1)!.usage } : { inputTokens: null, outputTokens: null, costUsd: null },
    }];
  });
}

function offlineReceipt(input: {
  pack: DecisionPatternPack; fixtureId: string; subjectId: string; spec: PatternSpec; route: PatternRoute; reason: string;
  gates: PatternGateEvidence[]; result: RulesetResult | null; invocations: number; transportCalls: number; candidate: string | null; usage: PatternUsageEvidence;
}): PatternReceipt {
  const evaluations = evaluationEvidence(input.spec, input.result);
  const outcome = input.result ? rulesetOutcome(input.result) : null;
  const checks = [
    ...(input.result ? ['evaluated-by-decision-runtime', 'acceptance-policy-applied'] : ['rejected-before-dispatch']),
    ...input.gates.map(gate => gate.gate === 'batch-subject' ? 'same-subject' : gate.gate === 'deterministic-policy' ? 'deterministic-policy-precedence'
      : gate.gate === 'durable-replay' ? 'idempotent-resume' : gate.gate),
    ...(input.usage.scope === 'request' ? ['request-usage-once'] : []),
    'action-not-executed',
  ];
  return {
    schema: 'decision-pattern-receipt/v2', pattern: { id: input.pack.id, version: input.pack.version }, fixtureId: input.fixtureId,
    subjectId: input.subjectId, executionMode: 'offline-recorded', evidenceOrigin: 'sanitized-recorded-fixture',
    primitive: input.pack.primitive, requestedModel: 'offline:recorded-fixture', actualModel: null,
    runtime: { evaluator: 'evaluateDecisionRuleset', adapter: 'jev@1.0.0', transport: 'recorded-replay', invocations: input.invocations, transportCalls: input.transportCalls },
    uncertainty: { provenance: 'recorded-uncalibrated', calibration: 'unavailable', distribution: evaluations.length === 1 ? evaluations[0]!.distribution : null },
    route: input.route, reason: input.reason,
    rulesetOutcome: input.result && outcome ? { status: input.result.spec.status, route: outcome.route, reason: outcome.reason, matchedRules: [...input.result.spec.matchedRules] } : null,
    gates: input.gates, evaluations, attempts: evaluations.reduce((sum, evaluation) => sum + evaluation.attempts, 0), usage: input.usage,
    action: { status: 'unexecuted', candidate: input.candidate }, checks: [...new Set(checks)], result: input.result,
  };
}

export function planLiveDecisionPattern(id: DecisionPatternId, options: { explicitOptIn: boolean; credentialResolved: boolean; egressApproved: boolean }): LivePatternPlan {
  const pack = getDecisionPatternPack(id);
  if (!pack.live) return { mode: 'live', status: 'skipped', reason: 'live-binding-unavailable', credentialRef: null, limits: null, executes: false };
  const base = { mode: 'live' as const, credentialRef: pack.live.credentialRef, limits: { ...pack.live.limits }, executes: false as const };
  if (!options.explicitOptIn) return { ...base, status: 'skipped', reason: 'explicit-opt-in-required' };
  if (!options.egressApproved) return { ...base, status: 'denied', reason: 'egress-denied' };
  if (!options.credentialResolved) return { ...base, status: 'skipped', reason: 'credential-unavailable' };
  return { ...base, status: 'ready', reason: 'ready' };
}

/**
 * Execute one explicitly approved synthetic live probe through the production
 * evaluator and Jev adapter. Pack limits become a scheduler admission policy, so
 * every transport call is admitted before it starts: a call that would exceed the
 * call, token or cost reservation is never started, unknown cost is never admitted,
 * and the deadline aborts the in-flight transport through the evaluator's signal.
 */
export async function runLiveDecisionPattern(
  id: DecisionPatternId,
  request: LivePatternRequest,
  options: { explicitOptIn: boolean; credentialResolved: boolean; egressApproved: boolean; limits?: Partial<LivePatternLimits> },
  transport: LivePatternTransport,
): Promise<LivePatternReceipt> {
  const pack = getDecisionPatternPack(id);
  const plan = planLiveDecisionPattern(id, options);
  if (plan.status !== 'ready' || !pack.live || !plan.limits) throw new Error(`Live decision pattern not ready: ${plan.reason}`);
  if (request.synthetic !== true) throw new Error('Live decision pattern input must be explicitly synthetic');
  if (!transport.model || !transport.model.trim()) throw new Error('Live decision pattern requires an explicit requested model');
  const limits = tightenedLimits(plan.limits, options.limits);
  const spec = PATTERN_SPECS[id];
  const artifacts = governedPatternArtifacts(id, pack.version);
  const binding = structuredClone(artifacts.liveBindingTemplate);
  binding.spec.totalTimeoutMs = limits.deadlineMs;
  binding.spec.maxAttempts = spec.evaluations.length * limits.maxAttempts;
  for (const evaluation of Object.values(binding.spec.evaluations)) {
    for (const target of evaluation.targets) {
      target.model = transport.model;
      target.timeoutMs = limits.deadlineMs;
      target.retry = { ...target.retry, maxRetries: limits.maxAttempts - 1 };
    }
  }
  let calls = 0;
  const admission: LivePatternReceipt['admission'] = [];
  let reservedTokens = 0;
  let reservedCostUsd = 0;
  const countedFetch = (async (url: string | URL | Request, init?: RequestInit) => { calls += 1; return transport.fetch(url, init); }) as typeof fetch;
  const scheduler: DecisionSchedulerPolicy = {
    // Admission profiles are registered process-wide per workspace; a revision names exactly one set of limits.
    enabled: true, profileVersion: `pattern.${id}@${pack.version}.live.${createHash('sha256').update(canonicalJson(limits as unknown as JsonValue)).digest('hex').slice(0, 16)}`,
    workspace: { id: 'pattern-playground', limits: { concurrency: 1 } },
    principal: { id: 'pattern-playground-operator', limits: { concurrency: 1 } },
    providers: { jev: { concurrency: 1, maxAttempts: limits.maxCalls, maxTokens: limits.maxTokens, maxCostUsd: limits.maxCostUsd, allowUnknownCost: false } },
    estimate: alias => {
      const estimate = transport.estimate(alias);
      return { tokens: estimate.tokens, costUsd: estimate.costUsd, attempts: 1, batchSize: 1, items: 1 };
    },
    onEvidence: (alias: string, evidence: DecisionAdmissionEvidence) => {
      admission.push({ alias, decision: evidence.decision, reason: evidence.reason });
      if (evidence.decision === 'admit') { reservedTokens += evidence.estimatedTokens ?? 0; reservedCostUsd += evidence.estimatedCostUsd ?? 0; }
    },
  };
  const result = await evaluateDecisionRuleset({
    ruleset: artifacts.ruleset, binding, definitions: artifacts.definitions, input: structuredClone(request.input),
    runId: `pattern-${id}-live`, invocationId: `pattern-${id}-live-${createHash('sha256').update(canonicalJson(request.input as JsonValue)).digest('hex').slice(0, 16)}-${Date.now()}`,
    adapters: { jev: new JevDecisionAdapter({ fetch: countedFetch, ...(transport.region ? { region: transport.region } : {}) }) },
    resolveCredential: transport.resolveCredential,
    scheduler, ...(transport.signal ? { signal: transport.signal } : {}),
    ...(transport.projection ? { projection: transport.projection } : {}),
  });
  const attempts = Object.values(result.spec.evaluations).flatMap(evaluation => evaluation.spec.attempts);
  const sum = (key: 'inputTokens' | 'outputTokens') => attempts.some(attempt => attempt.usage[key] !== null)
    ? attempts.reduce((total, attempt) => total + (attempt.usage[key] ?? 0), 0) : null;
  const usage = { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), reservedTokens, reservedCostUsd, reportedCostUsd: null };
  const limitBreaches = [
    ...(calls > limits.maxCalls ? ['calls'] : []),
    ...((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > limits.maxTokens ? ['tokens'] : []),
  ];
  const models = [...new Set(attempts.map(attempt => attempt.actualModel).filter((model): model is string => Boolean(model)))];
  const gated = applyGates(spec, request.input, result, []);
  const identityMissing = attempts.some(attempt => attempt.status === 'success' && !attempt.actualModel);
  const route: PatternRoute = limitBreaches.length || identityMissing ? (gated.route === 'deny' ? 'deny' : 'review') : gated.route;
  const reason = limitBreaches.length && gated.route !== 'deny' ? 'live-usage-exceeded-limit' : identityMissing && gated.route !== 'deny' ? 'model-identity-missing' : gated.reason;
  return {
    schema: 'decision-pattern-live-receipt/v2', pattern: { id, version: pack.version }, executionMode: 'live', evidenceOrigin: 'live-synthetic',
    requestedModel: transport.model, actualModel: models.length === 1 ? models[0]! : null, calls, attempts: attempts.length, limits, admission,
    usage, limitBreaches, deadlineMs: limits.deadlineMs, route, reason, action: { status: 'unexecuted' }, result,
  };
}

function tightenedLimits(pack: LivePatternLimits, requested: Partial<LivePatternLimits> = {}): LivePatternLimits {
  const next = { ...pack };
  for (const key of ['maxCalls', 'maxTokens', 'maxCostUsd', 'maxAttempts', 'deadlineMs'] as const) {
    const value = requested[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0 || value > pack[key] || (key !== 'maxCostUsd' && !Number.isInteger(value))) {
      throw new Error(`Live decision pattern limit ${key} may only be tightened`);
    }
    next[key] = value;
  }
  if (requested.allowUnknownCost !== undefined && requested.allowUnknownCost !== false) throw new Error('Live decision pattern never admits unknown cost');
  return next;
}
