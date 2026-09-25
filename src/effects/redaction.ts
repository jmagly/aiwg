/**
 * Digest-only guard applied to every effect ledger document before it is
 * signed or written.
 *
 * It composes the D13 restricted-material scan (`assertReviewProjection`,
 * `src/decision/review/validate.ts`) with the evidence-bundle restricted member
 * names (`src/evidence/bundle.ts`), plus private-key and token material and the
 * raw-payload member names the contract forbids. Rejected material is never
 * echoed.
 */

import { assertReviewProjection } from '../decision/review/validate.js';
import { EVIDENCE_RESTRICTED_KEY } from '../evidence/bundle.js';
import { EffectLedgerError } from './errors.js';

/** Raw effect payload members. `payload` is allowed only as the DSSE envelope member. */
const RAW_PAYLOAD_KEY = /^(?:body|rawBody|raw_body|content|text|request|response|payload)$/;
/** PEM blocks, base64 PKCS#8 Ed25519 private keys, and common token shapes. */
const RESTRICTED_MATERIAL = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|MC4CAQAwBQYDK2Vw|\b(?:aiwg_(?:at|rt)_[A-Za-z0-9_-]{6,}|gh[opsu]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,})/;

const restricted = () => new EffectLedgerError('usage', 'Effect ledger documents are digest-only; restricted material was refused', 'restricted-material');

function visit(value: unknown, parentKey: string | undefined): void {
  if (typeof value === 'string') {
    if (RESTRICTED_MATERIAL.test(value)) throw restricted();
  } else if (Array.isArray(value)) {
    for (const item of value) visit(item, parentKey);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const envelopePayload = key === 'payload' && parentKey === 'envelope';
      if (EVIDENCE_RESTRICTED_KEY.test(key) || (!envelopePayload && RAW_PAYLOAD_KEY.test(key))) throw restricted();
      visit(child, key);
    }
  }
}

/** Throw a usage error (exit 2) when `value` carries restricted material or raw payload members. */
export function assertDigestOnly(value: unknown): void {
  try { assertReviewProjection(value); }
  catch { throw restricted(); }
  visit(value, undefined);
}

/** True when `text` contains private-key or token-shaped material. For output canary scans. */
export function containsRestrictedMaterial(text: string): boolean {
  return RESTRICTED_MATERIAL.test(text) || /vault:\/\//i.test(text);
}
