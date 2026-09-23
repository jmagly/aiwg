import { createHash, randomUUID } from 'node:crypto';
import { composeRuleset } from './compose.js';
import { applyPrimitiveAcceptance, validatePrimitiveAcceptancePolicy } from './acceptance.js';
import { DecisionPreDispatchError, decisionInvocationFingerprint, nextReceipt } from './receipts.js';
import { admitEntry, EntryAdmissionError } from './entry.js';
import { correlateAtomicBatch, decisionBatchQuestionId, planNativeDecisionBatches } from './batch.js';
import { AdmissionError, DecisionAdmissionController } from './admission.js';
import { runBoundedFair, SchedulerWaitError } from './scheduler.js';
import { allocateEstimatedUsage, deriveCost } from './batch-receipts/accounting.js';
import { batchResultReference, newBatchReceipt, nextBatchReceipt } from './batch-receipts/receipt.js';
import type { BatchAttempt, DecisionBatchReceipt } from './batch-receipts/types.js';
import type { CompatibilityDecision } from './calibration/types.js';
import { prepareAdapterRequest } from './compile-cache/runtime.js';
import { providerPrefixEvidence } from './compile-cache/prefix.js';
import { digestCachedResult, RESULT_CACHE_KEY_VERSION } from './result-cache/index.js';
import type { CachedResultEvidence, ResultCacheSemanticIdentity } from './result-cache/index.js';
import { DecisionProjectionError, projectDecisionState, type DecisionProjectionEvidence } from './projection.js';
import { emitRulesetRuntimeTrace } from './telemetry/runtime.js';
import {
  assertContextPlanCurrent,
  ContextPlanError,
  planDecisionContext,
  recordContextActualUsage,
  type ContextActualUsageEvidence,
  type ContextPlan,
} from './context-plan.js';
import { DECISION_API_VERSION, DECISION_API_VERSION_STRUCTURED } from './types.js';
import type {
  AdapterObservation,
  ArtifactPin,
  DecisionAdapter,
  DecisionBatchEvidence,
  DecisionContextEvidence,
  DecisionAttempt,
  DecisionAdmissionEvidence,
  DecisionDefinition,
  DecisionEvaluationRequest,
  DecisionFailureReason,
  DecisionResult,
  DecisionReceipt,
  DecisionStatus,
  JsonValue,
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
  const result = request.resultCache?.policy.enabled
    ? await evaluateWithResultCache(request) : await evaluateDecisionRulesetInternal(request);
  await emitRulesetRuntimeTrace(request, result);
  return result;
}

/** A cache hit is a historical result accompanied by a NEW caller receipt, not a fresh adapter attempt. */
async function evaluateWithResultCache(request: DecisionEvaluationRequest): Promise<RulesetResult> {
  const config = request.resultCache!;
  if (!config.policy.sideEffectFree || !request.receiptStore || !request.calibrationPin || !request.policyPin
    || !config.recordCallerReceipt) {
    throw new Error('Result cache requires side-effect-free policy, durable receipts, policy and calibration pins');
  }
  // Exact invocation replay wins over semantic reuse, including fingerprint mismatch protection.
  const projectId = request.receiptProjectId ?? 'default';
  if (projectId !== config.actor.projectId) throw new Error('Cache actor and receipt project must match');
  if (await request.receiptStore.read(request.invocationId, projectId)) return evaluateDecisionRulesetInternal(request);
  // The experimental integration is deliberately narrower than the cache service: no
  // batching, fallback, retries or context-dependent scheduling that can vary per caller.
  if (request.ruleset.spec.evaluations.length !== 1 || request.batching?.enabled || request.context || request.scheduler?.enabled) {
    throw new Error('Result cache supports only a single unbatched, unscheduled evaluation');
  }
  const snapshot = { ...request, ruleset: structuredClone(request.ruleset), binding: structuredClone(request.binding),
    definitions: structuredClone(request.definitions), input: structuredClone(request.input) };
  admitEntry(snapshot.input);
  validateRuleset(snapshot.ruleset);
  validateBinding(snapshot.binding, snapshot.ruleset);
  validateAgainstSchema(snapshot.ruleset.spec.inputSchema, snapshot.input, 'ruleset input');
  const [item] = resolveDefinitions(snapshot);
  const targets = snapshot.binding.spec.evaluations[item.alias]?.targets;
  if (!targets || targets.length !== 1 || targets[0]!.retry.maxRetries !== 0) {
    throw new Error('Result cache requires one target without retry or fallback');
  }
  const target = targets[0]!;
  const projected = await projectRuntimeInput(snapshot, item.alias, target, item.input);
  // The key normalizes Unicode. The adapter must receive that same normalized
  // representation or two byte-distinct prompts could alias to one cache entry.
  assertNormalizedCacheInput(projected.input);
  const identity = config.identityFor({ alias: item.alias, definition: structuredClone(item.definition),
    target: structuredClone(target), projectedInput: structuredClone(projected.input) as JsonValue });
  assertRuntimeCacheIdentity(identity, snapshot, item.pin, target, projected.input);
  const alias = identity.modelCompatibility.mode === 'alias' ? identity.modelCompatibility : null;
  if (alias && !config.verifyAliasSnapshot) throw new Error('Alias cache requires a registry compatibility verifier');
  const approved = alias ? await config.verifyAliasSnapshot!(structuredClone(alias)) : true;
  const outcome = await config.service.evaluate({ actor: config.actor,
    policy: approved ? config.policy : { ...config.policy, enabled: false }, identity,
    callerInvocationId: snapshot.invocationId, nowEpochMs: snapshot.now?.() }, async (): Promise<CachedResultEvidence> => {
    const original = await evaluateDecisionRulesetInternal(snapshot);
    const attempt = original.spec.evaluations[item.alias]?.spec.attempts[0];
    const receipt = await snapshot.receiptStore!.read(snapshot.invocationId, projectId);
    // Never publish an incomplete or uncertain receipt, even if an adapter returned a value.
    const successful = original.spec.status === 'completed' && original.spec.evaluations[item.alias]?.spec.status === 'success'
      && original.spec.evaluations[item.alias]?.spec.attempts.length === 1 && attempt?.actualModel
      && attempt.remoteExecution !== 'unknown' && receipt?.state === 'completed';
    return { result: original as unknown as JsonValue, resultDigest: digestCachedResult(original),
      sourceInvocationId: snapshot.invocationId, sourceReceiptId: snapshot.invocationId,
      evaluatedAtEpochMs: receipt?.completedAtEpochMs ?? snapshot.now?.() ?? Date.now(),
      actualModel: attempt?.actualModel ?? '', uncertainty: (original.spec.evaluations[item.alias]?.spec.uncertainty ?? null) as unknown as JsonValue,
      calibrationStatus: original.spec.evaluations[item.alias]?.spec.calibrationCompatibility ? 'compatible' : 'pinned',
      durationMs: attempt?.durationMs ?? 0, usage: attempt?.usage ?? { inputTokens: null, outputTokens: null, costUsd: null },
      status: successful ? 'success' : 'terminal-failure', failureReason: successful ? 'none' : original.spec.reason };
  });
  if (outcome.receipt.disposition === 'cache-hit') {
    const source = await snapshot.receiptStore!.read(outcome.receipt.sourceInvocationId!, projectId);
    if (source?.state !== 'completed' || !source.result
      || digestCachedResult(source.result) !== digestCachedResult(outcome.evidence!.result)
      || source.completedAtEpochMs !== outcome.receipt.originalEvaluatedAtEpochMs) {
      throw new Error('Cached source receipt could not be verified');
    }
  }
  await config.recordCallerReceipt!(structuredClone(outcome.receipt));
  const historical = structuredClone(outcome.evidence!.result) as unknown as RulesetResult;
  return { ...historical, spec: { ...historical.spec, cache: outcome.receipt } };
}

function assertNormalizedCacheInput(value: unknown): void {
  if (typeof value === 'string' && value !== value.normalize('NFC')) throw new Error('Cache input must be NFC-normalized before dispatch');
  if (Array.isArray(value)) value.forEach(assertNormalizedCacheInput);
  else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key !== key.normalize('NFC')) throw new Error('Cache input keys must be NFC-normalized before dispatch');
      assertNormalizedCacheInput(entry);
    }
  }
}

function assertRuntimeCacheIdentity(identity: ResultCacheSemanticIdentity, request: DecisionEvaluationRequest,
  definition: ArtifactPin, target: ExecutionTarget, projected: unknown): void {
  const sha = (value: unknown): value is `sha256:${string}` => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  const pinMatches = (left: ArtifactPin, right: ArtifactPin) => digestCachedResult(left) === digestCachedResult(right);
  if (identity.keyVersion !== RESULT_CACHE_KEY_VERSION || !pinMatches(identity.definition, definition)
    || !pinMatches(identity.ruleset, artifactPin(request.ruleset))
    || !pinMatches(identity.binding, artifactPin(request.binding))
    || identity.adapter.id !== target.adapter || identity.adapter.version !== target.adapterVersion
    || identity.requestedModel !== target.model || identity.primitive !== Object.values(request.definitions).find(value => value.metadata.id === definition.id)?.spec.answer.kind
    || identity.acceptancePolicyDigest !== digestCachedResult(target.acceptance)
    || identity.calibrationDigest !== request.calibrationPin?.digest
    || identity.runtimePolicyDigest !== request.policyPin?.digest
    || digestCachedResult(identity.projectedInput) !== digestCachedResult(projected)
    || ![identity.promptDigest, identity.subjectIdentityDigest, identity.projectionPolicyDigest,
      identity.egressPolicyDigest].every(sha)
    || !identity.backend || !identity.capabilityMode
    || (identity.modelCompatibility.mode === 'pinned' && identity.modelCompatibility.actualModel !== target.model)
    || (identity.modelCompatibility.mode === 'alias' && identity.modelCompatibility.alias !== target.model)) {
    throw new Error('Invalid semantic result-cache identity');
  }
}

async function evaluateDecisionRulesetInternal(request: DecisionEvaluationRequest): Promise<RulesetResult> {
  let rulesetPin: ArtifactPin;
  let bindingPin: ArtifactPin;
  let base: RulesetResult = invalidResultBase(request);
  let resolved: Array<{ alias: string; definition: DecisionDefinition; pin: ArtifactPin; input: unknown }>;
  let admissionStage: 'artifact' | 'input' = 'artifact';
  let contextPlan: ContextPlan | undefined;
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
    contextPlan = prepareContextPlan(request, resolved);
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
    return failureResult(base, reason);
  }
  if (contextPlan) base = withRulesetContext(base, contextPlan, []);

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
  const contextUsage: ContextActualUsageEvidence[] = contextUsageFromEvaluations(evaluations);
  let attemptsUsed = Object.values(evaluations).reduce((sum, result) => sum + result.spec.attempts.length, 0);
  const attemptBudget = new AttemptBudget(request.binding.spec.maxAttempts, attemptsUsed);

  try {
  if (reconciled && receipt?.pending) {
    const pending = receipt.pending;
    const item = resolved.find(candidate => candidate.alias === pending.alias);
    const target = request.binding.spec.evaluations[pending.alias]?.targets[pending.targetIndex];
    if (!item || !target) throw new RemoteUncertainError();
    let observation: AdapterObservation;
    let calibrationCompatibility: CompatibilityDecision | undefined;
    try {
      const calibrated = normalizeObservationForRuntime({ request, item, target, observation: reconciled, now });
      observation = calibrated.observation;
      calibrationCompatibility = calibrated.calibrationCompatibility;
    }
    catch { throw new RemoteUncertainError(); }
    if (observation.status !== 'success') throw new RemoteUncertainError();
    const context: OneContext = { request, item, rulesetPin, bindingPin, totalDeadline, signal: totalAbort, totalTimeout,
      attemptBudget, now, advance };
    const attempts = [...pending.attempts, toAttempt(target, pending.ordinal, observation, 0)];
    evaluations[item.alias] = decisionResult(context, observation, attempts, calibrationCompatibility);
    attemptsUsed += attempts.length;
    attemptBudget.consume(attempts.length);
    await advance('observation-received', { evaluations, pending: null });
  }

  // Native batching may coexist with the invocation receipt only when a batch
  // receipt owns the shared dispatch and its accounting before transport begins.
  if ((!request.receiptStore || request.batchReceipts) && request.batching?.enabled) {
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
    for (const plan of contextPartitionedBatchPlans(planNativeDecisionBatches(candidates, request.batching), contextPlan)) {
      if (plan.candidates.some(candidate => evaluations[candidate.alias])) continue;
      if (attemptsUsed + plan.candidates.length > request.binding.spec.maxAttempts) continue;
      const started = now();
      const deadline = Math.min(totalDeadline, ...plan.candidates.map(candidate => started + candidate.target.timeoutMs));
      const questionIds = plan.candidates.map(candidate => decisionBatchQuestionId(candidate.alias));
      let observations = new Map<string, AdapterObservation>();
      let durableReceipt: DecisionBatchReceipt | undefined;
      let batchReferences = new Map<string, ReturnType<typeof batchResultReference>>();
      try {
        const adapter = plan.candidates[0]!.adapter;
        const projectedCandidates = await Promise.all(plan.candidates.map(async candidate => ({
          candidate,
          projected: await projectRuntimeInput(request, candidate.alias, candidate.target, candidate.input),
        })));
        if (request.batchReceipts) {
          const partition = request.batchReceipts.contextPlan.partitions.find(candidate =>
            sameStringSet(candidate.questionIds, questionIds));
          if (!partition) throw new ReceiptPersistenceError();
          const initial = newBatchReceipt({
            tenantId: request.batchReceipts.tenantId,
            projectId: request.batchReceipts.projectId,
            batchId: durableBatchId(request.invocationId, plan.groupId, partition.id),
            invocationId: request.invocationId,
            runId: request.runId,
            contextPlan: request.batchReceipts.contextPlan,
            partition,
            nativeBatchGroupId: plan.groupId,
            subjectHash: request.batchReceipts.subjectHash,
            executionEnvelope: plan.candidates[0]!.capabilities.batch!.executionEnvelope,
            nowEpochMs: started,
          });
          const acquired = await request.batchReceipts.store.acquire(initial);
          durableReceipt = acquired.receipt;
          if (!acquired.owner) {
            if (durableReceipt.status === 'completed') {
              const replayed = await request.batchReceipts.resultStore?.readMany(durableReceipt);
              if (!replayed || replayed.size !== questionIds.length) throw new RemoteUncertainError();
              batchReferences = new Map(questionIds.map(questionId =>
                [questionId, batchResultReference(durableReceipt!, questionId)]));
              observations = replayed;
              // The shared request already has an owner. Never dispatch it again.
              throw new ReplayedBatchReceipt();
            }
            throw new RemoteUncertainError();
          }
          const running = nextBatchReceipt(durableReceipt, { status: 'running', updatedAtEpochMs: now() });
          if (!await request.batchReceipts.store.compareAndSwap(durableReceipt, running)) {
            throw new ReceiptPersistenceError();
          }
          durableReceipt = running;
        }
        const preparedRequests = await Promise.all(projectedCandidates.map(({ candidate, projected }, index) =>
          prepareAdapterRequest({
            alias: candidate.alias, questionId: questionIds[index], definition: structuredClone(candidate.definition),
            input: structuredClone(projected.input), target: structuredClone(candidate.target),
            invocationId: `${request.invocationId}:${plan.groupId}`, deadlineEpochMs: deadline,
            signal: totalAbort, callerSignal: request.signal ?? new AbortController().signal, totalSignal: totalAbort,
            resolveCredential: request.resolveCredential ?? unauthorizedCredential,
            ...(projected.evidence ? { projectionEvidence: projected.evidence } : {}),
          }, adapter, request.compileCache)));
        const response = await adapter.evaluateMany!({ decisionSubject: plan.decisionSubject,
          requests: preparedRequests });
        if (contextPlan && response.sharedUsage.inputTokens !== null) {
          recordRuntimeContextUsage(contextPlan, questionIds[0]!, response.sharedUsage.inputTokens, contextUsage, 'partition');
        }
        observations = correlateAtomicBatch(questionIds,
          response.answers.map(answer => ({ questionId: answer.questionId, value: answer.observation })));
        // Validate every sibling before publishing any result: the batch is atomic.
        const normalized = new Map<string, { observation: AdapterObservation; calibrationCompatibility?: CompatibilityDecision }>();
        plan.candidates.forEach((candidate, index) => {
          const item = resolved.find(value => value.alias === candidate.alias)!;
          normalized.set(questionIds[index]!, normalizeObservationForRuntime({ request, item, target: candidate.target,
            observation: observations.get(questionIds[index]!)!, now }));
        });
        observations = new Map([...normalized].map(([id, value]) => [id, value.observation]));
        if (durableReceipt && request.batchReceipts) {
          const requestIds = uniqueNonNull(response.answers.map(answer => answer.observation.requestId));
          if (requestIds.length > 1) throw new Error('batch response contained multiple provider request IDs');
          const models = uniqueNonNull(response.answers.map(answer => answer.observation.actualModel));
          const cost = providerCost(response.sharedUsage.costUsd)
            ?? (request.batchReceipts.priceCatalog
              ? deriveCost(response.sharedUsage, request.batchReceipts.priceCatalog) : { kind: 'unknown' as const });
          const certainties = response.answers.map(answer => answer.observation.dispatchCertainty);
          const attemptStatus: BatchAttempt['status'] = certainties.some(value => value === 'unknown')
            ? 'execution-uncertain' : certainties.every(value => value === 'not-sent') ? 'not-sent' : 'succeeded';
          const attempt: BatchAttempt = {
            ordinal: durableReceipt.attempts.length + 1,
            adapterId: adapter.id,
            adapterVersion: adapter.version,
            requestedModel: plan.candidates[0]!.target.model,
            actualModel: models.length === 1 ? models[0]! : null,
            providerRequestId: requestIds[0] ?? null,
            status: attemptStatus,
            dispatchedAtEpochMs: attemptStatus === 'not-sent' ? null : started,
            completedAtEpochMs: now(),
            usage: { inputTokens: response.sharedUsage.inputTokens, outputTokens: response.sharedUsage.outputTokens },
            cost,
            fallbackFromAttemptOrdinal: null,
          };
          const answerReferences = plan.candidates.map((candidate, index) => ({
            questionId: questionIds[index]!,
            answerId: durableAnswerId(durableReceipt!.batchId, questionIds[index]!),
            resultId: `${request.invocationId}-${candidate.alias}`,
          }));
          const terminalStatus = attemptStatus === 'succeeded' ? 'completed'
            : attemptStatus === 'not-sent' ? 'failed' : 'execution-uncertain';
          const terminal = nextBatchReceipt(durableReceipt, { status: terminalStatus, updatedAtEpochMs: now(),
            attempts: [...durableReceipt.attempts, attempt],
            ...(terminalStatus === 'completed' ? { answerReferences,
              allocations: allocateEstimatedUsage(questionIds, attempt.usage) } : {}) });
          if (!await request.batchReceipts.store.compareAndSwap(durableReceipt, terminal)) {
            throw new ReceiptPersistenceError();
          }
          durableReceipt = terminal;
          if (terminalStatus === 'completed') {
            // Shared request identity, usage, and cost live only on the receipt and not in the governed value repository.
            observations = resultOnlyBatchObservations(observations);
            if (request.batchReceipts.resultStore) await request.batchReceipts.resultStore.writeMany(terminal, observations);
            batchReferences = new Map(questionIds.map(questionId =>
              [questionId, batchResultReference(terminal, questionId)]));
          }
          else observations = resultOnlyBatchObservations(new Map(questionIds.map(questionId =>
            [questionId, observationFailure(terminalStatus === 'execution-uncertain' ? 'execution-uncertain' : 'service-error')])));
        }
      } catch (error) {
        if (error instanceof ReplayedBatchReceipt || (error as Error).name === 'ReplayedBatchReceipt') {
          // References and reconstructed result observations were prepared above.
        } else if (durableReceipt && request.batchReceipts && durableReceipt.status === 'running') {
          const uncertain = nextBatchReceipt(durableReceipt, { status: 'execution-uncertain', updatedAtEpochMs: now(),
            attempts: [...durableReceipt.attempts, uncertainBatchAttempt(plan, started, now())] });
          if (!await request.batchReceipts.store.compareAndSwap(durableReceipt, uncertain)) {
            throw new ReceiptPersistenceError();
          }
          observations = new Map(questionIds.map(id => [id, observationFailure('execution-uncertain')]));
        } else if (error instanceof ReceiptPersistenceError || error instanceof RemoteUncertainError) {
          throw error;
        } else {
          const replayed = durableReceipt?.status === 'completed'
            ? await request.batchReceipts?.resultStore?.readMany(durableReceipt) : undefined;
          if (replayed && replayed.size === questionIds.length) {
            batchReferences = new Map(questionIds.map(questionId =>
              [questionId, batchResultReference(durableReceipt!, questionId)]));
            observations = replayed;
          } else {
            observations = new Map(questionIds.map(id => [id, observationFailure(
              error instanceof DecisionProjectionError ? 'data-boundary-denied' : 'invalid-output',
            )]));
          }
        }
      }
      plan.candidates.forEach((candidate, index) => {
        const item = resolved.find(value => value.alias === candidate.alias)!;
        const evidence: DecisionBatchEvidence = { mode: 'native', groupId: plan.groupId, questionId: questionIds[index]! };
        const observation = observations.get(questionIds[index]!)!;
        const context: OneContext = { request, item, rulesetPin, bindingPin, totalDeadline, signal: totalAbort, totalTimeout,
          attemptBudget, now, advance, batchResult: batchReferences.get(questionIds[index]!), contextPlan, contextUsage };
        const calibrationCompatibility = request.calibrationCompatibility && observation.status === 'success'
          ? normalizeObservationForRuntime({ request, item, target: candidate.target, observation, now }).calibrationCompatibility
          : undefined;
        evaluations[item.alias] = decisionResult(context, observation,
          [toAttempt(candidate.target, 1, observation, Math.max(0, now() - started), evidence)], calibrationCompatibility);
      });
      attemptsUsed += plan.candidates.length;
      attemptBudget.consume(plan.candidates.length);
    }
  }
  const concurrency = effectiveConcurrency(request);
  const remainingItems = resolved.filter(item => !evaluations[item.alias]);
  const waves = contextPlan
    ? [...new Set(contextPlan.partitions.map(partition => partition.wave))].sort((left, right) => left - right)
        .map(wave => remainingItems.filter(item => contextPlan.partitions.some(partition =>
          partition.wave === wave && partition.questionIds.includes(decisionBatchQuestionId(item.alias)))))
    : [remainingItems];
  for (const waveItems of waves) {
    const scheduled = await runBoundedFair(waveItems.map(item => ({ value: item, lane: schedulerLane(request, item) })), concurrency,
      async item => evaluateOne({ request, item, rulesetPin, bindingPin, totalDeadline, signal: totalAbort, totalTimeout,
        attemptBudget, now, advance, batchEvidence: singleBatchEvidence(request, item.alias), contextPlan, contextUsage }),
      { signal: totalAbort, deadlineEpochMs: totalDeadline, now });
    scheduled.forEach((execution, index) => {
      const item = waveItems[index]!;
      if (execution instanceof SchedulerWaitError) {
        const reason = execution.reason === 'cancelled' ? 'cancelled' : 'timeout';
        evaluations[item.alias] = emptyDecisionResult(request, item, rulesetPin, bindingPin,
          reason === 'cancelled' ? 'cancelled' : 'error', reason);
      } else {
        evaluations[item.alias] = execution;
      }
    });
  }
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

  if (contextPlan && !contextPlan.automaticActionAllowed && (result.spec.status === 'completed' || result.spec.status === 'defaulted')) {
    const { outcome: _outcome, ...withoutOutcome } = result.spec;
    result = { ...result, spec: { ...withoutOutcome, status: 'review', reason: 'insufficient-information' } };
  }
  await advance('composed');
  if (contextPlan) result = withRulesetContext(result, contextPlan, contextUsage);
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
class ReplayedBatchReceipt extends Error { constructor() { super('replayed batch receipt'); this.name = 'ReplayedBatchReceipt'; } }

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
  batchResult?: ReturnType<typeof batchResultReference>;
  contextPlan?: ContextPlan;
  contextUsage?: ContextActualUsageEvidence[];
}

async function evaluateOne(context: OneContext): Promise<DecisionResult> {
  const evaluation = context.request.binding.spec.evaluations[context.item.alias]!;
  const attempts: DecisionAttempt[] = [];
  let final: AdapterObservation = observationFailure('budget-exhausted');
  let calibrationCompatibility: CompatibilityDecision | undefined;

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
          const projected = await projectRuntimeInput(context.request, context.item.alias, target, context.item.input);
          await context.advance('dispatched', { pending: { alias: context.item.alias, targetIndex, ordinal: attempts.length + 1, attempts } });
          try {
            final = await invokeWithDeadline(context, adapter!, target, attemptDeadline, attempts.length + 1, projected);
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
          const calibrated = normalizeObservationForRuntime({ request: context.request, item: context.item, target,
            observation: final, now: context.now });
          final = calibrated.observation;
          calibrationCompatibility = calibrated.calibrationCompatibility;
          if (context.contextPlan && final.usage.inputTokens !== null && context.contextUsage) {
            recordRuntimeContextUsage(context.contextPlan, decisionBatchQuestionId(context.item.alias),
              final.usage.inputTokens, context.contextUsage);
          }
        } catch (error) {
          if (error instanceof ReceiptPersistenceError || error instanceof RemoteUncertainError) throw error;
          final = observationFailure(error instanceof DecisionProjectionError ? 'data-boundary-denied'
            : error instanceof DecisionValidationError ? 'invalid-output' : 'service-error');
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

  return decisionResult(context, final, attempts, calibrationCompatibility);
}

async function invokeWithDeadline(
  context: OneContext,
  adapter: DecisionAdapter,
  target: ExecutionTarget,
  deadlineEpochMs: number,
  ordinal: number,
  projected: { input: unknown; evidence?: DecisionProjectionEvidence },
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
    const preparedRequest = await prepareAdapterRequest({
        alias: context.item.alias,
        definition: structuredClone(context.item.definition),
        input: structuredClone(projected.input),
        target: structuredClone(target),
        invocationId: `${context.request.invocationId}:${context.item.alias}:${ordinal}`,
        deadlineEpochMs,
        signal,
        callerSignal: context.request.signal ?? new AbortController().signal,
        totalSignal: context.signal,
        resolveCredential: context.request.resolveCredential ?? unauthorizedCredential,
        ...(projected.evidence ? { projectionEvidence: projected.evidence } : {}),
        onRemoteHandle: async handle => {
          try {
            const previous = await context.request.receiptStore?.read(context.request.invocationId, context.request.receiptProjectId ?? 'default');
            if (previous && !previous.remoteHandles.includes(handle)) await context.advance('remote-handle-known', { remoteHandles: [...previous.remoteHandles, handle] });
          } catch { throw new ReceiptPersistenceError(); }
        },
      }, adapter, context.request.compileCache);
    const observedWithTransportMetadata = await Promise.race([
      adapter.evaluate(preparedRequest),
      boundary,
    ]);
    const { providerPrefixReport, ...observedWithoutPrefixReport } = observedWithTransportMetadata;
    let observed: AdapterObservation = observedWithoutPrefixReport;
    if (context.request.providerPrefix) {
      try {
        const identity = context.request.providerPrefix.identityFor({
          request: preparedRequest,
          adapter,
          observation: observedWithTransportMetadata,
        });
        const evidence = providerPrefixEvidence(identity, providerPrefixReport ?? { kind: 'unreported' }, context.now());
        observed = { ...observed, providerPrefix: evidence };
        context.request.providerPrefix.onEvidence?.({ alias: context.item.alias, evidence });
      } catch {
        // Provider cache metadata is observability-only and cannot alter decision semantics.
      }
    }
    const result = context.request.signal?.aborted ? observationFailure('cancelled', 'cancelled', observed, 'caller-cancelled') : observed;
    releaseAdmission?.({ success: result.status === 'success', ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) });
    return admissionEvidence ? { ...result, admission: admissionEvidence } : result;
  } finally {
    releaseAdmission?.({ success: false });
    if (timer) clearTimeout(timer);
    removeAbortListener();
  }
}

async function projectRuntimeInput(
  request: DecisionEvaluationRequest,
  alias: string,
  target: ExecutionTarget,
  input: unknown,
): Promise<{ input: unknown; evidence?: DecisionProjectionEvidence }> {
  if (!request.projection) return { input };
  const policy = request.projection.resolve({ alias, target: structuredClone(target) });
  if (policy.provider !== target.adapter || policy.model !== target.model) {
    throw new DecisionProjectionError('data-boundary-denied', 'projection destination does not match execution target');
  }
  const projected = await projectDecisionState(input, policy, {
    incompleteContext: request.projection.incompleteContext,
  });
  request.projection.onEvidence?.({ alias, evidence: structuredClone(projected.evidence) });
  return { input: projected.state, evidence: projected.evidence };
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

function normalizeObservationForRuntime(input: {
  request: DecisionEvaluationRequest;
  item: OneContext['item'];
  target: ExecutionTarget;
  observation: AdapterObservation;
  now: () => number;
}): { observation: AdapterObservation; calibrationCompatibility?: CompatibilityDecision } {
  let observation = input.observation;
  const runtime = input.request.calibrationCompatibility;
  if (runtime && observation.status === 'success') {
    if (observation.actualModel === null) {
      observation = withoutCalibratedRisk(observation);
    } else {
      const identity = runtime.identityFor({ alias: input.item.alias, definition: structuredClone(input.item.definition),
        target: structuredClone(input.target), actualModel: observation.actualModel });
      if (identity.actualModel !== observation.actualModel) {
        throw new DecisionValidationError('calibration identity actual model does not match provider evidence');
      }
      const calibrationCompatibility = runtime.registry.resolve({
        runId: `${input.request.runId}:${input.request.invocationId}:${input.item.alias}`,
        requestedAlias: input.target.model,
        actualIdentity: identity,
        calibrationArtifactId: runtime.calibrationArtifactId,
        at: new Date(input.now()).toISOString(),
      }, runtime.policy);
      observation = calibrationCompatibility.action === 'allow'
        ? retainPinnedCalibratedRisk(observation, calibrationCompatibility)
        : withoutCalibratedRisk(observation);
      return { observation: normalizeObservation(input.item.definition, input.target, observation), calibrationCompatibility };
    }
  }
  return { observation: normalizeObservation(input.item.definition, input.target, observation) };
}

function withoutCalibratedRisk(observation: AdapterObservation): AdapterObservation {
  if (!observation.uncertainty?.calibratedRisk) return observation;
  const uncertainty = structuredClone(observation.uncertainty);
  delete uncertainty.calibratedRisk;
  return { ...observation, uncertainty };
}

function retainPinnedCalibratedRisk(observation: AdapterObservation, pin: CompatibilityDecision): AdapterObservation {
  const risk = observation.uncertainty?.calibratedRisk;
  if (!risk || !pin.artifactId || !pin.artifactDigest) return withoutCalibratedRisk(observation);
  const acceptedReferences = new Set([pin.artifactId, pin.artifactDigest, `${pin.artifactId}@${pin.artifactDigest}`]);
  return acceptedReferences.has(risk.calibrationRef) ? observation : withoutCalibratedRisk(observation);
}

function decisionResult(context: OneContext, observation: AdapterObservation, attempts: DecisionAttempt[],
  calibrationCompatibility?: CompatibilityDecision): DecisionResult {
  return {
    apiVersion: resultVersion(context.request), kind: 'DecisionResult',
    metadata: { id: `${context.request.invocationId}-${context.item.alias}`, version: '1.0.0', description: `Decision result for ${context.item.alias}` },
    spec: {
      decision: context.item.pin, ruleset: context.rulesetPin, binding: context.bindingPin,
      alias: context.item.alias, runId: context.request.runId, invocationId: context.request.invocationId,
      status: observation.status, ...(observation.status === 'success' ? { value: observation.value! } : {}),
      reason: observation.reason, uncertainty: observation.uncertainty,
      ...(observation.acceptance ? { acceptance: observation.acceptance } : {}), attempts,
      ...(calibrationCompatibility ? { calibrationCompatibility } : {}),
      ...(context.batchResult ? { batchResult: context.batchResult } : {}),
      ...(context.contextPlan ? { context: decisionContextEvidence(context.contextPlan,
        context.contextUsage ?? [], decisionBatchQuestionId(context.item.alias)) } : {}),
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
  if (request.calibrationCompatibility || request.ruleset.apiVersion === DECISION_API_VERSION_STRUCTURED || request.binding.apiVersion === DECISION_API_VERSION_STRUCTURED
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

function resultOnlyBatchObservations(observations: ReadonlyMap<string, AdapterObservation>): Map<string, AdapterObservation> {
  return new Map([...observations].map(([questionId, observation]) => {
    const { requestIdSource: _requestIdSource, ...withoutRequestIdSource } = observation;
    return [questionId, { ...withoutRequestIdSource,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: null }];
  }));
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
    ...(observation.providerPrefix ? { providerPrefix: observation.providerPrefix } : {}),
  };
}

function prepareContextPlan(
  request: DecisionEvaluationRequest,
  resolved: Array<{ alias: string; definition: DecisionDefinition; pin: ArtifactPin; input: unknown }>,
): ContextPlan | undefined {
  const runtime = request.context;
  if (!runtime) return undefined;
  const expectedIds = resolved.map(item => decisionBatchQuestionId(item.alias)).sort();
  const suppliedIds = runtime.input.questions.map(question => question.id).sort();
  if (!sameStringSet(expectedIds, suppliedIds)) {
    throw new ContextPlanError('invalid-input', 'context questions must exactly cover the resolved decision evaluations');
  }
  if (request.batching?.enabled) {
    for (const item of resolved) {
      const batching = request.batching.evaluations[item.alias];
      if (batching?.independent && batching.decisionSubject !== runtime.input.subject) {
        throw new ContextPlanError('invalid-input', `batch subject for '${item.alias}' differs from context subject`);
      }
    }
  }
  const plan = runtime.plan ?? planDecisionContext(runtime.input, runtime.profile, runtime.estimator);
  assertContextPlanCurrent(plan, runtime.input, runtime.profile, runtime.estimator);
  if (request.batchReceipts && request.batchReceipts.contextPlan.planDigest !== plan.planDigest) {
    throw new ContextPlanError('stale-plan', 'batch receipt context plan differs from runtime context plan');
  }
  return plan;
}

function contextPartitionedBatchPlans(
  plans: ReturnType<typeof planNativeDecisionBatches>,
  contextPlan: ContextPlan | undefined,
): ReturnType<typeof planNativeDecisionBatches> {
  if (!contextPlan) return plans;
  const split = [] as ReturnType<typeof planNativeDecisionBatches>;
  for (const partition of [...contextPlan.partitions].sort((left, right) => left.wave - right.wave || left.id.localeCompare(right.id))) {
    const permitted = new Set(partition.questionIds);
    for (const plan of plans) {
      if (plan.decisionSubject !== partition.subject) continue;
      const candidates = plan.candidates.filter(candidate => permitted.has(decisionBatchQuestionId(candidate.alias)));
      if (candidates.length > 1) split.push({ ...plan, candidates });
    }
  }
  return split;
}

function recordRuntimeContextUsage(
  plan: ContextPlan,
  questionId: string,
  actualInputTokens: number,
  evidence: ContextActualUsageEvidence[],
  scope: 'single' | 'partition' = 'single',
): void {
  const partition = plan.partitions.find(candidate => candidate.questionIds.includes(questionId));
  if (!partition) throw new ContextPlanError('invalid-input', `question '${questionId}' has no context partition`);
  const recorded = recordContextActualUsage(plan, partition.id, actualInputTokens,
    scope === 'single' ? questionId : undefined);
  const key = recorded.questionIds.join('\0');
  const index = evidence.findIndex(candidate => candidate.planDigest === plan.planDigest
    && candidate.partitionId === partition.id && candidate.questionIds.join('\0') === key);
  if (index < 0) evidence.push(recorded);
  else evidence[index] = recorded;
}

function decisionContextEvidence(
  plan: ContextPlan,
  actualUsage: readonly ContextActualUsageEvidence[],
  questionId?: string,
): DecisionContextEvidence {
  const partitionIds = questionId === undefined
    ? new Set(plan.partitions.map(partition => partition.id))
    : new Set(plan.partitions.filter(partition => partition.questionIds.includes(questionId)).map(partition => partition.id));
  return { plan: structuredClone(plan), actualUsage: structuredClone(actualUsage.filter(item => partitionIds.has(item.partitionId))) };
}

function withRulesetContext(result: RulesetResult, plan: ContextPlan, usage: readonly ContextActualUsageEvidence[]): RulesetResult {
  return { ...result, spec: { ...result.spec, context: decisionContextEvidence(plan, usage) } };
}

function contextUsageFromEvaluations(evaluations: Record<string, DecisionResult>): ContextActualUsageEvidence[] {
  const usage = new Map<string, ContextActualUsageEvidence>();
  for (const result of Object.values(evaluations)) {
    for (const item of result.spec.context?.actualUsage ?? []) {
      usage.set(`${item.planDigest}\0${item.partitionId}\0${item.questionIds.join('\0')}`, structuredClone(item));
    }
  }
  return [...usage.values()];
}

function durableBatchId(invocationId: string, groupId: string, partitionId: string): string {
  return `batch_${createHash('sha256').update(`${invocationId}\0${groupId}\0${partitionId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function durableAnswerId(batchId: string, questionId: string): string {
  return `answer_${createHash('sha256').update(`${batchId}\0${questionId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

function uniqueNonNull(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function providerCost(costUsd: number | null): BatchAttempt['cost'] | null {
  if (costUsd === null) return null;
  const amountMicros = Math.round(costUsd * 1_000_000);
  return Number.isSafeInteger(amountMicros) && amountMicros >= 0
    ? { kind: 'provider-authoritative', currency: 'USD', amountMicros }
    : null;
}

function uncertainBatchAttempt(plan: ReturnType<typeof planNativeDecisionBatches>[number], started: number, completed: number): BatchAttempt {
  const target = plan.candidates[0]!.target;
  return { ordinal: 1, adapterId: target.adapter, adapterVersion: target.adapterVersion,
    requestedModel: target.model, actualModel: null, providerRequestId: null, status: 'execution-uncertain',
    dispatchedAtEpochMs: started, completedAtEpochMs: completed,
    usage: { inputTokens: null, outputTokens: null }, cost: { kind: 'unknown' }, fallbackFromAttemptOrdinal: null };
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
      limit.maxQueueLength, limit.maxQueueWaitMs, limit.maxRequestBytes, limit.maxItems, limit.maxRetainedWork]) {
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
  if (error instanceof ContextPlanError) return 'invalid-input';
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
