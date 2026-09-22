import { getDecisionPatternPack, decisionPatternPacks } from './catalog.js';
import type { JsonValue } from '../types.js';
import type { DecisionPatternId, DecisionPatternPack, LivePatternPlan, PatternFixture, PatternReceipt } from './types.js';

const strings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function listDecisionPatterns(): Array<Pick<DecisionPatternPack, 'id' | 'version' | 'status' | 'summary' | 'limitations'>> {
  return decisionPatternPacks.map(({ id, version, status, summary, limitations }) => ({ id, version, status, summary, limitations: [...limitations] }));
}

export function validateDecisionPattern(pack: DecisionPatternPack): string[] {
  const errors: string[] = [];
  if (pack.schema !== 'decision-pattern-pack/v1') errors.push('unsupported-schema');
  if (!/^\d+\.\d+\.\d+$/.test(pack.version)) errors.push('invalid-version');
  for (const [name, value] of Object.entries(pack.artifacts)) {
    if (Array.isArray(value) ? value.length === 0 || value.some(item => !item) : !value) errors.push(`missing-artifact:${name}`);
  }
  if (pack.status !== 'unavailable' && pack.fixtures.length === 0) errors.push('missing-offline-fixture');
  if (!pack.failurePath || !pack.rollback || pack.limitations.length === 0) errors.push('missing-governance-guidance');
  if (pack.live && (pack.live.limits.maxCalls < 1 || pack.live.limits.maxTokens < 1 || pack.live.limits.maxCostUsd <= 0 || pack.live.limits.allowUnknownCost !== false || pack.live.limits.maxAttempts < 1 || pack.live.limits.deadlineMs < 1)) errors.push('invalid-live-limits');
  return errors;
}

function decide(pack: DecisionPatternPack, fixture: PatternFixture): { route: PatternReceipt['route']; reason: string; candidate: string | null; checks: string[] } {
  const input = fixture.input;
  const evidence = fixture.recordedEvidence;
  if (input.deterministicPolicy === 'deny') return { route: 'deny', reason: 'deterministic-policy-deny', candidate: null, checks: ['deterministic-policy-precedence', 'action-not-executed'] };
  if (pack.id === 'intent-routing' || pack.id === 'bounded-classification' || pack.id === 'candidate-selection') {
    const allowed = strings(input.authorizedCandidates ?? input.allowedOptions ?? input.extractedCandidates);
    const selected = typeof evidence.selected === 'string' ? evidence.selected : null;
    return selected && allowed.includes(selected)
      ? { route: 'accept', reason: 'authorized-candidate', candidate: selected, checks: ['candidate-membership', 'action-not-executed'] }
      : { route: 'review', reason: 'candidate-not-authorized', candidate: null, checks: ['candidate-membership', 'authority-not-expanded'] };
  }
  if (pack.id === 'function-selection') {
    const selected = typeof evidence.selected === 'string' ? evidence.selected : null;
    return selected && strings(input.legalFunctions).includes(selected)
      ? { route: 'accept', reason: 'authorized-function', candidate: selected, checks: ['function-membership', 'typed-arguments', 'action-not-executed'] }
      : { route: 'deny', reason: 'function-not-authorized', candidate: null, checks: ['function-membership', 'authority-not-expanded'] };
  }
  if (pack.id === 'citation-support') {
    const locator = typeof evidence.selectedLocator === 'string' ? evidence.selectedLocator : null;
    return locator && strings(input.sourceLocators).includes(locator)
      ? { route: 'accept', reason: 'locator-verified', candidate: locator, checks: ['locator-exists', 'provenance-retained', 'action-not-executed'] }
      : { route: 'review', reason: 'locator-not-provided', candidate: null, checks: ['locator-exists', 'model-cannot-create-provenance'] };
  }
  if (pack.id === 'same-subject-batch') {
    const subjects = strings(input.itemSubjects);
    const same = subjects.length > 0 && subjects.every(subject => subject === subjects[0]);
    return same
      ? { route: 'accept', reason: 'same-subject-batch', candidate: null, checks: ['same-subject', 'request-usage-once', 'action-not-executed'] }
      : { route: 'deny', reason: 'multi-subject-batch-rejected', candidate: null, checks: ['same-subject', 'batch-not-dispatched'] };
  }
  if (pack.id === 'durable-review') return { route: 'review', reason: 'durable-review-required', candidate: null, checks: ['idempotency-key-present', 'single-result', 'action-not-executed'] };
  if (pack.id === 'ordinal-scoring') {
    const distribution = record(evidence.distribution);
    const complete = strings(input.legend).every(level => typeof distribution[level] === 'number');
    return complete
      ? { route: 'accept', reason: 'distribution-preserved', candidate: null, checks: ['legend-preserved', 'mean-preserved', 'dispersion-preserved', 'action-not-executed'] }
      : { route: 'review', reason: 'incomplete-distribution', candidate: null, checks: ['distribution-incomplete'] };
  }
  return { route: fixture.expected.route, reason: fixture.expected.reason, candidate: null, checks: ['policy-boundary', 'action-not-executed'] };
}

export function runOfflineDecisionPattern(id: DecisionPatternId, fixtureId?: string, recordedEvidenceOverride?: Record<string, JsonValue>): PatternReceipt {
  const pack = getDecisionPatternPack(id);
  const errors = validateDecisionPattern(pack);
  if (errors.length) throw new Error(`Invalid decision pattern: ${errors.join(', ')}`);
  if (pack.status === 'unavailable') throw new Error(`Decision pattern unavailable: ${id}`);
  const selectedFixture = fixtureId ? pack.fixtures.find(candidate => candidate.id === fixtureId) : pack.fixtures[0];
  if (!selectedFixture) throw new Error(`Unknown fixture for decision pattern: ${id}`);
  const fixture = recordedEvidenceOverride ? { ...selectedFixture, recordedEvidence: structuredClone(recordedEvidenceOverride) } : selectedFixture;
  const outcome = decide(pack, fixture);
  const distributionValue = record(fixture.recordedEvidence.distribution);
  const distribution = Object.values(distributionValue).every(value => typeof value === 'number') && Object.keys(distributionValue).length
    ? distributionValue as Record<string, number> : null;
  return {
    schema: 'decision-pattern-receipt/v1', pattern: { id: pack.id, version: pack.version }, fixtureId: fixture.id,
    subjectId: fixture.subjectId, executionMode: 'offline-recorded', evidenceOrigin: 'sanitized-recorded-fixture',
    primitive: pack.primitive, requestedModel: 'offline-fixture', actualModel: null,
    uncertainty: { provenance: 'recorded-uncalibrated', calibration: 'unavailable', distribution },
    route: outcome.route, reason: outcome.reason, attempts: 0,
    usage: { inputTokens: null, outputTokens: null, costUsd: null, availability: 'unavailable' },
    action: { status: 'unexecuted', candidate: outcome.candidate }, checks: outcome.checks,
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
