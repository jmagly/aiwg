// Resolve every native Ralph cycle before handing options to the provider launcher.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';

export async function routeRalphWorker(owner, state, outputDir, assignment = state.objective) {
  const { resolveDelegation } = await importImpl(import.meta.url, 'models/delegation.js');
  const provider = state.config.provider ?? owner.providerAdapter?.getName() ?? 'claude';
  let record;
  try {
    ({ record } = await resolveDelegation({ orchestrator: 'ralph', workerId: state.loopId ?? 'ralph-worker',
      assignment, provider, cwd: owner.projectRoot,
      requestedTier: state.config.workerTier, model: state.config.model,
      election: state.config.modelElection, premiumAuthorized: state.config.modelElection === 'user' }));
  } catch (error) {
    // A custom or project-local provider has no tier catalog, so no tier can be
    // resolved or enforced. Launch with the operator's explicit pin, or the
    // provider's own default, and record that tier policy did not apply. Every
    // other refusal (ceiling, flagship, premium) still fails the cycle.
    if (!/^Worker tier selection is unavailable for provider /.test(error?.message ?? '')) throw error;
    record = { version: 1, orchestrator: 'ralph', workerId: state.loopId ?? 'ralph-worker', role: null,
      requested_tier: state.config.workerTier ?? null, resolved_tier: null, resolved_model: state.config.model ?? null,
      wrapper: null, strategy: null, max_auto_tier: null, election: state.config.modelElection ?? null,
      tier_policy: 'unavailable',
      warnings: [`Tier policy is unavailable for provider ${provider}; launching with ${state.config.model ? 'the explicit model pin' : 'the provider default model'}.`] };
  }
  await writeFile(join(outputDir, 'routing.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
