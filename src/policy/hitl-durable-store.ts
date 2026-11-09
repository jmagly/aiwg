// Refreshes signed grant/use snapshots and records bounded receipt consumption in the existing ledger.
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { readAuthorizationGrants } from '../effects/authorization-store.js';
import { recordIntent, type EffectLedger } from '../effects/ledger.js';
import { payloadDigest } from '../effects/identity.js';
import { readAllSegments } from '../effects/reader.js';
import { AUTHORIZATION_GRANT_KIND } from '../effects/authorization-grant.js';
import { AUTHORIZATION_USE_KIND, type DurableAuthorization } from './hitl-durable.js';
import type { HitlContext, HitlResolution } from './hitl-types.js';

export async function refreshDurableAuthorization(ledger: EffectLedger, context: HitlContext): Promise<HitlContext> {
  const read = await readAuthorizationGrants(ledger);
  const workspaces = [await realpath(ledger.projectDir)];
  for (const layer of context.layers) {
    if (isAbsolute(layer.source)) workspaces.push(await realpath(dirname(dirname(layer.source))));
  }
  const snapshot: DurableAuthorization = { ...read, workspaces: [...new Set(workspaces)].sort(), uses: {} };
  if (!read.failures.length) {
    for (const segment of await readAllSegments(ledger.paths())) {
      for (const line of segment.lines) {
        const p = line.decoded?.statement.predicate;
        if (!p || segment.torn) { snapshot.failures.push({ reason: 'authorization-use-unreadable' }); continue; }
        // Purging a revocation can erase its link to an older grant. Do not resurrect authority.
        if (p.phase === 'tombstone' && p.kind === AUTHORIZATION_GRANT_KIND) {
          snapshot.historyUnavailable = true;
        }
        if (p.kind !== AUTHORIZATION_USE_KIND) continue;
        if (p.phase === 'tombstone') snapshot.usageUnavailable = true;
        else if (p.phase === 'intent') {
          const grantEffectId = p.context?.grantEffectId;
          if (typeof grantEffectId !== 'string') snapshot.usageUnavailable = true;
          else snapshot.uses[grantEffectId] = (snapshot.uses[grantEffectId] ?? 0) + 1;
        }
      }
    }
    // Verify again after the use scan: a concurrently damaged segment never supplies authority.
    const after = await readAuthorizationGrants(ledger);
    snapshot.failures.push(...after.failures);
    if (JSON.stringify(read.grants) !== JSON.stringify(after.grants)) snapshot.failures.push({ reason: 'authorization-grants-changed' });
  }
  return { ...context, durableAuthorization: snapshot };
}

/** Caller holds authorization-index lock, shared with grant recording and other consumers. */
export async function recordDurableUse(ledger: EffectLedger, resolution: HitlResolution, receiptEffectId: string) {
  const grant = resolution.authorizationGrant!;
  const context = { grantId: grant.grantId, grantEffectId: grant.effectId, grantRecordHash: grant.recordHash,
    receiptEffectId, useId: randomUUID() };
  return recordIntent(ledger, { kind: AUTHORIZATION_USE_KIND, target: `x-authorization-use:${grant.grantId}`,
    context, payloadDigest: payloadDigest(JSON.stringify(context)) });
}
