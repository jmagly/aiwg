/** Explain missing or changed environment names after the loader verifies signing trust. */
import { WorkerPolicyError } from './provider-policy.js';
import { changedWorkerDesktopEnvironment } from './worker-environment-binding.mjs';

type Rejections = NonNullable<WorkerPolicyError['details']>['rejections'];
interface EnvironmentRecord {
  installation?: { environmentNames?: unknown; environment?: Record<string, unknown>; environmentBindings?: unknown };
}

export class WorkerQualificationEnvironmentError extends WorkerPolicyError {
  readonly pointer = '/parallelism/clis';
  constructor(names: string[], rejections: Rejections, changed: string[] = []) {
    super('OG_ENVIRONMENT_MISMATCH',
      (names.length ? `Launch environment lacks variables present at worker qualification: ${names.join(', ')}. ` : '')
      + (changed.length ? `Launch environment variables changed since qualification: ${changed.join(', ')}. ` : '')
      + 'Launch with the same environment, or re-qualify from the launch environment '
      + 'with aiwg doctor --probe-workers --qualify.', { rejections });
  }
}

/** Only environment rejections reached after signature verification may disclose names. */
export function workerQualificationEnvironmentError(rejections: Rejections,
  records: EnvironmentRecord[] | undefined, environment: NodeJS.ProcessEnv = process.env): WorkerQualificationEnvironmentError | null {
  const missing = new Set<string>();
  const changed = new Set<string>();
  for (const row of rejections) {
    if (!['environment-name', 'environment-value'].includes(row.reason) || row.registration === null) continue;
    const installation = records?.[row.registration]?.installation;
    const names = installation?.environmentNames;
    // Malformed or value-bearing records retain the generic qualification diagnostic.
    if (!installation || Object.keys(installation.environment ?? {}).length || !Array.isArray(names)
      || names.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) continue;
    for (const name of names) if (environment[name] === undefined) missing.add(name);
    try {
      for (const name of changedWorkerDesktopEnvironment(installation, environment)) changed.add(name);
    } catch { /* Invalid bindings retain the generic diagnostic. */ }
  }
  return missing.size || changed.size
    ? new WorkerQualificationEnvironmentError([...missing].sort(), rejections, [...changed].sort()) : null;
}
