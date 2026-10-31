// Count only receipt-owned output in the bundle's recorded deployment scope.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { frameworkRegistryId } from '../../config/framework-aliases.js';
import { getProviderArtifactPathStrings } from '../../providers/provider-definitions.js';
import { deployedSkillRoots } from '../../providers/deployed-skill-roots.js';
import { bundleDeploymentHistory, bundleDeploymentScope } from './bundle-deployment-mode.js';
import { expectedBundleOwners } from './bundle-reconciliation.js';

export async function receiptIncludesOwner(file: string, owners: Set<string>): Promise<boolean> {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(path.dirname(file), '.aiwg-manifest.json'), 'utf8'));
    const record = receipt.managed?.[path.basename(file)];
    return record?.owners?.some((owner: string) => owners.has(frameworkRegistryId(owner))) === true;
  } catch { return false; }
}

export async function countRecordedFrameworkArtifacts(target: string, provider: string, id: string, root: string, args: string[]) {
  const selected = { installed: { [id]: { deployedTo: { [provider]: bundleDeploymentScope(id, provider, args) } } } } as AiwgConfig;
  const owners = await expectedBundleOwners(selected, provider, root);
  // Explicit bundles have their own records, even after undeclaration leaves edits.
  for (const owner of Object.keys(bundleDeploymentHistory(target)[provider] ?? {})) {
    if (owner !== frameworkRegistryId(id)) owners.delete(owner);
  }
  const paths = getProviderArtifactPathStrings(provider);
  const countFiles = async (dir: string | undefined, skills = false, rules = false) => {
    if (!dir) return 0;
    const destination = path.resolve(target, dir);
    let entries: string[];
    try { entries = await fs.readdir(destination); } catch { return 0; }
    const owned: string[] = [];
    for (const name of entries) {
      const file = path.join(destination, name, ...(skills ? ['SKILL.md'] : []));
      if (!skills && !name.endsWith('.md')) continue;
      if (await fs.stat(file).then(stat => stat.isFile()).catch(() => false) && await receiptIncludesOwner(file, owners)) owned.push(name);
    }
    if (!rules) return owned.length;
    const indexes = owned.filter(name => name.endsWith('RULES-INDEX.md'));
    if (!indexes.length) return owned.length;
    let count = 0;
    for (const name of indexes) {
      for (const match of (await fs.readFile(path.join(destination, name), 'utf8')).matchAll(/\((\d+) rules[^)]*\)/g)) count += Number(match[1]);
    }
    return count || owned.length;
  };
  return {
    agents: await countFiles(paths?.agents), commands: await countFiles(paths?.commands),
    skills: (await Promise.all(deployedSkillRoots(target, provider).map(dir => countFiles(dir, true)))).reduce((a, b) => a + b, 0),
    rules: await countFiles(paths?.rules, false, true),
  };
}
