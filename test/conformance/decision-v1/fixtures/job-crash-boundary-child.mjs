import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../../../src/security/artifact-trust.ts';
import { FileJobStore } from '../../../../src/decision/job-store.ts';
import { DecisionJobRuntime } from '../../../../src/decision/job-runtime.ts';
import { OfflineJobWorker } from '../../../../src/decision/job-worker.ts';
const [directory, boundary, phase, marker, calls, jobFile] = process.argv.slice(2);
const actor = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const digest = `sha256:${'a'.repeat(64)}`;
const running = job => job.items.some(item => item.state === 'running');
const armed = {
  validation: () => false,
  queue: (previous, next) => previous.job.state === 'validating' && next.job.state === 'queued',
  cancel: (_previous, next) => next.job.state === 'cancel-requested',
  finalization: (previous, next) => running(previous.job) && !running(next.job),
}[boundary];
if (!armed || !['before', 'after'].includes(phase)) throw new Error('Unknown crash boundary');
/** Stop this process at the durable write boundary and wait for the parent to SIGKILL it. */
async function halt(snapshot) {
  if (phase === 'before') {
    // Leave a torn, unpublished revision the way an interrupted temporary write would.
    const prefix = createHash('sha256').update(canonicalJson({ scope: snapshot.job.scope, id: snapshot.job.id })).digest('hex');
    const torn = canonicalJson(snapshot);
    await writeFile(join(directory, `.${prefix}.job-${randomUUID()}.tmp`), torn.slice(0, torn.length >> 1), { flag: 'wx', mode: 0o600 });
  }
  await writeFile(marker, `${boundary}:${phase}`, { flag: 'wx', mode: 0o600 });
  await new Promise(() => setInterval(() => {}, 1000));
}
class CrashingJobStore extends FileJobStore {
  async acquire(job) {
    if (boundary !== 'validation') return super.acquire(job);
    if (phase === 'before') await halt({ revision: 1, job, deleted: false, legalHold: false });
    const acquired = await super.acquire(job);
    await halt(acquired.snapshot);
    return acquired;
  }
  async compareAndSwap(previous, next) {
    if (!armed(previous, next)) return super.compareAndSwap(previous, next);
    if (phase === 'before') await halt(next);
    const published = await super.compareAndSwap(previous, next);
    if (!published) throw new Error('Crash fixture lost its compare-and-swap');
    await halt(next);
    return published;
  }
}
const runtime = new DecisionJobRuntime(new CrashingJobStore(directory), () => 20);
if (boundary === 'validation') {
  await runtime.submit(JSON.parse(await readFile(jobFile, 'utf8')), actor);
} else if (boundary === 'queue') {
  const initial = await runtime.poll(actor, 'jobA');
  const next = structuredClone(initial.job); next.state = 'queued';
  await runtime.advance(actor, 'jobA', initial, next);
} else if (boundary === 'cancel') {
  await runtime.cancel(actor, 'jobA');
} else {
  await new OfflineJobWorker(runtime).run(actor, 'jobA', 'item0', async () => {
    await appendFile(calls, 'item0\n', { mode: 0o600 });
    return { state: 'succeeded', resultDigest: digest, receiptDigest: digest };
  });
}
throw new Error('Crash boundary was not reached');
