import { writeFile } from 'node:fs/promises';
import { FileJobStore } from '../../../../src/decision/job-store.ts';
import { DecisionJobRuntime } from '../../../../src/decision/job-runtime.ts';
import { OfflineJobWorker } from '../../../../src/decision/job-worker.ts';
const [directory, marker] = process.argv.slice(2);
const actor = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const worker = new OfflineJobWorker(new DecisionJobRuntime(new FileJobStore(directory), () => 20));
await worker.run(actor, 'jobA', 'item0', async () => {
  // The executor is entered only after the immutable dispatch fence is synced.
  await writeFile(marker, 'dispatched', { flag: 'wx', mode: 0o600 });
  await new Promise(() => setInterval(() => {}, 1000));
  throw new Error('unreachable');
});
