// Build quickrefs from validated bundles while retaining rejected sibling diagnostics.
import { discoverProjectLocalBundles } from './project-local-discovery.js';
import { formatManifestValidationError } from './manifest.js';

export async function discoverProjectQuickrefBundles(projectDir: string) {
  const discovery = await discoverProjectLocalBundles(projectDir);
  return {
    ...discovery,
    warnings: discovery.errors.map(error =>
      `${error.path}: ${formatManifestValidationError(error)}`),
  };
}
