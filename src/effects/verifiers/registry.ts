/**
 * Verifier registry keyed by kind, and the framework runner that enforces the
 * tri-state rules on every verifier answer.
 *
 * @see docs/contracts/effect-ledger.v1.md "Verifier interface"
 */

import { canonicalJson } from '../../security/artifact-trust.js';
import { usageError } from '../errors.js';
import { isEffectKind, sha256Digest } from '../identity.js';
import { assertDigestOnly } from '../redaction.js';
import {
  ABSENT_REASONS,
  PRESENT_REASONS,
  UNKNOWN_REASONS,
  type UnknownReason,
  type VerifierRef,
} from '../types.js';
import {
  EffectVerifierError,
  type EffectVerifier,
  type EffectVerifierEvidence,
  type EffectVerifierObservation,
  type EffectVerifierRegistry,
  type EffectVerifierRequest,
} from './types.js';

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Build a registry. Kinds must be core kinds or `x.<vendor>.<name>` extension
 * kinds, versions must be semver, and each kind has exactly one verifier.
 * The default registry is empty: every reconcile is `unknown` / `verifier-missing`.
 */
export function createVerifierRegistry(verifiers: EffectVerifier[] = []): EffectVerifierRegistry {
  const byKind = new Map<string, EffectVerifier>();
  for (const verifier of verifiers) {
    if (!verifier || typeof verifier.verify !== 'function' || typeof verifier.canReportAbsent !== 'boolean') {
      throw usageError('A verifier needs kind, version, canReportAbsent and verify', 'invalid-verifier');
    }
    if (!isEffectKind(verifier.kind)) throw usageError('Verifier kind must be a core kind or x.<vendor>.<name>', 'invalid-verifier');
    if (byKind.has(verifier.kind)) throw usageError('Only one verifier may be registered per kind', 'duplicate-verifier');
    if (typeof verifier.version !== 'string' || !SEMVER.test(verifier.version)) throw usageError('Verifier version must be semver', 'invalid-verifier');
    byKind.set(verifier.kind, verifier);
  }
  const kinds = () => [...byKind.keys()].sort();
  return {
    get: kind => byKind.get(kind),
    kinds,
    listKinds: () => kinds().map(kind => refFor(byKind.get(kind)!)),
  };
}

function refFor(verifier: EffectVerifier): VerifierRef {
  return { kind: verifier.kind, version: verifier.version, canReportAbsent: verifier.canReportAbsent };
}

/** Digest of structured evidence: `sha256:` over `canonicalJson(evidence)`. */
export function evidenceDigest(evidence: EffectVerifierEvidence): string {
  return sha256Digest(canonicalJson(evidence));
}

export interface RunVerifierOptions {
  /** Default 30 000 ms. On expiry the request signal aborts and the result is `unknown` / `timeout`. */
  timeoutMs?: number;
  /** Pin an exact verifier version; any other version is `unknown` / `verifier-version-mismatch`. */
  verifierVersion?: string;
}

/** A normalized verifier run: the recorded ref and observation, plus the unrecorded evidence. */
export interface VerifierRun {
  verifier: VerifierRef;
  observation: Omit<EffectVerifierObservation, 'evidence'>;
  evidence?: EffectVerifierEvidence;
}

export const DEFAULT_VERIFIER_TIMEOUT_MS = 30_000;

const unknown = (reason: UnknownReason): Omit<EffectVerifierObservation, 'evidence'> => ({ result: 'unknown', reason, complete: false });

/** Enforce the tri-state rules: `absent` needs a capable verifier and a complete query; reasons must match the result. */
function normalize(verifier: EffectVerifier, observation: unknown): { observation: Omit<EffectVerifierObservation, 'evidence'>; evidence?: EffectVerifierEvidence } {
  const value = observation as EffectVerifierObservation;
  if (!value || typeof value !== 'object' || typeof value.complete !== 'boolean'
    || (value.evidenceDigest !== undefined && !DIGEST.test(value.evidenceDigest))) return { observation: unknown('malformed-response') };
  let evidence: EffectVerifierEvidence | undefined;
  let digest = value.evidenceDigest;
  if (value.evidence !== undefined) {
    const candidate = value.evidence;
    const flat = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Object.values(candidate).every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item));
    if (!flat) return { observation: unknown('malformed-response') };
    try { assertDigestOnly(candidate); } catch { return { observation: unknown('malformed-response') }; }
    evidence = structuredClone(candidate);
    const computed = evidenceDigest(evidence);
    if (digest !== undefined && digest !== computed) return { observation: unknown('malformed-response') };
    digest = computed;
  }
  const withEvidence = (base: Omit<EffectVerifierObservation, 'evidence' | 'evidenceDigest'>) => ({
    observation: { ...base, ...(digest ? { evidenceDigest: digest } : {}) },
    ...(evidence ? { evidence } : {}),
  });
  if (value.result === 'present') {
    return (PRESENT_REASONS as readonly string[]).includes(value.reason)
      ? withEvidence({ result: 'present', reason: value.reason, complete: value.complete })
      : { observation: unknown('malformed-response') };
  }
  if (value.result === 'absent') {
    if (!verifier.canReportAbsent) return { observation: unknown('verifier-cannot-report-absent') };
    if (!value.complete) return { observation: unknown('paging-incomplete') };
    if (!(ABSENT_REASONS as readonly string[]).includes(value.reason)) return { observation: unknown('malformed-response') };
    return withEvidence({ result: 'absent', reason: value.reason, complete: true });
  }
  if (value.result === 'unknown') {
    return (UNKNOWN_REASONS as readonly string[]).includes(value.reason)
      ? withEvidence({ result: 'unknown', reason: value.reason, complete: value.complete })
      : { observation: unknown('malformed-response') };
  }
  return { observation: unknown('malformed-response') };
}

function thrownReason(error: unknown, timedOut: boolean): UnknownReason {
  if (timedOut) return 'timeout';
  if (error instanceof EffectVerifierError && (UNKNOWN_REASONS as readonly string[]).includes(error.reason)) return error.reason;
  return 'server-error';
}

/**
 * Run one verifier query under the framework rules. Never throws: a missing
 * verifier, a kind or version mismatch, a throw, a timeout or a malformed
 * answer all give `unknown`. `absent` survives only from a verifier with
 * `canReportAbsent: true` reporting `complete: true`.
 */
export async function runVerifier(
  verifier: EffectVerifier | undefined,
  request: Omit<EffectVerifierRequest, 'signal'>,
  options: RunVerifierOptions = {},
): Promise<VerifierRun> {
  if (!verifier) return { verifier: { kind: request.kind, version: '0.0.0', canReportAbsent: false }, observation: unknown('verifier-missing') };
  const ref: VerifierRef = { kind: request.kind, version: SEMVER.test(String(verifier.version)) ? verifier.version : '0.0.0', canReportAbsent: verifier.canReportAbsent === true };
  if (verifier.kind !== request.kind || (options.verifierVersion !== undefined && options.verifierVersion !== verifier.version)) {
    return { verifier: ref, observation: unknown('verifier-version-mismatch') };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new EffectVerifierError('timeout', 'Effect verifier timed out'));
      reject(new EffectVerifierError('timeout'));
    }, timeoutMs);
  });
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => verifier.verify({ ...structuredClone(request), signal: controller.signal })),
      expiry,
    ]);
    if (timedOut) return { verifier: ref, observation: unknown('timeout') };
    return { verifier: ref, ...normalize(verifier, answer) };
  } catch (error) {
    return { verifier: ref, observation: unknown(thrownReason(error, timedOut)) };
  } finally {
    clearTimeout(timer);
  }
}
