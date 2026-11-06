// Records a credential-free decision artifact through existing effect intent/reconcile receipts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { projectAiwgWritePath, resolveProjectAiwgDirForWrite } from '../config/project-artifacts.js';
import { recordIntent, reconcileEffect, type EffectLedger } from '../effects/ledger.js';
import { payloadDigest } from '../effects/identity.js';
import { assertDigestOnly } from '../effects/redaction.js';
import { fileDigestVerifier } from '../effects/verifiers/file.js';
import { createVerifierRegistry } from '../effects/verifiers/registry.js';
import { hitlDigest, resolveHitlAuthorization, validHitlAction } from './hitl.js';
import { HITL_CATEGORIES, HITL_ENVIRONMENTS, type HitlContext } from './hitl-types.js';

/** Resolve again at receipt time. A preview result supplied by an agent is never trusted. */
export async function recordHitlAuthorization(ledger: EffectLedger, action: unknown, context: HitlContext) {
  const resolution = resolveHitlAuthorization(action, context);
  const receipt = {
    kind: 'hitl-authorization', evaluatedAtDigest: hitlDigest(context.now),
    sessionGrantDigest: hitlDigest(context.sessionAuthorization ?? null), ...resolution,
    // Arbitrary user strings become digests, including paths, repo identity and profile names.
    matchedProfile: resolution.matchedProfile ? hitlDigest(resolution.matchedProfile) : null,
    action: validHitlAction(action) ? {
      category: HITL_CATEGORIES.find(category => category === action.category) ?? 'restricted',
      descriptorDigest: hitlDigest(action), categoryDigest: hitlDigest(action.category),
      ...(action.actor === undefined ? {} : { actorDigest: hitlDigest(action.actor) }),
      ...(action.inputDigest === undefined ? {} : { inputDigest: action.inputDigest }),
      reversible: action.reversible, impact: action.impact,
    } : { descriptorDigest: hitlDigest(action) },
    scope: validHitlAction(action) ? {
      environmentClass: HITL_ENVIRONMENTS.find(environment => environment === action.environment) ?? 'restricted',
      repoDigest: hitlDigest(action.repo), environmentDigest: hitlDigest(action.environment),
      resourceDigests: action.resources.map(hitlDigest),
    } : null,
    origins: context.layers.map(layer => ({ sourceDigest: hitlDigest(layer.source), policyDigest: hitlDigest(layer.policy ?? null) })),
  };
  assertDigestOnly(receipt);
  const bytes = JSON.stringify(receipt) + '\n';
  const digest = payloadDigest(bytes);
  const root = resolveProjectAiwgDirForWrite(ledger.projectDir);
  const relativePath = join('effects', 'authorization', `${digest.slice(7)}.json`);
  const file = projectAiwgWritePath(ledger.projectDir, relativePath);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== bytes) throw new Error('HITL receipt identity conflict');
  }
  const intent = await recordIntent(ledger, {
    kind: 'file.digest', target: `file:${file}@${digest}`, payloadDigest: digest,
    context: { policyVersion: resolution.policyVersion, decision: resolution.decision, provenance: resolution.provenance, receiptDigest: digest },
  });
  const reconciled = await reconcileEffect(ledger, intent.effectId, {
    verifiers: createVerifierRegistry([fileDigestVerifier({ root })]),
  });
  return { resolution, file, intent, reconciled };
}
