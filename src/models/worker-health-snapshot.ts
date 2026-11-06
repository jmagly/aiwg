// Project signed historical approval inputs for offline health checks without granting launch authority.
import { inspectRecordedWorkerQualifications } from './worker-installation.mjs';
import type { WorkerPlanSnapshot } from './worker-plan.js';

export async function recordedWorkerHealthSnapshot(snapshot: WorkerPlanSnapshot, cwd: string): Promise<WorkerPlanSnapshot> {
  const parallelism = snapshot.config.parallelism;
  const policy = snapshot.models.defaults.workerSelection;
  if (!parallelism || !policy) return snapshot;
  const records = await inspectRecordedWorkerQualifications({ cwd, policy, parallelism, includeInputs: true })
    .catch(() => []);
  const result = structuredClone(snapshot);
  for (const { cli, provider, binding, adapter, observations } of records) {
    if (!binding || !adapter || !observations) continue;
    const providerEntry = Object.entries(result.registry.providers).find(([id]) => id === provider)?.[1];
    if (providerEntry) providerEntry.workerAdapter = adapter;
    else { result.registry.workerAdapters ??= {}; result.registry.workerAdapters[adapter.id] = adapter; }
    result.installations[cli] = binding;
    result.catalog.discovery ??= { source: 'static', fetchedAt: observations.observedAt, providers: {} };
    result.catalog.discovery.instances ??= {};
    // These are recorded facts only; current discovery and installation are rechecked at launch.
    result.catalog.discovery.instances[cli] = observations;
  }
  return result;
}
