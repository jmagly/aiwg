import { createHash } from 'node:crypto';
import { applyPrimitiveAcceptance } from './acceptance.js';
import type { AdapterObservation, DecisionAcceptanceEvidence, DecisionDefinition, PrimitiveAcceptancePolicy } from './types.js';

export type AcceptanceRolloutDigest = `sha256:${string}`;

export interface StoredAcceptanceEvidence {
  id: string;
  definition: DecisionDefinition;
  observation: AdapterObservation;
}

export interface AcceptancePolicyIdentity {
  id: string;
  version: string;
  digest: AcceptanceRolloutDigest;
}

export interface AcceptanceShadowRecord {
  schemaVersion: 'decision-acceptance-shadow/v1';
  rolloutId: string;
  useCaseId: string;
  incumbent: AcceptancePolicyIdentity;
  candidate: AcceptancePolicyIdentity;
  evidence: Array<{
    id: string;
    storedObservationDigest: AcceptanceRolloutDigest;
    incumbentAcceptance: DecisionAcceptanceEvidence;
    candidateAcceptance: DecisionAcceptanceEvidence;
  }>;
  summary: { total: number; changed: number; candidateActionCount: number };
  /** Shadow evaluation is evidence-only. It never authorizes an action. */
  actionAuthorization: 'not-authorized';
  recordedAt: string;
  digest: AcceptanceRolloutDigest;
}

export interface AcceptancePromotionRecord {
  schemaVersion: 'decision-acceptance-promotion/v1';
  promotionId: string;
  useCaseId: string;
  from: AcceptancePolicyIdentity;
  to: AcceptancePolicyIdentity;
  rollback: AcceptancePolicyIdentity;
  shadowRecordDigest: AcceptanceRolloutDigest;
  qualificationManifest: { path: string; digest: AcceptanceRolloutDigest };
  approvalReference: string;
  promotedAt: string;
  digest: AcceptanceRolloutDigest;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): AcceptanceRolloutDigest {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function required(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function timestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid date-time`);
}

export function acceptancePolicyIdentity(id: string, policy: PrimitiveAcceptancePolicy): AcceptancePolicyIdentity {
  required(id, 'policy id');
  return { id, version: policy.version, digest: digest(policy) };
}

/**
 * Replays two immutable policy versions over already-stored observations. This
 * function has no adapter, credential, executor, or action callback by design.
 */
export function replayAcceptancePolicyShadow(input: {
  rolloutId: string;
  useCaseId: string;
  incumbent: { id: string; policy: PrimitiveAcceptancePolicy };
  candidate: { id: string; policy: PrimitiveAcceptancePolicy };
  evidence: readonly StoredAcceptanceEvidence[];
  recordedAt: string;
}): AcceptanceShadowRecord {
  required(input.rolloutId, 'rollout id');
  required(input.useCaseId, 'use case id');
  timestamp(input.recordedAt, 'recordedAt');
  if (!input.evidence.length) throw new Error('shadow rollout requires stored evidence');
  const ids = new Set<string>();
  const evidence = input.evidence.map(item => {
    required(item.id, 'stored evidence id');
    if (ids.has(item.id)) throw new Error(`duplicate stored evidence id '${item.id}'`);
    ids.add(item.id);
    const before = structuredClone(item);
    const incumbent = applyPrimitiveAcceptance(item.definition, input.incumbent.policy, item.observation);
    const candidate = applyPrimitiveAcceptance(item.definition, input.candidate.policy, item.observation);
    if (canonical(item) !== canonical(before)) throw new Error(`shadow replay mutated stored evidence '${item.id}'`);
    if (!incumbent.acceptance || !candidate.acceptance) throw new Error(`shadow replay produced no acceptance evidence for '${item.id}'`);
    return {
      id: item.id,
      storedObservationDigest: digest({ definition: item.definition, observation: item.observation }),
      incumbentAcceptance: incumbent.acceptance,
      candidateAcceptance: candidate.acceptance,
    };
  });
  const withoutDigest: Omit<AcceptanceShadowRecord, 'digest'> = {
    schemaVersion: 'decision-acceptance-shadow/v1', rolloutId: input.rolloutId, useCaseId: input.useCaseId,
    incumbent: acceptancePolicyIdentity(input.incumbent.id, input.incumbent.policy),
    candidate: acceptancePolicyIdentity(input.candidate.id, input.candidate.policy),
    evidence,
    summary: {
      total: evidence.length,
      changed: evidence.filter(item => item.incumbentAcceptance.disposition !== item.candidateAcceptance.disposition).length,
      candidateActionCount: evidence.filter(item => item.candidateAcceptance.disposition === 'act').length,
    },
    actionAuthorization: 'not-authorized', recordedAt: input.recordedAt,
  };
  return structuredClone({ ...withoutDigest, digest: digest(withoutDigest) });
}

/** Records an explicitly approved, use-case-scoped pin change with an exact rollback target. */
export function createAcceptancePromotionRecord(input: {
  promotionId: string;
  useCaseId: string;
  shadow: AcceptanceShadowRecord;
  qualificationManifest: { path: string; digest: AcceptanceRolloutDigest };
  approvalReference: string;
  promotedAt: string;
}): AcceptancePromotionRecord {
  required(input.promotionId, 'promotion id');
  required(input.useCaseId, 'use case id');
  required(input.approvalReference, 'approval reference');
  required(input.qualificationManifest.path, 'qualification manifest path');
  timestamp(input.promotedAt, 'promotedAt');
  if (input.shadow.useCaseId !== input.useCaseId) throw new Error('shadow evidence belongs to a different use case');
  const { digest: claimedShadowDigest, ...shadowPayload } = input.shadow;
  if (digest(shadowPayload) !== claimedShadowDigest) throw new Error('shadow record digest mismatch');
  const withoutDigest: Omit<AcceptancePromotionRecord, 'digest'> = {
    schemaVersion: 'decision-acceptance-promotion/v1', promotionId: input.promotionId,
    useCaseId: input.useCaseId, from: input.shadow.incumbent, to: input.shadow.candidate,
    rollback: input.shadow.incumbent, shadowRecordDigest: input.shadow.digest,
    qualificationManifest: structuredClone(input.qualificationManifest),
    approvalReference: input.approvalReference, promotedAt: input.promotedAt,
  };
  return structuredClone({ ...withoutDigest, digest: digest(withoutDigest) });
}
