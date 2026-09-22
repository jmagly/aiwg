import { canonicalJson } from '../security/artifact-trust.js';
import { resolveJsonPointer } from './validate.js';

export type DecisionTrust = 'verified' | 'untrusted';
export type DecisionSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export interface DecisionProjectionField {
  pointer: string;
  output: string;
  source: string;
  subject: string;
  trust: DecisionTrust;
  sensitivity: DecisionSensitivity;
  purpose: string;
  retentionClass: string;
  allowedProviders: string[];
  allowedRegions: string[];
}

export interface DecisionProjectionPolicy {
  version: string;
  provider: string;
  model: string;
  origin: string;
  region: string;
  purpose: string;
  allowIncompleteContext: boolean;
  fields: DecisionProjectionField[];
}

export interface DecisionProjectionEvidence {
  policyVersion: string;
  subject: string;
  included: Array<Pick<DecisionProjectionField, 'pointer' | 'output' | 'source' | 'trust' | 'sensitivity' | 'retentionClass'>>;
  incompleteContext: boolean;
  automaticActionAllowed: boolean;
  projectedDigest: `sha256:${string}`;
}

export class DecisionProjectionError extends Error {
  constructor(readonly reason: 'invalid-policy' | 'data-boundary-denied' | 'invalid-input', message: string) {
    super(message);
    this.name = 'DecisionProjectionError';
  }
}

/**
 * Deterministically creates the only state object an adapter may receive.
 * Callers must run this before credential resolution or transport dispatch.
 */
export async function projectDecisionState(
  input: unknown,
  policy: DecisionProjectionPolicy,
  options: { incompleteContext?: boolean } = {},
): Promise<{ state: Record<string, unknown>; evidence: DecisionProjectionEvidence }> {
  validateProjectionPolicy(policy);
  const incompleteContext = options.incompleteContext === true;
  if (incompleteContext && !policy.allowIncompleteContext) {
    throw new DecisionProjectionError('data-boundary-denied', 'incomplete material context is not authorized by projection policy');
  }

  const state: Record<string, unknown> = {};
  const included: DecisionProjectionEvidence['included'] = [];
  let subject: string | undefined;
  for (const field of [...policy.fields].sort((a, b) => a.output.localeCompare(b.output))) {
    const resolved = resolveJsonPointer(input, field.pointer);
    if (!resolved.found) throw new DecisionProjectionError('invalid-input', `projection field '${field.pointer}' is missing`);
    state[field.output] = structuredClone(resolved.value);
    subject ??= field.subject;
    included.push({
      pointer: field.pointer, output: field.output, source: field.source, trust: field.trust,
      sensitivity: field.sensitivity, retentionClass: field.retentionClass,
    });
  }
  const canonical = canonicalJson(state);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return {
    state,
    evidence: {
      policyVersion: policy.version,
      subject: subject!,
      included,
      incompleteContext,
      automaticActionAllowed: !incompleteContext,
      projectedDigest: `sha256:${Buffer.from(digest).toString('hex')}`,
    },
  };
}

export function validateProjectionPolicy(policy: DecisionProjectionPolicy): void {
  if (!policy.version || !policy.provider || !policy.model || !policy.origin || !policy.region || !policy.purpose) {
    throw new DecisionProjectionError('invalid-policy', 'projection policy identity and destination fields are required');
  }
  let normalizedOrigin: URL;
  try { normalizedOrigin = new URL(policy.origin); }
  catch { throw new DecisionProjectionError('invalid-policy', 'projection origin must be an absolute HTTPS URL'); }
  if (normalizedOrigin.protocol !== 'https:' || normalizedOrigin.username || normalizedOrigin.password) {
    throw new DecisionProjectionError('invalid-policy', 'projection origin must be credential-free HTTPS');
  }
  if (!policy.fields.length) throw new DecisionProjectionError('invalid-policy', 'projection policy must allow at least one field');
  const outputs = new Set<string>();
  let subject: string | undefined;
  for (const field of policy.fields) {
    if (!field.pointer.startsWith('/') || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(field.output)) {
      throw new DecisionProjectionError('invalid-policy', 'projection fields require JSON pointers and portable output names');
    }
    if (outputs.has(field.output)) throw new DecisionProjectionError('invalid-policy', `duplicate projection output '${field.output}'`);
    outputs.add(field.output);
    subject ??= field.subject;
    if (!field.subject || field.subject !== subject) {
      throw new DecisionProjectionError('invalid-policy', 'one projection may contain exactly one stable subject');
    }
    if (field.purpose !== policy.purpose || !field.allowedProviders.includes(policy.provider)
      || !field.allowedRegions.includes(policy.region)) {
      throw new DecisionProjectionError('data-boundary-denied', `field '${field.pointer}' is not authorized for the selected destination`);
    }
    if (!field.source || !field.retentionClass || !field.allowedProviders.length || !field.allowedRegions.length) {
      throw new DecisionProjectionError('invalid-policy', `field '${field.pointer}' lacks provenance or lifecycle metadata`);
    }
  }
}

