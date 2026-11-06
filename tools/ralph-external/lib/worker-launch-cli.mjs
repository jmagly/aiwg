// Parse one-shot launch options and derive retry IDs from launcher records.
import { join, isAbsolute } from 'node:path';
import { boundedPrivateRead } from './worker-inputs.mjs';

export function parseWorkerLaunchArgs(args) {
  const result = {};
  const seen = new Set();
  let retryOfInvocationId;
  let retryOfRunDir;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Duplicate worker launch option: ${flag}`);
    seen.add(flag);
    if (flag === '--launch-worker') continue;
    if (flag === '--check-descendants') { result.checkDescendants = true; continue; }
    if (flag === '--retry-correction') continue;
    if (flag === '--allow-degraded-worker') { result.allowDegraded = true; continue; }
    // A run directory declares a retry; its launcher ID is derived before validation.
    const key = { '--invocation': 'invocationPath', '--run-dir': 'runDir',
      '--retry-of': '__retryOfInvocationId', '--retry-of-run-dir': '__retryOfRunDir' }[flag];
    if (!key) throw new Error(`Unsupported worker launch option: ${flag}. Worker launch already emits JSON; for JSON status use aiwg ralph-external --status --workers --run-dir DIR --json separately. Run the resolved command unchanged.`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (key === '__retryOfInvocationId') retryOfInvocationId = value;
    else if (key === '__retryOfRunDir') retryOfRunDir = value;
    else result[key] = value;
  }
  if (!seen.has('--launch-worker') || !result.invocationPath || !result.runDir) {
    throw new Error('Usage: ralph-external --launch-worker --invocation FILE --run-dir DIR [--allow-degraded-worker] [--check-descendants] [--retry-of-run-dir DIR [--retry-of ID] [--retry-correction]]');
  }
  // #3857: reject relative paths here, naming the flag, before any launch work.
  for (const [flag, value] of [['--invocation', result.invocationPath], ['--run-dir', result.runDir], ['--retry-of-run-dir', retryOfRunDir]]) {
    if (value !== undefined && !isAbsolute(value)) {
      throw new Error(`${flag} must be an absolute path; relative paths are not resolved against cwd.`);
    }
  }
  if (retryOfInvocationId !== undefined && retryOfRunDir === undefined) {
    throw new Error('--retry-of and --retry-of-run-dir must be supplied together when an explicit ID is used');
  }
  if (result.checkDescendants && retryOfRunDir === undefined) throw new Error('--check-descendants requires --retry-of-run-dir');
  if (seen.has('--retry-correction') && retryOfRunDir === undefined) throw new Error('--retry-correction requires --retry-of-run-dir');
  if (retryOfRunDir !== undefined) result.retryOf = { runDir: retryOfRunDir, ...(retryOfInvocationId === undefined ? {} : { invocationId: retryOfInvocationId }) };
  if (seen.has('--retry-correction')) result.retryOf.correction = true;
  return result;
}

export async function resolveRetryReference(retryOf, { inspect }) {
  if (!retryOf || typeof retryOf !== 'object' || retryOf.invocationId !== undefined) return retryOf;
  if (!isAbsolute(retryOf.runDir ?? '')) throw new Error('Retry run directory must be absolute');
  const bytes = await boundedPrivateRead(join(retryOf.runDir, 'invocation.json'), 1048576, inspect, true, true);
  const record = JSON.parse(bytes.toString('utf8'));
  if (record.origin !== 'launcher' || typeof record.invocationId !== 'string' || !record.invocationId) {
    throw new Error('Retry predecessor invocation.json must contain a launcher invocationId');
  }
  // Derivation is not acceptance: verifyRetryPredecessor still checks ownership,
  // task-chain identity, matching records, writable roots and confirmed stop.
  return { ...retryOf, invocationId: record.invocationId };
}
