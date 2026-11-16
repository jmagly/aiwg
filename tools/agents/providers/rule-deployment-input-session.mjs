// Reuse the existing immutable input pool within an update and measure staging.
import path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { importImpl } from '../../_resolve-impl.mjs';
import { resolveAiwgRoot } from './base.mjs';
import { createRuleDeploymentInputPool, disposeRuleDeploymentInputPool } from './rule-deployment-state.mjs';

const { deploymentSessionInput } = await importImpl(import.meta.url, 'providers/deployment-input-session.mjs');
const timings = channel('aiwg.provider-staging');
const sourceRoot = srcRoot => path.resolve(resolveAiwgRoot(srcRoot) || srcRoot);

export function sessionInputPool(srcRoot) {
  const root = sourceRoot(srcRoot);
  return deploymentSessionInput(root, () => {
    const start = performance.now();
    let status = 'failed';
    try {
      const pool = createRuleDeploymentInputPool(srcRoot);
      status = 'succeeded';
      return pool;
    }
    finally {
      timings.publish({ phase: 'snapshot-provider-inputs', source: root, durationMs: performance.now() - start, status });
    }
  }, disposeRuleDeploymentInputPool);
}

export async function measureProviderStaging(original, provider, prepare) {
  const source = sourceRoot(original.srcRoot);
  const start = performance.now();
  let status = 'failed';
  try {
    const plan = await prepare();
    status = 'prepared';
    return plan;
  } finally {
    timings.publish({ phase: 'prepare-provider-staging', source, provider: provider.name,
      durationMs: performance.now() - start, status });
  }
}
