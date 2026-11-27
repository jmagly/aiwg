// Mirror Antigravity addon skills through the existing user-scope ownership flow.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { hashManifest } from '../../config/aiwg-config.js';
import { recordUserDeploy } from '../../config/user-registry.js';
import { getProviderArtifactPathStrings, getProviderKernelSkillPath } from '../../providers/provider-definitions.js';
import { mirrorToUserScope } from '../scope-resolver.js';

export async function mirrorAntigravityAddon(opts: { source: string; target: string; bundle: string }): Promise<void> {
  const provider = 'antigravity';
  const paths = getProviderArtifactPathStrings(provider)!;
  const projectPath = (value: string): string => !value ? '' : isAbsolute(value) ? value : join(opts.target, value);
  const mirrored = await mirrorToUserScope(provider, {
    agents: projectPath(paths.agents), commands: projectPath(paths.commands),
    skills: projectPath(paths.skills), rules: projectPath(paths.rules), behaviors: projectPath(paths.behaviors),
    kernelSkills: projectPath(getProviderKernelSkillPath(provider)),
  });
  if (mirrored.skills.count === 0) return;
  const manifestPath = join(opts.source, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
  await recordUserDeploy({
    framework: opts.bundle, provider, version: manifest.version, source: 'bundled',
    manifestHash: await hashManifest(manifestPath),
    counts: { agents: 0, commands: 0, skills: mirrored.skills.count, rules: 0 },
    entries: { skills: mirrored.skills.entries },
  });
}
