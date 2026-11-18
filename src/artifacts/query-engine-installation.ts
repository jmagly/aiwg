// Resolve artifact availability from provider deployment paths and bundle records.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MetadataEntry } from './types.js';
import { isCorpusBundleInstalled } from './framework-capabilities.js';
import { readAiwgConfigCandidate } from '../config/aiwg-config.js';
import { frameworkRegistryId } from '../config/framework-aliases.js';

export async function isArtifactInstalled(cwd: string, root: string, entry: Pick<MetadataEntry, 'path' | 'type'>,
  kind: 'framework' | 'addon' | 'extension' | 'plugin' | null, bundle: string | null): Promise<boolean> {
  if (['skill', 'agent', 'command'].includes(entry.type)) {
    const normalized = entry.path.replace(/\\/g, '/');
    const slug = path.posix.basename(normalized) === 'SKILL.md'
      ? path.posix.basename(path.posix.dirname(normalized)) : path.posix.basename(normalized, '.md');
    const { listProviderDeploymentLayouts, resolveProviderPathValue } = await import('../providers/provider-definitions.js');
    for (const provider of listProviderDeploymentLayouts()) {
      const roots = entry.type === 'skill'
        ? [provider.paths.kernelSkills, provider.paths.artifacts.skills, provider.paths.contextDiscovery?.skills, provider.smithPaths?.skills]
        : [provider.paths.artifacts[entry.type === 'agent' ? 'agents' : 'commands']];
      for (const base of [cwd, os.homedir()]) for (const relative of roots) {
        if (!relative) continue;
        const directory = resolveProviderPathValue(relative, base);
        const files = entry.type === 'skill' ? [path.join(slug, 'SKILL.md')]
          : [slug + '.md', slug + '.toml', slug + '.yaml', slug + '.prompt.md'];
        if (files.some(file => fs.existsSync(path.join(directory, file)))) return true;
      }
    }
  }
  if (bundle && ['skill', 'agent', 'command'].includes(entry.type)) {
    const config = await readAiwgConfigCandidate(cwd);
    const selected = Object.entries(config?.installed ?? {}).find(([id]) => frameworkRegistryId(id) === frameworkRegistryId(bundle))?.[1]
      ?? config?.installed.all;
    const deployments = Object.values(selected?.deployedTo ?? {});
    if (deployments.length && deployments.every(flags => flags.copy === false && flags.kernelOnly !== false)) return false;
  }
  return isCorpusBundleInstalled(cwd, root, kind, bundle);
}
