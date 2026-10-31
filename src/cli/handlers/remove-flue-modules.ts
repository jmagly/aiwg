// Regenerate shared Flue app modules after a bundle's files are removed.
import { getFrameworkRoot } from '../../channel/manager.mjs';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { REGISTRY_ID_TO_USE_NAME } from '../../config/framework-aliases.js';
import { bundleCopyArgs } from './bundle-deployment-mode.js';
import { withInstalledSelection } from '../../config/installed-selection.js';
export async function refreshRemainingFlueModules(project: string, config: AiwgConfig): Promise<void> {
  const id = Object.keys(config.installed).find(id => config.installed[id].deployedTo.flue?.skills !== undefined);
  if (!id) return;
  const { useHandler } = await import('./use.js');
  const name = REGISTRY_ID_TO_USE_NAME[id] ?? id;
  const frameworkRoot = await getFrameworkRoot();
  const result = await withInstalledSelection(project, config.installed, () => useHandler.execute({
    cwd: project, frameworkRoot, args: [name, '--provider', 'flue', '--target', project, '--yes', '--json', ...bundleCopyArgs(config.installed, id, 'flue')], rawArgs: ['use', name],
  }));
  if (result.exitCode) throw new Error(`Flue module regeneration failed: ${result.message || name}`);
}
