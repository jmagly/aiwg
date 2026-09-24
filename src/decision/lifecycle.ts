/** Common host-side lifecycle contract. Never derive these controls from model state. */
export const DECISION_LIFECYCLE_VERSION = 'decision-lifecycle/v1' as const;

export const DECISION_LIFECYCLE_SURFACES = [
  'state', 'receipt', 'trace', 'debug-sidecar', 'cache', 'job', 'review',
  'calibration', 'evaluation', 'export', 'preprocessing-lineage',
] as const;
export type DecisionLifecycleSurface = typeof DECISION_LIFECYCLE_SURFACES[number];

export interface DecisionLifecycleRule {
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  accessScopes: string[];
  retentionMs: number;
  export: 'denied' | 'sanitized';
  deletion: 'erase' | 'tombstone';
  backup: 'not-persisted' | 'expire-with-primary';
}

export interface DecisionLifecyclePolicy {
  version: typeof DECISION_LIFECYCLE_VERSION;
  surfaces: Record<DecisionLifecycleSurface, DecisionLifecycleRule>;
}

export interface DecisionLifecycleReference {
  surface: DecisionLifecycleSurface;
  opaqueId: string;
}

export interface DecisionLifecycleHold {
  subject: string;
  reason: string;
  scope: DecisionLifecycleSurface[];
  expiresAt: number;
  authorizedBy: string;
}

export interface DecisionLifecycleTombstone {
  subject: string;
  reference: DecisionLifecycleReference;
  deletedAt: number;
}

export interface DecisionLifecycleStore {
  /** Erase body, keys and identifiers; retain only the opaque reference in a tombstone. */
  erase(reference: DecisionLifecycleReference): Promise<void>;
  /** Store a tombstone that backup restores cannot overwrite. */
  tombstone(value: DecisionLifecycleTombstone): Promise<void>;
  /** Reverse references are discovered by the host, never by model-visible state. */
  links(subject: string): Promise<DecisionLifecycleReference[]>;
  holds(subject: string): Promise<DecisionLifecycleHold[]>;
  recordHold(hold: DecisionLifecycleHold): Promise<void>;
  releaseHold(hold: DecisionLifecycleHold, actor: string, reason: string, at: number): Promise<void>;
}

export function validateDecisionLifecyclePolicy(policy: DecisionLifecyclePolicy): void {
  if (policy?.version !== DECISION_LIFECYCLE_VERSION || !policy.surfaces
    || Object.keys(policy.surfaces).length !== DECISION_LIFECYCLE_SURFACES.length
    || Object.keys(policy.surfaces).some(surface => !DECISION_LIFECYCLE_SURFACES.includes(surface as DecisionLifecycleSurface))) {
    throw new Error('Decision lifecycle policy is incomplete');
  }
  for (const surface of DECISION_LIFECYCLE_SURFACES) {
    const rule = policy.surfaces[surface];
    if (!rule || !['public', 'internal', 'confidential', 'restricted'].includes(rule.classification)
      || !Array.isArray(rule.accessScopes) || !rule.accessScopes.length
      || rule.accessScopes.some(scope => typeof scope !== 'string' || !scope)
      || !Number.isSafeInteger(rule.retentionMs) || rule.retentionMs <= 0
      || !['denied', 'sanitized'].includes(rule.export) || !['erase', 'tombstone'].includes(rule.deletion)
      || !['not-persisted', 'expire-with-primary'].includes(rule.backup)) {
      throw new Error('Decision lifecycle rule is incomplete');
    }
  }
}

/** Hold requires an independent authorization decision and finite expiry. */
export async function placeDecisionLifecycleHold(
  hold: DecisionLifecycleHold, authorize: (hold: DecisionLifecycleHold) => Promise<boolean>,
  store: DecisionLifecycleStore, now: number,
): Promise<DecisionLifecycleHold> {
  if (!hold.subject || !hold.reason || !hold.authorizedBy || !hold.scope.length
    || hold.scope.some(surface => !DECISION_LIFECYCLE_SURFACES.includes(surface))
    || !Number.isSafeInteger(hold.expiresAt) || hold.expiresAt <= now) throw new Error('Decision lifecycle hold denied');
  let approved = false;
  try { approved = await authorize(hold); } catch { /* authorization fails closed */ }
  if (!approved) throw new Error('Decision lifecycle hold denied');
  const stored = structuredClone(hold);
  try { await store.recordHold(stored); }
  catch { throw new Error('Decision lifecycle hold recording failed'); }
  return stored;
}

export async function releaseDecisionLifecycleHold(
  hold: DecisionLifecycleHold, actor: string, reason: string,
  authorize: (hold: DecisionLifecycleHold, actor: string) => Promise<boolean>,
  store: DecisionLifecycleStore, now: number,
): Promise<void> {
  if (!actor || !reason || !Number.isSafeInteger(now) || now < 0) throw new Error('Decision lifecycle hold release denied');
  let approved = false;
  try { approved = await authorize(hold, actor); } catch { /* authorization fails closed */ }
  if (!approved) throw new Error('Decision lifecycle hold release denied');
  try { await store.releaseHold(hold, actor, reason, now); }
  catch { throw new Error('Decision lifecycle hold release failed'); }
}

/** Cascading erasure runs only after the host resolves linked records. No body is returned. */
export async function eraseDecisionSubject(
  subject: string, policy: DecisionLifecyclePolicy, store: DecisionLifecycleStore, now: number,
): Promise<DecisionLifecycleTombstone[]> {
  validateDecisionLifecyclePolicy(policy);
  if (!subject || !Number.isSafeInteger(now) || now < 0) throw new Error('Decision lifecycle deletion denied');
  let links: DecisionLifecycleReference[];
  let holds: DecisionLifecycleHold[];
  try { links = await store.links(subject); holds = await store.holds(subject); }
  catch { throw new Error('Decision lifecycle lookup failed'); }
  if (holds.some(hold => hold.subject === subject && hold.expiresAt > now
    && links.some(link => hold.scope.includes(link.surface)))) throw new Error('Decision lifecycle deletion denied by hold');
  const tombstones: DecisionLifecycleTombstone[] = [];
  for (const reference of links) {
    if (!DECISION_LIFECYCLE_SURFACES.includes(reference.surface) || !reference.opaqueId) {
      throw new Error('Decision lifecycle reference invalid');
    }
    const tombstone = { subject, reference: { ...reference }, deletedAt: now };
    // Publish the tombstone before erasure so a failed erase cannot resurrect on restore.
    try { await store.tombstone(tombstone); await store.erase(reference); }
    catch { throw new Error('Decision lifecycle erasure failed'); }
    tombstones.push(tombstone);
  }
  return tombstones;
}

/** A restored backup cannot make erased content queryable. */
export function mayRestoreDecisionReference(
  reference: DecisionLifecycleReference, createdAt: number, now: number, policy: DecisionLifecyclePolicy,
  tombstones: ReadonlyArray<DecisionLifecycleTombstone>,
): boolean {
  validateDecisionLifecyclePolicy(policy);
  if (!DECISION_LIFECYCLE_SURFACES.includes(reference.surface) || !Number.isSafeInteger(createdAt)
    || !Number.isSafeInteger(now) || now < createdAt) return false;
  return !tombstones.some(value => value.reference.surface === reference.surface && value.reference.opaqueId === reference.opaqueId)
    && now - createdAt < policy.surfaces[reference.surface].retentionMs;
}
