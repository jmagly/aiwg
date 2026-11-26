// Resolve every native Ralph cycle before handing options to the provider launcher.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';

export async function routeRalphWorker(owner, state, outputDir, assignment = state.objective) {
  const { resolveDelegation } = await importImpl(import.meta.url, 'models/delegation.js');
  const { record } = await resolveDelegation({ orchestrator: 'ralph', workerId: state.loopId ?? 'ralph-worker',
    assignment, provider: state.config.provider ?? owner.providerAdapter?.getName() ?? 'claude', cwd: owner.projectRoot,
    requestedTier: state.config.workerTier, model: state.config.model,
    election: state.config.modelElection, premiumAuthorized: state.config.modelElection === 'user' });
  await writeFile(join(outputDir, 'routing.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
