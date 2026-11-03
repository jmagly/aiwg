// Workspace/group environment protocol shared by worker launchers and the host census.
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WORKER_INVOCATION_MARKER } from './worker-invocation-marker.mjs';

export const WORKER_WORKSPACE_MARKER = 'AIWG_WORKER_WORKSPACE';
export const WORKER_GROUP_MARKER = 'AIWG_WORKER_GROUP';

export function workerWorkspace(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return undefined;
  try { return realpathSync(value); } catch { return path.normalize(value); }
}

export function workerAttributionEnvironment(invocationId, workspace, group) {
  const canonical = workerWorkspace(workspace);
  if (typeof invocationId !== 'string' || !invocationId || /[\0\r\n]/.test(invocationId)) {
    throw new Error('Worker attribution requires a non-empty invocation ID');
  }
  if (!canonical || typeof group !== 'string' || !group || /[\0\r\n]/.test(group)) {
    throw new Error('Worker attribution requires an absolute workspace and a non-empty group');
  }
  return { [WORKER_INVOCATION_MARKER]: invocationId,
    [WORKER_WORKSPACE_MARKER]: canonical, [WORKER_GROUP_MARKER]: group };
}

export function directWorkerEnvironment(invocation) {
  const id = invocation.invocationId ?? createHash('sha256').update(JSON.stringify([
    invocation.cwd, invocation.selected, invocation.finalPath, invocation.briefDigest,
  ])).digest('hex');
  return workerAttributionEnvironment(id, invocation.cwd, invocation.selected.group);
}

export function readWorkerAttribution(environment) {
  const fields = environment.split('\0');
  const read = name => {
    const values = fields.filter(field => field.startsWith(`${name}=`)).map(field => field.slice(name.length + 1));
    return values.length === 1 ? values[0] : undefined;
  };
  const invocation = read(WORKER_INVOCATION_MARKER);
  const workspace = workerWorkspace(read(WORKER_WORKSPACE_MARKER));
  const group = read(WORKER_GROUP_MARKER);
  return { invocation, ...(workspace && group && !/[\0\r\n]/.test(group) ? { workspace, group } : {}) };
}
