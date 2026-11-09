// Verifies a persisted HITL receipt against the exact host effect and current authority.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveProjectAiwgDirForWrite } from '../config/project-artifacts.js';
import { lookupEffect, type EffectLedger } from '../effects/ledger.js';
import { payloadDigest } from '../effects/identity.js';
import { fileDigestVerifier } from '../effects/verifiers/file.js';
import { runVerifier } from '../effects/verifiers/registry.js';
import { hitlDigest, resolveHitlAuthorization, validHitlAction } from './hitl.js';
import type { HitlContext, HitlResolution } from './hitl-types.js';
import { ensureLedgerDirectories, withLedgerLock } from '../effects/store.js';
import { recordDurableUse, refreshDurableAuthorization } from './hitl-durable-store.js';

export interface HitlReceiptRef { file: string; effectId: string }

/** Receipt existence is historical evidence; only this fresh comparison authorizes dispatch. */
export async function consumeHitlAuthorization(ledger: EffectLedger, action: unknown, context: HitlContext,
  reference: HitlReceiptRef): Promise<HitlResolution> {
  await ensureLedgerDirectories(ledger.paths());
  return withLedgerLock(ledger.paths(), 'authorization-index', ledger.lockTimeoutMs,
    () => consumeCurrentAuthorization(ledger, action, context, reference));
}

async function consumeCurrentAuthorization(ledger: EffectLedger, action: unknown, context: HitlContext,
  reference: HitlReceiptRef): Promise<HitlResolution> {
  context = await refreshDurableAuthorization(ledger, context);
  const resolution = resolveHitlAuthorization(action, context);
  const refuse = (reason: string): HitlResolution => ({ ...resolution, decision: 'escalate', reason });
  if (!validHitlAction(action)) return refuse('invalid-action-descriptor');
  if (context.durableAuthorization?.failures.length) return resolution;
  const effect = await lookupEffect(ledger, reference.effectId);
  const intent = effect.records.find(record => record.phase === 'intent');
  if (effect.kind !== 'file.digest' || effect.tombstoned || effect.result !== 'present' || !intent
    || effect.target !== `file:${resolve(reference.file)}@${intent.payloadDigest}`) return refuse('approval-unverified');
  const verification = await runVerifier(fileDigestVerifier({ root: resolveProjectAiwgDirForWrite(ledger.projectDir) }), {
    effectId: reference.effectId, scope: ledger.scope, kind: effect.kind, target: effect.target,
    context: {}, payloadDigest: intent.payloadDigest, intentRecordedAt: intent.recordedAt, expected: { digest: intent.payloadDigest },
  });
  if (verification.observation.result !== 'present') return refuse('approval-unverified');
  const bytes = await readFile(reference.file, 'utf8');
  if (payloadDigest(bytes) !== intent.payloadDigest) return refuse('approval-unverified');
  const receipt = JSON.parse(bytes);
  if (receipt.kind !== 'hitl-authorization' || receipt.decision !== 'auto-authorized') return refuse('approval-not-authorized');
  if (action.category === 'repo.edit' && (!receipt.action?.actorDigest || !receipt.action?.inputDigest || !receipt.expiresAt)) {
    return refuse('approval-missing-bindings');
  }
  if (receipt.action?.actorDigest !== (action.actor === undefined ? undefined : hitlDigest(action.actor))) return refuse('approval-actor-mismatch');
  if (receipt.action?.inputDigest !== action.inputDigest) return refuse('approval-input-mismatch');
  if (receipt.action?.descriptorDigest !== hitlDigest(action)) return refuse('approval-descriptor-mismatch');
  const now = Date.parse(context.now);
  if (!Number.isFinite(now)) return refuse('invalid-clock');
  if (!Number.isFinite(Date.parse(receipt.expiresAt)) || now >= Date.parse(receipt.expiresAt)) return refuse('approval-expired');
  if (resolution.decision !== 'auto-authorized') return resolution;
  if (receipt.policyVersion !== resolution.policyVersion || receipt.sessionGrantDigest !== hitlDigest(context.sessionAuthorization ?? null)) {
    return refuse('stale-policy-version');
  }
  if (receipt.provenance !== resolution.provenance
    || JSON.stringify(receipt.authorizationGrant) !== JSON.stringify(resolution.authorizationGrant)) return refuse('approval-grant-mismatch');
  if (resolution.provenance === 'durable-user') await recordDurableUse(ledger, resolution, reference.effectId);
  return resolution;
}
