// Render OpenCode model/effort arguments for the qualified distribution line.
import { workerVersionRangeMismatch } from './worker-installation.mjs';
import { major } from 'semver';

export const OPENCODE_SUPPORTED_VERSIONS = Object.freeze(['>=1.18.0 <2.0.0', '>=2.0.26 <3.0.0']);

export function opencodeWorkerModelArgs(model, effort, cliVersion) {
  if (typeof cliVersion !== 'string'
    || workerVersionRangeMismatch(cliVersion, [OPENCODE_SUPPORTED_VERSIONS.join(' || ')]) !== null) {
    throw new Error('OpenCode worker requires a supported installed CLI version');
  }
  if (major(cliVersion) === 1) {
    return ['-m', model, ...(effort === null ? [] : ['--variant', effort])];
  }
  return ['-m', effort === null ? model : `${model}#${effort}`];
}
