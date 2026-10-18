import os from 'node:os';
import path from 'node:path';

/** Host-local AIWG state, shared by CLI telemetry and maintenance leases. */
export function getUserStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state'), 'aiwg');
}
