// Projects an existing qualified worker plan into the common orchestration routing record.
import type { DelegationRecord } from './delegation.js';
import { MODEL_WRAPPERS, type ModelRole } from './wrapper-definitions.js';
import { workerSelectionTier } from './worker-tier-selection.js';
import { normalizeModelTier } from './tiers.js';
import type { ModelRouteRequest, ModelTier } from './types.js';
import type { WorkerPlanSnapshot, WorkerResolutionPlan } from './worker-plan.js';

export function workerRoutingRecord(orchestrator: DelegationRecord['orchestrator'], workerId: string,
  plan: WorkerResolutionPlan, snapshot: WorkerPlanSnapshot, requestedTier?: ModelTier, authority: ModelRouteRequest = {}): DelegationRecord {
  if (!plan.selected || !plan.role) throw new Error('Worker routing requires an eligible selected worker');
  const guidance = plan.policy?.roleGuidance?.[plan.role];
  if (!guidance) throw new Error('Selected worker has no role guidance');
  const rows = snapshot.catalog.discovery?.instances?.[plan.selected.cli]?.models ?? [];
  const observation = rows.find(row => row.apiModelId === plan.selected!.model || row.id === plan.selected!.model)?.worker;
  if (!observation) throw new Error('Selected worker has no model observation');
  const tier = workerSelectionTier(guidance.tier, plan.selected.model, observation.pricing);
  if (requestedTier && normalizeModelTier(requestedTier) !== normalizeModelTier(tier)) throw new Error(`Resolved worker tier ${tier} differs from --worker-tier ${requestedTier}`);
  return { version: 1, orchestrator, workerId, role: plan.role, requested_tier: requestedTier ?? null,
    resolved_tier: tier, resolved_model: plan.selected.model,
    wrapper: MODEL_WRAPPERS[(guidance.baseRole ?? plan.role) as ModelRole],
    strategy: plan.policy?.strategy ?? 'balanced', max_auto_tier: plan.policy?.maxAutoTier ?? null,
    election: authority.election ?? null, warnings: plan.diagnostics.map(item => item.message) };
}
