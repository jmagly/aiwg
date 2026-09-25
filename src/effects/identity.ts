/**
 * Effect identity: the `aiwg.effect/v1` derivation, the contract-registered
 * adapter derivations (`d13.review/v1`), payload digests and input grammar.
 *
 * Every canonical form is RFC 8785 JSON from `artifact-trust.canonicalJson`.
 *
 * @see docs/contracts/effect-ledger.v1.md "Effect identity"
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../security/artifact-trust.js';
import { usageError } from './errors.js';
import {
  CORE_EFFECT_KINDS,
  EFFECT_ID_DERIVATION_NAMES,
  EFFECT_SUBSYSTEMS,
  type EffectContext,
  type EffectIdDerivationName,
  type EffectIdentityInput,
  type EffectScope,
} from './types.js';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const EFFECT_ID_V1_PATTERN = /^eff1_[a-z2-7]{51}[aq]$/;
export const D13_REVIEW_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const WRITER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const EXTENSION_KIND_PATTERN = /^x\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const TARGET_PATTERN = /^(?:gitea|github|git|git-tag|file|release|decision|review|x-[a-z0-9-]+):[^\s]+$/;
const CONTEXT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const D13_CONTEXT_KEYS = ['continuationId', 'proposalVersion', 'reviewId'];

const sha256Hex = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** `"sha256:"` plus lowercase hex SHA-256 of the bytes (strings are UTF-8). */
export function sha256Digest(bytes: string | Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** Unpadded lowercase RFC 4648 section 6 base32, most significant bit first. */
export function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function isCoreEffectKind(kind: string): boolean {
  return (CORE_EFFECT_KINDS as readonly string[]).includes(kind);
}

export function isEffectKind(kind: unknown): kind is string {
  return typeof kind === 'string' && (isCoreEffectKind(kind) || (kind.length <= 128 && EXTENSION_KIND_PATTERN.test(kind)));
}

export function assertEffectScope(scope: unknown): asserts scope is EffectScope {
  const value = scope as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'project,subsystem,tenant'
    || typeof value.tenant !== 'string' || !IDENTIFIER_PATTERN.test(value.tenant)
    || typeof value.project !== 'string' || !IDENTIFIER_PATTERN.test(value.project)
    || !(EFFECT_SUBSYSTEMS as readonly unknown[]).includes(value.subsystem)) {
    throw usageError('Effect scope must be {tenant, project, subsystem} with a known subsystem', 'invalid-scope');
  }
}

export function assertWriterId(writer: unknown): asserts writer is string {
  if (typeof writer !== 'string' || !WRITER_ID_PATTERN.test(writer)) throw usageError('Effect writer ID is invalid', 'invalid-writer');
}

export function assertEffectKind(kind: unknown): asserts kind is string {
  if (!isEffectKind(kind)) throw usageError('Unknown effect kind', 'unknown-kind');
}

export function assertEffectTarget(target: unknown): asserts target is string {
  if (typeof target !== 'string' || target.length > 1024 || !TARGET_PATTERN.test(target)) {
    throw usageError('Effect target must be a <scheme>:<ref> reference', 'invalid-target');
  }
}

export function assertEffectContext(context: unknown): asserts context is EffectContext {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw usageError('Effect context must be a flat object', 'invalid-context');
  const entries = Object.entries(context as Record<string, unknown>);
  if (entries.length > 16) throw usageError('Effect context has more than 16 members', 'invalid-context');
  for (const [key, value] of entries) {
    const scalar = (typeof value === 'string' && value.length <= 256)
      || (typeof value === 'number' && Number.isSafeInteger(value))
      || typeof value === 'boolean';
    if (!CONTEXT_KEY_PATTERN.test(key) || !scalar) throw usageError('Effect context members must be named scalars', 'invalid-context');
  }
}

export function assertPayloadDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256_DIGEST_PATTERN.test(value)) throw usageError('Payload digest must be sha256:<hex>', 'invalid-payload-digest');
}

/** Digest the exact bytes an effect sends, or `canonicalJson` of a structured request. */
export function payloadDigest(payload: string | Uint8Array | Record<string, unknown> | unknown[]): string {
  if (typeof payload === 'string' || payload instanceof Uint8Array) return sha256Digest(payload);
  return sha256Digest(canonicalJson(payload));
}

export interface EffectIdDerivation {
  readonly name: EffectIdDerivationName;
  readonly pattern: RegExp;
  /** Kinds this derivation may identify. */
  permitsKind(kind: string): boolean;
  /** Validate the identity inputs and derive the ID. */
  derive(input: EffectIdentityInput): string;
}

function assertIdentityInput(input: EffectIdentityInput): void {
  if (!input || typeof input !== 'object') throw usageError('Effect identity input is required', 'invalid-identity');
  assertEffectScope(input.scope);
  assertEffectKind(input.kind);
  assertEffectTarget(input.target);
  assertEffectContext(input.context);
}

const aiwgEffectV1: EffectIdDerivation = Object.freeze({
  name: 'aiwg.effect/v1' as const,
  pattern: EFFECT_ID_V1_PATTERN,
  permitsKind: (kind: string) => kind !== 'decision.review.continuation',
  derive(input: EffectIdentityInput): string {
    assertIdentityInput(input);
    if (input.kind === 'decision.review.continuation') throw usageError('decision.review.continuation uses the d13.review/v1 derivation', 'derivation-kind-mismatch');
    const canonical = canonicalJson({ v: 1, scope: input.scope, kind: input.kind, target: input.target, context: input.context });
    return `eff1_${base32Lower(createHash('sha256').update(canonical, 'utf8').digest())}`;
  },
});

/**
 * `d13.review/v1`: exactly D13's `reviewDigest({reviewId, continuationId,
 * proposalVersion})` (`src/decision/review/validate.ts`), so persisted reviews
 * keep their identity.
 */
const d13ReviewV1: EffectIdDerivation = Object.freeze({
  name: 'd13.review/v1' as const,
  pattern: D13_REVIEW_ID_PATTERN,
  permitsKind: (kind: string) => kind === 'decision.review.continuation',
  derive(input: EffectIdentityInput): string {
    assertIdentityInput(input);
    const context = input.context;
    if (input.kind !== 'decision.review.continuation' || input.scope.subsystem !== 'review'
      || Object.keys(context).sort().join(',') !== D13_CONTEXT_KEYS.join(',')
      || typeof context.reviewId !== 'string' || !context.reviewId
      || typeof context.continuationId !== 'string' || !context.continuationId
      || typeof context.proposalVersion !== 'number' || !Number.isSafeInteger(context.proposalVersion) || context.proposalVersion < 1) {
      throw usageError('d13.review/v1 needs kind decision.review.continuation, subsystem review and context {reviewId, continuationId, proposalVersion}', 'derivation-input-invalid');
    }
    const identity = { reviewId: context.reviewId, continuationId: context.continuationId, proposalVersion: context.proposalVersion };
    return sha256Digest(canonicalJson(identity));
  },
});

/**
 * Contract-registered derivations. Registration is closed: a new derivation
 * needs a contract revision (and a schema `idDerivation` value), so this map is
 * frozen rather than extensible at runtime.
 */
export const EFFECT_ID_DERIVATIONS: Readonly<Record<EffectIdDerivationName, EffectIdDerivation>> = Object.freeze({
  'aiwg.effect/v1': aiwgEffectV1,
  'd13.review/v1': d13ReviewV1,
});

export function effectIdDerivation(name: unknown): EffectIdDerivation {
  if (!(EFFECT_ID_DERIVATION_NAMES as readonly unknown[]).includes(name)) throw usageError('Unknown effect ID derivation', 'unknown-derivation');
  return EFFECT_ID_DERIVATIONS[name as EffectIdDerivationName];
}

/** The derivation a kind uses by default. */
export function defaultDerivationFor(kind: string): EffectIdDerivationName {
  return kind === 'decision.review.continuation' ? 'd13.review/v1' : 'aiwg.effect/v1';
}

/**
 * Derive an effect ID. Attempt, time, actor, host and payload are not inputs.
 * `derivation` defaults to the kind's registered derivation.
 */
export function effectId(input: EffectIdentityInput, derivation: EffectIdDerivationName = defaultDerivationFor(input?.kind)): string {
  return effectIdDerivation(derivation).derive(input);
}

/** Strict reader-side check. Uppercase, padding, other lengths and non-zero trailing bits are rejected, never normalized. */
export function isValidEffectId(id: unknown, derivation?: EffectIdDerivationName): id is string {
  if (typeof id !== 'string') return false;
  if (derivation) return effectIdDerivation(derivation).pattern.test(id);
  return EFFECT_ID_V1_PATTERN.test(id) || D13_REVIEW_ID_PATTERN.test(id);
}

export function assertEffectId(id: unknown, derivation?: EffectIdDerivationName): asserts id is string {
  if (!isValidEffectId(id, derivation)) throw usageError('Malformed effect ID', 'malformed-effect-id');
}
