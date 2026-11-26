// Adds explicit worker model policy to conductor invocation descriptors.
import { resolveDelegation, type DelegationRecord } from '../models/delegation.js';
import type { ModelTier } from '../models/types.js';
import type { WorkerInvocation } from './stack-adapters.js';

export interface CycleSelection {
  role?: string;
  workerTier?: ModelTier;
  election?: 'user';
  premiumAuthorized?: boolean;
}
export type RoutedWorkerInvocation = WorkerInvocation & { routing?: DelegationRecord; model?: string };

export async function routeCycleWorker(cycle: CycleSelection & { id: string; runtime: string; prompt: string },
  invocation: RoutedWorkerInvocation, activityLog: string[], cwd?: string): Promise<RoutedWorkerInvocation> {
  const { record } = await resolveDelegation({ orchestrator: cycle.id.startsWith('flow:') ? 'flow' : 'mission',
    workerId: cycle.id, assignment: cycle.prompt, provider: cycle.runtime, cwd,
    role: cycle.role, requestedTier: cycle.workerTier, election: cycle.election, premiumAuthorized: cycle.premiumAuthorized });
  activityLog.push(JSON.stringify(record));
  return { ...invocation, model: record.resolved_model, routing: record };
}
