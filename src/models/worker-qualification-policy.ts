/** Explain recorded worker-policy drift without disclosing policy values or dynamic keys. */
import path from 'node:path';
import type { WorkerPolicyError } from './provider-policy.js';
import { WorkerSelectionPolicySchema } from './worker-selection-policy.js';
import { qualificationDigest } from './qualification-digest.mjs';
import type { WorkerPolicyDiagnostic, WorkerSelectionPolicy } from './types.js';

type Rejections = NonNullable<WorkerPolicyError['details']>['rejections'];
interface PolicyRecord {
  installation?: { cwd?: string; policy?: WorkerSelectionPolicy; effectiveConfigDigest?: string };
}
const policyPointer = '/defaults/workerSelection';
// Schema-owned names are public; model IDs, role aliases, paths and values are not.
const fieldNames: Record<string, string[]> = {
  guards: Object.keys(WorkerSelectionPolicySchema.shape.guards.unwrap().shape),
  dataPolicy: Object.keys(WorkerSelectionPolicySchema.shape.dataPolicy.unwrap().shape),
  freshness: Object.keys(WorkerSelectionPolicySchema.shape.freshness.unwrap().shape),
};
function changedPointers(before: WorkerSelectionPolicy, after: WorkerSelectionPolicy | undefined): string[] {
  const pointers: string[] = [];
  const oldPolicy = before as Record<string, unknown>;
  const newPolicy = (after ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(WorkerSelectionPolicySchema.shape)) {
    if (qualificationDigest([oldPolicy[key]]) === qualificationDigest([newPolicy[key]])) continue;
    const fields = fieldNames[key];
    if (!fields) { pointers.push(`${policyPointer}/${key}`); continue; }
    const oldFields = (oldPolicy[key] ?? {}) as Record<string, unknown>;
    const newFields = (newPolicy[key] ?? {}) as Record<string, unknown>;
    for (const field of fields) {
      if (qualificationDigest([oldFields[field]]) !== qualificationDigest([newFields[field]])) {
        pointers.push(`${policyPointer}/${key}/${field}`);
      }
    }
  }
  return pointers.length ? pointers : [policyPointer];
}

/** Called only for the loader's fixed rejection stages, after signature verification. */
export function workerQualificationPolicyDiagnostic(rejections: Rejections, records: PolicyRecord[] | undefined,
  policy: WorkerSelectionPolicy | undefined): WorkerPolicyDiagnostic | null {
  const diagnostics = rejections.filter(row => row.reason === 'effective-config-digest' && row.registration !== null)
    .map(row => {
      const installed = records?.[row.registration!]?.installation;
      // Older or inconsistent records cannot establish which individual fields changed.
      const pointers = installed?.policy && qualificationDigest(installed.policy) === installed.effectiveConfigDigest
        ? changedPointers(installed.policy, policy) : [policyPointer];
      const workspace = typeof installed?.cwd === 'string' && path.isAbsolute(installed.cwd)
        ? ` ${JSON.stringify(installed.cwd)}` : '';
      return { code: 'OG_ADAPTER_UNQUALIFIED' as const,
        pointer: pointers.length === 1 ? pointers[0] : policyPointer,
        message: `Worker policy changed since qualification (effective-config-digest; pointers: ${pointers.join(', ')}); `
          + `align the shared project policy in the conductor and worker trees, then requalify the worker tree${workspace} `
          + 'by running aiwg doctor --probe-workers --qualify there.' };
    });
  return diagnostics.length ? { code: 'OG_ADAPTER_UNQUALIFIED',
    pointer: diagnostics.length === 1 ? diagnostics[0].pointer : policyPointer,
    message: diagnostics.map(row => row.message).join(' ') } : null;
}
