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
  accessScopes: string[];
  exportPolicy: 'denied' | 'sanitized';
  deletionPolicy: 'erase' | 'tombstone';
  backupPolicy: 'expire-with-primary' | 'not-persisted';
  allowedProviders: string[];
  allowedModels: string[];
  allowedOrigins: string[];
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
  included: Array<Pick<DecisionProjectionField, 'pointer' | 'output' | 'source' | 'trust' | 'sensitivity' | 'retentionClass'
    | 'accessScopes' | 'exportPolicy' | 'deletionPolicy' | 'backupPolicy'>>;
  incompleteContext: boolean;
  automaticActionAllowed: boolean;
  projectedDigest: `sha256:${string}`;
}

export interface ProjectedDecisionDispatch<TCredential, TResult> {
  resolveCredential(): Promise<TCredential>;
  dispatch(request: {
    state: Readonly<Record<string, unknown>>;
    evidence: Readonly<DecisionProjectionEvidence>;
    credential: TCredential;
  }): Promise<TResult>;
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
      accessScopes: [...field.accessScopes], exportPolicy: field.exportPolicy,
      deletionPolicy: field.deletionPolicy, backupPolicy: field.backupPolicy,
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

/**
 * Enforces the projection boundary before any credential lookup or transport.
 * The credential resolver receives no state, and dispatch receives only the
 * minimized projection rather than the ambient input object.
 */
export async function dispatchProjectedDecisionState<TCredential, TResult>(
  input: unknown,
  policy: DecisionProjectionPolicy,
  handlers: ProjectedDecisionDispatch<TCredential, TResult>,
  options: { incompleteContext?: boolean } = {},
): Promise<TResult> {
  const projected = await projectDecisionState(input, policy, options);
  const credential = await handlers.resolveCredential();
  return handlers.dispatch({
    state: Object.freeze(projected.state),
    evidence: Object.freeze(projected.evidence),
    credential,
  });
}

export function validateProjectionPolicy(policy: DecisionProjectionPolicy): void {
  rejectUnknownKeys(policy as unknown as Record<string, unknown>,
    ['version', 'provider', 'model', 'origin', 'region', 'purpose', 'allowIncompleteContext', 'fields'], 'projection policy');
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
    rejectUnknownKeys(field as unknown as Record<string, unknown>, [
      'pointer', 'output', 'source', 'subject', 'trust', 'sensitivity', 'purpose', 'retentionClass',
      'accessScopes', 'exportPolicy', 'deletionPolicy', 'backupPolicy', 'allowedProviders',
      'allowedModels', 'allowedOrigins', 'allowedRegions',
    ], `projection field '${field.pointer || '<unknown>'}'`);
    if (!field.pointer.startsWith('/') || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(field.output)) {
      throw new DecisionProjectionError('invalid-policy', 'projection fields require JSON pointers and portable output names');
    }
    if (outputs.has(field.output)) throw new DecisionProjectionError('invalid-policy', `duplicate projection output '${field.output}'`);
    outputs.add(field.output);
    subject ??= field.subject;
    if (!field.subject || field.subject !== subject) {
      throw new DecisionProjectionError('invalid-policy', 'one projection may contain exactly one stable subject');
    }
    const normalizedAllowedOrigins = field.allowedOrigins?.map(origin => normalizeAuthorizedOrigin(origin));
    if (field.purpose !== policy.purpose || !field.allowedProviders?.includes(policy.provider)
      || !field.allowedModels?.includes(policy.model) || !normalizedAllowedOrigins?.includes(normalizedOrigin.origin)
      || !field.allowedRegions?.includes(policy.region)) {
      throw new DecisionProjectionError('data-boundary-denied', `field '${field.pointer}' is not authorized for the selected destination`);
    }
    if (!field.source || !field.retentionClass || !field.allowedProviders.length || !field.allowedModels.length
      || !field.allowedOrigins.length || !field.allowedRegions.length || !field.accessScopes?.length
      || !['denied', 'sanitized'].includes(field.exportPolicy)
      || !['erase', 'tombstone'].includes(field.deletionPolicy)
      || !['expire-with-primary', 'not-persisted'].includes(field.backupPolicy)) {
      throw new DecisionProjectionError('invalid-policy', `field '${field.pointer}' lacks provenance or lifecycle metadata`);
    }
    rejectPortableSecretMaterial(field as unknown as Record<string, unknown>, `projection field '${field.pointer}'`);
  }
}

function normalizeAuthorizedOrigin(origin: string): string {
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new DecisionProjectionError('invalid-policy', 'allowed origins must be absolute HTTPS origins'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash) {
    throw new DecisionProjectionError('invalid-policy', 'allowed origins must be credential-free HTTPS origins');
  }
  return parsed.origin;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new DecisionProjectionError('invalid-policy', `${name} contains unsupported control fields: ${unknown.sort().join(', ')}`);
}

function rejectPortableSecretMaterial(value: Record<string, unknown>, name: string): void {
  const serialized = canonicalJson(value);
  if (/bearer\s+[a-z0-9._~+/=-]+/i.test(serialized)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(serialized)
    || /(?:vault|secret):\/\//i.test(serialized)
    || /"(?:secret|credential|token|api[_-]?key)[^"]*hash"\s*:/i.test(serialized)) {
    throw new DecisionProjectionError('invalid-policy', `${name} contains forbidden credential or private-locator material`);
  }
}
