import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';

export type ContextValue = null | boolean | number | string | ContextValue[] | { [key: string]: ContextValue };

export interface ContextTokenEstimate {
  tokens: number;
  serializedBytes: number;
}

/** Estimators are deliberately replaceable: provider tokenization is not a timeless fact. */
export interface ContextTokenEstimator {
  id: string;
  version: string;
  estimate(value: ContextValue): ContextTokenEstimate;
}

export interface ContextProviderProfile {
  id: string;
  version: string;
  estimator: { id: string; version: string };
  limits: {
    aggregateTokens: number;
    stateAndLongestQuestionTokens: number;
  };
  /** Reserve this portion of each documented limit; 2_000 means twenty percent. */
  safetyMarginBps: number;
  requestEnvelopeTokens: number;
}

export interface ContextQuestion {
  id: string;
  subject: string;
  entry: ContextValue;
  /** A question with dependencies is placed in a later execution wave. */
  dependsOn?: string[];
  /** Questions may share a request only when this key is identical. */
  compatibilityKey?: string;
}

export interface ContextPlanInput {
  subject: string;
  authorizedState: ContextValue;
  authorizationDigest: `sha256:${string}`;
  incompleteContext: boolean;
  questions: ContextQuestion[];
}

export interface ContextPartition {
  id: string;
  wave: number;
  compatibilityKey: string;
  subject: string;
  stateDigest: `sha256:${string}`;
  questionIds: string[];
  questionDigests: Record<string, `sha256:${string}`>;
  questionDependencies: Record<string, string[]>;
  estimate: {
    stateTokens: number;
    questionTokens: Record<string, number>;
    longestQuestionTokens: number;
    aggregateTokens: number;
    stateAndLongestQuestionTokens: number;
  };
  reason: 'fits-original-group' | 'aggregate-limit-partition' | 'dependency-wave';
}

export interface ContextPlan {
  schemaVersion: 'decision-context-plan/v1';
  planDigest: `sha256:${string}`;
  assumptionsDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  subject: string;
  authorizationDigest: `sha256:${string}`;
  incompleteContext: boolean;
  automaticActionAllowed: boolean;
  estimator: { id: string; version: string };
  providerProfile: { id: string; version: string; digest: `sha256:${string}` };
  limits: {
    documentedAggregateTokens: number;
    documentedStateAndLongestQuestionTokens: number;
    safetyMarginBps: number;
    effectiveAggregateTokens: number;
    effectiveStateAndLongestQuestionTokens: number;
  };
  rawEstimate: {
    stateTokens: number;
    allQuestionTokens: number;
    longestQuestionTokens: number;
    aggregateTokens: number;
    stateAndLongestQuestionTokens: number;
  };
  partitions: ContextPartition[];
}

export interface ContextActualUsageEvidence {
  schemaVersion: 'decision-context-usage/v1';
  planDigest: `sha256:${string}`;
  partitionId: string;
  /** Exact questions carried by this provider request. */
  questionIds: string[];
  estimator: { id: string; version: string };
  providerProfile: { id: string; version: string };
  estimatedInputTokens: number;
  actualInputTokens: number;
  estimationErrorTokens: number;
  estimationErrorBps: number | null;
}

export type ContextPlanFailureReason =
  | 'invalid-input' | 'invalid-profile' | 'estimator-profile-mismatch'
  | 'oversized-state' | 'oversized-question' | 'dependency-error' | 'stale-plan';

export class ContextPlanError extends Error {
  constructor(readonly reason: ContextPlanFailureReason, message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ContextPlanError';
  }
}

/** Conservative, deterministic fallback; it does not claim vendor-tokenizer equivalence. */
export class CanonicalJsonByteEstimator implements ContextTokenEstimator {
  readonly id = 'canonical-json-utf8-ceil';
  constructor(readonly version = '1.0.0', private readonly bytesPerToken = 3) {
    if (!Number.isInteger(bytesPerToken) || bytesPerToken < 1) {
      throw new ContextPlanError('invalid-profile', 'bytesPerToken must be a positive integer');
    }
  }

  estimate(value: ContextValue): ContextTokenEstimate {
    const serializedBytes = Buffer.byteLength(canonicalJson(value), 'utf8');
    return { serializedBytes, tokens: Math.ceil(serializedBytes / this.bytesPerToken) };
  }
}

export function planDecisionContext(
  input: ContextPlanInput,
  profile: ContextProviderProfile,
  estimator: ContextTokenEstimator,
): ContextPlan {
  validate(input, profile, estimator);
  const effectiveAggregateTokens = effectiveLimit(profile.limits.aggregateTokens, profile.safetyMarginBps);
  const effectiveLongestTokens = effectiveLimit(profile.limits.stateAndLongestQuestionTokens, profile.safetyMarginBps);
  const state = checkedEstimate(estimator, input.authorizedState);
  if (state.tokens + profile.requestEnvelopeTokens > effectiveAggregateTokens
    || state.tokens + profile.requestEnvelopeTokens > effectiveLongestTokens) {
    throw new ContextPlanError('oversized-state', 'authorized state cannot fit the effective provider limits', {
      stateTokens: state.tokens, requestEnvelopeTokens: profile.requestEnvelopeTokens,
      effectiveAggregateTokens, effectiveStateAndLongestQuestionTokens: effectiveLongestTokens,
    });
  }

  const sorted = [...input.questions].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const estimates = new Map(sorted.map(question => [question.id, checkedEstimate(estimator, question.entry)]));
  for (const question of sorted) {
    const tokens = estimates.get(question.id)!.tokens;
    if (state.tokens + tokens + profile.requestEnvelopeTokens > effectiveLongestTokens
      || state.tokens + tokens + profile.requestEnvelopeTokens > effectiveAggregateTokens) {
      throw new ContextPlanError('oversized-question', `question '${question.id}' cannot fit with the authorized state`, {
        questionId: question.id, questionTokens: tokens, stateTokens: state.tokens,
        effectiveAggregateTokens, effectiveStateAndLongestQuestionTokens: effectiveLongestTokens,
      });
    }
  }

  const waves = dependencyWaves(sorted);
  const allQuestionTokens = sorted.reduce((sum, question) => sum + estimates.get(question.id)!.tokens, 0);
  const longestQuestionTokens = sorted.reduce((max, question) => Math.max(max, estimates.get(question.id)!.tokens), 0);
  const rawAggregate = state.tokens + allQuestionTokens + profile.requestEnvelopeTokens;
  const rawLongest = state.tokens + longestQuestionTokens + profile.requestEnvelopeTokens;
  const stateDigest = digest(input.authorizedState);
  const partitions: ContextPartition[] = [];

  for (const [wave, waveQuestions] of waves.entries()) {
    const groups = new Map<string, ContextQuestion[]>();
    for (const question of waveQuestions) {
      const key = question.compatibilityKey ?? 'default';
      const group = groups.get(key) ?? [];
      group.push(question);
      groups.set(key, group);
    }
    for (const key of [...groups.keys()].sort()) {
      const pending = groups.get(key)!;
      let current: ContextQuestion[] = [];
      let currentTokens = state.tokens + profile.requestEnvelopeTokens;
      const flush = (): void => {
        if (!current.length) return;
        const questionTokens = Object.fromEntries(current.map(question => [question.id, estimates.get(question.id)!.tokens]));
        const aggregateTokens = state.tokens + profile.requestEnvelopeTokens
          + Object.values(questionTokens).reduce((sum, tokens) => sum + tokens, 0);
        const partitionLongest = Math.max(...Object.values(questionTokens));
        const split = pending.length !== current.length;
        const reason = wave > 0 ? 'dependency-wave' : split ? 'aggregate-limit-partition' : 'fits-original-group';
        const questionIds = current.map(question => question.id);
        partitions.push({
          id: `ctx-w${wave}-${key.replace(/[^A-Za-z0-9_.-]/g, '_')}-${String(partitions.length + 1).padStart(4, '0')}`,
          wave, compatibilityKey: key, subject: input.subject, stateDigest, questionIds,
          questionDigests: Object.fromEntries(current.map(question => [question.id, digest(question.entry)])),
          questionDependencies: Object.fromEntries(current.map(question => [
            question.id, [...new Set(question.dependsOn ?? [])].sort(),
          ])),
          estimate: { stateTokens: state.tokens, questionTokens, longestQuestionTokens: partitionLongest,
            aggregateTokens, stateAndLongestQuestionTokens: state.tokens + profile.requestEnvelopeTokens + partitionLongest },
          reason,
        });
        current = [];
        currentTokens = state.tokens + profile.requestEnvelopeTokens;
      };
      for (const question of pending) {
        const tokens = estimates.get(question.id)!.tokens;
        if (current.length && currentTokens + tokens > effectiveAggregateTokens) flush();
        current.push(question);
        currentTokens += tokens;
      }
      flush();
    }
  }

  const profileDigest = digest(profile as unknown as ContextValue);
  const inputDigest = digest({ ...input, questions: sorted.map(question => question.dependsOn
    ? { ...question, dependsOn: [...new Set(question.dependsOn)].sort() }
    : { ...question }) } as unknown as ContextValue);
  const assumptionsDigest = digest({ profileDigest, estimator: { id: estimator.id, version: estimator.version } });
  const withoutDigest = {
    schemaVersion: 'decision-context-plan/v1' as const, assumptionsDigest, inputDigest,
    subject: input.subject, authorizationDigest: input.authorizationDigest,
    incompleteContext: input.incompleteContext, automaticActionAllowed: !input.incompleteContext,
    estimator: { id: estimator.id, version: estimator.version },
    providerProfile: { id: profile.id, version: profile.version, digest: profileDigest },
    limits: { documentedAggregateTokens: profile.limits.aggregateTokens,
      documentedStateAndLongestQuestionTokens: profile.limits.stateAndLongestQuestionTokens,
      safetyMarginBps: profile.safetyMarginBps, effectiveAggregateTokens,
      effectiveStateAndLongestQuestionTokens: effectiveLongestTokens },
    rawEstimate: { stateTokens: state.tokens, allQuestionTokens, longestQuestionTokens,
      aggregateTokens: rawAggregate, stateAndLongestQuestionTokens: rawLongest },
    partitions,
  };
  return { ...withoutDigest, planDigest: digest(withoutDigest as unknown as ContextValue) };
}

/** Replanning is intentional: a changed profile, estimator or authorized input invalidates the old plan. */
export function assertContextPlanCurrent(
  plan: ContextPlan,
  input: ContextPlanInput,
  profile: ContextProviderProfile,
  estimator: ContextTokenEstimator,
): void {
  const current = planDecisionContext(input, profile, estimator);
  if (current.planDigest !== plan.planDigest) {
    throw new ContextPlanError('stale-plan', 'context plan assumptions or authorized input changed', {
      plannedDigest: plan.planDigest, currentDigest: current.planDigest,
    });
  }
}

/** Provider usage augments evidence and never mutates or recomputes the original plan. */
export function recordContextActualUsage(
  plan: ContextPlan,
  partitionId: string,
  actualInputTokens: number,
  questionId?: string | readonly string[],
): ContextActualUsageEvidence {
  const partition = plan.partitions.find(candidate => candidate.id === partitionId);
  if (!partition) throw new ContextPlanError('invalid-input', `unknown context partition '${partitionId}'`);
  if (!Number.isSafeInteger(actualInputTokens) || actualInputTokens < 0) {
    throw new ContextPlanError('invalid-input', 'actualInputTokens must be a non-negative safe integer');
  }
  const questionIds = questionId === undefined ? [...partition.questionIds]
    : typeof questionId === 'string' ? [questionId] : [...questionId];
  if (!questionIds.length || new Set(questionIds).size !== questionIds.length
    || questionIds.some(id => !partition.questionIds.includes(id))) {
    throw new ContextPlanError('invalid-input', 'usage questions must be unique members of the context partition');
  }
  questionIds.sort();
  const selected = new Set(questionIds);
  const estimatedInputTokens = partition.estimate.aggregateTokens
    - Object.entries(partition.estimate.questionTokens)
      .filter(([id]) => !selected.has(id))
      .reduce((sum, [, tokens]) => sum + tokens, 0);
  const estimationErrorTokens = actualInputTokens - estimatedInputTokens;
  return {
    schemaVersion: 'decision-context-usage/v1', planDigest: plan.planDigest, partitionId, questionIds,
    estimator: { ...plan.estimator }, providerProfile: { id: plan.providerProfile.id, version: plan.providerProfile.version },
    estimatedInputTokens, actualInputTokens, estimationErrorTokens,
    estimationErrorBps: actualInputTokens === 0 ? null : Math.round(estimationErrorTokens * 10_000 / actualInputTokens),
  };
}

function validate(input: ContextPlanInput, profile: ContextProviderProfile, estimator: ContextTokenEstimator): void {
  if (!input.subject || !input.questions.length || !/^sha256:[0-9a-f]{64}$/.test(input.authorizationDigest)) {
    throw new ContextPlanError('invalid-input', 'subject, questions, and a SHA-256 authorization digest are required');
  }
  if (!profile.id || !profile.version || !profile.estimator.id || !profile.estimator.version
    || !Number.isSafeInteger(profile.limits.aggregateTokens) || profile.limits.aggregateTokens <= 0
    || !Number.isSafeInteger(profile.limits.stateAndLongestQuestionTokens) || profile.limits.stateAndLongestQuestionTokens <= 0
    || !Number.isSafeInteger(profile.requestEnvelopeTokens) || profile.requestEnvelopeTokens < 0
    || !Number.isInteger(profile.safetyMarginBps) || profile.safetyMarginBps < 0 || profile.safetyMarginBps >= 10_000) {
    throw new ContextPlanError('invalid-profile', 'provider context profile is incomplete or has invalid limits');
  }
  if (profile.estimator.id !== estimator.id || profile.estimator.version !== estimator.version) {
    throw new ContextPlanError('estimator-profile-mismatch', 'provider profile was qualified with another estimator version');
  }
  const ids = new Set<string>();
  for (const question of input.questions) {
    if (!question.id || question.subject !== input.subject || ids.has(question.id)) {
      throw new ContextPlanError('invalid-input', 'question IDs must be unique and every question must preserve the plan subject');
    }
    ids.add(question.id);
  }
}

function dependencyWaves(questions: ContextQuestion[]): ContextQuestion[][] {
  const byId = new Map(questions.map(question => [question.id, question]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new ContextPlanError('dependency-error', `question dependency cycle includes '${id}'`);
    visiting.add(id);
    const question = byId.get(id)!;
    let value = 0;
    for (const dependency of [...new Set(question.dependsOn ?? [])].sort()) {
      if (!byId.has(dependency)) throw new ContextPlanError('dependency-error', `question '${id}' has unknown dependency '${dependency}'`);
      if (dependency === id) throw new ContextPlanError('dependency-error', `question '${id}' depends on itself`);
      value = Math.max(value, depth(dependency) + 1);
    }
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  for (const question of questions) depth(question.id);
  const waves: ContextQuestion[][] = [];
  for (const question of questions) (waves[depth(question.id)] ??= []).push(question);
  return waves;
}

function checkedEstimate(estimator: ContextTokenEstimator, value: ContextValue): ContextTokenEstimate {
  const result = estimator.estimate(value);
  if (!result || !Number.isSafeInteger(result.tokens) || result.tokens < 0
    || !Number.isSafeInteger(result.serializedBytes) || result.serializedBytes < 0) {
    throw new ContextPlanError('invalid-profile', 'estimator returned invalid token or byte counts');
  }
  return result;
}

function effectiveLimit(limit: number, marginBps: number): number {
  return Math.floor(limit * (10_000 - marginBps) / 10_000);
}

function digest(value: ContextValue): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
