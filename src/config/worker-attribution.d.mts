import type { WorkerResolvedInvocation } from '../mission-protocol/types.js';
export const WORKER_WORKSPACE_MARKER: 'AIWG_WORKER_WORKSPACE';
export const WORKER_GROUP_MARKER: 'AIWG_WORKER_GROUP';
export function workerWorkspace(value?: string): string | undefined;
export function workerAttributionEnvironment(invocationId: string, workspace: string, group: string): Record<string, string>;
export function directWorkerEnvironment(invocation: WorkerResolvedInvocation): Record<string, string>;
export function readWorkerAttribution(environment: string): { invocation?: string; workspace?: string; group?: string };
