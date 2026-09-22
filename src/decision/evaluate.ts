import { randomUUID } from 'node:crypto';
import { composeRuleset } from './compose.js';
import { applyPrimitiveAcceptance, validatePrimitiveAcceptancePolicy } from './acceptance.js';
import { DecisionPreDispatchError, decisionInvocationFingerprint, nextReceipt } from './receipts.js';
import { admitEntry, EntryAdmissionError } from './entry.js';
import { correlateAtomicBatch, decisionBatchQuestionId, planNativeDecisionBatches } from './batch.js';
import { AdmissionError, DecisionAdmissionController } from './admission.js';
import { runBoundedFair, SchedulerWaitError } from './scheduler.js';
import { DECISION_API_VERSION, DECISION_API_VERSION_STRUCTURED } from './types.js';
import type {
  AdapterObservation,
  ArtifactPin,
  DecisionAdapter,
  DecisionBatchEvidence,
  DecisionAttempt,
  DecisionAdmissionEvidence,
  DecisionDefinition,
  DecisionEvaluationRequest,
  DecisionFailureReason,
  DecisionResult,
  DecisionReceipt,
  DecisionStatus,
  ExecutionTarget,
  RulesetResult,
} from './types.js';
import {
  artifactPin,
  assertArtifactPin,
  DecisionValidationError,
  resolveJsonPointer,
  validateAgainstSchema,
  validateBinding,
  validateDecisionValue,
  validateDefinition,
  validateDistribution,
  validateRuleset,
} from './validate.js';

const RETRIABLE = new Set<DecisionFailureReason>([
  'timeout', 'network-transient', 'rate-limited', 'overloaded', 'service-error',
]);

const admissionControllers = new WeakMap<object, DecisionAdmissionController>();

export async function evaluateDecisionRuleset(request: DecisionEvaluationRequest): Promise<RulesetResult> {
  let rulesetPin: ArtifactPin;
  let bindingPin: ArtifactPin;
  let base: RulesetResult | undefined;
  let resolved: Array<{ alias: string; definition: DecisionDefinition; pin: ArtifactPin; input: unknown }>;
  let admissionStage: 'artifact' | 'input' = 'artifact';
  try {
    admitEntry(request.ruleset);
    admitEntry(request.binding);
    admitEntry(request.definitions);
    admissionStage = 'input';
    admitEntry(request.input);
    admissionStage = 'artifact';
    validateRuleset(request.ruleset);
    rulesetPin = artifactPin(request.ruleset);
    bindingPin = artifactPin(request.binding);
    // Pin and execute immutable snapshots; adapters receive separate per-attempt copies.
    request = {
      ...request,
      ruleset: structuredClone(request.ruleset), binding: structuredClone(request.binding),
      definitions: structuredClone(request.definitions), input: structuredClone(request.input),
    };
    base = resultBase(request, rulesetPin, bindingPin);
    validateBinding(request.binding, request.ruleset);
    validateSchedulerPolicy(request);
    validateAgainstSchema(request.ruleset.spec.inputSchema, request.input, 'ruleset input');
    resolved = resolveDefinitions(request);
    for (const item of resolved) {
      for (const target of request.binding.spec.evaluations[item.alias]!.targets) {
        if (target.acceptance.mode === 'primitive-policy') {
          if (request.binding.apiVersion !== DECISION_API_VERSION_STRUCTURED) {
            throw new DecisionValidationError('primitive-aware acceptance requires decision.aiwg.io/v1alpha2');
          }
          validatePrimitiveAcceptancePolicy(target.acceptance, item.definition);
        }
      }
    }
  } catch (error) {
    const reason = error instanceof EntryAdmissionError && admissionStage === 'input'
      ? 'invalid-input' : classifyValidationFailure(error);
    return failureResult(base ?? invalidResultBase(request), reason);
  }
  if (!base) return failureResult(invalidResultBase(request), 'invalid-definition');

  const fingerprint = decisionInvocationFingerprint({
    invocationId: request.invocationId,
    value: request.input,
    definitions: resolved.map(item => item.pin),
    ruleset: rulesetPin,
    binding: bindingPin,
    policy: request.policyPin,
    calibration: request.calibrationPin,
  });
  let receipt: DecisionReceipt | undefined;
  let reconciled: AdapterObservation | null = null;
  const projectId = request.receiptProjectId ?? 'default';
  if (request.receiptStore) {
    try {
      const acquisition = await request.receiptStore.acquire(request.invocationId, projectId, fingerprint);
      if (!acquisition.owner) {
        if (acquisition.receipt.fingerprint !== fingerprint) return failureResult(base, 'replay-mismatch');
        if (acquisition.receipt.state === 'completed') return structuredClone(acquisition.receipt.result!);
        if (acquisition.receipt.state === 'failed' || acquisition.receipt.state === 'execution-uncertain') return failureResult(base, 'execution-uncertain');
        try {
          const terminal = await request.receiptStore.waitForTerminal(request.invocationId, projectId, fingerprint,
            AbortSignal.timeout(request.binding.spec.totalTimeoutMs + 1000));
          return terminal.state === 'completed' ? structuredClone(terminal.result!) : failureResult(base, 'execution-uncertain');
        } catch {
          try {
            const pending = await request.receiptStore.read(request.invocationId, projectId);
            if (pending?.state === 'completed') return structuredClone(pending.result!);
            if (pending && pending.fingerprint === fingerprint && (pending.state === 'remote-handle-known' || pending.state === 'observation-received')
              && pending.pending && pending.remoteHandles.length && request.reconcileRemote) {
              const authorized = await request.receiptStore.read(request.invocationId, projectId);
              if (!authorized || authorized.revision !== pending.revision || authorized.fingerprint !== fingerprint) {
                throw new ReceiptPersistenceError();
              }
              reconciled = await request.reconcileRemote(pending.remoteHandles.at(-1)!, request.signal ?? new AbortController().signal);
              if (reconciled?.status === 'success') {
                receipt = pending;
              }
            }
            if (!receipt && pending && pending.fingerprint === fingerprint && pending.state !== 'execution-uncertain' && pending.state !== 'failed') {
              await request.receiptStore.compareAndSwap(request.invocationId, projectId, pending.revision, nextReceipt(pending, 'execution-uncertain'));
            }
          } catch { return failureResult(base, 'persistence-error'); }
          if (!receipt) return failureResult(base, 'execution-uncertain');
        }
      }
      if (acquisition.owner) receipt = acquisition.receipt;
    } catch {
      return failureResult(base, 'persistence-error');
    }
  }

  const advance = async (state: DecisionReceipt['state'], extra: Partial<Pick<DecisionReceipt, 'result' | 'remoteHandles' | 'evaluations' | 'pending'>> = {}): Promise<void> => {
    if (!request.receiptStore || !receipt) return;
    try {
      const next = nextReceipt(receipt, state, extra);
      if (!await request.receiptStore.compareAndSwap(request.invocationId, projectId, receipt.revision, next)) {
        throw new ReceiptPersistenceError();
      }
      receipt = next;
    } catch {
      throw new ReceiptPersistenceError();
    }
  };

  const now = request.now ?? Date.now;
  const totalDeadline = now() + request.binding.spec.totalTimeoutMs;
  const totalTimeout = AbortSignal.timeout(request.binding.spec.totalTimeoutMs);
  const totalAbort = AbortSignal.any([request.signal ?? new AbortController().signal, totalTimeout]);
  const evaluations: Record<string, DecisionResult> = structuredClone(receipt?.evaluations ?? {});
  let attemptsUsed = Object.values(evaluations).reduce((sum, result) => sum + result.spec.attempts.length, 0);
  const attemptBudget = new AttemptBudget(request.binding.spec.maxAttempts, attemptsUsed);

  try {
  if (reconciled && receipt?.pending) {
    const pending = receipt.pending;
    const item = resolved.find(candidate => candidate.alias === pending.alias);
    const target = request.binding.spec.evaluations[pending.alias]?.targets[pending.targetIndex];
    if (!item || !target) throw new RemoteUncertainError();
    let observation: AdapterObservation;
    try { observation = normalizeObservation(item.definition, target, reconciled); }
    catch { throw new RemoteUncertainError(); }
    if (observation.status !== 'success') throw new RemoteUncertainError();
    const context: OneContext = { request, item, rulesetPin, bindingPin, totalDeadline, signal: totalAbort, totalTimeout,
      attemptBudget, now, advance };
    const attempts = [...pending.attempts, toAttempt(target, pending.ordinal, observation, 0)];
    evaluations[item.alias] = decisionResult(context, observation, attempts);
    attemptsUsed += attempts.length;
    attemptBudget.consume(attempts.length);
    await advance('observation-received', { evaluations, pending: null });
  }

  // Durable per-evaluation receipts do not yet model one dispatch shared by many
  // questions (D07/#2602). Preserve their exactly-once semantics by degrading.
  if (!request.receiptStore && request.batching?.enabled) {
    const candidates = [];
    for (const item of resolved) {
      if (evaluations[item.alias]) continue;
      const configured = request.binding.spec.evaluations[item.alias];
      const target = configured?.targets.length === 1 && configured.targets[0]?.retry.maxRetries === 0
        ? configured.targets[0] : undefined;
      const adapter = target ? request.adapters[target.adapter] : undefined;
      if (!target || !adapter) continue;
      const capabilityFailure = await checkCapabilities(adapter, target, item.definition);
      if (capabilityFailure) continue;
      candidates.push({ alias: item.alias, definition: item.definition, input: item.input, target, adapter,
        capabilities: await adapter.capabilities() });
    }
    for (const plan of planNativeDecisionBatches(candidates, request.batching)) {
      if (plan.candidates.some(candidate => evaluations[candidate.alias])) continue;
      if (attemptsUsed + plan.candidates.length > request.binding.spec.maxAttempts) continue;
      const started = now();
      const deadline = Math.min(totalDeadline, ...plan.candidates.map(candidate => started + candidate.target.timeoutMs));
      const questionIds = plan.candidates.map(candidate => decisionBatchQuestionId(candidate.alias));
      let observations = new Map<string, AdapterObservation>();
      try {
        const adapter = plan.candidates[0]!.adapter;
        const response = await adapter.evaluateMany!({ decisionSubject: plan.decisionSubject,
          requests: plan.candidates.map((candidate, index) => ({
            alias: candidate.alias, questionId: questionIds[index], definition: structuredClone(candidate.definition),
            input: structuredClone(candidate.input), target: structuredClone(candidate.target),
            invocationId: `${request.invocationId}:${plan.groupId}`, deadlineEpochMs: deadline,
            signal: totalAbort, callerSignal: request.signal ?? new AbortController().signal, totalSignal: totalAbort,
            resolveCredential: request.resolveCredential ?? unauthorizedCredential,
          })) });
        observations = correlateAtomicBatch(questionIds,
          response.answers.map(answer => ({ questionId: answer.questionId, value: answer.observation })));
        // Validate every sibling before publishing any result: the batch is atomic.
        const normalized = new Map<string, AdapterObservation>();
        plan.candidates.forEach((candidate, index) => {
          normalized.set(questionIds[index]!, normalizeObservation(candidate.definition, candidate.target,
            observations.get(questionIds[index]!)!));
        });
        observations = normalized;
      } catch {
        observations = new Map(questionIds.map(id => [id, observationFailure('invalid-output')]));
      }
      plan.candidates.forEach((candidate, index) => {
        const item = resolved.find(value => value.alias === candidate.alias)!;
        const evidence: DecisionBatchEvidence = { mode: 'native', groupId: plan.groupId, questionId: questionIds[index]! };
        const observation = observations.get(questionIds[index]!)!;
        const context: OneContext = { request, item, rulesetPin, bindingPin, totalDeadline, signal: totalAbort, totalTimeout,
          attemptBudget, now, advance };
        evaluations[item.alias] = decisionResult(context, observation,
          [toAttempt(candidate.target, 1, observation, Math.max(0, now() - started), evidence)]);
      });
      attemptsUsed += plan.candidates.length;
      attemptBudget.consume(plan.candidates.length);
    }
  }
  const remainingItems = resolved.filter(item => !evaluations[item.alias]);
  const concurrency = effectiveConcurrency(request);
  const scheduled = await runBoundedFair(remainingItems.map(item => ({ value: item, lane: schedulerLane(request, item) })), concurrency,
    async item => evaluateOne({ request, item, rulesetPin, bindingPin, totalDeadline, signal: totalAbort, totalTimeout,
      attemptBudget, now, advance, batchEvidence: singleBatchEvidence(request, item.alias) }),
    { signal: totalAbort, deadlineEpochMs: totalDeadline, now });
  scheduled.forEach((execution, index) => {
    const item = remainingItems[index]!;
    if (execution instanceof SchedulerWaitError) {
      const reason = execution.reason === 'cancelled' ? 'cancelled' : 'timeout';
      evaluations[item.alias] = emptyDecisionResult(request, item, rulesetPin, bindingPin,
        reason === 'cancelled' ? 'cancelled' : 'error', reason);
    } else {
      evaluations[item.alias] = execution;
    }
  });
  // Receipt v2 has one pending slot; concurrency is forced to one when durable
  // ownership is enabled, so this update remains an atomic chronology.
  if (request.receiptStore) await advance('observation-received', { evaluations, pending: null });

  if (receipt?.state === 'execution-uncertain') {
    releaseAdmissionBudget(request);
    return failureResult(base, 'execution-uncertain', evaluations);
  }

  const orderedEvaluations = Object.fromEntries(resolved
    .filter(item => evaluations[item.alias])
    .map(item => [item.alias, evaluations[item.alias]!]));
  let result: RulesetResult;
  if (totalAbort.aborted) {
    const reason = request.signal?.aborted ? 'cancelled' : 'timeout';
    result = { ...base, spec: { ...base.spec, status: reason === 'cancelled' ? 'cancelled' : 'error', reason, matchedRules: [], evaluations: orderedEvaluations } };
  } else {
    try {
      const composition = composeRuleset(request.ruleset, request.input, orderedEvaluations);
      result = {
        ...base,
        spec: {
          ...base.spec,
          status: composition.status,
          reason: composition.reason as DecisionFailureReason,
          ...(composition.outcome !== undefined ? { outcome: composition.outcome } : {}),
          matchedRules: composition.matchedRules,
          evaluations: orderedEvaluations,
        },
      };
    } catch {
      result = { ...base, spec: { ...base.spec, status: 'error', reason: 'invalid-output', matchedRules: [], evaluations: orderedEvaluations } };
    }
  }

  await advance('composed');
  await advance('completed', { result });
  releaseAdmissionBudget(request);
  return result;
  } catch (error) {
    if (error instanceof RemoteUncertainError) {
      try { await advance('execution-uncertain'); } catch { return failureResult(base, 'persistence-error', evaluations); }
      releaseAdmissionBudget(request);
      return failureResult(base, 'execution-uncertain', evaluations);
    }
    releaseAdmissionBudget(request);
    return failureResult(base, 'persistence-error', evaluations);
  }
}

class ReceiptPersistenceError extends Error {}
class RemoteUncertainError extends Error {}

interface OneContext {
  request: DecisionEvaluationRequest;
  item: { alias: string; definition: DecisionDefinition; pin: ArtifactPin; input: unknown };
  rulesetPin: ArtifactPin;
  bindingPin: ArtifactPin;
  totalDeadline: number;
  signal: AbortSignal;
  totalTimeout: AbortSignal;
  attemptBudget: AttemptBudget;
  now: () => number;
  advance: (state: DecisionReceipt['state'], extra?: Partial<Pick<DecisionReceipt, 'result' | 'remoteHandles' | 'evaluations' | 'pending'>>) => Promise<void>;
  batchEvidence?: DecisionBatchEvidence;
}

async function evaluateOne(context: OneContext): Promise<DecisionResult> {
  const evaluation = context.request.binding.spec.evaluations[context.item.alias]!;
  const attempts: DecisionAttempt[] = [];
  let final: AdapterObservation = observationFailure('budget-exhausted');

  for (let targetIndex = 0; targetIndex < evaluation.targets.length; targetIndex += 1) {
    const target = evaluation.targets[targetIndex]!;
    if (context.signal.aborted || context.now() >= context.totalDeadline) {
      final = interruption(context);
      break;
    }
    if (!context.attemptBudget.available) {
      final = observationFailure('budget-exhausted');
      break;
    }
    const adapter = context.request.adapters[target.adapter];
    const capabilityFailure = await checkCapabilities(adapter, target, context.item.definition);
    if (capabilityFailure) {
      if (!context.attemptBudget.claim()) { final = observationFailure('budget-exhausted'); break; }
      final = capabilityFailure;
      attempts.push(toAttempt(target, attempts.length + 1, final, 0, context.batchEvidence));
    } else {
      for (let retry = 0; retry <= target.retry.maxRetries; retry += 1) {
        if (context.signal.aborted || context.now() >= context.totalDeadline) {
          final = interruption(context);
          break;
        }
        if (!context.attemptBudget.claim()) {
          final = observationFailure('budget-exhausted');
          break;
        }
        const started = context.now();
        const attemptDeadline = Math.min(context.totalDeadline, started + target.timeoutMs);
        try {
          await context.advance('dispatched', { pending: { alias: context.item.alias, targetIndex, ordinal: attempts.length + 1, attempts } });
          try {
            final = await invokeWithDeadline(context, adapter!, target, attemptDeadline, attempts.length + 1);
          } catch (error) {
            if (context.request.receiptStore && !(error instanceof DecisionPreDispatchError)) throw new RemoteUncertainError();
            await context.advance('observation-received');
            throw error;
          }
          if (context.request.receiptStore && final.status !== 'success'
            && final.dispatchCertainty !== 'terminal-response' && final.dispatchCertainty !== 'not-sent') {
            throw new RemoteUncertainError();
          }
          await context.advance('observation-received');
          final = normalizeObservation(context.item.definition, target, final);
        } catch (error) {
          if (error instanceof ReceiptPersistenceError || error instanceof RemoteUncertainError) throw error;
          final = observationFailure(error instanceof DecisionValidationError ? 'invalid-output' : 'service-error');
        }
        attempts.push(toAttempt(target, attempts.length + 1, final, Math.max(0, context.now() - started), context.batchEvidence));
        if (final.status === 'success') break;
        if (!RETRIABLE.has(final.reason) || retry === target.retry.maxRetries) break;
        const remaining = Math.max(0, context.totalDeadline - context.now());
        const baseDelay = Math.min(target.retry.maxDelayMs,
          final.retryAfterMs ?? target.retry.initialDelayMs * 2 ** retry);
        const random = context.request.random?.() ?? Math.random();
        const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
        const jittered = final.retryAfterMs === undefined ? Math.round(baseDelay * (0.75 + 0.5 * jitter)) : baseDelay;
        const delayMs = Math.min(remaining, target.retry.maxDelayMs, Math.max(0, jittered));
        if (context.signal.aborted || remaining <= delayMs) { final = interruption(context); break; }
        attempts[attempts.length - 1]!.retryDelayMs = delayMs;
        try {
          await (context.request.delay ?? abortableDelay)(delayMs, context.signal);
        } catch {
          final = interruption(context);
          break;
        }
        if (context.signal.aborted || context.now() >= context.totalDeadline) { final = interruption(context); break; }
      }
    }
    if (final.status === 'success' || final.reason === 'cancelled') break;
    const hasNext = targetIndex + 1 < evaluation.targets.length;
    if (!hasNext || !evaluation.fallbackOn.includes(final.reason)) break;
  }

  return decisionResult(context, final, attempts);
}

async function invokeWithDeadline(
  context: OneContext,
  adapter: DecisionAdapter,
  target: ExecutionTarget,
  deadlineEpochMs: number,
  ordinal: number,
): Promise<AdapterObservation> {
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const timeoutMs = Math.max(1, deadlineEpochMs - context.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => undefined;
  let admissionEvidence: DecisionAdmissionEvidence | undefined;
  let releaseAdmission: ((outcome?: { success: boolean; retryAfterMs?: number }) => void) | undefined;
  const boundary = new Promise<AdapterObservation>(resolve => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Decision target timed out', 'TimeoutError'));
      resolve(context.request.signal?.aborted ? interruption(context) : observationFailure('timeout', 'error', undefined, 'target-timeout'));
    }, timeoutMs);
    const cancelled = (): void => resolve(interruption(context));
    if (context.signal.aborted) cancelled();
    else {
      context.signal.addEventListener('abort', cancelled, { once: true });
      removeAbortListener = () => context.signal.removeEventListener('abort', cancelled);
    }
  });
  try {
    if (context.request.scheduler?.enabled) {
      const policy = context.request.scheduler;
      const providerLimits = policy.providers[target.adapter];
      if (!providerLimits) return observationFailure('overloaded');
      let controller = admissionControllers.get(policy);
      if (!controller) {
        controller = new DecisionAdmissionController(admissionRequest => ({
          principal: policy.principal.limits, workspace: policy.workspace.limits,
          provider: policy.providers[admissionRequest.providerId] ?? providerLimits,
        }), context.now);
        admissionControllers.set(policy, controller);
      }
      try {
        const lease = await controller.acquire({ budgetId: context.request.invocationId,
          principalId: policy.principal.id, workspaceId: policy.workspace.id,
          providerId: target.adapter, estimate: policy.estimate?.(context.item.alias, target, context.item.input) ?? { attempts: 1, batchSize: 1, items: 1 },
          deadlineEpochMs, signal });
        admissionEvidence = lease.evidence;
        releaseAdmission = lease.release;
        policy.onEvidence?.(context.item.alias, lease.evidence);
      } catch (error) {
        if (error instanceof AdmissionError) {
          policy.onEvidence?.(context.item.alias, error.evidence);
          return { ...observationFailure(admissionReason(error)), admission: error.evidence };
        }
        throw error;
      }
    }
    const observed = await Promise.race([
      adapter.evaluate({
        alias: context.item.alias,
        definition: structuredClone(context.item.definition),
        input: structuredClone(context.item.input),
        target: structuredClone(target),
        invocationId: `${context.request.invocationId}:${context.item.alias}:${ordinal}`,
        deadlineEpochMs,
        signal,
        callerSignal: context.request.signal ?? new AbortController().signal,
        totalSignal: context.signal,
        resolveCredential: context.request.resolveCredential ?? unauthorizedCredential,
        onRemoteHandle: async handle => {
          try {
            const previous = await context.request.receiptStore?.read(context.request.invocationId, context.request.receiptProjectId ?? 'default');
            if (previous && !previous.remoteHandles.includes(handle)) await context.advance('remote-handle-known', { remoteHandles: [...previous.remoteHandles, handle] });
          } catch { throw new ReceiptPersistenceError(); }
        },
      }),
      boundary,
    ]);
    const result = context.request.signal?.aborted ? observationFailure('cancelled', 'cancelled', observed, 'caller-cancelled') : observed;
    releaseAdmission?.({ success: result.status === 'success', ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) });
    return admissionEvidence ? { ...result, admission: admissionEvidence } : result;
  } finally {
    releaseAdmission?.({ success: false });
    if (timer) clearTimeout(timer);
    removeAbortListener();
  }
}

function interruption(context: OneContext): AdapterObservation {
  if (context.request.signal?.aborted) return observationFailure('cancelled', 'cancelled', undefined, 'caller-cancelled');
  return observationFailure('timeout', 'error', undefined,
    context.totalTimeout.aborted || context.now() >= context.totalDeadline ? 'total-deadline' : 'target-timeout');
}

function resolveDefinitions(request: DecisionEvaluationRequest): Array<{ alias: string; definition: DecisionDefinition; pin: ArtifactPin; input: unknown }> {
  const values = Object.values(request.definitions);
  return request.ruleset.spec.evaluations.map(evaluation => {
    const definition = values.find(candidate => candidate.metadata.id === evaluation.decision.id);
    if (!definition) throw new DecisionValidationError(`missing decision '${evaluation.decision.id}'`);
    validateDefinition(definition);
    assertArtifactPin(definition, evaluation.decision, `decision ${evaluation.alias}`);
    const projection = resolveJsonPointer(request.input, evaluation.inputPointer);
    if (!projection.found) throw new DecisionValidationError(`input projection for '${evaluation.alias}' is missing`);
    validateAgainstSchema(definition.spec.inputSchema, projection.value, `${evaluation.alias} input`);
    return { alias: evaluation.alias, definition, pin: evaluation.decision, input: structuredClone(projection.value) };
  });
}

async function checkCapabilities(
  adapter: DecisionAdapter | undefined,
  target: ExecutionTarget,
  definition: DecisionDefinition,
): Promise<AdapterObservation | null> {
  if (!adapter || adapter.id !== target.adapter || adapter.version !== target.adapterVersion) return observationFailure('executor-unavailable');
  const capabilities = await adapter.capabilities();
  if (!capabilities.executable || !capabilities.answerKinds.includes(definition.spec.answer.kind)) return observationFailure('unsupported-capability', 'unsupported');
  if (definition.apiVersion === DECISION_API_VERSION_STRUCTURED && !capabilities.features.includes('structured-entries')) {
    return observationFailure('unsupported-capability', 'unsupported');
  }
  const required = new Set([...definition.spec.requiredCapabilities, ...target.requiredCapabilities]);
  const available = new Set([...capabilities.answerKinds, ...capabilities.features]);
  if ([...required].some(capability => !available.has(capability))) return observationFailure('unsupported-capability', 'unsupported');
  if (definition.spec.answer.kind === 'choice' && capabilities.maxOptions !== null && definition.spec.answer.options.length > capabilities.maxOptions) {
    return observationFailure('unsupported-capability', 'unsupported');
  }
  if (definition.spec.answer.kind === 'ordinal-score' && capabilities.maxLevels !== null && definition.spec.answer.levels.length > capabilities.maxLevels) {
    return observationFailure('unsupported-capability', 'unsupported');
  }
  if (target.acceptance.mode === 'confidence-threshold' && !capabilities.confidenceProfiles.includes(target.acceptance.profile)) {
    return observationFailure('confidence-profile-mismatch', 'abstained');
  }
  return null;
}

function normalizeObservation(definition: DecisionDefinition, target: ExecutionTarget, observation: AdapterObservation): AdapterObservation {
  if (observation.status !== 'success') return observation;
  validateDecisionValue(definition, observation.value);
  if (observation.uncertainty?.distribution) validateDistribution(definition, observation.uncertainty.distribution);
  if (target.acceptance.mode === 'typed-value') return observation;
  if (target.acceptance.mode === 'primitive-policy') return applyPrimitiveAcceptance(definition, target.acceptance, observation);
  if (!observation.uncertainty || observation.uncertainty.confidence === null) return observationFailure('missing-confidence', 'abstained', observation);
  if (observation.uncertainty.profile !== target.acceptance.profile) return observationFailure('confidence-profile-mismatch', 'abstained', observation);
  if (observation.uncertainty.confidence * 10_000 < target.acceptance.minimumBps) return observationFailure('low-confidence', 'abstained', observation);
  return observation;
}

function decisionResult(context: OneContext, observation: AdapterObservation, attempts: DecisionAttempt[]): DecisionResult {
  return {
    apiVersion: resultVersion(context.request), kind: 'DecisionResult',
    metadata: { id: `${context.request.invocationId}-${context.item.alias}`, version: '1.0.0', description: `Decision result for ${context.item.alias}` },
    spec: {
      decision: context.item.pin, ruleset: context.rulesetPin, binding: context.bindingPin,
      alias: context.item.alias, runId: context.request.runId, invocationId: context.request.invocationId,
      status: observation.status, ...(observation.status === 'success' ? { value: observation.value! } : {}),
      reason: observation.reason, uncertainty: observation.uncertainty,
      ...(observation.acceptance ? { acceptance: observation.acceptance } : {}), attempts,
    },
  };
}

function emptyDecisionResult(
  request: DecisionEvaluationRequest,
  item: OneContext['item'],
  rulesetPin: ArtifactPin,
  bindingPin: ArtifactPin,
  status: DecisionStatus,
  reason: DecisionFailureReason,
): DecisionResult {
  return decisionResult({ request, item, rulesetPin, bindingPin, totalDeadline: 0, signal: new AbortController().signal,
    totalTimeout: new AbortController().signal, attemptBudget: new AttemptBudget(0), now: Date.now, advance: async () => undefined }, observationFailure(reason, status), []);
}

function resultBase(request: DecisionEvaluationRequest, ruleset: ArtifactPin, binding: ArtifactPin): RulesetResult {
  return {
    apiVersion: resultVersion(request), kind: 'RulesetResult',
    metadata: { id: request.invocationId, version: '1.0.0', description: `Ruleset result for ${request.ruleset.metadata.id}` },
    spec: { ruleset, binding, runId: request.runId, invocationId: request.invocationId, status: 'error', reason: 'evaluation-failed', matchedRules: [], evaluations: {} },
  };
}

function resultVersion(request: DecisionEvaluationRequest): typeof DECISION_API_VERSION | typeof DECISION_API_VERSION_STRUCTURED {
  if (request.ruleset.apiVersion === DECISION_API_VERSION_STRUCTURED || request.binding.apiVersion === DECISION_API_VERSION_STRUCTURED
    || Object.values(request.definitions).some(definition => definition.apiVersion === DECISION_API_VERSION_STRUCTURED)) {
    return DECISION_API_VERSION_STRUCTURED;
  }
  return DECISION_API_VERSION;
}

function invalidResultBase(request: DecisionEvaluationRequest): RulesetResult {
  const invalidPin: ArtifactPin = { id: 'invalid', version: '0.0.0', digest: `sha256:${'0'.repeat(64)}` };
  return {
    apiVersion: DECISION_API_VERSION, kind: 'RulesetResult',
    metadata: { id: request.invocationId, version: '1.0.0', description: 'Rejected decision evaluation' },
    spec: { ruleset: invalidPin, binding: invalidPin, runId: request.runId, invocationId: request.invocationId,
      status: 'error', reason: 'invalid-definition', matchedRules: [], evaluations: {} },
  };
}

function failureResult(base: RulesetResult, reason: DecisionFailureReason, evaluations: Record<string, DecisionResult> = {}): RulesetResult {
  return { ...base, spec: { ...base.spec, status: reason === 'cancelled' ? 'cancelled' : 'error', reason, matchedRules: [], evaluations } };
}

function observationFailure(
  reason: DecisionFailureReason,
  status: DecisionStatus = reason === 'cancelled' ? 'cancelled' : reason === 'unsupported-capability' ? 'unsupported' : 'error',
  inherit?: AdapterObservation,
  termination?: DecisionAttempt['termination'],
): AdapterObservation {
  return {
    status, reason, uncertainty: inherit?.uncertainty ?? null,
    actualModel: inherit?.actualModel ?? null,
    usage: inherit?.usage ?? { inputTokens: null, outputTokens: null, costUsd: null },
    requestId: inherit?.requestId ?? null,
    ...(termination ? { termination } : {}),
  };
}

function toAttempt(target: ExecutionTarget, ordinal: number, observation: AdapterObservation, durationMs: number,
  batch?: DecisionBatchEvidence): DecisionAttempt {
  return {
    ordinal, adapter: target.adapter, adapterVersion: target.adapterVersion, requestedModel: target.model,
    actualModel: observation.actualModel, subagent: target.subagent ?? null, status: observation.status,
    reason: observation.reason, durationMs, usage: observation.usage, requestId: observation.requestId,
    ...(observation.requestIdSource ? { requestIdSource: observation.requestIdSource } : {}),
    ...(observation.httpStatus !== undefined ? { httpStatus: observation.httpStatus } : {}),
    ...(observation.termination ? { termination: observation.termination } : {}),
    ...(observation.remoteExecution ? { remoteExecution: observation.remoteExecution } : {}),
    ...(batch ? { batch } : {}),
    ...(observation.admission ? { admission: observation.admission } : {}),
  };
}

class AttemptBudget {
  private consumed: number;
  constructor(private readonly maximum: number, used = 0) { this.consumed = used; }
  get available(): boolean { return this.consumed < this.maximum; }
  claim(): boolean { if (!this.available) return false; this.consumed += 1; return true; }
  consume(count: number): void { this.consumed = Math.min(this.maximum, this.consumed + Math.max(0, count)); }
}

function effectiveConcurrency(request: DecisionEvaluationRequest): number {
  const policy = request.scheduler;
  // Receipt v2 serializes one pending dispatch. Do not weaken atomic ownership.
  if (!policy?.enabled || request.receiptStore) return 1;
  const ceilings = [request.binding.spec.concurrency, policy.callerConcurrency, policy.graphConcurrency,
    policy.workspace.limits.concurrency, policy.principal.limits.concurrency,
    ...Object.values(policy.providers).map(limits => limits.concurrency)]
    .filter((value): value is number => value !== undefined && Number.isInteger(value) && value > 0);
  return Math.max(1, Math.min(...ceilings));
}

function schedulerLane(request: DecisionEvaluationRequest, item: OneContext['item']): string {
  const policy = request.scheduler;
  if (!policy?.enabled) return 'serial';
  const target = request.binding.spec.evaluations[item.alias]?.targets[0];
  return `${target?.adapter ?? 'none'}\u0000${policy.workspace.id}\u0000${policy.principal.id}`;
}

function admissionReason(error: AdmissionError): DecisionFailureReason {
  if (error.evidence.reason === 'cancelled') return 'cancelled';
  if (error.evidence.reason === 'deadline-exceeded' || error.evidence.reason === 'queue-timeout') return 'timeout';
  if (error.evidence.reason === 'requests-per-minute' || error.evidence.reason === 'tokens-per-second'
    || error.evidence.reason === 'retry-after') return 'rate-limited';
  if (error.evidence.reason === 'attempts' || error.evidence.reason === 'cost' || error.evidence.reason === 'unknown-cost') return 'budget-exhausted';
  return 'overloaded';
}

function releaseAdmissionBudget(request: DecisionEvaluationRequest): void {
  if (!request.scheduler?.enabled) return;
  admissionControllers.get(request.scheduler)?.releaseBudget(request.invocationId);
}

function validateSchedulerPolicy(request: DecisionEvaluationRequest): void {
  const policy = request.scheduler;
  if (!policy) return;
  if (!policy.profileVersion.trim() || !policy.workspace.id.trim() || !policy.principal.id.trim()) {
    throw new DecisionValidationError('scheduler profile version and trusted scope identities are required');
  }
  const limits = [policy.workspace.limits, policy.principal.limits, ...Object.values(policy.providers)];
  if (!Object.keys(policy.providers).length || limits.some(limit => !Number.isInteger(limit.concurrency) || limit.concurrency < 1)) {
    throw new DecisionValidationError('scheduler concurrency ceilings must be positive integers');
  }
  for (const value of [policy.callerConcurrency, policy.graphConcurrency]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new DecisionValidationError('scheduler caller/graph ceilings must be positive integers');
  }
  for (const limit of limits) {
    for (const value of [limit.requestsPerMinute, limit.tokensPerSecond, limit.maxAttempts, limit.maxBatchSize,
      limit.maxQueueLength, limit.maxQueueWaitMs, limit.maxRequestBytes, limit.maxItems]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new DecisionValidationError('scheduler admission limits must be finite and non-negative');
    }
    if (limit.maxCostUsd !== undefined && (!Number.isFinite(limit.maxCostUsd) || limit.maxCostUsd < 0)) {
      throw new DecisionValidationError('scheduler cost limit must be finite and non-negative');
    }
  }
}

function singleBatchEvidence(request: DecisionEvaluationRequest, alias: string): DecisionBatchEvidence | undefined {
  if (!request.batching) return undefined;
  const configured = request.batching.evaluations[alias];
  const target = request.binding.spec.evaluations[alias]?.targets[0];
  const adapter = target ? request.adapters[target.adapter] : undefined;
  const reason = !request.batching.enabled ? 'disabled'
    : configured?.independent && (!adapter?.evaluateMany || Boolean(request.receiptStore)) ? 'unsupported' : 'ineligible';
  return {
    mode: 'single',
    groupId: `single_${decisionBatchQuestionId(alias).slice(2)}`,
    questionId: decisionBatchQuestionId(alias),
    degradationReason: reason,
  };
}

function classifyValidationFailure(error: unknown): DecisionFailureReason {
  if (!(error instanceof DecisionValidationError)) return 'invalid-definition';
  if (/digest/.test(error.message)) return 'digest-mismatch';
  if (/input|projection/.test(error.message)) return 'invalid-input';
  return 'invalid-definition';
}

async function unauthorizedCredential(): Promise<Uint8Array> {
  throw new DecisionValidationError('credential resolver is not configured');
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

export function createDecisionInvocationId(prefix = 'decision'): string {
  return `${prefix}-${randomUUID()}`;
}
