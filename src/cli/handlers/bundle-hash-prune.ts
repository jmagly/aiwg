// Reuse project-local removal when historical provider hashes outlive its declaration.
import { frameworkRegistryId } from '../../config/framework-aliases.js';
import { bundleDeploymentHistory } from './bundle-deployment-mode.js';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { getProviderArtifactPathStrings } from '../../providers/provider-definitions.js';
import { deployedSkillRoots } from '../../providers/deployed-skill-roots.js';
import { removeProjectLocalBundle } from '../../extensions/project-local-remove.js';
export async function pruneUndeclaredHashes(project: string, config: AiwgConfig, requested: string | undefined, dryRun: boolean): Promise<Set<string>> {
  const handled = new Set<string>();
  for (const [id, entry] of Object.entries(config.installed)) {
    if (entry.source !== 'project-local') continue;
    const historicalProviders = new Set([...Object.keys(entry.deployedArtifactHashes ?? {}), ...(Object.keys(entry.artifactHashes ?? {}).length ? config.providers ?? [] : [])]);
    for (const provider of historicalProviders) {
      if (!getProviderArtifactPathStrings(provider)) continue;
      if (entry.deployedTo[provider] || requested && !requested.split(',').includes(provider)) continue;
      const mode = bundleDeploymentHistory(project)[provider]?.[frameworkRegistryId(id)];
      if (mode?.copy || mode?.package) {
        console.log(`${id} for ${provider}: kept (${mode?.copy ? 'copy' : 'package'} mode); run \`aiwg remove ${id}\` to delete`);
        handled.add(`${provider}:${id}`);
        continue;
      }
      const others = Object.keys(entry.deployedTo).filter(other => other !== provider);
      const preserveRoots = deployedSkillRoots(project, provider).filter(root => others.some(other => deployedSkillRoots(project, other).includes(root)));
      const historical = structuredClone(config);
      historical.installed[id].deployedTo[provider] = {};
      console.log(`${dryRun ? 'Would remove' : 'Removing'} ${id} for ${provider} (recorded hashes)`);
      const result = await removeProjectLocalBundle(historical, project, id, { provider, dryRun, keepRegistry: true, preserveRoots });
      for (const outcome of result.outcomes) console.log(`  ${outcome.deployedAbsPath}: ${outcome.message}`);
      handled.add(`${provider}:${id}`);
    }
  }
  return handled;
}
