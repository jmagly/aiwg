import { createHash } from 'node:crypto';
import type {
  AliasDriftEvent, AliasEvent, CalibrationArtifact, CalibrationIdentity, CompatibilityDecision,
  CompatibilityPolicy, CompatibilityRelation, CompatibilityRequest, DecisionEvidenceEnvelope,
  CalibrationDigest, PromotionEligibility, RawDecisionEvidence, CalibratedDecisionEvidence,
} from './types.js';

export class CalibrationRegistryError extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function calibrationIdentityDigest(identity: CalibrationIdentity): CalibrationDigest {
  return `sha256:${createHash('sha256').update(canonical(identity)).digest('hex')}`;
}

export function calibrationArtifactDigest(artifact: Omit<CalibrationArtifact, 'digest'>): CalibrationDigest {
  return `sha256:${createHash('sha256').update(canonical(artifact)).digest('hex')}`;
}

function immutable<T>(value: T): T { return Object.freeze(structuredClone(value)); }
function validDate(value: string): number { const time = Date.parse(value); if (!Number.isFinite(time)) throw new CalibrationRegistryError(`invalid date: ${value}`); return time; }
function nonEmpty(value: string, name: string): void { if (!value.trim()) throw new CalibrationRegistryError(`${name} must not be empty`); }

export class CalibrationRegistry {
  private readonly artifacts = new Map<string, CalibrationArtifact>();
  private readonly artifactDigests = new Map<CalibrationDigest, string>();
  private readonly relations: CompatibilityRelation[] = [];
  private readonly aliases = new Map<string, AliasEvent[]>();
  private readonly drift: AliasDriftEvent[] = [];
  private readonly eligibility = new Map<string, PromotionEligibility>();
  private readonly pins = new Map<string, CompatibilityDecision>();

  registerArtifact(input: CalibrationArtifact): CalibrationArtifact {
    validateArtifact(input);
    const existing = this.artifacts.get(input.id);
    if (existing && canonical(existing) !== canonical(input)) throw new CalibrationRegistryError(`artifact '${input.id}' is immutable`);
    const digestOwner = this.artifactDigests.get(input.digest);
    if (digestOwner && digestOwner !== input.id) throw new CalibrationRegistryError(`artifact digest already belongs to '${digestOwner}'`);
    const artifact = immutable(input);
    this.artifacts.set(artifact.id, artifact); this.artifactDigests.set(artifact.digest, artifact.id);
    return structuredClone(artifact);
  }

  registerRelation(input: CompatibilityRelation): CompatibilityRelation {
    if (input.state === 'approved-compatible' && !input.approvalReference) throw new CalibrationRegistryError('approved compatibility requires an approval reference');
    validDate(input.effectiveAt); if (input.expiresAt) validDate(input.expiresAt);
    if (this.relations.some(item => item.id === input.id && canonical(item) !== canonical(input))) throw new CalibrationRegistryError(`relation '${input.id}' is immutable`);
    if (!this.relations.some(item => item.id === input.id)) this.relations.push(immutable(input));
    return structuredClone(input);
  }

  observeAlias(alias: string, identity: CalibrationIdentity, at: string): AliasEvent {
    nonEmpty(alias, 'alias'); validDate(at);
    const digest = calibrationIdentityDigest(identity); const history = this.aliases.get(alias) ?? []; const previous = history.at(-1);
    if (previous?.actualIdentityDigest === digest && previous.kind !== 'retired') return structuredClone(previous);
    if (previous && previous.kind !== 'retired') this.drift.push(immutable({
      id: `${alias}:drift:${history.length + 1}`, alias, previousIdentityDigest: previous.actualIdentityDigest,
      observedIdentityDigest: digest, previousActualModel: previous.actualModel, observedActualModel: identity.actualModel, detectedAt: at,
    }));
    const event: AliasEvent = immutable({ revision: history.length + 1, alias, actualIdentityDigest: digest,
      actualModel: identity.actualModel, recordedAt: at, kind: 'observed', promotionEligibilityId: null });
    history.push(event); this.aliases.set(alias, history); return structuredClone(event);
  }

  recordPromotionEligibility(input: PromotionEligibility): PromotionEligibility {
    validateEligibility(input, this.aliases.get(input.alias) ?? []);
    const existing = this.eligibility.get(input.id);
    if (existing && canonical(existing) !== canonical(input)) throw new CalibrationRegistryError(`promotion eligibility '${input.id}' is immutable`);
    const record = immutable(input); this.eligibility.set(record.id, record); return structuredClone(record);
  }

  promoteAlias(eligibilityId: string, at: string): AliasEvent {
    const eligibility = this.eligibility.get(eligibilityId);
    if (!eligibility?.eligible) throw new CalibrationRegistryError('alias movement requires an eligible promotion record');
    const history = this.aliases.get(eligibility.alias) ?? [];
    const rollback = history.find(event => event.revision === eligibility.rollbackTarget.aliasRevision);
    if (!rollback || rollback.actualIdentityDigest !== eligibility.rollbackTarget.identityDigest) throw new CalibrationRegistryError('rollback target no longer matches immutable alias history');
    const event: AliasEvent = immutable({ revision: history.length + 1, alias: eligibility.alias,
      actualIdentityDigest: eligibility.candidateIdentityDigest, actualModel: eligibility.candidateActualModel, recordedAt: new Date(validDate(at)).toISOString(),
      kind: 'promoted', promotionEligibilityId: eligibility.id });
    history.push(event); this.aliases.set(event.alias, history); return structuredClone(event);
  }

  rollbackAlias(alias: string, targetRevision: number, approvalReference: string, at: string): AliasEvent {
    nonEmpty(approvalReference, 'rollback approval reference'); const history = this.aliases.get(alias) ?? [];
    const target = history.find(event => event.revision === targetRevision);
    if (!target) throw new CalibrationRegistryError('rollback target must be an exact alias-history revision');
    const event: AliasEvent = immutable({ ...target, revision: history.length + 1, recordedAt: new Date(validDate(at)).toISOString(),
      kind: 'rolled-back', promotionEligibilityId: `rollback-approval:${approvalReference}` });
    history.push(event); return structuredClone(event);
  }

  retireAlias(alias: string, approvalReference: string, at: string): AliasEvent {
    nonEmpty(approvalReference, 'retirement approval reference'); const history = this.aliases.get(alias) ?? []; const current = history.at(-1);
    if (!current) throw new CalibrationRegistryError(`unknown alias '${alias}'`);
    const event: AliasEvent = immutable({ ...current, revision: history.length + 1, recordedAt: new Date(validDate(at)).toISOString(),
      kind: 'retired', promotionEligibilityId: `retirement-approval:${approvalReference}` });
    history.push(event); return structuredClone(event);
  }

  resolve(request: CompatibilityRequest, policy: CompatibilityPolicy): CompatibilityDecision {
    const existing = this.pins.get(request.runId); if (existing) return structuredClone(existing);
    validDate(request.at); const actualDigest = calibrationIdentityDigest(request.actualIdentity);
    const history = this.aliases.get(request.requestedAlias) ?? []; const alias = history.at(-1) ?? null;
    if (alias && alias.kind !== 'retired' && alias.actualIdentityDigest !== actualDigest) this.observeAlias(request.requestedAlias, request.actualIdentity, request.at);
    const artifact = request.calibrationArtifactId ? this.artifacts.get(request.calibrationArtifactId) : findExactArtifact(this.artifacts, actualDigest);
    const artifactIdentity = artifact ? calibrationIdentityDigest(artifact.identity) : null;
    let state: CompatibilityDecision['state'] = artifactIdentity === actualDigest ? 'exact' : 'unknown';
    const relation = artifactIdentity ? this.relations.filter(item => item.fromIdentityDigest === artifactIdentity && item.toIdentityDigest === actualDigest
      && validDate(item.effectiveAt) <= validDate(request.at) && (!item.expiresAt || validDate(item.expiresAt) > validDate(request.at))).at(-1) : undefined;
    if (state !== 'exact' && relation) state = relation.state;
    const reasons: string[] = [];
    if (!artifact) reasons.push('calibration-missing');
    const usable = artifact ? calibrationUsability(artifact, request.at) : [];
    reasons.push(...usable);
    if (alias?.kind === 'retired') reasons.push('alias-retired');
    if (alias && alias.actualIdentityDigest !== actualDigest) reasons.push('alias-drift');
    let action: CompatibilityDecision['action'];
    if (reasons.length) action = policy.unusableCalibration;
    else if (state === 'exact' || state === 'approved-compatible') action = 'allow';
    else if (state === 'shadow-required') action = policy.shadowRequired;
    else if (state === 'incompatible') action = policy.incompatible;
    else action = policy.unknown;
    const currentAlias = (this.aliases.get(request.requestedAlias) ?? []).at(-1) ?? alias;
    const pin: CompatibilityDecision = immutable({ schemaVersion: 'decision-calibration-compatibility/v1', pinId: `${request.runId}:${actualDigest}`,
      runId: request.runId, requestedAlias: request.requestedAlias, actualModel: request.actualIdentity.actualModel,
      aliasRevision: currentAlias?.revision ?? null, artifactId: artifact?.id ?? null, artifactDigest: artifact?.digest ?? null,
      state, action, reasons, decidedAt: request.at });
    this.pins.set(request.runId, pin); return structuredClone(pin);
  }

  evidence(pin: CompatibilityDecision, raw: RawDecisionEvidence, calibrated: CalibratedDecisionEvidence | null): DecisionEvidenceEnvelope {
    if (calibrated && (calibrated.calibrationArtifactId !== pin.artifactId || calibrated.calibrationArtifactDigest !== pin.artifactDigest)) {
      throw new CalibrationRegistryError('calibrated evidence must cite the pinned calibration artifact');
    }
    return immutable({ raw, calibrated, compatibilityPin: pin });
  }

  aliasHistory(alias: string): AliasEvent[] { return structuredClone(this.aliases.get(alias) ?? []); }
  driftEvents(alias?: string): AliasDriftEvent[] { return structuredClone(alias ? this.drift.filter(event => event.alias === alias) : this.drift); }
  promotionHistory(): PromotionEligibility[] { return structuredClone([...this.eligibility.values()]); }
  artifactHistory(): CalibrationArtifact[] { return structuredClone([...this.artifacts.values()]); }
  compatibilityHistory(): CompatibilityRelation[] { return structuredClone(this.relations); }
}

function findExactArtifact(artifacts: Map<string, CalibrationArtifact>, digest: CalibrationDigest): CalibrationArtifact | undefined {
  return [...artifacts.values()].find(artifact => calibrationIdentityDigest(artifact.identity) === digest);
}

function calibrationUsability(artifact: CalibrationArtifact, at: string): string[] {
  const reasons: string[] = [];
  if (artifact.approval.state !== 'approved' || !artifact.approval.reference) reasons.push(`calibration-${artifact.approval.state}`);
  if (artifact.metrics.totalSamples < artifact.profile.minimumTotalSamples) reasons.push('insufficient-total-samples');
  if (artifact.metrics.perSliceSamples < artifact.profile.minimumPerSliceSamples) reasons.push('insufficient-slice-samples');
  if (artifact.metrics.calibrationError > artifact.profile.maximumCalibrationError) reasons.push('calibration-bound-exceeded');
  if (artifact.metrics.selectiveRisk > artifact.profile.maximumSelectiveRisk) reasons.push('selective-risk-bound-exceeded');
  if (validDate(at) >= validDate(artifact.effectiveAt) + artifact.profile.expiresAfterDays * 86_400_000) reasons.push('calibration-expired');
  return reasons;
}

function validateArtifact(artifact: CalibrationArtifact): void {
  nonEmpty(artifact.id, 'artifact id'); validDate(artifact.effectiveAt);
  if (artifact.schemaVersion !== 'decision-calibration-artifact/v1') throw new CalibrationRegistryError('unsupported calibration artifact schema');
  validateIdentity(artifact.identity);
  const { digest, ...payload } = artifact;
  if (digest !== calibrationArtifactDigest(payload)) throw new CalibrationRegistryError('calibration artifact digest does not match its immutable content');
  if (!artifact.limitations.length) throw new CalibrationRegistryError('calibration limitations must be explicit');
  const profile = artifact.profile;
  if (!Number.isInteger(profile.minimumTotalSamples) || profile.minimumTotalSamples < 1 || !Number.isInteger(profile.minimumPerSliceSamples) || profile.minimumPerSliceSamples < 1) throw new CalibrationRegistryError('sample minima must be positive integers');
  if (!(profile.confidenceInterval.level > 0 && profile.confidenceInterval.level < 1) || !profile.confidenceInterval.method) throw new CalibrationRegistryError('confidence interval method and level must be pinned');
  if (profile.maximumCalibrationError < 0 || profile.maximumCalibrationError > 1 || profile.maximumSelectiveRisk < 0 || profile.maximumSelectiveRisk > 1) throw new CalibrationRegistryError('risk bounds must be in [0,1]');
  if (!(profile.expiresAfterDays > 0)) throw new CalibrationRegistryError('expiry rule must be positive');
  if (!Number.isInteger(artifact.metrics.totalSamples) || artifact.metrics.totalSamples < 0 || !Number.isInteger(artifact.metrics.perSliceSamples) || artifact.metrics.perSliceSamples < 0) throw new CalibrationRegistryError('sample observations must be non-negative integers');
  if (artifact.approval.state === 'approved' && !artifact.approval.reference) throw new CalibrationRegistryError('approved calibration requires an approval reference');
  if (artifact.splitProvenance.holdoutAccessedAt && validDate(artifact.splitProvenance.holdoutAccessedAt) < validDate(artifact.effectiveAt)) throw new CalibrationRegistryError('profile must be preregistered before holdout access');
}

function validateIdentity(identity: CalibrationIdentity): void {
  for (const [name, value] of Object.entries({ provider: identity.provider, backend: identity.backend, actualModel: identity.actualModel,
    primitive: identity.primitive, adapterVersion: identity.adapterVersion, datasetId: identity.dataset.id, sliceId: identity.slice.id,
    calibratorId: identity.calibrator.id, calibratorVersion: identity.calibrator.version })) nonEmpty(value, name);
  for (const digest of [identity.definitionDigest, identity.dataset.hash, identity.slice.hash, identity.calibrator.parametersDigest]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new CalibrationRegistryError('identity digests must be lowercase sha256 values');
  }
}

function validateEligibility(record: PromotionEligibility, history: AliasEvent[]): void {
  nonEmpty(record.approvalReference, 'promotion approval reference'); nonEmpty(record.candidateActualModel, 'candidate actual model'); validDate(record.recordedAt);
  if (!record.evaluationIntegrityReport.id || !record.evaluationIntegrityReport.digest) throw new CalibrationRegistryError('promotion requires a pinned evaluation-integrity report');
  const target = history.find(event => event.revision === record.rollbackTarget.aliasRevision);
  if (!target || target.actualIdentityDigest !== record.rollbackTarget.identityDigest) throw new CalibrationRegistryError('promotion requires an exact rollback target');
  if (record.eligible && record.reasons.length) throw new CalibrationRegistryError('eligible promotion records cannot contain denial reasons');
  if (!record.eligible && !record.reasons.length) throw new CalibrationRegistryError('ineligible promotion records must explain the denial');
}
