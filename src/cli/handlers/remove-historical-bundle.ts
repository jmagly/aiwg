// Explicitly remove receipt-owned files after a bundle declaration was dropped.
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { frameworkRegistryId } from '../../config/framework-aliases.js';
import { bundleDeploymentHistory } from './bundle-deployment-mode.js';
import { refreshRemainingFlueModules } from './remove-flue-modules.js';
import { removeBundledDeployment } from './remove-bundled.js';
export async function removeHistoricalBundle(project: string, id: string, provider: string | undefined, config: AiwgConfig, dryRun: boolean) {
  const owner = frameworkRegistryId(id);
  const history = bundleDeploymentHistory(project);
  const providers = Object.keys(history).filter(p => (!provider || p === provider) && history[p][owner]);
  if (!providers.length) return undefined;
  const historical = structuredClone(config);
  historical.installed[id] = { deployedTo: Object.fromEntries(providers.map(p => [p, {}])) };
  const result = await removeBundledDeployment(project, id, owner, historical, providers, { dryRun, keepRegistry: true });
  if (!dryRun && !result.exitCode && providers.includes('flue')) await refreshRemainingFlueModules(project, config);
  return result;
}
