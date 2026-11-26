import {
  compileModelPolicy,
  type CompiledModelPolicy,
  type ProviderModelCatalog,
} from './provider-policy.js';
import { MODEL_WRAPPERS, type ModelRole } from './provider-models.js';
import { routeModelTier } from './router.js';
import type { ModelRouteRequest, ModelRouteDecision, ModelTier } from './types.js';
import type { ResolvedRoutableCapability } from '../artifacts/capability-resolver.js';
import { resolveWorkerPlan, type WorkerPlanRequest, type WorkerPlanSnapshot, type WorkerResolutionPlan } from './resolver.js';

export type RoutedCapabilityType = ResolvedRoutableCapability['type'];
export type WrapperLaunchMechanism = 'native-subagent' | 'aiwg-mc' | 'manual';

export interface WrapperRouteRequest extends ModelRouteRequest {
  role?: ModelRole;
  modelOverride?: string;
  provider: Parameters<typeof compileModelPolicy>[0]['provider'];
  capability: ResolvedRoutableCapability;
  assignment: string;
  launchMechanism: WrapperLaunchMechanism;
  catalog?: ProviderModelCatalog;
  worker?: { snapshot: WorkerPlanSnapshot; request: WorkerPlanRequest };
}

export interface WrapperRouteEnvelope {
  version: 1;
  provider: WrapperRouteRequest['provider'];
  decision: ModelRouteDecision;
  role: ModelRole | null;
  tier: ModelTier | null;
  wrapper: string | null;
  capability: ResolvedRoutableCapability;
  assignment: string;
  model: CompiledModelPolicy | null;
  worker?: WorkerResolutionPlan;
  launch: {
    mechanism: WrapperLaunchMechanism;
    target: string | null;
    prompt: string;
  };
}

function roleForTier(tier: ModelTier | null): ModelRole | null {
  if (tier === 'economy') return 'efficiency';
  if (tier === 'premium' || tier === 'flagship' || tier === 'max-quality') return 'reasoning';
  if (tier === 'standard') return 'coding';
  return null;
}

export function buildWrapperRouteEnvelope(request: WrapperRouteRequest): WrapperRouteEnvelope {
  if (typeof request.assignment !== 'string' || !request.assignment.trim()) throw new Error('Wrapper routing requires a bounded assignment.');

  const decision = routeModelTier({ ...request, agentName: request.agentName ?? request.capability.name });
  if (request.worker?.snapshot.config.parallelism?.worker_dispatch && !request.deterministic) {
    const worker = resolveWorkerPlan(request.worker.snapshot, {
      ...request.worker.request,
      authority: request,
    });
    const role = worker.role as ModelRole | null;
    const wrapper = role ? MODEL_WRAPPERS[role] : null;
    return {
      version: 1, provider: request.provider, decision, role,
      tier: role ? worker.policy?.roleGuidance?.[role]?.tier ?? null : null,
      wrapper, capability: request.capability, assignment: request.assignment.trim(), model: null, worker,
      launch: { mechanism: request.launchMechanism, target: worker.selected ? wrapper : null,
        prompt: worker.selected
          ? `Run this bounded assignment through ${wrapper}.\nSelected worker: ${worker.selected.group}/${worker.selected.member}; model ${worker.selected.model}; effort ${worker.selected.effort ?? 'not-applicable'}.\nAssignment: ${request.assignment.trim()}\nRevalidate current input digests before invocation; return claims for conductor verification.`
          : 'Worker resolution is blocked; inspect the plan diagnostics and exclusions.' },
    };
  }
  const tier = decision.modelTier;
  const role = tier ? request.role ?? roleForTier(tier) : null;
  const wrapper = role ? MODEL_WRAPPERS[role] : null;
  const model = role && tier
    ? compileModelPolicy({
        provider: request.provider,
        artifact: 'agent',
        policy: { role, tier, override: request.modelOverride },
        election: request.election,
        flagshipAllowlist: request.flagshipAllowlist,
        agentName: request.agentName ?? request.capability.name,
        ...(request.catalog ? { catalog: request.catalog } : {}),
      })
    : null;
  const prompt = wrapper
    ? [
        `Run this assignment through ${wrapper}.`,
        `Selected capability: ${request.capability.type} ${request.capability.name} (${request.capability.id}).`,
        `Load it with aiwg show ${request.capability.type === 'workflow' ? 'metadata' : request.capability.type} ${request.capability.id}${request.capability.type === 'workflow' ? '' : ' --body'} after discover-first validation.`,
        `Assignment: ${request.assignment.trim()}`,
        'Return capability evidence, changed artifacts, validation results, and remaining risks.',
      ].join('\n')
    : `No model call is required. Execute the deterministic assignment: ${request.assignment.trim()}`;

  return {
    version: 1,
    provider: request.provider,
    decision,
    role,
    tier,
    wrapper,
    capability: request.capability,
    assignment: request.assignment.trim(),
    model,
    launch: {
      mechanism: request.launchMechanism,
      target: wrapper,
      prompt,
    },
  };
}
