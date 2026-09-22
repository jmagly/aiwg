import type {
  AcceptanceCondition,
  AcceptanceMetric,
  AcceptanceRoute,
  AdapterObservation,
  DecisionAcceptanceEvidence,
  DecisionDefinition,
  PrimitiveAcceptancePolicy,
} from './types.js';
import { DecisionValidationError } from './validate.js';

const METRICS: Record<DecisionDefinition['spec']['answer']['kind'], ReadonlySet<AcceptanceMetric>> = {
  'truth-probability': new Set(['yes-probability', 'calibrated-risk']),
  choice: new Set(['selected-probability', 'native-confidence', 'top-two-margin', 'entropy', 'concentration', 'calibrated-risk']),
  'ordinal-score': new Set(['expected-score', 'native-confidence', 'dispersion', 'concentration', 'calibrated-risk']),
};

export function validatePrimitiveAcceptancePolicy(policy: PrimitiveAcceptancePolicy, definition?: DecisionDefinition): void {
  if (!/^\d+\.\d+\.\d+$/.test(policy.version)) throw new DecisionValidationError('acceptance policy version must be semver');
  if (!policy.compatibleUncertaintyProfiles.length
    || new Set(policy.compatibleUncertaintyProfiles).size !== policy.compatibleUncertaintyProfiles.length
    || policy.compatibleUncertaintyProfiles.some(profile => !profile.trim())) {
    throw new DecisionValidationError('primitive acceptance requires unique non-empty compatible uncertainty profiles');
  }
  if (policy.precedence !== 'first-match') throw new DecisionValidationError('acceptance policy requires explicit first-match precedence');
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (!rule.id || ids.has(rule.id)) throw new DecisionValidationError('acceptance rule IDs must be non-empty and unique');
    ids.add(rule.id);
    if (!rule.all.length) throw new DecisionValidationError(`acceptance rule '${rule.id}' must contain a condition`);
    for (const condition of rule.all) if (!METRICS[rule.primitive].has(condition.metric)) {
      throw new DecisionValidationError(`acceptance metric '${condition.metric}' is incompatible with ${rule.primitive}`);
    }
    for (const condition of rule.all) validateCondition(condition);
    validateRoute(rule.route);
  }
  [policy.defaultRoute, policy.missingEvidenceRoute, policy.invalidEvidenceRoute, policy.tieRoute].forEach(validateRoute);
  if (policy.requiredOptions) {
    if (!policy.requiredOptions.length || new Set(policy.requiredOptions).size !== policy.requiredOptions.length
      || policy.requiredOptions.some(option => !option)) {
      throw new DecisionValidationError('required Choice options must be unique non-empty IDs');
    }
    if (definition?.spec.answer.kind !== 'choice') throw new DecisionValidationError('requiredOptions is valid only for Choice policies');
    const options = new Set(definition.spec.answer.options.map(option => option.id));
    if (policy.requiredOptions.some(option => !options.has(option))) {
      throw new DecisionValidationError('Choice definition is missing an option required by its acceptance policy');
    }
  }
}

export function applyPrimitiveAcceptance(
  definition: DecisionDefinition,
  policy: PrimitiveAcceptancePolicy,
  observation: AdapterObservation,
): AdapterObservation {
  if (observation.status !== 'success') return observation;
  validatePrimitiveAcceptancePolicy(policy, definition);
  const uncertaintyProfile = observation.uncertainty?.profile;
  if (!uncertaintyProfile) {
    return routed(observation, policy, policy.missingEvidenceRoute, 'missing-evidence', {});
  }
  if (!policy.compatibleUncertaintyProfiles.includes(uncertaintyProfile)) {
    return routed(observation, policy, policy.invalidEvidenceRoute, 'invalid-evidence', {});
  }
  const evidence = deriveEvidence(definition, observation);
  if (!evidence) return routed(observation, policy, policy.invalidEvidenceRoute, 'invalid-evidence', {});
  if (policy.calibration === 'required' && evidence['calibrated-risk'] === undefined) {
    return routed(observation, policy, policy.missingEvidenceRoute, 'calibration-required', evidence);
  }
  if (definition.spec.answer.kind === 'choice' && evidence['top-two-margin']?.normalizedBps === 0) {
    return routed(observation, policy, policy.tieRoute, 'tie', evidence);
  }
  for (const rule of policy.rules) {
    if (rule.primitive !== definition.spec.answer.kind) continue;
    const conditionValues = rule.all.map(condition => evidence[condition.metric]);
    if (conditionValues.some(value => value === undefined)) {
      return routed(observation, policy, policy.missingEvidenceRoute, 'missing-evidence', evidence);
    }
    if (rule.all.every((condition, index) => matches(conditionValues[index]!.normalizedBps, condition))) {
      return routed(observation, policy, rule.route, 'matched', evidence, rule.id);
    }
  }
  return routed(observation, policy, policy.defaultRoute, 'default', evidence);
}

function deriveEvidence(
  definition: DecisionDefinition,
  observation: AdapterObservation,
): DecisionAcceptanceEvidence['values'] | null {
  const values: DecisionAcceptanceEvidence['values'] = {};
  const add = (metric: AcceptanceMetric, value: number, normalized: number,
    provenance: DecisionAcceptanceEvidence['values'][AcceptanceMetric] extends infer T
      ? T extends { provenance: infer P } ? P : never : never,
    calibrationRef: string | null = null): boolean => {
    if (!Number.isFinite(value) || !Number.isFinite(normalized) || normalized < 0 || normalized > 1) return false;
    // Preserve the raw statistic and remove only IEEE-754 representation noise
    // from the separate basis-point comparison value (eight decimal places).
    const normalizedBps = Math.round(normalized * 1_000_000_000_000) / 100_000_000;
    values[metric] = { value, normalizedBps, provenance, calibrationRef };
    return true;
  };
  const uncertainty = observation.uncertainty;
  if (uncertainty?.calibratedRisk
    && !add('calibrated-risk', uncertainty.calibratedRisk.value, uncertainty.calibratedRisk.value,
      'calibrated', uncertainty.calibratedRisk.calibrationRef)) return null;
  const kind = definition.spec.answer.kind;
  if (kind === 'truth-probability') {
    return typeof observation.value === 'number' && add('yes-probability', observation.value, observation.value, 'provider-value') ? values : null;
  }
  const distribution = uncertainty?.distribution;
  if (!distribution) return values;
  const probabilities = Object.values(distribution);
  if (!probabilities.length) return null;
  const concentration = probabilities.reduce((sum, probability) => sum + probability ** 2, 0);
  if (!add('concentration', concentration, concentration, 'derived')) return null;
  if (uncertainty.confidence !== null && !add('native-confidence', uncertainty.confidence, uncertainty.confidence, 'provider-confidence')) return null;
  if (kind === 'choice') {
    if (typeof observation.value !== 'string' || distribution[observation.value] === undefined) return null;
    const sorted = [...probabilities].sort((a, b) => b - a);
    const selected = distribution[observation.value]!;
    const margin = selected - (sorted[1] ?? 0);
    const entropy = probabilities.length <= 1 ? 0
      : -probabilities.reduce((sum, probability) => sum + (probability === 0 ? 0 : probability * Math.log(probability)), 0) / Math.log(probabilities.length);
    if (!add('selected-probability', selected, selected, 'provider-distribution')
      || !add('top-two-margin', margin, margin, 'derived')
      || !add('entropy', entropy, entropy, 'derived')) return null;
    return values;
  }
  const range = definition.spec.answer.levels.length - 1;
  if (range <= 0) return null;
  const expected = Object.entries(distribution).reduce((sum, [level, probability]) => sum + Number(level) * probability, 0);
  const variance = Object.entries(distribution).reduce((sum, [level, probability]) => sum + (Number(level) - expected) ** 2 * probability, 0);
  if (!add('expected-score', expected, expected / range, 'derived')
    || !add('dispersion', variance, variance / (range ** 2), 'derived')) return null;
  return values;
}

function routed(
  observation: AdapterObservation,
  policy: PrimitiveAcceptancePolicy,
  route: AcceptanceRoute,
  reason: DecisionAcceptanceEvidence['reason'],
  values: DecisionAcceptanceEvidence['values'],
  matchedRule: string | null = null,
): AdapterObservation {
  const acceptance: DecisionAcceptanceEvidence = {
    policyVersion: policy.version, uncertaintyProfile: observation.uncertainty?.profile ?? null,
    disposition: route.disposition, matchedRule, reason, values,
    ...(route.fallbackTarget ? { fallbackTarget: route.fallbackTarget } : {}),
  };
  if (route.disposition === 'act') return { ...observation, acceptance };
  return { ...observation, status: 'abstained', reason: 'low-confidence', acceptance };
}

function matches(value: number, condition: AcceptanceCondition): boolean {
  switch (condition.op) {
    case 'lt': return value < condition.thresholdBps!;
    case 'lte': return value <= condition.thresholdBps!;
    case 'gt': return value > condition.thresholdBps!;
    case 'gte': return value >= condition.thresholdBps!;
    case 'between': return value >= condition.minimumBps! && value <= condition.maximumBps!;
    case 'outside': return value < condition.minimumBps! || value > condition.maximumBps!;
  }
}

function validateCondition(condition: AcceptanceCondition): void {
  const scalar = condition.op === 'lt' || condition.op === 'lte' || condition.op === 'gt' || condition.op === 'gte';
  if (scalar) {
    if (!Number.isInteger(condition.thresholdBps) || condition.thresholdBps! < 0 || condition.thresholdBps! > 10_000
      || condition.minimumBps !== undefined || condition.maximumBps !== undefined) {
      throw new DecisionValidationError('scalar acceptance conditions require one thresholdBps in [0,10000]');
    }
  } else if (!Number.isInteger(condition.minimumBps) || !Number.isInteger(condition.maximumBps)
    || condition.minimumBps! < 0 || condition.maximumBps! > 10_000 || condition.minimumBps! > condition.maximumBps!
    || condition.thresholdBps !== undefined) {
    throw new DecisionValidationError('range acceptance conditions require ordered minimumBps/maximumBps in [0,10000]');
  }
}

function validateRoute(route: AcceptanceRoute): void {
  if (route.disposition === 'fallback') {
    if (!route.fallbackTarget) throw new DecisionValidationError('fallback route requires fallbackTarget');
  } else if (route.fallbackTarget !== undefined) throw new DecisionValidationError('fallbackTarget is valid only for fallback routes');
}
