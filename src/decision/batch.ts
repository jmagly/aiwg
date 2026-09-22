import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import type {
  AdapterCapabilities,
  DecisionAdapter,
  DecisionBatchPolicy,
  DecisionDefinition,
  ExecutionTarget,
} from './types.js';

export interface BatchCandidate {
  alias: string;
  definition: DecisionDefinition;
  input: unknown;
  target: ExecutionTarget;
  adapter: DecisionAdapter;
  capabilities: AdapterCapabilities;
}

export interface NativeBatchPlan {
  groupId: string;
  decisionSubject: string;
  stage: number;
  candidates: BatchCandidate[];
}

/** Stable, opaque, declaration-order-independent provider question identity. */
export function decisionBatchQuestionId(alias: string): string {
  return `q_${createHash('sha256').update(alias, 'utf8').digest('hex').slice(0, 24)}`;
}

export function planNativeDecisionBatches(
  candidates: readonly BatchCandidate[],
  policy: DecisionBatchPolicy | undefined,
): NativeBatchPlan[] {
  if (!policy?.enabled) return [];
  const groups = new Map<string, BatchCandidate[]>();
  for (const candidate of candidates) {
    const rule = policy.evaluations[candidate.alias];
    const batch = candidate.capabilities.batch;
    if (!rule?.independent || !rule.decisionSubject || !rule.egressPolicy || !rule.hostPolicy || !batch?.native
      || !candidate.adapter.evaluateMany) continue;
    const stage = rule.stage ?? 0;
    const key = canonicalJson({
      decisionSubject: rule.decisionSubject,
      state: candidate.input,
      stage,
      egressPolicy: rule.egressPolicy,
      hostPolicy: rule.hostPolicy,
      adapter: candidate.adapter.id,
      adapterVersion: candidate.adapter.version,
      executionEnvelope: batch.executionEnvelope,
      target: {
        adapter: candidate.target.adapter,
        adapterVersion: candidate.target.adapterVersion,
        model: candidate.target.model,
        credentialRef: candidate.target.credentialRef ?? null,
        subagent: candidate.target.subagent ?? null,
        timeoutMs: candidate.target.timeoutMs,
        retry: candidate.target.retry,
      },
    });
    const values = groups.get(key) ?? [];
    values.push(candidate);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([key, values]) => ({
      groupId: `batch_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24)}`,
      decisionSubject: policy.evaluations[values[0]!.alias]!.decisionSubject,
      stage: policy.evaluations[values[0]!.alias]!.stage ?? 0,
      // Candidate iteration follows ruleset declaration order; response order never does.
      candidates: [...values],
    }))
    .sort((left, right) => left.stage - right.stage || left.groupId.localeCompare(right.groupId));
}

export function correlateAtomicBatch<T>(
  requestedIds: readonly string[],
  returned: readonly { questionId: string; value: T }[],
): Map<string, T> {
  const requested = new Set(requestedIds);
  if (requested.size !== requestedIds.length || returned.length !== requestedIds.length) {
    throw new Error('batch response cardinality mismatch');
  }
  const correlated = new Map<string, T>();
  for (const answer of returned) {
    if (!requested.has(answer.questionId) || correlated.has(answer.questionId)) {
      throw new Error('batch response identity mismatch');
    }
    correlated.set(answer.questionId, answer.value);
  }
  if (correlated.size !== requested.size) throw new Error('batch response identity mismatch');
  return correlated;
}
