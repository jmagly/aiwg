import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION,
  type DecisionLifecyclePolicy } from '../../../../src/decision/lifecycle.js';

export function jobPolicy(retentionMs: number, exportMode: 'denied' | 'sanitized' = 'denied'): DecisionLifecyclePolicy {
  return { version: DECISION_LIFECYCLE_VERSION,
    surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
      classification: 'restricted', accessScopes: ['case-worker'], retentionMs,
      export: exportMode, deletion: 'erase', backup: 'expire-with-primary',
    }])) as DecisionLifecyclePolicy['surfaces'] };
}
