import { describe, it } from 'vitest';
import * as loader from '../../../src/gates/providers/loader.js';

/**
 * Bundle providers run only inside the bubblewrap sandbox and refuse
 * (fail closed) where it is unavailable. Cases that execute a provider skip
 * VISIBLY there: the skip names the refusal reason. On hosts with a working
 * bwrap (this repository's development hosts) they always run.
 */
const status = loader.isolationSandboxStatus();

// The dedicated CI step preflights bwrap/user namespaces. Once available,
// a broken isolation or memory capability must fail that lane, never skip it.
if (process.env.AIWG_REQUIRE_PROVIDER_SANDBOX === '1' && !status.ok) {
  throw new Error(`Required provider sandbox failed: ${status.reason}`);
}

export const SANDBOX_READY = status.ok;
export const SANDBOX_SKIP_SUFFIX = status.ok ? '' : ` [SKIPPED: provider sandbox unavailable: ${status.reason}]`;

export const itSandboxed = (name: string, fn: () => unknown, timeout?: number): void => {
  if (SANDBOX_READY) it(name, fn, timeout);
  else it.skip(`${name}${SANDBOX_SKIP_SUFFIX}`, fn);
};

export const describeSandboxed = (name: string, fn: () => void): void => {
  if (SANDBOX_READY) describe(name, fn);
  else describe.skip(`${name}${SANDBOX_SKIP_SUFFIX}`, fn);
};
