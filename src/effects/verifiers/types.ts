/**
 * The effect verifier interface (#2718). This is the stable plugin contract
 * that tracker verifiers (#2719), the `aiwg effect` CLI (#2720) and D13
 * adoption (#2721) build on. Keep it minimal: additions must be optional.
 *
 * @see docs/contracts/effect-ledger.v1.md "Verifier interface"
 */

import type { EffectContext, EffectScope, UnknownReason, VerificationResult, VerifierRef } from '../types.js';

/**
 * Caller expectations that are not part of the effect identity. Digests and
 * references only. Built-in verifiers read each member from here first and
 * fall back to a context member of the same name.
 */
export interface EffectVerifierExpectation {
  /** Expected `sha256:<hex>` digest of the target object (a file, a D03 receipt). */
  digest?: string;
  /** Expected git object ID a ref resolves to (`git.tag`). */
  object?: string;
  /** Require a cryptographically good signature (`git.commit`, `git.tag`). */
  signed?: boolean;
}

/** What the framework hands a verifier for one query. Built by `reconcileEffect` from the intent record. */
export interface EffectVerifierRequest {
  effectId: string;
  scope: EffectScope;
  kind: string;
  target: string;
  context: EffectContext;
  payloadDigest: string;
  intentRecordedAt: string;
  /** Always present; `{}` when the caller pinned nothing. */
  expected: EffectVerifierExpectation;
  /** Aborted when the framework timeout fires. Verifiers SHOULD pass it to I/O. */
  signal: AbortSignal;
}

/** Digest-and-reference-only evidence. Never raw payloads, bodies, secrets or local paths. */
export type EffectVerifierEvidence = Record<string, string | number | boolean | null>;

/** A verifier's answer. The framework validates it before anything is recorded. */
export interface EffectVerifierObservation {
  result: VerificationResult;
  /** A reason code from the contract table for `result`. */
  reason: string;
  /** True only for an authenticated, successful, fully paged query. Required for `absent`. */
  complete: boolean;
  /** `sha256:<hex>`. When `evidence` is given the framework computes it and the two must agree. */
  evidenceDigest?: string;
  /**
   * Structured evidence. The framework digests `canonicalJson(evidence)` into
   * `evidenceDigest` and returns it to the caller; it is never written to the ledger.
   */
  evidence?: EffectVerifierEvidence;
}

/**
 * A per-kind verifier plugin. `verify` should return `unknown` itself for any
 * failure it can classify; any throw becomes `unknown` (see `EffectVerifierError`).
 */
export interface EffectVerifier {
  /** A core kind or an extension kind `x.<vendor>.<name>`. */
  readonly kind: string;
  /** Semver `MAJOR.MINOR.PATCH`. Recorded in every verification. */
  readonly version: string;
  /** Whether this verifier may ever return `absent`. When false, `absent` becomes `unknown`. */
  readonly canReportAbsent: boolean;
  verify(request: EffectVerifierRequest): Promise<EffectVerifierObservation>;
}

/** A registry keyed by kind; one verifier per kind. */
export interface EffectVerifierRegistry {
  get(kind: string): EffectVerifier | undefined;
  /** Registered kinds, sorted. */
  kinds(): string[];
  /** `{kind, version, canReportAbsent}` for every registered verifier, sorted by kind. */
  listKinds(): VerifierRef[];
}

/**
 * Throw from `verify` to report a classified `unknown`. Any other throw maps to
 * `unknown` / `server-error`; an abort after the timeout maps to `timeout`.
 * The message is never recorded.
 */
export class EffectVerifierError extends Error {
  constructor(readonly reason: UnknownReason, message = 'Effect verifier could not settle the target') {
    super(message);
    this.name = 'EffectVerifierError';
  }
}
