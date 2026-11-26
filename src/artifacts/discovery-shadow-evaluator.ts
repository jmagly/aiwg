import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { canonicalJson } from '../security/artifact-trust.js';
import { admitEntry } from '../decision/entry.js';
import { evaluateDecisionRuleset } from '../decision/evaluate.js';
import { validateProjectionPolicy, type DecisionProjectionPolicy, type DecisionProjectionEvidence } from '../decision/projection.js';
import { artifactPin, assertArtifactPin, validateAgainstSchema, validateBinding, validateDefinition, validateRuleset } from '../decision/validate.js';
import type { CalibrationRegistry } from '../decision/calibration/registry.js';
import type { CalibrationArtifact } from '../decision/calibration/types.js';
import type { ArtifactPin, DecisionAdapter, DecisionBinding, DecisionDefinition, DecisionEvaluationRequest,
  DecisionReceiptStore, DecisionRuleset, DecisionSchedulerPolicy, DecisionAdmissionLimits } from '../decision/types.js';
import type { DiscoveryShadowHost, DiscoveryShadowPolicy, DiscoveryShadowRequest, DiscoveryShadowReceipt } from './discovery-shadow.js';

/** Trusted host configuration. None of these fields is taken from retrieval results. */
export interface DiscoveryShadowEvaluatorConfig {
  shadowPolicy: DiscoveryShadowPolicy;
  definition: DecisionDefinition;
  ruleset: DecisionRuleset;
  binding: DecisionBinding;
  projectionPolicy: DecisionProjectionPolicy;
  /** Existing D02 admission profile, including a conservative estimate before dispatch. */
  scheduler: DecisionSchedulerPolicy;
  policyPin: ArtifactPin;
  calibration: { registry: CalibrationRegistry; artifact: CalibrationArtifact };
  adapters: Record<string, DecisionAdapter>;
  resolveCredential: NonNullable<DecisionEvaluationRequest['resolveCredential']>;
  /** Host owns protected storage, project access and retention/deletion enforcement. */
  receiptStore: DecisionReceiptStore;
  receiptProjectId: string;
  runId: string;
  /** Same request in this host-owned scope replays the original durable receipt. */
  invocationScope: string;
  record(receipt: DiscoveryShadowReceipt): void;
  health?: DiscoveryShadowHost['health'];
  onProjectionEvidence?: (input: { alias: string; evidence: DecisionProjectionEvidence }) => void;
  now?: () => number;
}

const hash = (value: unknown): `sha256:${string}` => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const pinEqual = (a: ArtifactPin, b: ArtifactPin): boolean => canonicalJson(a) === canonicalJson(b);
const validPin = (pin: ArtifactPin): boolean => Boolean(pin?.id && pin.version && /^sha256:[a-f0-9]{64}$/.test(pin.digest));
const requestFields = ['query', 'candidates', 'options', 'definition', 'binding'] as const;
type Payload = Omit<DiscoveryShadowRequest, 'signal'>;

/** Strip only the trusted cancellation handle; reject accessors/proxies before reading data. */
function payloadOf(request: Payload | DiscoveryShadowRequest): Payload {
  if (!request || typeof request !== 'object' || utilTypes.isProxy(request)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) throw new Error('Invalid shadow request');
  const descriptors = Object.getOwnPropertyDescriptors(request);
  if (Reflect.ownKeys(request).some(key => typeof key !== 'string' || ![...requestFields, 'signal'].includes(key as typeof requestFields[number]))) {
    throw new Error('Unsupported shadow request field');
  }
  const data: Record<string, unknown> = {};
  for (const key of requestFields) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('Invalid shadow request field');
    data[key] = descriptor.value;
  }
  admitEntry(data);
  return structuredClone(data) as unknown as Payload;
}

/** Concrete Decision runtime bridge, deliberately without an executor or transport shortcut.
 * It supports one pinned option cardinality, one evaluation and one non-retrying target.
 * Other candidate cardinalities fail closed and retain deterministic discovery. */
export class DiscoveryShadowEvaluator implements DiscoveryShadowHost {
  private readonly profile: Pick<DiscoveryShadowEvaluatorConfig, 'shadowPolicy' | 'definition' | 'ruleset' | 'binding'
    | 'projectionPolicy' | 'policyPin' | 'receiptProjectId' | 'runId' | 'invocationScope'>;
  private readonly calibration: CalibrationArtifact;
  private readonly scheduler: DecisionSchedulerPolicy;
  private readonly runtime: Pick<DiscoveryShadowEvaluatorConfig, 'adapters' | 'resolveCredential' | 'receiptStore' | 'record' | 'health' | 'now' | 'onProjectionEvidence'>;
  private readonly registry: CalibrationRegistry;
  private readonly alias: string;
  private readonly options: string[];
  private readonly profileDigest: string;

  constructor(config: DiscoveryShadowEvaluatorConfig) {
    const profile = { shadowPolicy: config.shadowPolicy, definition: config.definition, ruleset: config.ruleset, binding: config.binding,
      projectionPolicy: config.projectionPolicy, policyPin: config.policyPin, receiptProjectId: config.receiptProjectId,
      runId: config.runId, invocationScope: config.invocationScope };
    admitEntry(profile);
    this.profile = structuredClone(profile);
    const p = this.profile;
    validateDefinition(p.definition); validateRuleset(p.ruleset); validateBinding(p.binding, p.ruleset);
    assertArtifactPin(p.definition, p.shadowPolicy.definition, 'discovery definition');
    assertArtifactPin(p.binding, p.shadowPolicy.binding, 'discovery binding');
    if (![p.runId, p.invocationScope, p.receiptProjectId].every(value => typeof value === 'string' && value.trim())
      || !validPin(p.policyPin) || p.ruleset.spec.evaluations.length !== 1 || p.definition.spec.answer.kind !== 'choice') {
      throw new Error('Shadow evaluator requires an identified single Choice profile');
    }
    if (!Number.isSafeInteger(p.shadowPolicy.ambiguity.maximumCandidates) || p.shadowPolicy.ambiguity.maximumCandidates < 1
      || p.shadowPolicy.ambiguity.maximumCandidates > 100 || !Number.isSafeInteger(p.shadowPolicy.ambiguity.maximumTextBytes)
      || p.shadowPolicy.ambiguity.maximumTextBytes < 1 || p.shadowPolicy.ambiguity.maximumTextBytes > 1_000_000
      || !Number.isSafeInteger(p.shadowPolicy.maximumLatencyMs) || p.shadowPolicy.maximumLatencyMs < 1
      || !Number.isSafeInteger(p.shadowPolicy.maximumTokens) || p.shadowPolicy.maximumTokens < 1
      || !Number.isFinite(p.shadowPolicy.maximumCostUsd) || p.shadowPolicy.maximumCostUsd < 0) {
      throw new Error('Invalid bounded shadow profile');
    }
    if (p.projectionPolicy.fields.length !== 2
      || canonicalJson(p.projectionPolicy.fields.map(field => field.output).sort()) !== canonicalJson(['candidates', 'query'])
      || p.projectionPolicy.fields.some(field => field.trust !== 'untrusted' || field.pointer !== `/${field.output}`)) {
      throw new Error('Discovery query and candidates require the untrusted D10 projection');
    }
    const evaluation = p.ruleset.spec.evaluations[0]!;
    this.alias = evaluation.alias;
    if (evaluation.inputPointer !== '' || !pinEqual(evaluation.decision, artifactPin(p.definition))) throw new Error('Shadow evaluation definition mismatch');
    this.options = p.definition.spec.answer.options.map(option => option.id);
    const candidates = this.options.slice(0, -1);
    if (candidates.length < 1 || candidates.length > p.shadowPolicy.ambiguity.maximumCandidates
      || this.options.at(-1) !== 'none' || candidates.some((id, i) => id !== `candidate_${i}`)) throw new Error('Invalid pinned shadow option domain');
    const binding = p.binding.spec.evaluations[this.alias]!;
    const target = binding.targets[0]!;
    if (binding.targets.length !== 1 || binding.fallbackOn.length || target.retry.maxRetries !== 0
      || p.binding.spec.maxAttempts !== 1 || p.binding.spec.concurrency !== 1
      || p.binding.spec.totalTimeoutMs > p.shadowPolicy.maximumLatencyMs || target.timeoutMs > p.shadowPolicy.maximumLatencyMs
      || target.acceptance.mode !== 'primitive-policy'
      || !target.acceptance.compatibleUncertaintyProfiles.includes(p.shadowPolicy.uncertaintyProfile)) {
      throw new Error('Shadow evaluator requires bounded single-target primitive acceptance');
    }
    if (!config.scheduler.enabled || !config.scheduler.estimate) throw new Error('Shadow evaluator requires existing admission and cost/token estimates');
    const { estimate, onEvidence, ...schedulerData } = config.scheduler;
    admitEntry(schedulerData);
    this.scheduler = { ...structuredClone(schedulerData), estimate, ...(onEvidence ? { onEvidence } : {}) };
    // Shared host limits may be broader than this observer's per-invocation budget.
    // Narrow every admission scope before resolution/dispatch, preserving stricter limits.
    const bounded = (limits: DecisionAdmissionLimits): DecisionAdmissionLimits => ({ ...limits,
      maxTokens: Math.min(limits.maxTokens ?? p.shadowPolicy.maximumTokens, p.shadowPolicy.maximumTokens),
      maxCostUsd: Math.min(limits.maxCostUsd ?? p.shadowPolicy.maximumCostUsd, p.shadowPolicy.maximumCostUsd),
      allowUnknownCost: false,
    });
    this.scheduler.workspace.limits = bounded(this.scheduler.workspace.limits);
    this.scheduler.principal.limits = bounded(this.scheduler.principal.limits);
    this.scheduler.providers = Object.fromEntries(Object.entries(this.scheduler.providers).map(([id, limits]) => [id, bounded(limits)]));
    admitEntry(config.calibration.artifact);
    this.calibration = structuredClone(config.calibration.artifact);
    this.registry = config.calibration.registry;
    const registered = this.registry.artifactHistory().find(item => item.id === this.calibration.id);
    const identity = this.calibration.identity;
    if (!registered || hash(registered) !== hash(this.calibration) || this.calibration.digest !== p.shadowPolicy.calibrationDigest
      || identity.definitionDigest !== artifactPin(p.definition).digest || identity.primitive !== 'choice'
      || identity.provider !== target.adapter || identity.adapterVersion !== target.adapterVersion
      || !p.shadowPolicy.allowedModels.includes(identity.actualModel)) throw new Error('Shadow calibration is not the registered pinned profile');
    this.runtime = { adapters: { ...config.adapters }, resolveCredential: config.resolveCredential, receiptStore: config.receiptStore,
      record: config.record, health: config.health, ...(config.now ? { now: config.now } : {}), ...(config.onProjectionEvidence ? { onProjectionEvidence: config.onProjectionEvidence } : {}) };
    this.profileDigest = hash({ profile: p, calibration: this.calibration.digest, scheduler: schedulerData });
  }

  authorize(request: Payload): boolean {
    try { this.checkedPayload(request); validateProjectionPolicy(this.profile.projectionPolicy); return true; } catch { return false; }
  }

  record(receipt: DiscoveryShadowReceipt): void { this.runtime.record(structuredClone(receipt)); }

  health(): ReturnType<NonNullable<DiscoveryShadowHost['health']>> {
    return this.runtime.health ? this.runtime.health() : { drift: false, quality: false, latency: false, cost: false };
  }

  async evaluate(request: DiscoveryShadowRequest): Promise<{ result: import('../decision/types.js').DecisionResult; receiptDigest: string }> {
    const payload = this.checkedPayload(request);
    const descriptor = Object.getOwnPropertyDescriptor(request, 'signal');
    if (!descriptor || !('value' in descriptor) || !(descriptor.value instanceof AbortSignal)) throw new Error('Shadow evaluation requires a cancellation signal');
    const signal: AbortSignal = descriptor.value;
    if (signal.aborted) throw new Error('Shadow evaluation cancelled');
    const p = this.profile;
    const input = { query: payload.query, candidates: payload.candidates };
    const invocationId = `discovery-shadow:${hash({ scope: p.invocationScope, profile: this.profileDigest, input }).slice(7)}`;
    const evaluated = await evaluateDecisionRuleset({
      ruleset: structuredClone(p.ruleset), binding: structuredClone(p.binding), definitions: { [p.definition.metadata.id]: structuredClone(p.definition) },
      input, runId: p.runId, invocationId, signal, adapters: this.runtime.adapters, resolveCredential: this.runtime.resolveCredential,
      receiptStore: this.runtime.receiptStore, receiptProjectId: p.receiptProjectId, policyPin: p.policyPin,
      calibrationPin: { id: this.calibration.id, version: this.calibration.identity.calibrator.version, digest: this.calibration.digest },
      calibrationCompatibility: { registry: this.registry, calibrationArtifactId: this.calibration.id,
        policy: { unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' },
        identityFor: ({ actualModel }) => ({ ...structuredClone(this.calibration.identity), actualModel }) },
      projection: { resolve: () => structuredClone(p.projectionPolicy), ...(this.runtime.onProjectionEvidence ? { onEvidence: this.runtime.onProjectionEvidence } : {}) },
      scheduler: this.scheduler, ...(this.runtime.now ? { now: this.runtime.now } : {}),
    });
    const receipt = await this.runtime.receiptStore.read(invocationId, p.receiptProjectId);
    const decision = evaluated.spec.evaluations[this.alias];
    if (!receipt || receipt.state !== 'completed' || !receipt.result || !decision
      || !receipt.evaluations[this.alias] || hash(receipt.result) !== hash(evaluated) || hash(receipt.evaluations[this.alias]) !== hash(decision)) {
      throw new Error('Shadow evaluation has no verified terminal receipt');
    }
    return { result: structuredClone(decision), receiptDigest: hash(receipt) };
  }

  private checkedPayload(request: Payload | DiscoveryShadowRequest): Payload {
    const payload = payloadOf(request);
    const p = this.profile;
    if (p.shadowPolicy.mode !== 'shadow' || !pinEqual(payload.definition, p.shadowPolicy.definition) || !pinEqual(payload.binding, p.shadowPolicy.binding)
      || canonicalJson(payload.options) !== canonicalJson(this.options) || !Array.isArray(payload.candidates)
      || payload.candidates.length !== this.options.length - 1 || typeof payload.query !== 'string' || !payload.query.trim()
      || payload.candidates.some((c, i) => !c || c.option !== this.options[i] || Object.keys(c).sort().join(',') !== 'capability,id,name,option,type'
        || [c.id, c.name, c.type, c.capability].some(value => typeof value !== 'string') || !c.id)
      || new Set(payload.candidates.map(c => c.id)).size !== payload.candidates.length
      || Buffer.byteLength(canonicalJson({ query: payload.query, candidates: payload.candidates })) > p.shadowPolicy.ambiguity.maximumTextBytes) {
      throw new Error('Shadow request does not match pinned bounded domain');
    }
    validateAgainstSchema(p.ruleset.spec.inputSchema, { query: payload.query, candidates: payload.candidates }, 'shadow input');
    validateAgainstSchema(p.definition.spec.inputSchema, { query: payload.query, candidates: payload.candidates }, 'shadow input');
    return payload;
  }
}
