import { appendFile } from 'node:fs/promises';
import { FileCompileCache, type CompileCacheIdentity, type CompileCacheReadContext } from '../../../src/decision/compile-cache/index.js';

const [directory, counter, workerId] = process.argv.slice(2);
if (!directory || !counter || !workerId) throw new Error('directory, counter, and worker ID are required');
const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const identity: CompileCacheIdentity = {
  identityVersion: 'decision-compile-cache-identity/v1', layer: 'definition-compilation',
  sourceArtifactDigests: [digest('a')], compiler: { id: 'decision', version: '1' }, runtimeVersion: 'node-22',
  schemaVersion: 'decision-v1alpha2', canonicalizer: { id: 'rfc8785', version: '1' },
  adapter: { id: 'jev', version: '1', promptVersion: 'p1' }, backendCapabilityMode: 'json-schema',
  modelPolicy: { requested: 'jev-1', compatibleActualModels: ['jev-1.0'] }, featureFlags: { strict: true },
  tenantId: 'tenant', projectId: 'project', dataClass: 'internal',
};
const now = Date.now();
const context: CompileCacheReadContext = {
  tenantId: 'tenant', projectId: 'project', nowEpochMs: now, authorize: () => true,
};
const cache = new FileCompileCache<string>(directory, { lockPollMs: 1, lockTimeoutMs: 5_000 });
const result = await cache.getOrCompile(identity, context, 10_000, async () => {
  await appendFile(counter, `${workerId}\n`);
  await new Promise(resolve => setTimeout(resolve, 100));
  return 'cross-process-compiled';
});
process.stdout.write(`${JSON.stringify({ outcome: result.outcome, value: result.entry.value })}\n`);
