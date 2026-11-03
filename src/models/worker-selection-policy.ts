// Validates and merges worker selection restrictions and constrained role aliases.
import { z } from 'zod';
import { validLocalOnlyPath } from './conductor-data-policy.mjs';
import { integer } from '../schema/zod-validation.mjs';
import type { WorkerSelectionPolicy, WorkerPolicyOrigin, WorkerPolicyDiagnostic, WorkerDataPolicy } from './types.js';

const uniqueStrings = z.array(z.string().min(1)).refine(values => new Set(values).size === values.length, 'Duplicate entries');
const WorkerDataPolicySchema = z.strictObject({
  localOnlyPaths: uniqueStrings.refine(values => values.every(validLocalOnlyPath), 'Expected literal project-relative paths').optional(),
  allowedProcessing: z.array(z.enum(['local', 'remote'])).refine(values => new Set(values).size === values.length).optional(),
  allowProductImprovement: z.boolean().optional(),
  allowUnknown: z.boolean().optional(),
  maxRetentionDays: integer().nonnegative().optional(),
});
const baseRoles = ['efficiency', 'coding', 'reasoning'] as const;
const WorkerRoleSchema = z.strictObject({
  baseRole: z.enum(baseRoles).optional(),
  groups: uniqueStrings.refine(values => values.length > 0),
  tier: z.enum(['economy', 'standard', 'premium', 'flagship', 'max-quality']),
  initialEffort: z.string().min(1).nullable(),
  effortLadder: uniqueStrings,
  escalateAfter: integer().positive().optional(),
  maxEscalations: integer().nonnegative().optional(),
  deescalateAfter: integer().positive().optional(),
  allowNotApplicableEffort: z.boolean().optional(),
});
const reservedRoleKey = (key: string): boolean => key === 'prototype' || Object.hasOwn(Object.prototype, key);
const roleGuidanceSchema = z.preprocess((input, context) => {
  if (input !== null && typeof input === 'object') for (const role of Object.keys(input)) {
    if (reservedRoleKey(role)) context.addIssue({ code: 'custom', path: [role], message: `Reserved worker role alias key: ${role}` });
  }
  return input;
}, z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerRoleSchema));

/** Inherited object members never constitute configured role guidance. */
export function ownWorkerRoleGuidance(policy: WorkerSelectionPolicy | undefined, role: string) {
  return policy?.roleGuidance && Object.hasOwn(policy.roleGuidance, role) ? policy.roleGuidance[role] : undefined;
}

export const WorkerSelectionPolicySchema = z.strictObject({
  roleGuidance: roleGuidanceSchema.optional(),
  guards: z.strictObject({
    deniedEfforts: uniqueStrings.optional(),
    deniedModels: uniqueStrings.optional(),
    denySelfDelegation: z.boolean().optional(),
    denyConductorWorkerExecution: z.boolean().optional(),
    requireExactModel: z.boolean().optional(),
    allowedVisibility: z.array(z.enum(['listed', 'hidden'])).refine(v => new Set(v).size === v.length).optional(),
    allowedLifecycle: z.array(z.enum(['active', 'deprecated'])).refine(v => new Set(v).size === v.length).optional(),
    minimumIdentityEvidence: z.enum(['runtime-configured', 'backend-attested']).optional(),
  }).optional(),
  dataPolicy: WorkerDataPolicySchema.optional(),
  dataClasses: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerDataPolicySchema).optional(),
  freshness: z.strictObject({
    warnHours: integer().positive().optional(),
    blockHours: integer().positive().optional(),
    policyDays: integer().positive().optional(),
  }).optional(),
  taskClasses: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), z.string().min(1)).optional(),
}).superRefine((policy, context) => {
  for (const [role, guidance] of Object.entries(policy.roleGuidance ?? {})) {
    if (baseRoles.includes(role as typeof baseRoles[number]) ? guidance.baseRole !== undefined : guidance.baseRole === undefined) context.addIssue({ code: 'custom', path: ['roleGuidance', role], message: 'Unknown worker role requires a baseRole; base roles cannot be aliases' });
    const base = guidance.baseRole && ownWorkerRoleGuidance(policy, guidance.baseRole);
    if (base) for (const message of aliasRestrictionErrors(guidance, base)) context.addIssue({ code: 'custom', path: ['roleGuidance', role], message });
    if (guidance.effortLadder.includes('none') || (guidance.initialEffort === 'none' ? guidance.effortLadder.length !== 0 : guidance.initialEffort !== null && !guidance.effortLadder.includes(guidance.initialEffort))) {
      context.addIssue({ code: 'custom', path: ['roleGuidance', role], message: 'Initial effort must belong to the ladder; real none requires an empty ladder' });
    }
    if (guidance.initialEffort === null && (guidance.allowNotApplicableEffort !== true || guidance.effortLadder.length !== 0)) {
      context.addIssue({ code: 'custom', path: ['roleGuidance', role], message: 'Null effort requires an empty ladder and allowNotApplicableEffort=true' });
    }
  }
  for (const key of policy.guards?.deniedModels ?? []) {
    if (!isCanonicalWorkerModelKey(key)) context.addIssue({ code: 'custom', path: ['guards', 'deniedModels'], message: 'Noncanonical inference model key' });
  }
  if (policy.freshness?.warnHours !== undefined && policy.freshness.blockHours !== undefined && policy.freshness.warnHours > policy.freshness.blockHours) {
    context.addIssue({ code: 'custom', path: ['freshness'], message: 'warnHours must not exceed blockHours' });
  }
  for (const role of Object.values(policy.taskClasses ?? {})) {
    if (!baseRoles.includes(role as typeof baseRoles[number]) && !ownWorkerRoleGuidance(policy, role)?.baseRole) context.addIssue({ code: 'custom', path: ['taskClasses'], message: 'Unknown worker role' });
  }
});

/** Aliases may reorder/subset choices, never change base authority or escalation controls. */
function aliasRestrictionErrors(alias: import('./types.js').WorkerRoleGuidance, base: import('./types.js').WorkerRoleGuidance): string[] {
  const errors: string[] = [];
  if (alias.groups.some(group => !base.groups.includes(group))) errors.push('Alias groups widen base role');
  if (alias.effortLadder.some(effort => !base.effortLadder.includes(effort))
    || alias.initialEffort === 'none' && base.initialEffort !== 'none'
    || alias.initialEffort === null && base.initialEffort !== null
    || alias.allowNotApplicableEffort === true && base.allowNotApplicableEffort !== true) errors.push('Alias effort choices widen base role');
  if (alias.tier !== base.tier) errors.push('Alias tier must retain base role authority');
  if ((alias.maxEscalations ?? base.maxEscalations ?? 2) > (base.maxEscalations ?? 2)) errors.push('Alias maxEscalations widens base role');
  for (const key of ['escalateAfter', 'deescalateAfter'] as const) {
    if (alias[key] !== undefined && alias[key] !== (base[key] ?? 2)) errors.push(`Alias ${key} must retain base role control`);
  }
  return errors;
}

/** Canonical RFC3986 identity; installation and account never enter the key. */
export function workerModelKey(inferenceProvider: string, apiModelId: string): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(inferenceProvider) || !apiModelId) throw new Error('OG_CONFIG_REFERENCE: invalid inference model identity');
  return `${inferenceProvider}/${encodeURIComponent(apiModelId).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export function isCanonicalWorkerModelKey(key: string): boolean {
  const slash = key.indexOf('/');
  try { return slash > 0 && workerModelKey(key.slice(0, slash), decodeURIComponent(key.slice(slash + 1))) === key; } catch { return false; }
}

export const DEFAULT_WORKER_SELECTION: WorkerSelectionPolicy = {
  guards: { deniedEfforts: ['ultra'], deniedModels: [], denySelfDelegation: true, requireExactModel: true, allowedVisibility: ['listed'], allowedLifecycle: ['active'], minimumIdentityEvidence: 'runtime-configured' },
  dataPolicy: { allowedProcessing: ['local', 'remote'], allowProductImprovement: false, allowUnknown: false },
  freshness: { warnHours: 24, blockHours: 168, policyDays: 30 },
  taskClasses: { inventory: 'efficiency', implementation: 'coding', architecture: 'reasoning', review: 'reasoning' },
};

export interface WorkerPolicyLayer {
  source: string;
  authority: WorkerPolicyOrigin['authority'];
  digest: string;
  policy?: WorkerSelectionPolicy;
}

/** Merge leaves, preserving pre-merge explicit origins and attempted relaxations. */
export function mergeWorkerSelection(layers: WorkerPolicyLayer[]): {
  policy: WorkerSelectionPolicy; origins: Record<string, WorkerPolicyOrigin[]>; diagnostics: WorkerPolicyDiagnostic[];
} {
  const policy: Record<string, any> = Object.create(null);
  const origins: Record<string, WorkerPolicyOrigin[]> = Object.create(null);
  const diagnostics: WorkerPolicyDiagnostic[] = [];
  const visit = (target: Record<string, any>, input: Record<string, any>, parts: string[], layer: WorkerPolicyLayer): void => {
    for (const [key, value] of Object.entries(input)) {
      const path = [...parts, key];
      const pointer = `/defaults/workerSelection/${path.map(p => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (!Object.hasOwn(target, key)) target[key] = Object.create(null);
        visit(target[key], value, path, layer);
        continue;
      }
      const origin: WorkerPolicyOrigin = { source: layer.source, authority: layer.authority, digest: layer.digest, pointer, contribution: structuredClone(value) };
      const prior = origins[pointer] ?? [];
      const explicit = prior.filter(o => o.authority !== 'builtin');
      let effective = structuredClone(value);
      let relaxation = false;
      if (layer.authority !== 'builtin' && explicit.length > 0) {
        const previous = target[key];
        if (['deniedEfforts', 'deniedModels', 'localOnlyPaths'].includes(key)) effective = [...new Set([...previous, ...value])];
        else if (['allowedVisibility', 'allowedLifecycle', 'allowedProcessing'].includes(key)) {
          relaxation = value.some((v: string) => !previous.includes(v));
          effective = previous.filter((v: string) => value.includes(v));
        } else if (['denySelfDelegation', 'denyConductorWorkerExecution', 'requireExactModel'].includes(key)) {
          relaxation = previous === true && value === false;
          effective = previous || value;
        } else if (['allowUnknown', 'allowProductImprovement'].includes(key)) {
          relaxation = previous === false && value === true;
          effective = previous && value;
        } else if (['maxRetentionDays', 'warnHours', 'blockHours', 'policyDays'].includes(key)) {
          relaxation = value > previous;
          effective = Math.min(previous, value);
        } else if (key === 'minimumIdentityEvidence') {
          relaxation = previous === 'backend-attested' && value !== previous;
          effective = previous === 'backend-attested' ? previous : value;
        }
      }
      if (relaxation) diagnostics.push({ code: 'OG_POLICY_RELAXATION', pointer, message: 'Explicit restriction cannot relax an inherited restriction', origins: [...explicit, origin] });
      target[key] = effective;
      origins[pointer] = [...prior, origin];
    }
  };
  for (const layer of layers) if (layer.policy) {
    for (const [role, guidance] of Object.entries(layer.policy.roleGuidance ?? {})) {
      if (!guidance.baseRole) continue;
      const previous = ownWorkerRoleGuidance(policy, role);
      if (layer.authority !== 'project' || previous?.baseRole && previous.baseRole !== guidance.baseRole) diagnostics.push({
        code: 'OG_POLICY_RELAXATION', pointer: `/defaults/workerSelection/roleGuidance/${role}/baseRole`,
        message: 'Only project layers may declare constrained aliases; inherited aliases cannot change baseRole',
      });
    }
    visit(policy, layer.policy, [], layer);
  }
  for (const [role, guidance] of Object.entries((policy as WorkerSelectionPolicy).roleGuidance ?? {})) {
    const base = guidance.baseRole && ownWorkerRoleGuidance(policy, guidance.baseRole);
    if (base) for (const field of ['maxEscalations', 'escalateAfter', 'deescalateAfter'] as const) guidance[field] ??= base[field];
    if (guidance.baseRole && !base) diagnostics.push({
      code: 'OG_CONFIG_REFERENCE', pointer: `/defaults/workerSelection/roleGuidance/${role}/baseRole`, message: 'Alias base role has no guidance',
    });
  }
  const validation = WorkerSelectionPolicySchema.safeParse(policy);
  if (!validation.success) for (const issue of validation.error.issues) diagnostics.push({ code: 'OG_CONFIG_REFERENCE', pointer: `/defaults/workerSelection/${issue.path.join('/')}`, message: issue.message });
  // Data classes are applied as further restrictions to the base path.
  for (const dataClass of Object.values(policy.dataClasses ?? {}) as WorkerDataPolicy[]) {
    const base = policy.dataPolicy ?? {};
    if (dataClass.allowedProcessing) dataClass.allowedProcessing = dataClass.allowedProcessing.filter(p => !base.allowedProcessing || base.allowedProcessing.includes(p));
    for (const key of ['allowUnknown', 'allowProductImprovement'] as const) if (base[key] === false) dataClass[key] = false;
    if (base.maxRetentionDays !== undefined) dataClass.maxRetentionDays = Math.min(dataClass.maxRetentionDays ?? base.maxRetentionDays, base.maxRetentionDays);
  }
  return { policy, origins, diagnostics };
}
