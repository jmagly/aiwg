/**
 * #1567 composition: effect records link the operator decisions that
 * authorized them through `links.operatorDecisionEventId` and
 * `links.operatorDecisionRecordHash`. This module checks those links against
 * an operator-decision audit chain. It is read-only on both sides: there is
 * no write coupling between the ledger and the decision store.
 *
 * @see docs/contracts/effect-ledger.v1.md "Composition"
 * @see docs/contracts/operator-decision-audit.v1.md
 */

import type { EffectLedger } from './ledger.js';
import { readAllSegments } from './reader.js';
import type { EffectLinks } from './types.js';

/** The two fields of an operator-decision record the links bind to. */
export interface DecisionEventRef {
  event_id: string;
  record_hash: string;
}

export type DecisionLinkFailureReason = 'decision-event-missing' | 'decision-record-hash-mismatch' | 'decision-record-hash-orphan';

export interface DecisionLinkFailure {
  reason: DecisionLinkFailureReason;
  writer: string;
  seq: number;
  effectId: string;
  operatorDecisionEventId?: string;
}

export interface DecisionLinkVerification {
  ok: boolean;
  /** Ledger records that carry an operator-decision link. */
  linked: number;
  /** Distinct operator-decision events referenced. */
  events: number;
  failures: DecisionLinkFailure[];
}

/** The operator-decision links a ledger record carries, or null. */
export function decisionLinkOf(links: EffectLinks | undefined): { eventId?: string; recordHash?: string } | null {
  if (!links || (!links.operatorDecisionEventId && !links.operatorDecisionRecordHash)) return null;
  return {
    ...(links.operatorDecisionEventId ? { eventId: links.operatorDecisionEventId } : {}),
    ...(links.operatorDecisionRecordHash ? { recordHash: links.operatorDecisionRecordHash } : {}),
  };
}

/**
 * Check every operator-decision link in the ledger against `decisions`. A
 * linked event ID must exist; a linked record hash must equal that event's
 * `record_hash`; a record hash without an event ID is refused. The caller
 * verifies the decision chain itself (`verifyDecisionChain`).
 */
export async function verifyDecisionLinks(ledger: EffectLedger, decisions: readonly DecisionEventRef[]): Promise<DecisionLinkVerification> {
  const byId = new Map(decisions.map(record => [record.event_id, record.record_hash]));
  const failures: DecisionLinkFailure[] = [];
  const events = new Set<string>();
  let linked = 0;
  for (const segment of await readAllSegments(ledger.paths())) {
    for (const line of segment.lines) {
      const predicate = line.decoded?.statement.predicate;
      const link = decisionLinkOf(predicate?.links);
      if (!predicate || !link) continue;
      linked += 1;
      const at = { writer: segment.writer, seq: line.index, effectId: predicate.effectId };
      if (!link.eventId) { failures.push({ ...at, reason: 'decision-record-hash-orphan' }); continue; }
      events.add(link.eventId);
      const recordHash = byId.get(link.eventId);
      if (recordHash === undefined) failures.push({ ...at, reason: 'decision-event-missing', operatorDecisionEventId: link.eventId });
      else if (link.recordHash && link.recordHash !== recordHash) failures.push({ ...at, reason: 'decision-record-hash-mismatch', operatorDecisionEventId: link.eventId });
    }
  }
  return { ok: failures.length === 0, linked, events: events.size, failures };
}
