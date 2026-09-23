import { randomUUID } from 'node:crypto';
import { digestCachedResult, digestResultCacheIdentity } from './key.js';
import { entryIntegrityDigest } from './integrity.js';
import type { CachedResultEvidence, ResultCacheActor, ResultCacheEntry, ResultCacheFill, ResultCacheOutcome, ResultCachePolicy, ResultCacheSemanticIdentity, ResultCacheStore, ResultCacheTelemetry } from './types.js';

export interface ResultCacheRequest {
  actor: ResultCacheActor; policy: ResultCachePolicy; identity: ResultCacheSemanticIdentity;
  callerInvocationId: string; nowEpochMs?: number; operationId?: string;
}
export type ResultCacheTelemetrySink = (event: ResultCacheTelemetry) => void;

export class DecisionResultCache {
  private readonly flights = new Map<string, Promise<{ evidence: CachedResultEvidence; entry: ResultCacheEntry | null }>>();
  constructor(private readonly store: ResultCacheStore, private readonly telemetry: ResultCacheTelemetrySink = () => {}) {}

  async evaluate(request: ResultCacheRequest, fill: ResultCacheFill): Promise<ResultCacheOutcome> {
    const now = request.nowEpochMs ?? Date.now(); const operationId = request.operationId ?? randomUUID();
    if (!cacheable(request.policy)) return this.bypass(request, fill, now, operationId, 'policy-disabled');
    if (!modelReusable(request.identity, now)) return this.bypass(request, fill, now, operationId, 'model-compatibility-unproven');
    const key = digestResultCacheIdentity(request.identity); const existing = await this.store.read(request.actor, key);
    if (existing && reusable(existing, request, now)) {
      this.emit({ event: 'hit', operationId, reason: 'fresh-compatible-entry', saved: savings(existing.evidence) });
      return { evidence: structuredClone(existing.evidence), receipt: receipt('cache-hit', request.callerInvocationId, existing, existing.evidence, now, false) };
    }
    if (existing) { this.emit({ event: 'stale', operationId, reason: 'expired-or-policy-incompatible' }); await this.store.invalidate(request.actor, key, existing.entryId); }
    else this.emit({ event: 'miss', operationId, reason: 'no-entry' });
    // A flight must never cross an authorization or freshness-policy boundary.
    const flightKey = JSON.stringify([request.actor.tenantId, request.actor.projectId,
      request.actor.workspaceId, request.actor.subjectId, [...request.actor.permissions].sort(),
      key, request.policy.policyVersion, request.policy.sensitivity, request.policy.ttlMs,
      request.policy.negative]);
    const pending = this.flights.get(flightKey);
    if (pending) { this.emit({ event: 'single-flight', operationId, reason: 'joined' }); const completed = await pending; return { evidence: structuredClone(completed.evidence), receipt: receipt(completed.entry ? 'cache-hit' : 'cache-miss-fill', request.callerInvocationId, completed.entry, completed.evidence, now, false) }; }
    const promise = (async (): Promise<{ evidence: CachedResultEvidence; entry: ResultCacheEntry | null }> => {
      const evidence = await fill();
      const ttl = cacheableEvidence(evidence, request.policy) && modelEvidenceApproved(request.identity, evidence) ? (evidence.status === 'success' ? request.policy.ttlMs : request.policy.negative!.ttlMs) : 0;
      if (ttl <= 0) return { evidence, entry: null };
      const unsigned: Omit<ResultCacheEntry, 'integrityDigest'> = { schemaVersion: 'decision-result-cache/v1', revision: 1, entryId: randomUUID(), scope: { tenantId: request.actor.tenantId, projectId: request.actor.projectId, workspaceId: request.actor.workspaceId }, keyDigest: key, identityDigest: key, policyVersion: request.policy.policyVersion, sensitivity: request.policy.sensitivity, createdAtEpochMs: now, expiresAtEpochMs: now + ttl, evidence: { ...evidence, resultDigest: digestCachedResult(evidence.result) } };
      const entry = await this.store.putIfAbsent(request.actor, { ...unsigned, integrityDigest: entryIntegrityDigest(unsigned) });
      return { evidence: entry.evidence, entry };
    })();
    this.flights.set(flightKey, promise);
    try {
      const completed = await promise;
      return { evidence: structuredClone(completed.evidence), receipt: receipt('cache-miss-fill', request.callerInvocationId, completed.entry, completed.evidence, now, true) };
    } finally { this.flights.delete(flightKey); }
  }
  private async bypass(request: ResultCacheRequest, fill: ResultCacheFill, now: number, operationId: string, reason: string): Promise<ResultCacheOutcome> { this.emit({ event: 'bypass', operationId, reason }); const evidence = await fill(); return { evidence, receipt: receipt('bypass', request.callerInvocationId, null, evidence, now, true) }; }
  private emit(event: ResultCacheTelemetry): void { this.telemetry(event); }
}

function cacheable(policy: ResultCachePolicy): boolean { return policy.enabled && policy.sideEffectFree && policy.ttlMs > 0 && policy.scope === 'workspace' && policy.policyVersion.length > 0; }
function modelReusable(identity: ResultCacheSemanticIdentity, now: number): boolean { const p = identity.modelCompatibility; return p.mode === 'pinned' ? p.actualModel === identity.requestedModel : p.validUntilEpochMs > now && p.approvedActualModels.length > 0; }
function modelEvidenceApproved(identity: ResultCacheSemanticIdentity, evidence: CachedResultEvidence): boolean { const p = identity.modelCompatibility; return p.mode === 'pinned' ? evidence.actualModel === p.actualModel : p.approvedActualModels.includes(evidence.actualModel); }
function reusable(entry: ResultCacheEntry, request: ResultCacheRequest, now: number): boolean { return entry.expiresAtEpochMs > now && entry.policyVersion === request.policy.policyVersion && entry.sensitivity === request.policy.sensitivity && entry.identityDigest === digestResultCacheIdentity(request.identity) && modelEvidenceApproved(request.identity, entry.evidence); }
function cacheableEvidence(e: CachedResultEvidence, policy: ResultCachePolicy): boolean { return e.status === 'success' ? e.failureReason === 'none' : Boolean(policy.negative?.enabled && policy.negative.reasons.includes('invalid-input') && e.failureReason === 'invalid-input'); }
function savings(e: CachedResultEvidence): NonNullable<ResultCacheTelemetry['saved']> {
  return { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens,
    costUsd: e.usage.costUsd, latencyMs: e.durationMs, estimated: true };
}
function receipt(disposition: ResultCacheOutcome['receipt']['disposition'], caller: string, entry: ResultCacheEntry | null, evidence: CachedResultEvidence, now: number, providerAttempted: boolean): ResultCacheOutcome['receipt'] { return { disposition, callerInvocationId: caller, sourceInvocationId: evidence.sourceInvocationId, sourceReceiptId: evidence.sourceReceiptId, originalEvaluatedAtEpochMs: evidence.evaluatedAtEpochMs, cacheEntryId: entry?.entryId ?? null, createdAtEpochMs: now, providerAttempted }; }
