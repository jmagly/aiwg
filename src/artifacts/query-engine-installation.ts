// Resolve artifact availability from provider deployment paths and bundle records.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MetadataEntry } from './types.js';
import { isCorpusBundleInstalled } from './framework-capabilities.js';

export async function isArtifactInstalled(cwd: string, root: string, entry: Pick<MetadataEntry, 'path' | 'type'>,
  kind: 'framework' | 'addon' | 'extension' | 'plugin' | null, bundle: string | null): Promise<boolean> {
  if (entry.type === 'skill') {
    const normalized = entry.path.replace(/\\/g, '/');
    const slug = path.posix.basename(normalized) === 'SKILL.md'
      ? path.posix.basename(path.posix.dirname(normalized)) : path.posix.basename(normalized, '.md');
    const { listProviderDeploymentLayouts, resolveProviderPathValue } = await import('../providers/provider-definitions.js');
    for (const provider of listProviderDeploymentLayouts()) {
      const roots = [provider.paths.kernelSkills, provider.paths.artifacts.skills, provider.paths.contextDiscovery?.skills,
        provider.smithPaths?.skills];
      for (const base of [cwd, os.homedir()]) for (const relative of roots) {
        if (!relative) continue;
        const directory = resolveProviderPathValue(relative, base);
        if (fs.existsSync(path.join(directory, slug, 'SKILL.md'))) return true;
      }
    }
  }
  return isCorpusBundleInstalled(cwd, root, kind, bundle);
}
