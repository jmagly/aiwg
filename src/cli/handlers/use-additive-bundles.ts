// Discover additive framework bundles once for deployment and reconciliation.
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Addons excluded from `aiwg use all`.
 * aiwg-dev is contributor-only tooling — not for end users.
 */
export const USE_ALL_DISALLOW = new Set(['aiwg-dev']);

/**
 * Whether an addon's manifest keeps it out of bulk deploys (#2641).
 *
 * `devOnly` marks contributor tooling; `explicitInstall` marks an addon that is
 * deployed only when named, such as `aiwg use decision-engine`. Both match
 * `discoverAddons()` in tools/agents/providers/base.mjs, which applies the same
 * rule to framework-mode deploys.
 *
 * `autoInstall: false` is deliberately NOT an exclusion signal: most addons
 * declare it (and the extension manifest schema defaults to it), so honoring
 * it would drop most addons from `all` for existing users.
 */
async function isExplicitOnlyAddon(addonDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(addonDir, 'manifest.json'), 'utf8'));
    return manifest?.devOnly === true || manifest?.explicitInstall === true;
  } catch {
    return false;
  }
}

/**
 * Discover all addon names from the filesystem, minus the disallow list and
 * addons whose manifest restricts them to explicit installs.
 */
export async function getAllAddons(frameworkRoot: string): Promise<string[]> {
  const addonsDir = path.join(frameworkRoot, 'agentic/code/addons');
  const entries = await fs.readdir(addonsDir, { withFileTypes: true });
  const candidates = entries.filter(e => e.isDirectory() && !USE_ALL_DISALLOW.has(e.name));
  const excluded = await Promise.all(candidates.map(e => isExplicitOnlyAddon(path.join(addonsDir, e.name))));
  return candidates.filter((_, index) => !excluded[index]).map(e => e.name);
}

/**
 * Extensions excluded from `aiwg use all` deployment.
 * `api-adapter` is an OpenAPI spec, not a deployable artifact bundle.
 */
export const USE_ALL_EXTENSIONS_DISALLOW = new Set(['api-adapter']);

/**
 * Discover all extension names from `agentic/code/extensions/*` (#1221).
 *
 * Extensions are addon-shaped bundles with their own `manifest.json`,
 * `skills/`, `rules/`, and `templates/` directories. Only directories
 * containing a `manifest.json` are considered deployable; bare directories
 * (e.g. `api-adapter` which only ships an OpenAPI spec) are skipped.
 */
export async function getAllExtensions(frameworkRoot: string): Promise<string[]> {
  const extensionsDir = path.join(frameworkRoot, 'agentic/code/extensions');
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (USE_ALL_EXTENSIONS_DISALLOW.has(entry.name)) continue;
    const manifestPath = path.join(extensionsDir, entry.name, 'manifest.json');
    try {
      await fs.access(manifestPath);
      result.push(entry.name);
    } catch {
      // Directory without a manifest is not deployable as an extension.
      continue;
    }
  }
  return result;
}

/** The same provider and kernel gates govern use passes and expected receipt owners. */
export async function frameworkAdditiveBundles(frameworkRoot: string, provider: string, skipUtils = false, kernelOnly = false) {
  const addons = skipUtils || provider === 'flue' ? [] : await getAllAddons(frameworkRoot);
  const extensions = skipUtils || kernelOnly || provider === 'flue' ? [] : await getAllExtensions(frameworkRoot);
  return { addons, extensions };
}
