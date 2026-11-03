// Expected internal marker additions for existing exact shell/environment assertions.
import type { WorkerResolvedInvocation } from '../../src/mission-protocol/types.js';
import { directWorkerEnvironment } from '../../src/config/worker-attribution.mjs';
export const workerMarkerNames = ['AIWG_WORKER_GROUP', 'AIWG_WORKER_INVOCATION_ID', 'AIWG_WORKER_WORKSPACE'];
export function workerMarkerShell(invocation: WorkerResolvedInvocation) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  return Object.entries(directWorkerEnvironment(invocation)).map(([name, value]) => `${name}=${quote(value)}`).join(' ');
}
