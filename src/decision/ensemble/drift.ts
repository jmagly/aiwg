import { admitEntry } from '../entry.js';
import { EnsembleContractError, validateDriftResponsePolicy } from './contract.js';
import type { DriftResponseDecision, DriftSignal } from './types.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Maps one drift signal to its exact configured response. It does not execute the response.
 * A signal with no configured rule, a different alias, or evaluated against a different
 * threshold version is rejected rather than falling back to a default or stale threshold. */
export function resolveDriftResponse(policyInput: unknown, signal: DriftSignal): DriftResponseDecision {
  const policy = validateDriftResponsePolicy(policyInput);
  try { admitEntry(signal); } catch { throw new EnsembleContractError('drift signal admission denied', 'admission'); }
  const reject = (message: string): never => { throw new EnsembleContractError(message, 'semantic', [message]); };
  const base = { schemaVersion: 'decision-drift-response-decision/v1' as const,
    policy: { id: policy.id, version: policy.version, thresholdsVersion: policy.thresholds.version } };
  if (signal.source === 'alias-drift') {
    const event = signal.event;
    if (!event?.id || event.alias !== policy.alias) return reject('drift event alias does not match the drift response policy');
    if (!DIGEST.test(event.previousIdentityDigest) || !DIGEST.test(event.observedIdentityDigest) || event.previousIdentityDigest === event.observedIdentityDigest) {
      return reject('alias drift event must record two different pinned identities');
    }
    const rule = policy.rules.find(item => item.source === 'alias-drift');
    if (!rule) return reject('drift event has no configured response');
    return { ...base, signalId: event.id, source: 'alias-drift', metric: 'identity-change', ruleId: rule.id,
      state: 'breached', evidence: 'identity-change', response: rule.response };
  }
  if (signal.source !== 'output-distribution' && signal.source !== 'label-drift') return reject('drift event has no configured response');
  if (!signal.id || signal.alias !== policy.alias) return reject('drift event alias does not match the drift response policy');
  if (signal.thresholdsVersion !== policy.thresholds.version) return reject('drift event was evaluated against a different threshold version');
  if (!Number.isSafeInteger(signal.valueBps) || signal.valueBps < 0 || !Number.isSafeInteger(signal.sampleN) || signal.sampleN < 0) {
    return reject('drift event value and sample count must be non-negative integers');
  }
  const rule = policy.rules.find(item => item.source === signal.source && item.metric === signal.metric);
  if (!rule) return reject('drift event has no configured response');
  const evidence = signal.source === 'label-drift' ? 'labeled-quality' as const : 'unlabeled-distribution-warning' as const;
  const common = { ...base, signalId: signal.id, source: signal.source, metric: signal.metric, ruleId: rule.id, evidence };
  if (signal.sampleN < policy.window.minimumSamples) return { ...common, state: 'insufficient-samples', response: policy.insufficientSamplesResponse };
  return signal.valueBps > rule.thresholdBps!
    ? { ...common, state: 'breached', response: rule.response }
    : { ...common, state: 'within-threshold', response: null };
}
