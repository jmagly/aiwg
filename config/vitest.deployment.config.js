import base from './vitest.config.js';
import { deploymentFiles, deploymentShards } from './test-lanes.mjs';

/** Files for AIWG_DEPLOYMENT_SHARD=1|2; unset runs the whole lane. */
export function deploymentLaneFiles(shard = process.env.AIWG_DEPLOYMENT_SHARD) {
  if (shard === undefined || shard === '') return deploymentFiles;
  const index = Number(shard) - 1;
  if (!Number.isInteger(index) || !deploymentShards[index]) {
    throw new Error(`AIWG_DEPLOYMENT_SHARD must be 1-${deploymentShards.length} (got '${shard}')`);
  }
  return deploymentShards[index];
}

// Full-corpus provider deployment is a required, deterministic offline lane.
// Keep these files in one process-wide run so they share the reviewed immutable
// source caches without competing with the general test worker pool.
// CI sets AIWG_DEPLOYMENT_SHARD to run one of the two shards.
export default {
  ...base,
  test: {
    ...base.test,
    include: deploymentLaneFiles(),
    exclude: ['node_modules/**', 'dist/**'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    isolate: true,
  },
};
