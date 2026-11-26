import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import type { DecisionResult, ArtifactPin } from '../decision/types.js';

/** Experimental D27 shadow route. Never installs, invokes, or authorizes a capability. */
export interface DiscoveryCandidate {
  id: string; name: string; type: string; capability: string; score: number;
}
export interface DiscoveryAmbiguityPolicy {
  version: 'discovery-ambiguity/v1';
  minimumScore: number;
  /** A margin equal to this threshold bypasses inference. */
  minimumMargin: number;
  maximumCandidates: number;
  maximumTextBytes: number;
}
export type DiscoveryRouteReason = 'disabled' | 'exact-name' | 'high-margin' | 'no-candidates'
  | 'low-score' | 'low-margin' | 'cross-type' | 'invalid-input' | 'circuit-open';
export interface DiscoveryAmbiguity {
  version: DiscoveryAmbiguityPolicy['version'];
  eligible: boolean;
  reason: DiscoveryRouteReason;
}
const finite = (n: number) => Number.isFinite(n) && n >= 0;
function validatePolicy(policy: DiscoveryAmbiguityPolicy): void {
  if (policy.version !== 'discovery-ambiguity/v1' || !finite(policy.minimumScore)
    || !Number.isFinite(policy.minimumMargin) || policy.minimumMargin <= 0
    || !Number.isSafeInteger(policy.maximumCandidates) || policy.maximumCandidates < 1 || policy.maximumCandidates > 100
    || !Number.isSafeInteger(policy.maximumTextBytes) || policy.maximumTextBytes < 1 || policy.maximumTextBytes > 1_000_000) {
    throw new Error('Invalid discovery ambiguity policy');
  }
}
/** Retrieval order is authoritative, including ties; this function never sorts it. */
export function discoveryAmbiguity(query: string, candidates: readonly DiscoveryCandidate[], policy: DiscoveryAmbiguityPolicy): DiscoveryAmbiguity {
  validatePolicy(policy);
  const answer = (reason: DiscoveryRouteReason, eligible = false): DiscoveryAmbiguity => ({ version: policy.version, eligible, reason });
  if (typeof query !== 'string' || !query.trim() || !Array.isArray(candidates)
    || candidates.some(c => !c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string'
      || typeof c.type !== 'string' || typeof c.capability !== 'string' || !finite(c.score))
    || new Set(candidates.map(c => c.id)).size !== candidates.length
    || candidates.some((c, i) => i > 0 && c.score > candidates[i - 1]!.score)
    || Buffer.byteLength(query + candidates.map(c => c.name + c.type + c.capability + c.id).join('')) > policy.maximumTextBytes) {
    return answer('invalid-input');
  }
  if (!candidates.length) return answer('no-candidates');
  const normalized = query.trim().toLowerCase();
  if (candidates.some(c => c.name.trim().toLowerCase() === normalized || c.id.toLowerCase() === normalized)) return answer('exact-name');
  const first = candidates[0]!;
  if (first.score < policy.minimumScore) return answer('low-score', true);
  const margin = first.score - (candidates[1]?.score ?? 0);
  if (margin >= policy.minimumMargin) return answer('high-margin');
  return answer(candidates[1] && first.type !== candidates[1].type ? 'cross-type' : 'low-margin', true);
}

export interface DiscoveryShadowPolicy {
  mode: 'disabled' | 'shadow';
  ambiguity: DiscoveryAmbiguityPolicy;
  definition: ArtifactPin;
  binding: ArtifactPin;
  allowedModels: readonly string[];
  uncertaintyProfile: string;
  calibrationDigest: string;
  minimumProbability: number;
  minimumMargin: number;
  maximumLatencyMs: number;
  maximumTokens: number;
  maximumCostUsd: number;
}
export interface DiscoveryShadowRequest {
  query: string;
  /** Opaque choices prevent candidate text or IDs from becoming control fields. */
  candidates: ReadonlyArray<{ option: string; id: string; name: string; type: string; capability: string }>;
  options: readonly string[];
  definition: ArtifactPin;
  binding: ArtifactPin;
  signal: AbortSignal;
}
export interface DiscoveryShadowHost {
  /** Trusted host performs D10 projection/egress/admission BEFORE resolver/transport access.
   * Return only a normalized result backed by a durable receipt. No raw response here. */
  evaluate(request: DiscoveryShadowRequest): Promise<{ result: DecisionResult; receiptDigest: string }>;
  /** Explicit trusted-host authorization of the query and bounded candidate projection. */
  authorize(request: Omit<DiscoveryShadowRequest, 'signal'>): boolean;
  /** Store the complete result only under the host's normal D10 scope/lifecycle policy. */
  record(receipt: DiscoveryShadowReceipt): void;
  /** Trusted monitoring verdict; retrieval/model content cannot supply health. */
  health?: () => { drift: boolean; quality: boolean; latency: boolean; cost: boolean };
  clock?: () => number;
}
export interface DiscoveryShadowReceipt {
  schemaVersion: 'discovery-shadow/v1';
  route: 'deterministic-only' | 'shadow';
  reason: DiscoveryRouteReason | 'privacy-denied' | 'evaluation-failed' | 'rejected-evidence' | 'budget-breach' | 'accepted-shadow';
  ambiguityReason: DiscoveryRouteReason;
  /** Digests only: no query, names, capability descriptions, private paths or raw result. */
  candidatesDigest: string;
  policyDigest: string;
  selection: { kind: 'none' } | { kind: 'candidate'; ordinal: number } | null;
  resultDigest: string | null;
  servedModel: string | null;
  latencyMs: number;
  usage: { tokens: number | null; costUsd: number | null };
}
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const samePin = (a: ArtifactPin, b: ArtifactPin): boolean => canonicalJson(a) === canonicalJson(b);

/** One host-owned circuit per workload. Drift/quality controls can trip it without changing
 * any index or active decision pins. Re-enabling requires a newly constructed route. */
export class DiscoveryShadowRoute {
  private readonly policy: DiscoveryShadowPolicy;
  private stopped = false;
  private readonly active = new Set<AbortController>();
  constructor(policy: DiscoveryShadowPolicy, private readonly host: DiscoveryShadowHost) {
    validatePolicy(policy.ambiguity);
    if (!['disabled', 'shadow'].includes(policy.mode) || !policy.allowedModels.length
      || !policy.uncertaintyProfile || !/^sha256:[0-9a-f]{64}$/.test(policy.calibrationDigest)
      || ![policy.minimumProbability, policy.minimumMargin].every(n => finite(n) && n <= 1)
      || !Number.isSafeInteger(policy.maximumLatencyMs) || policy.maximumLatencyMs < 1
      || !Number.isSafeInteger(policy.maximumTokens) || policy.maximumTokens < 1
      || !finite(policy.maximumCostUsd)
      || ![policy.definition, policy.binding].every(pin => pin && typeof pin.id === 'string' && pin.id.length > 0
        && typeof pin.version === 'string' && pin.version.length > 0 && /^sha256:[0-9a-f]{64}$/.test(pin.digest))
      || policy.allowedModels.some(model => typeof model !== 'string' || !model)) throw new Error('Invalid discovery shadow policy');
    this.policy = structuredClone(policy);
  }
  disable(): void { this.stopped = true; for (const controller of this.active) controller.abort(); }
  get disabled(): boolean { return this.stopped || this.policy.mode === 'disabled'; }

  /** Return metadata via the governed sink. Caller results always retain baseline order. */
  async observe(query: string, baseline: readonly DiscoveryCandidate[]): Promise<void> {
    const p = this.policy;
    if (!this.disabled && this.host.health) {
      try {
        const health = this.host.health();
        if (!health || ['drift', 'quality', 'latency', 'cost'].some(key => health[key as keyof typeof health] !== false)) this.disable();
      } catch { this.disable(); }
    }
    const gate = discoveryAmbiguity(query, baseline, p.ambiguity);
    const selected = gate.reason === 'invalid-input' ? [] : baseline.slice(0, p.ambiguity.maximumCandidates);
    const projection = {
      query,
      candidates: selected.map((c, i) => ({ option: `candidate_${i}`, id: c.id, name: c.name, type: c.type, capability: c.capability })),
      options: [...selected.map((_, i) => `candidate_${i}`), 'none'],
      definition: structuredClone(p.definition), binding: structuredClone(p.binding),
    };
    const receipt: DiscoveryShadowReceipt = {
      schemaVersion: 'discovery-shadow/v1', route: 'deterministic-only', reason: 'privacy-denied',
      ambiguityReason: gate.reason, candidatesDigest: digest(selected.map(c => c.id)), policyDigest: digest(p),
      selection: null, resultDigest: null, servedModel: null, latencyMs: 0, usage: { tokens: null, costUsd: null },
    };
    const record = () => { try { this.host.record(structuredClone(receipt)); } catch { this.disable(); } };
    if (this.disabled || !gate.eligible) {
      receipt.reason = this.stopped ? 'circuit-open' : p.mode === 'disabled' ? 'disabled' : gate.reason;
      record(); return;
    }
    let authorized = false;
    try { authorized = this.host.authorize(structuredClone(projection)) === true; } catch { /* fail closed */ }
    if (!authorized) { record(); return; }
    // A failed host clock is unavailable evidence, never a reason to lose the receipt.
    const clock = () => { try { return (this.host.clock ?? Date.now)(); } catch { return NaN; } };
    const start = clock();
    if (!Number.isFinite(start)) { receipt.reason = 'evaluation-failed'; this.disable(); record(); return; }
    const controller = new AbortController();
    this.active.add(controller);
    let timedOut = false;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('deadline')); }, p.maximumLatencyMs);
      });
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('cancelled'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      receipt.route = 'shadow';
      const response = await Promise.race([this.host.evaluate({ ...structuredClone(projection), signal: controller.signal }), timeout, cancelled]);
      if (this.stopped) throw new Error('circuit-open');
      const elapsed = clock() - start;
      receipt.latencyMs = finite(elapsed) ? elapsed : p.maximumLatencyMs;
      if (!finite(elapsed) || elapsed >= p.maximumLatencyMs) { timedOut = true; controller.abort(); throw new Error('deadline'); }
      const r = response.result.spec;
      receipt.resultDigest = /^sha256:[0-9a-f]{64}$/.test(response.receiptDigest) ? response.receiptDigest : null;
      const attempts = r.attempts;
      const last = attempts.at(-1);
      const knownModel = last?.actualModel != null && p.allowedModels.includes(last.actualModel);
      receipt.servedModel = knownModel ? last.actualModel : null;
      // Shared request accounting must remain at its owner; a per-item route cannot charge it again.
      const ordinary = attempts.length > 0 && attempts.every(a => !a.batch);
      const tokenKnown = ordinary && attempts.every(a => Number.isSafeInteger(a.usage.inputTokens) && a.usage.inputTokens! >= 0
        && Number.isSafeInteger(a.usage.outputTokens) && a.usage.outputTokens! >= 0);
      const costKnown = ordinary && attempts.every(a => a.usage.costUsd !== null && finite(a.usage.costUsd));
      receipt.usage.tokens = tokenKnown ? attempts.reduce((n, a) => n + a.usage.inputTokens! + a.usage.outputTokens!, 0) : null;
      receipt.usage.costUsd = costKnown ? attempts.reduce((n, a) => n + a.usage.costUsd!, 0) : null;
      if (receipt.usage.tokens === null || receipt.usage.costUsd === null || !Number.isSafeInteger(receipt.usage.tokens)
        || receipt.usage.tokens > p.maximumTokens || receipt.usage.costUsd > p.maximumCostUsd) {
        receipt.reason = 'budget-breach'; this.disable(); record(); return;
      }
      const uncertainty = r.uncertainty;
      const distribution = uncertainty?.distribution;
      const probabilities = distribution && projection.options.every(option => Object.hasOwn(distribution, option))
        && Object.keys(distribution).length === projection.options.length ? Object.values(distribution) : [];
      const option = r.value;
      let accept = r.status === 'success' && samePin(r.decision, p.definition) && samePin(r.binding, p.binding)
        && knownModel && receipt.resultDigest !== null && r.acceptance?.disposition === 'act'
        && r.calibrationCompatibility?.action === 'allow' && ['exact', 'approved-compatible'].includes(r.calibrationCompatibility.state)
        && r.calibrationCompatibility.artifactDigest === p.calibrationDigest
        && r.calibrationCompatibility.actualModel === last!.actualModel
        && r.calibrationCompatibility.runId === `${r.runId}:${r.invocationId}:${r.alias}`
        && uncertainty?.source === 'provider' && uncertainty.profile === p.uncertaintyProfile
        && probabilities.length > 0 && probabilities.every(v => finite(v) && v <= 1)
        && Math.abs(probabilities.reduce((sum, v) => sum + v, 0) - 1) < 1e-6
        && typeof option === 'string' && projection.options.includes(option);
      if (accept && distribution && typeof option === 'string') {
        const probability = distribution[option]!;
        const competitor = Math.max(...Object.entries(distribution).filter(([key]) => key !== option).map(([, value]) => value));
        accept = probability > competitor && probability >= p.minimumProbability && probability - competitor >= p.minimumMargin;
      }
      receipt.reason = accept ? 'accepted-shadow' : 'rejected-evidence';
      if (!accept) this.disable(); // quality/model/calibration breach restores deterministic-only routing
      if (accept) receipt.selection = option === 'none' ? { kind: 'none' } : { kind: 'candidate', ordinal: projection.options.indexOf(option as string) };
    } catch {
      receipt.reason = timedOut ? 'budget-breach' : this.stopped ? 'circuit-open' : 'evaluation-failed';
      const elapsed = clock() - start;
      receipt.latencyMs = timedOut ? Math.max(p.maximumLatencyMs, finite(elapsed) ? elapsed : 0) : finite(elapsed) ? elapsed : 0;
      receipt.selection = null;
      if (timedOut) this.disable();
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      this.active.delete(controller);
    }
    record();
  }
}

export { DiscoveryShadowEvaluator, type DiscoveryShadowEvaluatorConfig } from './discovery-shadow-evaluator.js';
export * from './discovery-shadow-study.js';
